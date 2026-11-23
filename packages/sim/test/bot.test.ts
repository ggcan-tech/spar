import { describe, expect, it } from 'vitest';
import { BIT, PUNCH_MASK, type InputBits } from '@spar/protocol';
import { sim, createBot, MS, type SimState } from '../src';

function botMatch(seed: number, botSeed0: number, botSeed1: number, maxFrames = 20000): { state: SimState; frames: number; stats: { hits: number; blocks: number; evades: number; steps: number } } {
  const b0 = createBot(botSeed0);
  const b1 = createBot(botSeed1, 0.8);
  let s = sim.init(seed);
  const stats = { hits: 0, blocks: 0, evades: 0, steps: 0 };
  let frames = 0;
  while (s.state !== MS.OVER && frames < maxFrames) {
    const v = sim.view(s);
    const r = sim.step(s, [b0(v, 0), b1(v, 1)]);
    s = r.state;
    for (const e of r.events) {
      if (e.kind === 'HIT') stats.hits++;
      else if (e.kind === 'BLOCK') stats.blocks++;
      else if (e.kind === 'EVADE') stats.evades++;
      else if (e.kind === 'STEP') stats.steps++;
    }
    frames++;
  }
  return { state: s, frames, stats };
}

describe('createBot', () => {
  it('is deterministic: same seed → same 600-frame output sequence against the sim; it throws punches', () => {
    const outA: InputBits[] = [];
    const outB: InputBits[] = [];
    for (const out of [outA, outB]) {
      const bot = createBot(2024, 0.5);
      let s = sim.init(1);
      for (let i = 0; i < 600; i++) {
        const bits = bot(sim.view(s), 0);
        out.push(bits);
        s = sim.step(s, [bits, 0]).state;
      }
      expect(s.f[0].thrown).toBeGreaterThan(5);
      expect(s.f[0].landed).toBeGreaterThan(0);
    }
    expect(outA).toEqual(outB);
    expect(outA.some((b) => (b & PUNCH_MASK) !== 0)).toBe(true);
    // guard high most of the frames it fights, but not all
    const guardFrames = outA.filter((b) => (b & BIT.GUARD_HIGH) !== 0).length;
    expect(guardFrames).toBeGreaterThan(200);
    expect(guardFrames).toBeLessThan(600);
  });

  it('different seeds produce different behaviour', () => {
    const a = createBot(1);
    const b = createBot(2);
    let s = sim.init(1);
    const outA: InputBits[] = [];
    const outB: InputBits[] = [];
    for (let i = 0; i < 600; i++) {
      const v = sim.view(s);
      outA.push(a(v, 0));
      outB.push(b(v, 0));
      s = sim.step(s, [0, 0]).state;
    }
    expect(outA).not.toEqual(outB);
  });

  it('bot vs bot: a 3-round match completes (OVER) with a stable hash across two runs', () => {
    const a = botMatch(99, 1, 2);
    const b = botMatch(99, 1, 2);
    expect(a.state.state).toBe(MS.OVER);
    expect(b.state.state).toBe(MS.OVER);
    expect(sim.hash(a.state)).toBe(sim.hash(b.state));
    expect(a.frames).toBe(b.frames);
    const v = sim.view(a.state);
    expect(v.winner).not.toBeNull();
    expect(v.method).not.toBeNull();
    expect(v.fighters[0].thrown).toBeGreaterThan(20);
    expect(v.fighters[1].thrown).toBeGreaterThan(20);
    expect(a.stats.hits).toBeGreaterThan(10);
    expect(a.stats.steps).toBeGreaterThan(5);
    // a decision fills the scorecards; a stoppage happens inside a round
    if (v.method === 'DECISION') {
      expect(v.scores[0]).toHaveLength(3);
      expect(v.scores[1]).toHaveLength(3);
    } else {
      expect(['KO', 'TKO']).toContain(v.method);
    }
    // eslint-disable-next-line no-console
    console.log(`bot match: ${v.method} winner=${String(v.winner)} frames=${a.frames} hits=${a.stats.hits} blocks=${a.stats.blocks} evades=${a.stats.evades} scores=${JSON.stringify(v.scores)}`);
  });

  it('bot only reads MatchView (it works on a structurally-cloned view) and gets up after a knockdown', () => {
    const bot = createBot(5);
    let s = sim.init(2);
    // fast-forward into the fight, then knock the bot down with a state patch
    while (s.state !== MS.FIGHTING) s = sim.step(s, [0, bot(structuredClone(sim.view(s)), 1)]).state;
    s = { ...s, f: [s.f[0], { ...s.f[1], hp: 20 }] };
    let kd = false;
    for (let i = 0; i < 200 && !kd; i++) {
      const r = sim.step(s, [BIT.JAB, bot(structuredClone(sim.view(s)), 1)]);
      s = r.state;
      kd = r.events.some((e) => e.kind === 'KNOCKDOWN' && e.who === 1);
    }
    expect(kd).toBe(true);
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      const r = sim.step(s, [0, bot(structuredClone(sim.view(s)), 1)]);
      s = r.state;
      up = r.events.some((e) => e.kind === 'GET_UP' && e.who === 1);
    }
    expect(up).toBe(true);
    expect(s.state).toBe(MS.FIGHTING);
  });
});
