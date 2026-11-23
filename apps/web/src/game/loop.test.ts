import { describe, expect, it } from 'vitest';
import type { MatchView, SimEvent, TickResult } from '@spar/protocol';
import { BIT, FRAME_MS, INTRO_FRAMES } from '@spar/protocol';
import { createBot, sim } from '@spar/sim';
import { createLocalSession } from '@spar/netcode';
import { createEventFeed, createFrameScheduler, createGameLoop, eventKey, RAF_WATCHDOG_MS } from './loop';

const fighter = {
  hp: 1000, stamina: 1000, guardHigh: true, head: 'CENTER' as const, phase: 'IDLE' as const,
  punch: null, body: false, phaseFrames: 0, counterWindow: 0, knockdowns: 0,
  stance: 'orthodox' as const, landed: 0, thrown: 0,
};
const view: MatchView = {
  frame: 0, state: 'FIGHTING', round: 1, roundFrame: 0, clockSec: 60, range: 600,
  fighters: [fighter, { ...fighter }], scores: [[], []], winner: null, method: null,
};

function fakeSession(stalledEvery = 0) {
  let frame = 0;
  const inputs: number[] = [];
  return {
    inputs,
    tick(input: number): TickResult {
      frame++;
      inputs.push(input);
      return {
        frame,
        view: { ...view, frame },
        events: [],
        stalled: stalledEvery > 0 && frame % stalledEvery === 0,
        stats: { rttMs: 0, rollbackFrames: 0, rollbacksTotal: 0, framesAhead: 0, confirmedFrame: frame },
      };
    },
  };
}

/** Manual RAF: callbacks are queued and fired by `pump()`; `clock` is advanced by the test. */
function fakeScheduler() {
  let clock = 1000;
  let queued: ((t: number) => void) | null = null;
  return {
    now: () => clock,
    advance: (ms: number) => (clock += ms),
    raf: (cb: (t: number) => void) => {
      queued = cb;
      return 1;
    },
    caf: () => {
      queued = null;
    },
    pump() {
      const cb = queued;
      queued = null;
      cb?.(clock);
    },
    pending: () => queued !== null,
  };
}

describe('createGameLoop', () => {
  it('ticks the session once per 60 Hz frame of elapsed time and renders every RAF', () => {
    const s = fakeScheduler();
    const session = fakeSession();
    const ticks: TickResult[] = [];
    let renders = 0;
    let sampled = 0;
    const loop = createGameLoop({
      session,
      input: { sample: () => ++sampled },
      onTick: (r) => ticks.push(r),
      onFrameRender: () => renders++,
      now: s.now, raf: s.raf, caf: s.caf,
    });
    loop.start();
    expect(loop.running()).toBe(true);

    s.advance(FRAME_MS * 2); // exactly two frames
    s.pump();
    expect(ticks.length).toBe(2);
    expect(renders).toBe(1);
    expect(session.inputs).toEqual([1, 2]);

    s.advance(FRAME_MS * 0.5); // half a frame: no tick, still a render
    s.pump();
    expect(ticks.length).toBe(2);
    expect(renders).toBe(2);

    s.advance(FRAME_MS * 0.5); // accumulator now reaches one frame
    s.pump();
    expect(ticks.length).toBe(3);
    expect(renders).toBe(3);

    loop.stop();
    expect(loop.running()).toBe(false);
    expect(s.pending()).toBe(false);
  });

  it('caps at 4 ticks per RAF and drops the backlog after a long stall', () => {
    const s = fakeScheduler();
    const session = fakeSession();
    let renders = 0;
    const loop = createGameLoop({
      session,
      input: { sample: () => 0 },
      onTick: () => {},
      onFrameRender: () => renders++,
      now: s.now, raf: s.raf, caf: s.caf,
    });
    loop.start();
    s.advance(2000); // tab was hidden for two seconds
    s.pump();
    expect(loop.counters().ticks).toBe(4);
    expect(renders).toBe(1);
    // The backlog is clamped: the next frame catches up at most one extra tick, not 100+.
    s.advance(FRAME_MS);
    s.pump();
    expect(loop.counters().ticks).toBeLessThanOrEqual(6);
    loop.stop();
  });

  it('still renders when ticks are stalled', () => {
    const s = fakeScheduler();
    const session = fakeSession(1); // every tick stalls
    let renders = 0;
    const loop = createGameLoop({
      session,
      input: { sample: () => 0 },
      onTick: () => {},
      onFrameRender: () => renders++,
      now: s.now, raf: s.raf, caf: s.caf,
    });
    loop.start();
    s.advance(FRAME_MS * 3);
    s.pump();
    expect(loop.counters().stalledTicks).toBe(3);
    expect(renders).toBe(1);
    loop.stop();
  });

  it('honours stop() called from within onTick', () => {
    const s = fakeScheduler();
    const session = fakeSession();
    let renders = 0;
    const loop = createGameLoop({
      session,
      input: { sample: () => 0 },
      onTick: () => loop.stop(),
      onFrameRender: () => renders++,
      now: s.now, raf: s.raf, caf: s.caf,
    });
    loop.start();
    s.advance(FRAME_MS * 4);
    s.pump();
    expect(loop.counters().ticks).toBe(1);
    expect(renders).toBe(0);
    expect(s.pending()).toBe(false);
  });
});

