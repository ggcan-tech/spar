/**
 * @spar/netcode — P2P rollback netcode (GGPO-style) over an abstract `Transport`.
 *
 * Exports:
 *   createRollbackSession  — two-player rollback session over a Transport
 *   createLocalSession     — no networking; bot fights and tests
 *   createLoopbackPair     — in-memory simulated network driven by a virtual clock
 *   createDirectPair       — in-memory zero-latency pair (synchronous delivery)
 *   encodeInputPacket / decodeInputPacket — 44-byte binary input packet
 *
 * Frame conventions (shared by every number in this file):
 *   • "frame" is a *position*: the number of frames executed so far. `frame === 0` means nothing has
 *     run yet; after one tick `frame === 1`. Inputs and saved states are indexed by frame *index*
 *     (0-based): input[f] is consumed when executing frame index f, saved[f] is the state *before*
 *     executing frame index f (saved[0] = sim.init(seed)).
 *   • Local input handed to `tick()` while at position F is scheduled for frame index F + inputDelay.
 *     Frame indices 0..inputDelay-1 are pre-filled with 0 on both sides and sent like any other input.
 *   • confirmedFrame (position) = min(frame, lastContiguousRemoteFrameIndex + 1): every frame index
 *     below it was executed with real inputs from both players. `inputLog()` returns exactly those.
 */
import {
  FRAME_MS,
  IMPULSE_MASK,
  predictInput,
  type InputBits,
  type MatchView,
  type NetStats,
  type RollbackSessionLike,
  type SimEvent,
  type SimLike,
  type TickResult,
  type Transport,
} from '@spar/protocol';

// ───────────────────────── Constants ─────────────────────────
export const DEFAULT_INPUT_DELAY = 2;
export const DEFAULT_MAX_ROLLBACK = 8;
/** Redundant input frames carried by every packet. */
export const PACKET_INPUTS = 8;
export const PACKET_MAGIC = 0x5a;
export const PACKET_HEADER_BYTES = 28;
/** 28-byte header + 8 × uint16 inputs = 44 bytes (< 48). */
export const PACKET_MAX_BYTES = PACKET_HEADER_BYTES + PACKET_INPUTS * 2;

/** Time sync: average frame advantage over this many samples… */
const TIME_SYNC_WINDOW = 30;
/** …must exceed this (frames) to skip a tick, at most once per TIME_SYNC_WINDOW executed frames. */
const TIME_SYNC_THRESHOLD = 1.5;
/** EMA weight for round-trip-time samples. */
const RTT_ALPHA = 0.1;
/** RTT samples above this are considered garbage (clock wrap, reordering). */
const RTT_MAX_SAMPLE_MS = 10_000;

// ───────────────────────── Packet format ─────────────────────────
/**
 * Binary input packet, little-endian DataView. Layout (offset: field):
 *   0  u8   magic (0x5A)
 *   1  u8   bit7 = hasEcho, bits0-3 = input count (0..8)
 *   2  u16  echoDelay   ms between receiving the echoed packet and sending this one
 *   4  u32  frame       sender's frame position after its tick (for time sync)
 *   8  i32  ack         highest contiguous remote frame index the sender has real input for (-1 = none)
 *   12 u32  startFrame  frame index of inputs[0]
 *   16 u32  sendTime    sender clock, ms mod 2^32
 *   20 u32  echoTime    the most recent sendTime received from the peer (valid iff hasEcho)
 *   24 f32  advantage   sender's raw estimate of how many frames it runs ahead of the peer
 *   28 u16×count inputs consecutive local inputs starting at startFrame (16-bit InputBits)
 * RTT on receipt = now − echoTime − echoDelay.
 */
export interface InputPacket {
  frame: number;
  ack: number;
  startFrame: number;
  inputs: InputBits[];
  sendTime: number;
  hasEcho: boolean;
  echoTime: number;
  echoDelay: number;
  advantage: number;
}

