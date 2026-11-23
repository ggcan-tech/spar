/**
 * Tiny deterministic sim for netcode tests (no dependency on @spar/sim).
 * Two counters, one per player, mixed with that player's input each frame; FNV-1a hash over the
 * integer fields; a minimal MatchView. Events:
 *   BELL  who 0  every 10th frame (depends on frame only)
 *   HIT   who p  when player p's input has JAB   (impulse bit → never predicted)
 *   BLOCK who p  when player p's input has GUARD_HIGH (held bit → predicted)
 */
import { BIT, HELD_MASK, IMPULSE_MASK, type InputBits, type MatchView, type SimEvent, type SimLike, type FighterView } from '@spar/protocol';

export interface DState {
  frame: number;
  a: number;
  b: number;
  last: [InputBits, InputBits];
}

function fnv1a(words: number[]): number {
  let h = 0x811c9dc5;
  for (const w of words) {
    for (let i = 0; i < 4; i++) {
      h ^= (w >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function fighter(input: InputBits): FighterView {
  return {
    hp: 1000,
    stamina: 1000,
    guardHigh: (input & BIT.GUARD_HIGH) !== 0,
    head: 'CENTER',
    phase: 'IDLE',
    punch: null,
    body: false,
    phaseFrames: 0,
    counterWindow: 0,
    knockdowns: 0,
    stance: 'orthodox',
    landed: 0,
    thrown: input, // exposes the input used for this fighter on the last executed frame
  };
}

export const dummySim: SimLike<DState> = {
  init(seed) {
    return { frame: 0, a: seed >>> 0, b: Math.imul(seed, 0x9e3779b1) >>> 0, last: [0, 0] };
  },
  step(s, [i0, i1]) {
    const a = (Math.imul(s.a, 1103515245) + i0 + 12345) >>> 0;
    const b = (Math.imul(s.b, 1103515245) + i1 + 12345) >>> 0;
    const events: SimEvent[] = [];
    const f = s.frame;
    if (f % 10 === 0) events.push({ frame: f, kind: 'BELL', who: 0 });
    if (i0 & BIT.JAB) events.push({ frame: f, kind: 'HIT', who: 0, punch: 'JAB', damage: 40 });
    if (i1 & BIT.JAB) events.push({ frame: f, kind: 'HIT', who: 1, punch: 'JAB', damage: 40 });
    if (i0 & BIT.GUARD_HIGH) events.push({ frame: f, kind: 'BLOCK', who: 0 });
    if (i1 & BIT.GUARD_HIGH) events.push({ frame: f, kind: 'BLOCK', who: 1 });
    return { state: { frame: f + 1, a, b, last: [i0, i1] }, events };
  },
  hash(s) {
    return fnv1a([s.frame, s.a, s.b]);
  },
  view(s): MatchView {
    return {
      frame: s.frame,
      state: 'FIGHTING',
      round: 1,
      roundFrame: s.frame,
      clockSec: 60,
      range: 600,
      fighters: [fighter(s.last[0]), fighter(s.last[1])],
      scores: [[], []],
      winner: null,
      method: null,
    };
  },
};

/** Run the sim directly for `frames` frames with the given per-player logs. */
export function directRun(seed: number, log0: InputBits[], log1: InputBits[], frames: number) {
  let s = dummySim.init(seed);
  const events: SimEvent[] = [];
  for (let f = 0; f < frames; f++) {
    const r = dummySim.step(s, [log0[f] ?? 0, log1[f] ?? 0]);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, hash: dummySim.hash(s), events };
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic input script for one player, indexed by the tick frame: held bits change every
 * ~8-20 frames, impulse bits fire on ~12% of frames (so predictions are wrong often).
 */
export function makeScript(seed: number): (frame: number) => InputBits {
  const r = rng(seed);
  const held: InputBits[] = [];
  let cur = 0;
  let until = 0;
  const cache: InputBits[] = [];
  return (frame: number) => {
    while (cache.length <= frame) {
      const f = cache.length;
      if (f >= until) {
        cur = Math.floor(r() * 0xffff) & HELD_MASK;
        until = f + 8 + Math.floor(r() * 12);
      }
      held[f] = cur;
      const impulse = r() < 0.12 ? Math.floor(r() * 0xffff) & IMPULSE_MASK : 0;
      cache.push((cur | impulse) & 0xffff);
    }
    return cache[frame];
  };
}

/** The per-frame input log a session with `delay` produces from a tick script. */
export function expectedLog(script: (frame: number) => InputBits, delay: number, frames: number): InputBits[] {
  const out: InputBits[] = [];
  for (let f = 0; f < frames; f++) out.push(f < delay ? 0 : script(f - delay));
  return out;
}

export function countKind(events: SimEvent[], kind: SimEvent['kind'], who?: 0 | 1, maxFrame = Infinity): number {
  let n = 0;
  for (const e of events) if (e.kind === kind && (who === undefined || e.who === who) && e.frame < maxFrame) n++;
  return n;
}