describe('loop + local session + bot (integration)', () => {
  it('drives a real bot fight through INTRO into FIGHTING and reports each event once', () => {
    const s = fakeScheduler();
    const seed = 0xc0ffee;
    const bot = createBot(seed, 0.5);
    const session = createLocalSession({
      sim,
      seed,
      localPlayer: 0,
      remoteInput: (view) => bot(view, 1),
    });
    const feed = createEventFeed();
    const seen: SimEvent[] = [];
    let last: TickResult | null = null;
    let frame = 0;
    const loop = createGameLoop({
      session,
      // jab every 30 frames once the round is on, guard high otherwise
      input: { sample: () => (++frame % 30 === 0 ? BIT.JAB : BIT.GUARD_HIGH) },
      onTick: (r) => {
        last = r;
        seen.push(...feed.push(r.events));
      },
      onFrameRender: () => {},
      now: s.now, raf: s.raf, caf: s.caf,
    });
    loop.start();
    const frames = INTRO_FRAMES + 300;
    for (let i = 0; i < frames; i++) {
      s.advance(FRAME_MS);
      s.pump();
    }
    expect(last).not.toBeNull();
    expect(last!.frame).toBe(frames);
    expect(last!.view.state).toBe('FIGHTING');
    expect(last!.view.round).toBe(1);
    expect(last!.view.clockSec).toBeLessThan(60);
    expect(seen.filter((e) => e.kind === 'BELL')).toHaveLength(1);
    expect(seen.some((e) => e.kind === 'HIT' || e.kind === 'BLOCK' || e.kind === 'MISS' || e.kind === 'EVADE')).toBe(true);
    expect(new Set(seen.map(eventKey)).size).toBe(seen.length);
    loop.stop();
    session.close();
  });
});

describe('createFrameScheduler', () => {
  it('falls back to a timer when there is no requestAnimationFrame (node) and cancels it', async () => {
    const sch = createFrameScheduler();
    let fired = 0;
    const id = sch.raf(() => fired++);
    expect(id).toBeGreaterThan(0);
    sch.caf(id);
    await new Promise((r) => setTimeout(r, FRAME_MS * 3));
    expect(fired).toBe(0);
    const id2 = sch.raf(() => fired++);
    await new Promise((r) => setTimeout(r, FRAME_MS * 3));
    expect(fired).toBe(1);
    sch.caf(id2);
  });

  it('runs the frame from the watchdog timer when requestAnimationFrame never fires', async () => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
    const prevR = g.requestAnimationFrame;
    const prevC = g.cancelAnimationFrame;
    let cancelled = 0;
    g.requestAnimationFrame = () => 123; // a compositor that never paints
    g.cancelAnimationFrame = () => cancelled++;
    try {
      const sch = createFrameScheduler();
      let fired = 0;
      sch.raf(() => fired++);
      await new Promise((r) => setTimeout(r, RAF_WATCHDOG_MS * 2));
      expect(fired).toBe(1);
      expect(cancelled).toBe(1); // the dead rAF handle was released
      sch.raf(() => fired++);
      await new Promise((r) => setTimeout(r, RAF_WATCHDOG_MS * 2));
      expect(fired).toBe(2);
    } finally {
      g.requestAnimationFrame = prevR;
      g.cancelAnimationFrame = prevC;
    }
  });
});

describe('createEventFeed', () => {
  const hit: SimEvent = { frame: 100, kind: 'HIT', who: 0, punch: 'JAB', damage: 40 };
  const block: SimEvent = { frame: 100, kind: 'BLOCK', who: 0, punch: 'JAB' };
  const bell: SimEvent = { frame: 0, kind: 'BELL', who: 0 };

  it('passes an event through once and drops rollback re-reports', () => {
    const feed = createEventFeed();
    expect(feed.push([hit, bell])).toEqual([hit, bell]);
    expect(feed.push([hit])).toEqual([]);
    expect(feed.push([{ ...hit, damage: 60 }])).toEqual([]); // same key, different payload
    expect(feed.push([bell, hit])).toEqual([]);
  });

  it('keys by frame, kind, who and punch', () => {
    const feed = createEventFeed();
    feed.push([hit]);
    expect(feed.push([block])).toEqual([block]); // different kind
    expect(feed.push([{ ...hit, who: 1 }])).toHaveLength(1); // different actor
    expect(feed.push([{ ...hit, punch: 'CROSS' }])).toHaveLength(1); // different punch
    expect(feed.push([{ ...hit, frame: 101 }])).toHaveLength(1); // different frame
    expect(eventKey(hit)).toBe('100|HIT|0|JAB');
    expect(eventKey(bell)).toBe('0|BELL|0|');
  });

  it('keeps recent keys across pruning and forgets ancient ones', () => {
    const feed = createEventFeed(240);
    feed.push([hit]);
    for (let f = 101; f <= 600; f++) feed.push([{ frame: f, kind: 'STEP', who: 1 }]);
    // Within the horizon (600 - 240 = 360): a late re-report of frame 500 is still dropped.
    expect(feed.push([{ frame: 500, kind: 'STEP', who: 1 }])).toEqual([]);
    // Far outside it: old keys were forgotten (bounded memory), which is acceptable.
    expect(feed.size()).toBeLessThan(300);
    feed.reset();
    expect(feed.size()).toBe(0);
    expect(feed.push([hit])).toEqual([hit]);
  });
});