export function encodeInputPacket(p: InputPacket): Uint8Array {
  const n = Math.min(p.inputs.length, PACKET_INPUTS);
  const buf = new ArrayBuffer(PACKET_HEADER_BYTES + n * 2);
  const dv = new DataView(buf);
  dv.setUint8(0, PACKET_MAGIC);
  dv.setUint8(1, (n & 0x0f) | (p.hasEcho ? 0x80 : 0));
  dv.setUint16(2, clamp(Math.round(p.echoDelay), 0, 0xffff), true);
  dv.setUint32(4, p.frame >>> 0, true);
  dv.setInt32(8, p.ack | 0, true);
  dv.setUint32(12, p.startFrame >>> 0, true);
  dv.setUint32(16, p.sendTime >>> 0, true);
  dv.setUint32(20, p.echoTime >>> 0, true);
  dv.setFloat32(24, Number.isFinite(p.advantage) ? p.advantage : 0, true);
  for (let i = 0; i < n; i++) dv.setUint16(PACKET_HEADER_BYTES + i * 2, p.inputs[i] & 0xffff, true);
  return new Uint8Array(buf);
}

/** Returns null for anything that is not a well-formed input packet. */
export function decodeInputPacket(data: Uint8Array): InputPacket | null {
  if (data.byteLength < PACKET_HEADER_BYTES) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint8(0) !== PACKET_MAGIC) return null;
  const b1 = dv.getUint8(1);
  const n = b1 & 0x0f;
  if (n > PACKET_INPUTS || data.byteLength < PACKET_HEADER_BYTES + n * 2) return null;
  const inputs: InputBits[] = new Array(n);
  for (let i = 0; i < n; i++) inputs[i] = dv.getUint16(PACKET_HEADER_BYTES + i * 2, true);
  const advantage = dv.getFloat32(24, true);
  return {
    hasEcho: (b1 & 0x80) !== 0,
    echoDelay: dv.getUint16(2, true),
    frame: dv.getUint32(4, true),
    ack: dv.getInt32(8, true),
    startFrame: dv.getUint32(12, true),
    sendTime: dv.getUint32(16, true),
    echoTime: dv.getUint32(20, true),
    advantage: Number.isFinite(advantage) ? advantage : 0,
    inputs,
  };
}

// ───────────────────────── Rollback session ─────────────────────────
export interface RollbackSessionOptions<S> {
  sim: SimLike<S>;
  transport: Transport;
  localPlayer: 0 | 1;
  seed: number;
  /** Local input is scheduled inputDelay frames ahead. Default 2. */
  inputDelay?: number;
  /** Max predicted (unconfirmed) frames before stalling. Default 8. */
  maxRollback?: number;
  /** Millisecond clock. Default performance.now(). Tests pass a virtual clock. */
  now?: () => number;
}

export interface ConfirmedState {
  /** Confirmed frame position (number of frames executed with real inputs from both players). */
  frame: number;
  hash: number;
  view: MatchView;
}

export interface RollbackSession extends RollbackSessionLike {
  /** Current (predicted) frame position. */
  readonly frame: number;
  /** Ticks skipped by time sync so far (a stalled tick that was NOT a time-sync skip was a remote stall). */
  readonly timeSyncSkips: number;
  /** State at the confirmed frame — what `inputLog()` replays to. Use its hash for result submission. */
  confirmed(): ConfirmedState;
  stats(): NetStats;
}

