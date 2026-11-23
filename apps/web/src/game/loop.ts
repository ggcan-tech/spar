import type { InputBits, RollbackSessionLike, SimEvent, TickResult } from '@spar/protocol';
import { FRAME_MS } from '@spar/protocol';

export interface GameLoopOpts {
  session: Pick<RollbackSessionLike, 'tick'>;
  input: { sample(): InputBits };
  onTick: (r: TickResult) => void;
  /** Called once per animation frame, after any ticks — even when every tick stalled. */
  onFrameRender: () => void;
  /** Max sim ticks per animation frame before the backlog is dropped. Default 4. */
  maxTicksPerFrame?: number;
  /** Injectable clock/scheduler (tests). */
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
}

export interface GameLoop {
  start(): void;
  stop(): void;
  running(): boolean;
  /** Total sim ticks and animation frames since start(). */
  counters(): { ticks: number; frames: number; stalledTicks: number };
}

/** Longest gap we are willing to catch up on (tab was hidden etc.). */
const MAX_CATCHUP_MS = 250;
/** Float slack so that exactly N frames of elapsed time yields N ticks. */
const EPS_MS = 1e-6;

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** If requestAnimationFrame has not fired within this long, the watchdog runs the frame instead. */
export const RAF_WATCHDOG_MS = 50;

interface Ticker { subscribe(fn: () => void): () => void }

let sharedTicker: Ticker | null | undefined;

/**
 * A 60 Hz tick stream from a dedicated Worker. Main-thread timers are throttled to ~1 Hz in
 * background tabs and in panes that are not compositing; worker timers are not, so the sim keeps
 * running at full rate (an online opponent must never stall because we alt-tabbed).
 */
function getWorkerTicker(): Ticker | null {
  if (sharedTicker !== undefined) return sharedTicker;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
      sharedTicker = null;
      return null;
    }
    const src =
      `let id=null;onmessage=(e)=>{if(e.data==='start'&&id===null){id=setInterval(()=>postMessage(0),${FRAME_MS});}` +
      `else if(e.data==='stop'&&id!==null){clearInterval(id);id=null;}};`;
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const subs = new Set<() => void>();
    worker.onmessage = () => {
      for (const fn of Array.from(subs)) fn();
    };
    sharedTicker = {
      subscribe(fn) {
        subs.add(fn);
        if (subs.size === 1) worker.postMessage('start');
        return () => {
          subs.delete(fn);
          if (subs.size === 0) worker.postMessage('stop');
        };
      },
    };
  } catch {
    sharedTicker = null;
  }
  return sharedTicker;
}

/**
 * Browsers pause requestAnimationFrame in hidden tabs (and in embedded panes that are not
 * compositing), which would freeze the sim and stall an online opponent. Every frame is armed on
 * rAF and on a watchdog (worker ticks, or a timer when workers are unavailable); whichever fires
 * first runs the callback and cancels the other. In the normal case rAF wins every time.
 */
export function createFrameScheduler(): {
  raf: (cb: (t: number) => void) => number;
  caf: (id: number) => void;
} {
  const pending = new Map<number, () => void>();
  let next = 1;
  const hasRaf = typeof requestAnimationFrame !== 'undefined';
  const ticker = getWorkerTicker();
  return {
    raf(cb) {
      const id = next++;
      let rafId = 0;
      let timer: ReturnType<typeof setTimeout> | 0 = 0;
      let unsub: (() => void) | null = null;
      let done = false;
      const cancel = (): void => {
        if (rafId) cancelAnimationFrame(rafId);
        if (timer) clearTimeout(timer);
        if (unsub) unsub();
        pending.delete(id);
      };
      const fire = (t: number): void => {
        if (done) return;
        done = true;
        cancel();
        cb(t);
      };
      const armed = performance.now();
      const visible = hasRaf && !documentHidden();
      if (visible) rafId = requestAnimationFrame(fire);
      const grace = visible ? RAF_WATCHDOG_MS : 0;
      if (ticker) {
        unsub = ticker.subscribe(() => {
          if (performance.now() - armed >= grace) fire(performance.now());
        });
      } else {
        timer = setTimeout(() => fire(performance.now()), visible ? RAF_WATCHDOG_MS : FRAME_MS);
      }
      pending.set(id, cancel);
      return id;
    },
    caf(id) {
      const cancel = pending.get(id);
      if (cancel) cancel();
    },
  };
}

