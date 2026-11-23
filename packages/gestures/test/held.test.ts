import { describe, expect, it } from 'vitest';
import { BIT, LM } from '@spar/protocol';
import { synth } from '../src/index';
import { FPS, SIGMA, noisyCalibration, run, count } from './helpers';

const cal = noisyCalibration();
const g = (ms: number) => synth.guard(ms, { fps: FPS });

describe('head: slip / duck held bits with hysteresis', () => {
  for (const dir of ['L', 'R'] as const) {
    it(`SLIP_${dir}: bit while displaced, clears after return, HEAD_CENTER on return`, () => {
      const bit = dir === 'L' ? BIT.SLIP_L : BIT.SLIP_R;
      const other = dir === 'L' ? BIT.SLIP_R : BIT.SLIP_L;
      const seq = synth.sequenceWithStarts([g(500), synth.slip(dir, { fps: FPS }), g(600)], FPS);
      const { events, held, frames } = run(synth.withNoise(seq.frames, SIGMA, 31), cal);
      const at = (t: number) => held[frames.findIndex((f) => f.t >= t)];
      expect(at(seq.starts[1] + 200 + 150) & bit).toBe(bit);         // mid-hold
      expect(at(seq.starts[1] + 200 + 150) & other).toBe(0);
      expect(held[held.length - 1] & (BIT.SLIP_L | BIT.SLIP_R)).toBe(0);
      expect(count(events, `SLIP_${dir}`)).toBe(1);
      expect(count(events, 'HEAD_CENTER')).toBe(1);
      expect(count(events, dir === 'L' ? 'SLIP_R' : 'SLIP_L')).toBe(0);
      const enter = events.find((e) => e.type === `SLIP_${dir}`)!;
      const exit = events.find((e) => e.type === 'HEAD_CENTER')!;
      expect(enter.t).toBeGreaterThan(seq.starts[1]);
      expect(exit.t).toBeGreaterThan(seq.starts[1] + 500);
    });
  }

  it('hysteresis: enters above 0.35, stays set at 0.28, clears below 0.20', () => {
    const fig = synth.FIGURE;
    const frames = synth.animate(1300, (t) => {
      const p = synth.neutralPose(fig);
      const x = t < 200 ? 0.45 * synth.ease(t / 200) : t < 400 ? 0.45 : t < 600 ? 0.45 - 0.17 * synth.ease((t - 400) / 200) : t < 900 ? 0.28 : 0.28 * (1 - synth.ease((t - 900) / 200));
      p.head = { x, y: 0, z: 0 };
      return p;
    }, { fps: FPS });
    const { held, frames: fr } = run(frames, cal);
    const at = (t: number) => held[fr.findIndex((f) => f.t >= t)];
    expect(at(0) & BIT.SLIP_L).toBe(0);
    expect(at(350) & BIT.SLIP_L).toBe(BIT.SLIP_L);
    expect(at(850) & BIT.SLIP_L).toBe(BIT.SLIP_L);   // 0.28 is inside the hysteresis band → still slipping
    expect(held[held.length - 1] & BIT.SLIP_L).toBe(0);
    // a small displacement (0.28) from center never enters
    const small = synth.slip('L', { fps: FPS, amount: 0.28 });
    expect(run(synth.sequence([g(300), small, g(300)], FPS), cal).events.filter((e) => e.type === 'SLIP_L')).toHaveLength(0);
  });

  it('DUCK: bit while dropped with bent knees, HEAD_CENTER on return', () => {
    const seq = synth.sequenceWithStarts([g(500), synth.duck({ fps: FPS }), g(600)], FPS);
    const { events, held, frames, engine } = run(synth.withNoise(seq.frames, SIGMA, 32), cal);
    const at = (t: number) => held[frames.findIndex((f) => f.t >= t)];
    expect(at(seq.starts[1] + 220 + 150) & BIT.DUCK).toBe(BIT.DUCK);
    expect(held[held.length - 1] & BIT.DUCK).toBe(0);
    expect(count(events, 'DUCK')).toBe(1);
    expect(count(events, 'HEAD_CENTER')).toBe(1);
    expect(count(events, 'SLIP_L') + count(events, 'SLIP_R')).toBe(0);
    expect(engine.debug().head.kneeAngle).toBeGreaterThan(160); // standing again
  });

  it('DUCK needs bent knees when knees are visible; works from the drop alone when they are not', () => {
    // head tuck only (nose drops 0.45 units, legs straight) → not a duck
    const fig = synth.FIGURE;
    const tuck = synth.animate(900, (t) => {
      const p = synth.neutralPose(fig);
      const s = t < 250 ? synth.ease(t / 250) : t < 650 ? 1 : 1 - synth.ease((t - 650) / 250);
      p.head = { x: 0, y: 0.45 * s, z: 0 };
      return p;
    }, { fps: FPS });
    expect(count(run(synth.sequence([g(300), tuck, g(300)], FPS), cal).events, 'DUCK')).toBe(0);
    // full duck with legs out of frame → detected from the nose drop
    const legless = synth.withVisibility(synth.sequence([g(500), synth.duck({ fps: FPS }), g(500)], FPS), [LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE], 0.2);
    expect(count(run(legless, cal).events, 'DUCK')).toBe(1);
  });
});

describe('guard high/low with debounce', () => {
  const fig = synth.FIGURE;
  const handsDown = (ms: number) => synth.animate(ms, () => {
    const p = synth.neutralPose(fig);
    p.wrist.L = { x: 0.55, y: 0.6, z: -0.5 };
    p.wrist.R = { x: -0.55, y: 0.6, z: -0.5 };
    return p;
  }, { fps: FPS });

  it('emits GUARD_HIGH / GUARD_LOW on debounced transitions and reflects them in held()', () => {
    const seq = synth.sequenceWithStarts([g(500), handsDown(400), g(500)], FPS);
    const { events, held, frames } = run(synth.withNoise(seq.frames, SIGMA, 33), cal);
    const at = (t: number) => held[frames.findIndex((f) => f.t >= t)];
    expect(events.map((e) => e.type).filter((t) => t.startsWith('GUARD'))).toEqual(['GUARD_HIGH', 'GUARD_LOW', 'GUARD_HIGH']);
    expect(at(0) & BIT.GUARD_HIGH).toBe(0);                    // before debounce
    expect(at(400) & BIT.GUARD_HIGH).toBe(BIT.GUARD_HIGH);
    expect(at(seq.starts[1] + 300) & BIT.GUARD_HIGH).toBe(0);
    expect(held[held.length - 1] & BIT.GUARD_HIGH).toBe(BIT.GUARD_HIGH);
    const low = events.find((e) => e.type === 'GUARD_LOW')!;
    expect(low.t - seq.starts[1]).toBeGreaterThanOrEqual(100);   // debounce delay
    expect(low.t - seq.starts[1]).toBeLessThan(200);
  });

  it('a 66 ms dip does not flip the guard', () => {
    const frames = synth.sequence([g(500), handsDown(33), g(500)], FPS);  // 2 frames out of the box
    const { events } = run(frames, cal);
    expect(count(events, 'GUARD_LOW')).toBe(0);
    expect(count(events, 'GUARD_HIGH')).toBe(1);
  });

  it('a punch drops the guard only while the arm is extended', () => {
    const frames = synth.sequence([g(500), synth.jab('L', { fps: FPS }), g(600)], FPS);
    const { events, held } = run(frames, cal);
    expect(count(events, 'GUARD_LOW')).toBe(1);
    expect(held[held.length - 1] & BIT.GUARD_HIGH).toBe(BIT.GUARD_HIGH);
  });
});