const zeroStats = (): NetStats => ({ rttMs: 0, rollbackFrames: 0, rollbacksTotal: 0, framesAhead: 0, confirmedFrame: 0 });

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/**
 * GGPO-style rollback session.
 *
 * Every tick: schedule local input at frame+inputDelay, execute one frame (remote input real if known,
 * else `predictInput(last known remote input)`), then send one packet carrying up to 8 local input
 * frames, the ack of the remote's inputs and timing (sendTime / echo) for RTT.
 *
 * On receipt, a real remote input that differs from the one used for an already-executed frame marks a
 * rollback; the next `tick()` (or `confirmed()`) restores the saved state of that frame and re-simulates.
 * Saved states live in a ring of maxRollback + inputDelay + 2 entries, one per frame.
 *
 * Stalls (`stalled: true`, frame does not advance, input's impulse bits are kept and merged into the next
 * accepted input so a punch thrown during a stall is not lost):
 *   • remote stall: executing this frame would leave more than maxRollback frames unconfirmed;
 *   • time sync: local is > 1.5 frames ahead of the peer on average over the last 30 samples —
 *     skip one tick, at most once every 30 executed frames.
 *
 * EVENT RE-EMISSION RULE (rollback-safe FX):
 *   • A frame's events are emitted the first time that frame is executed, whether it ran with real
 *     (confirmed) or predicted remote input.
 *   • When a rollback re-executes a frame, an event of that frame is emitted again ONLY if an identical
 *     event (same frame/kind/who/punch/body/damage/detail) was not already emitted for that frame —
 *     i.e. only corrected or new outcomes reach the caller. Events that vanish on re-simulation cannot be
 *     recalled; the renderer must tolerate the occasional mispredicted FX.
 *   Consequences: newly confirmed frames whose prediction was right contribute nothing; newly confirmed
 *   frames whose outcome changed contribute their corrected events; predicted frames beyond the previously
 *   reported frame contribute their events. A given event is never delivered twice.
 */