/**
 * Fixed-timestep 60 Hz accumulator on requestAnimationFrame. Each tick samples the input source
 * once and advances the session by one frame. A tick that reports `stalled` still counts as a
 * consumed frame (the session decided to wait for the peer) and the frame is still rendered.
 */
export function createGameLoop(opts: GameLoopOpts): GameLoop {
  const now = opts.now ?? (() => performance.now());
  const scheduler = opts.raf && opts.caf ? { raf: opts.raf, caf: opts.caf } : createFrameScheduler();
  const raf = opts.raf ?? scheduler.raf;
  const caf = opts.caf ?? scheduler.caf;
  const maxTicks = Math.max(1, opts.maxTicksPerFrame ?? 4);

  let running = false;
  let rafId = 0;
  let acc = 0;
  let last = 0;
  let ticks = 0;
  let frames = 0;
  let stalledTicks = 0;

  function frame(): void {
    if (!running) return;
    const t = now();
    const dt = Math.min(Math.max(0, t - last), MAX_CATCHUP_MS);
    last = t;
    acc += dt;

    let n = 0;
    while (acc >= FRAME_MS - EPS_MS && n < maxTicks) {
      acc -= FRAME_MS;
      n++;
      ticks++;
      const r = opts.session.tick(opts.input.sample());
      if (r.stalled) stalledTicks++;
      opts.onTick(r);
      if (!running) return; // onTick may have stopped us (match over / quit)
    }
    // Hit the cap with backlog remaining: keep at most one frame so we never spiral.
    if (acc > FRAME_MS) acc = FRAME_MS;

    frames++;
    opts.onFrameRender();
    if (running) rafId = raf(frame);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      last = now();
      acc = 0;
      rafId = raf(frame);
    },
    stop(): void {
      if (!running) return;
      running = false;
      caf(rafId);
    },
    running: () => running,
    counters: () => ({ ticks, frames, stalledTicks }),
  };
}

// ───────────────────────── Event feed ─────────────────────────

export interface EventFeed {
  /** Returns only the events not seen before (by frame, kind, who, punch). */
  push(events: SimEvent[]): SimEvent[];
  reset(): void;
  size(): number;
}

export function eventKey(e: SimEvent): string {
  return `${e.frame}|${e.kind}|${e.who}|${e.punch ?? ''}`;
}

/**
 * Rollback re-executes frames, so the same SimEvent can be reported by several ticks. The feed
 * remembers keys for `horizonFrames` past the newest frame seen and drops repeats.
 */
export function createEventFeed(horizonFrames = 240): EventFeed {
  const seen = new Map<string, number>();
  let newest = -Infinity;
  let sincePrune = 0;

  function prune(): void {
    const cutoff = newest - horizonFrames;
    for (const [key, frame] of seen) if (frame < cutoff) seen.delete(key);
    sincePrune = 0;
  }

  return {
    push(events: SimEvent[]): SimEvent[] {
      const fresh: SimEvent[] = [];
      for (const e of events) {
        const key = eventKey(e);
        if (seen.has(key)) continue;
        seen.set(key, e.frame);
        if (e.frame > newest) newest = e.frame;
        fresh.push(e);
      }
      if (++sincePrune >= 120 || seen.size > 2048) prune();
      return fresh;
    },
    reset(): void {
      seen.clear();
      newest = -Infinity;
      sincePrune = 0;
    },
    size: () => seen.size,
  };
}
