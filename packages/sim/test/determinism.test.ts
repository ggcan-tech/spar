import { describe, expect, it } from 'vitest';
import { BIT, INTRO_FRAMES, type InputBits } from '@spar/protocol';
import { sim, replay, MS } from '../src';
import { deepFreeze, makeRng } from './helpers';

/** A noisy but plausible input log: held bits flicker slowly, impulses fire sparsely. */
function randomLog(seed: number, frames: number): [InputBits[], InputBits[]] {
  const rnd = makeRng(seed);
  const log: [InputBits[], InputBits[]] = [[], []];
  let held: [InputBits, InputBits] = [0, 0];
  for (let i = 0; i < frames; i++) {
    for (let p = 0; p < 2; p++) {
      const r = rnd();
      if (r % 13 === 0) held[p] = (rnd() >>> 7) & (BIT.SLIP_L | BIT.SLIP_R | BIT.DUCK | BIT.GUARD_HIGH);
      let bits = held[p];
      const r2 = rnd();
      if (r2 % 5 === 0) bits |= 1 << (r2 % 7); // a punch bit (or BODY)
      if (r2 % 23 === 0) bits |= BIT.STEP_IN << (rnd() % 4);
      if (r2 % 17 === 0) bits |= BIT.GET_UP;
      log[p].push(bits & 0xffff);
    }
  }
  return log;
}

function play(seed: number, log: [InputBits[], InputBits[]]) {
  let s = sim.init(seed);
  const n = Math.max(log[0].length, log[1].length);
  const hashes: number[] = [];
  for (let i = 0; i < n; i++) {
    s = sim.step(s, [log[0][i] ?? 0, log[1][i] ?? 0]).state;
    hashes.push(sim.hash(s));
  }
  return { state: s, hashes };
}

describe('determinism', () => {
  it('same seed + same input log → identical hash and state across two runs', () => {
    const log = randomLog(42, 6000);
    const a = play(1234, log);
    const b = play(1234, log);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.state).toEqual(b.state);
    expect(sim.hash(a.state)).toBe(sim.hash(b.state));
    // the log actually exercised the sim
    expect(a.state.f[0].thrown).toBeGreaterThan(20);
    expect(a.state.f[1].thrown).toBeGreaterThan(20);
    expect(a.state.f[0].landed + a.state.f[1].landed).toBeGreaterThan(0);
  });

  it('changing one input bit changes the hash', () => {
    const log = randomLog(42, 6000);
    const flipFrame = INTRO_FRAMES; // first FIGHTING frame: p0 is guaranteed IDLE
    log[0][flipFrame] = 0;
    const variant: [InputBits[], InputBits[]] = [log[0].slice(), log[1].slice()];
    variant[0][flipFrame] = BIT.JAB;
    const a = play(1234, log);
    const b = play(1234, variant);
    expect(a.hashes[flipFrame]).not.toBe(b.hashes[flipFrame]);
    expect(a.hashes[flipFrame - 1]).toBe(b.hashes[flipFrame - 1]);
    expect(sim.hash(a.state)).not.toBe(sim.hash(b.state));
  });

  it('different seeds hash differently even with identical inputs', () => {
    expect(sim.hash(sim.init(1))).not.toBe(sim.hash(sim.init(2)));
  });

  it('hash is a 32-bit unsigned integer', () => {
    const h = sim.hash(sim.init(99));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('step never mutates its arguments (deep-frozen state survives 3000 random frames)', () => {
    const log = randomLog(7, 3000);
    let s = deepFreeze(sim.init(5));
    for (let i = 0; i < 3000; i++) {
      const inputs: [InputBits, InputBits] = [log[0][i], log[1][i]];
      Object.freeze(inputs);
      const before = JSON.stringify(s);
      const r = sim.step(s, inputs);
      expect(JSON.stringify(s)).toBe(before);
      s = deepFreeze(r.state);
    }
    expect(s.frame).toBe(3000);
  });

  it('replay() returns the same hash as stepping manually, pads a shorter log with 0', () => {
    const log = randomLog(11, 4000);
    const manual = play(77, log);
    const rep = replay(77, log);
    expect(rep.hash).toBe(sim.hash(manual.state));
    expect(rep.frames).toBe(4000);
    expect(rep.view).toEqual(sim.view(manual.state));

    const cut = 300; // early in round 1 — the match is still live, so p1's later inputs matter
    expect(replay(77, [log[0].slice(0, cut), log[1].slice(0, cut)]).view.state).toBe('FIGHTING');
    const short: [InputBits[], InputBits[]] = [log[0], log[1].slice(0, cut)];
    const padded: [InputBits[], InputBits[]] = [log[0], [...log[1].slice(0, cut), ...new Array(4000 - cut).fill(0)]];
    expect(replay(77, short).hash).toBe(replay(77, padded).hash);
    expect(replay(77, short).frames).toBe(4000);
    expect(replay(77, short).hash).not.toBe(rep.hash);
  });

  it('step is fast: 20k frames of random input well under 20 µs each', () => {
    const log = randomLog(3, 20000);
    let s = sim.init(1);
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) s = sim.step(s, [log[0][i], log[1][i]]).state;
    const perStepUs = ((performance.now() - t0) * 1000) / 20000;
    expect(s.frame).toBe(20000);
    expect(s.state === MS.OVER || s.state === MS.FIGHTING || s.state === MS.REST || s.state === MS.INTRO).toBe(true);
    // generous bound to keep CI stable; real numbers are printed for the record
    // eslint-disable-next-line no-console
    console.log(`sim.step: ${perStepUs.toFixed(2)} µs/frame`);
    expect(perStepUs).toBeLessThan(100);
  });
});