export function createRollbackSession<S>(opts: RollbackSessionOptions<S>): RollbackSession {
  const { sim, transport, localPlayer, seed } = opts;
  const inputDelay = Math.max(0, opts.inputDelay ?? DEFAULT_INPUT_DELAY);
  const maxRollback = Math.max(1, opts.maxRollback ?? DEFAULT_MAX_ROLLBACK);
  const now = opts.now ?? defaultNow;
  const RING = maxRollback + inputDelay + 2;

  // ── simulation state ──
  let state: S = sim.init(seed);
  let frame = 0; // position: frames executed so far
  const localLog: InputBits[] = []; // real local inputs, contiguous from index 0
  for (let f = 0; f < inputDelay; f++) localLog.push(0);
  const remoteLog: (InputBits | undefined)[] = []; // real remote inputs (may have holes)
  let remoteConfirmed = -1; // highest index such that remoteLog[0..remoteConfirmed] are all known
  const usedRemote: InputBits[] = []; // remote input used the last time index f was executed
  const saved: (S | undefined)[] = new Array(RING);
  const savedFrame: number[] = new Array(RING).fill(-1);
  saved[0] = state;
  savedFrame[0] = 0;

  // ── events ──
  const emitted: (string[] | undefined)[] = []; // per frame index: keys of events already emitted
  let pendingEvents: SimEvent[] = [];

  // ── rollback bookkeeping ──
  let rollbackFrom = Infinity; // lowest frame index that must be re-simulated
  let rollbackDepthPending = 0;
  let rollbacksTotal = 0;
  let pendingImpulse: InputBits = 0;

  // ── network state ──
  let closed = false;
  let gotPacket = false;
  let remoteAck = -1; // peer's contiguous confirmed index of OUR inputs
  let remoteFrame = 0; // peer's reported frame position
  let remoteFrameAt = 0; // when we received it
  let remoteAdvantage = 0; // peer's raw "frames ahead" estimate
  let hasEcho = false;
  let echoTime = 0;
  let echoAt = 0;
  let rtt = 0;
  let rttSamples = 0;
  let lastRawAhead = 0;
  const aheadWindow: number[] = [];
  let ticksSinceSkip = TIME_SYNC_WINDOW;
  let timeSyncSkips = 0;
  let resendCursor = 0;

  const confirmedPos = (): number => Math.min(frame, remoteConfirmed + 1);

  function remoteInputFor(f: number): InputBits {
    const real = remoteLog[f];
    if (real !== undefined) return real;
    // predict from the last known real remote input before f (holes are rare and short)
    let g = f - 1;
    while (g >= 0 && remoteLog[g] === undefined) g--;
    return predictInput(g >= 0 ? (remoteLog[g] as InputBits) : 0);
  }

  function eventKey(e: SimEvent): string {
    return `${e.kind}|${e.who}|${e.punch ?? ''}|${e.body ? 1 : 0}|${e.damage ?? ''}|${e.detail ?? ''}`;
  }

  /** Execute frame index f from the current `state` (which must be the state before f). */
  function execute(f: number): void {
    const remote = remoteInputFor(f);
    const local = localLog[f];
    const inputs: [InputBits, InputBits] = localPlayer === 0 ? [local, remote] : [remote, local];
    const r = sim.step(state, inputs);
    state = r.state;
    usedRemote[f] = remote;
    const slot = (f + 1) % RING;
    saved[slot] = state;
    savedFrame[slot] = f + 1;
    // event re-emission rule (see doc comment above)
    const prev = emitted[f];
    if (prev === undefined) {
      emitted[f] = r.events.map(eventKey);
      for (const e of r.events) pendingEvents.push(e);
    } else {
      for (const e of r.events) {
        const k = eventKey(e);
        if (!prev.includes(k)) {
          prev.push(k);
          pendingEvents.push(e);
        }
      }
    }
  }

  function applyPendingRollback(): void {
    if (rollbackFrom >= frame) {
      rollbackFrom = Infinity;
      return;
    }
    const from = rollbackFrom;
    rollbackFrom = Infinity;
    const slot = from % RING;
    if (savedFrame[slot] !== from || saved[slot] === undefined) {
      throw new Error(`netcode: cannot roll back to frame ${from} (ring holds ${savedFrame.join(',')})`);
    }
    state = saved[slot] as S;
    const depth = frame - from;
    for (let f = from; f < frame; f++) execute(f);
    rollbackDepthPending = Math.max(rollbackDepthPending, depth);
    rollbacksTotal++;
  }

  function onPacket(data: Uint8Array): void {
    if (closed) return;
    const pkt = decodeInputPacket(data);
    if (!pkt) return;
    const t = now();
    for (let i = 0; i < pkt.inputs.length; i++) {
      const f = pkt.startFrame + i;
      if (remoteLog[f] !== undefined) continue;
      const input = pkt.inputs[i];
      remoteLog[f] = input;
      if (f < frame && usedRemote[f] !== input && f < rollbackFrom) rollbackFrom = f;
    }
    while (remoteLog[remoteConfirmed + 1] !== undefined) remoteConfirmed++;
    if (pkt.ack > remoteAck) remoteAck = pkt.ack;
    if (!gotPacket || pkt.frame >= remoteFrame) {
      remoteFrame = pkt.frame;
      remoteFrameAt = t;
      remoteAdvantage = pkt.advantage;
    }
    if (!hasEcho || ((pkt.sendTime - echoTime) | 0) > 0) {
      hasEcho = true;
      echoTime = pkt.sendTime;
      echoAt = t;
    }
    if (pkt.hasEcho) {
      const sample = (((t >>> 0) - pkt.echoTime) >>> 0) - pkt.echoDelay;
      if (sample >= 0 && sample < RTT_MAX_SAMPLE_MS) {
        rtt = rttSamples === 0 ? sample : rtt + (sample - rtt) * RTT_ALPHA;
        rttSamples++;
      }
    }
    gotPacket = true;
  }
  transport.onMessage(onPacket);

  /** Which 8-frame window of local inputs to send: the latest one, unless the peer lags behind it. */
  function windowStart(lastIndex: number): number {
    const latestStart = Math.max(0, lastIndex - (PACKET_INPUTS - 1));
    const needStart = remoteAck + 1; // first frame the peer lacks
    if (needStart >= latestStart) return latestStart;
    // Peer lags by more than one window: walk the missing range in 8-frame chunks, then the latest
    // window, then restart at the ack — so a long silence recovers at 8 frames per packet.
    if (resendCursor < needStart) resendCursor = needStart;
    if (resendCursor >= latestStart) {
      resendCursor = needStart;
      return latestStart;
    }
    const start = resendCursor;
    resendCursor += PACKET_INPUTS;
    return start;
  }

  function sendPacket(): void {
    if (closed) return;
    const last = localLog.length - 1;
    const start = windowStart(last);
    const count = Math.min(PACKET_INPUTS, last - start + 1);
    const t = now();
    transport.send(
      encodeInputPacket({
        frame,
        ack: remoteConfirmed,
        startFrame: start,
        inputs: localLog.slice(start, start + count),
        sendTime: t >>> 0,
        hasEcho,
        echoTime,
        echoDelay: hasEcho ? Math.max(0, t - echoAt) : 0,
        advantage: lastRawAhead,
      }),
    );
  }

  function timeSyncSample(): void {
    if (!gotPacket) return;
    const t = now();
    const estRemote = remoteFrame + (t - remoteFrameAt + rtt / 2) / FRAME_MS;
    lastRawAhead = frame - estRemote;
    // symmetric estimate: both sides' raw numbers carry the same latency bias, so the difference halves it
    aheadWindow.push((lastRawAhead - remoteAdvantage) / 2);
    if (aheadWindow.length > TIME_SYNC_WINDOW) aheadWindow.shift();
  }

  function shouldSkipForTimeSync(): boolean {
    if (ticksSinceSkip < TIME_SYNC_WINDOW || aheadWindow.length < TIME_SYNC_WINDOW) return false;
    let sum = 0;
    for (const v of aheadWindow) sum += v;
    if (sum / aheadWindow.length > TIME_SYNC_THRESHOLD) {
      aheadWindow.length = 0;
      ticksSinceSkip = 0;
      timeSyncSkips++;
      return true;
    }
    return false;
  }

  function makeStats(): NetStats {
    const c = confirmedPos();
    const s: NetStats = {
      rttMs: rtt,
      rollbackFrames: rollbackDepthPending,
      rollbacksTotal,
      framesAhead: frame - c,
      confirmedFrame: c,
    };
    rollbackDepthPending = 0;
    return s;
  }

  function result(stalled: boolean): TickResult {
    const events = pendingEvents;
    pendingEvents = [];
    return { frame, view: sim.view(state), events, stalled, stats: makeStats() };
  }

  function tick(localInput: InputBits): TickResult {
    applyPendingRollback();
    const remoteStall = frame - remoteConfirmed > maxRollback;
    if (remoteStall || shouldSkipForTimeSync()) {
      pendingImpulse |= localInput & IMPULSE_MASK;
      sendPacket();
      return result(true);
    }
    localLog[frame + inputDelay] = (localInput | pendingImpulse) & 0xffff;
    pendingImpulse = 0;
    execute(frame);
    frame++;
    ticksSinceSkip++;
    timeSyncSample();
    sendPacket();
    return result(false);
  }

  function inputLog(): [InputBits[], InputBits[]] {
    const n = confirmedPos();
    const local = localLog.slice(0, n);
    const remote = remoteLog.slice(0, n) as InputBits[];
    return localPlayer === 0 ? [local, remote] : [remote, local];
  }

  function confirmed(): ConfirmedState {
    applyPendingRollback();
    const n = confirmedPos();
    let st: S;
    if (n === frame) st = state;
    else {
      const slot = n % RING;
      if (savedFrame[slot] !== n || saved[slot] === undefined) {
        throw new Error(`netcode: confirmed state for frame ${n} is not in the ring`);
      }
      st = saved[slot] as S;
    }
    return { frame: n, hash: sim.hash(st), view: sim.view(st) };
  }

  return {
    localPlayer,
    get frame() {
      return frame;
    },
    get timeSyncSkips() {
      return timeSyncSkips;
    },
    tick,
    inputLog,
    confirmed,
    stats: makeStats,
    close: () => {
      closed = true;
    },
  };
}

