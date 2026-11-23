import type { InputBits, SimEvent, SimEventKind } from '@spar/protocol';
import { sim, MS, type SimState, type FighterState } from '../src';

export interface RunResult {
  state: SimState;
  events: SimEvent[];
}

/** Step `n` frames with constant inputs, collecting every event. */
export function run(s: SimState, n: number, in0: InputBits = 0, in1: InputBits = 0): RunResult {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, [in0, in1]);
    s = r.state;
    for (const e of r.events) events.push(e);
  }
  return { state: s, events };
}

/** Step with constant inputs until an event of `kind` appears (inclusive) or `max` frames pass. */
export function runUntil(
  s: SimState,
  kind: SimEventKind,
  in0: InputBits = 0,
  in1: InputBits = 0,
  max = 5000,
): RunResult & { found: SimEvent | null; frames: number } {
  const events: SimEvent[] = [];
  for (let i = 0; i < max; i++) {
    const r = sim.step(s, [in0, in1]);
    s = r.state;
    for (const e of r.events) events.push(e);
    const hit = r.events.find((e) => e.kind === kind);
    if (hit) return { state: s, events, found: hit, frames: i + 1 };
  }
  return { state: s, events, found: null, frames: max };
}

/** Fresh match advanced to the first FIGHTING frame (range 600, both IDLE). */
export function fighting(seed = 1): SimState {
  let s = sim.init(seed);
  while (s.state !== MS.FIGHTING) s = sim.step(s, [0, 0]).state;
  return s;
}

export function withRange(s: SimState, range: number): SimState {
  return { ...s, range };
}

export function withFighter(s: SimState, i: 0 | 1, patch: Partial<FighterState>): SimState {
  const f: [FighterState, FighterState] = [{ ...s.f[0] }, { ...s.f[1] }];
  f[i] = { ...f[i], ...patch };
  return { ...s, f };
}

export function kinds(events: SimEvent[]): SimEventKind[] {
  return events.map((e) => e.kind);
}

/** Deep-freeze a state (arrays + fighters) so any mutation throws in strict mode. */
export function deepFreeze(s: SimState): SimState {
  Object.freeze(s.scores[0]);
  Object.freeze(s.scores[1]);
  Object.freeze(s.scores);
  for (const f of s.f) {
    Object.freeze(f.dmgLog);
    Object.freeze(f);
  }
  Object.freeze(s.f);
  return Object.freeze(s);
}

/** xorshift32 for test-side input generation (independent of the bot's RNG). */
export function makeRng(seed: number): () => number {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}