// ───────────────────────── Local session ─────────────────────────
export interface LocalSessionOptions<S> {
  sim: SimLike<S>;
  seed: number;
  localPlayer: 0 | 1;
  /** Produces the other player's input for the frame about to be executed (bot policy, script…). */
  remoteInput: (view: MatchView, frame: number) => InputBits;
}

/**
 * No networking, no input delay, no prediction: each tick executes exactly one frame with the local
 * input and `remoteInput(view, frame)`. Same TickResult shape as the rollback session (stats are zeros,
 * never stalls). Used for bot fights and tests.
 */
export function createLocalSession<S>(opts: LocalSessionOptions<S>): RollbackSessionLike {
  const { sim, seed, localPlayer, remoteInput } = opts;
  let state = sim.init(seed);
  let frame = 0;
  const logs: [InputBits[], InputBits[]] = [[], []];
  return {
    localPlayer,
    tick(localInput: InputBits): TickResult {
      const remote = remoteInput(sim.view(state), frame) & 0xffff;
      const local = localInput & 0xffff;
      const inputs: [InputBits, InputBits] = localPlayer === 0 ? [local, remote] : [remote, local];
      const r = sim.step(state, inputs);
      state = r.state;
      logs[0].push(inputs[0]);
      logs[1].push(inputs[1]);
      frame++;
      const stats = zeroStats();
      stats.confirmedFrame = frame;
      return { frame, view: sim.view(state), events: r.events, stalled: false, stats };
    },
    inputLog: () => [logs[0].slice(), logs[1].slice()],
    close: () => {},
  };
}

// ───────────────────────── Simulated transports ─────────────────────────
export interface VirtualClock {
  now(): number;
  /** Advance the clock by ms, delivering every packet due on the way (in send-time order). */
  advance(ms: number): void;
}

export interface TransportPair {
  a: Transport;
  b: Transport;
  clock: VirtualClock;
}

export interface LoopbackOptions {
  latencyMs?: number;
  jitterMs?: number;
  /** Packet loss probability 0..1. */
  loss?: number;
  seed?: number;
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Endpoint {
  transport: Transport;
  listeners: ((data: Uint8Array) => void)[];
}

function makeEndpoint(send: (data: Uint8Array) => void): Endpoint {
  const listeners: ((data: Uint8Array) => void)[] = [];
  return {
    listeners,
    transport: {
      send,
      onMessage(cb) {
        listeners.push(cb);
      },
    },
  };
}

function deliver(ep: Endpoint, data: Uint8Array): void {
  for (const cb of ep.listeners) cb(data);
}

/**
 * In-memory two-endpoint network with latency, jitter and loss. Nothing is delivered until
 * `clock.advance(ms)` reaches a packet's due time, so tests are fully deterministic (seeded).
 */
export function createLoopbackPair(opts: LoopbackOptions = {}): TransportPair {
  const latency = Math.max(0, opts.latencyMs ?? 0);
  const jitter = Math.max(0, opts.jitterMs ?? 0);
  const loss = clamp(opts.loss ?? 0, 0, 1);
  const rand = mulberry32(opts.seed ?? 1);
  let t = 0;
  let seq = 0;
  interface Pending { at: number; seq: number; to: Endpoint; data: Uint8Array }
  const pending: Pending[] = [];

  const endpoints: Endpoint[] = [];
  const makeSend = (toIndex: 0 | 1) => (data: Uint8Array) => {
    if (loss > 0 && rand() < loss) return;
    const j = jitter > 0 ? (rand() * 2 - 1) * jitter : 0;
    pending.push({ at: t + Math.max(0, latency + j), seq: seq++, to: endpoints[toIndex], data: new Uint8Array(data) });
  };
  endpoints.push(makeEndpoint(makeSend(1)), makeEndpoint(makeSend(0)));

  const clock: VirtualClock = {
    now: () => t,
    advance(ms: number) {
      const target = t + Math.max(0, ms);
      for (;;) {
        let best = -1;
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i];
          if (p.at > target) continue;
          if (best < 0 || p.at < pending[best].at || (p.at === pending[best].at && p.seq < pending[best].seq)) best = i;
        }
        if (best < 0) break;
        const p = pending[best];
        pending.splice(best, 1);
        if (p.at > t) t = p.at;
        deliver(p.to, p.data);
      }
      t = target;
    },
  };
  return { a: endpoints[0].transport, b: endpoints[1].transport, clock };
}

/** Zero-latency pair: `send` delivers synchronously to the other side. The clock is a plain counter. */
export function createDirectPair(): TransportPair {
  const endpoints: Endpoint[] = [];
  endpoints.push(
    makeEndpoint((data) => deliver(endpoints[1], new Uint8Array(data))),
    makeEndpoint((data) => deliver(endpoints[0], new Uint8Array(data))),
  );
  let t = 0;
  return {
    a: endpoints[0].transport,
    b: endpoints[1].transport,
    clock: {
      now: () => t,
      advance(ms: number) {
        t += Math.max(0, ms);
      },
    },
  };
}

// ───────────────────────── util ─────────────────────────
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
