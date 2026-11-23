import { describe, expect, it } from 'vitest';
import { LM, type PoseFrame } from '@spar/protocol';
import { createAutomaticGestureEngine, synth } from '../src';

const encodeAspect = (frames: PoseFrame[], aspect: number) => frames.map(f => ({
  ...f, lm: f.lm.map(p => ({ ...p, y: p.y / aspect })),
}));

describe('passive setup', () => {
  it('learns arm length from a resting guard, without extending or emitting setup punches', () => {
    const engine = createAutomaticGestureEngine();
    const events = synth.guard(1300).flatMap(f => engine.push(f));
    expect(engine.tracking().phase).toBe('ready');
    expect(engine.calibration().armLen.lead).toBeCloseTo(synth.ARM_LEN, 1);
    expect(engine.calibration().armLen.rear).toBeCloseTo(synth.ARM_LEN, 1);
    expect(events.filter(e => ['JAB', 'CROSS', 'STEP_IN', 'STEP_OUT'].includes(e.type))).toEqual([]);
  });

  it('does not start from one frame, hidden hands, or moving observations', () => {
    const engine = createAutomaticGestureEngine();
    engine.push(synth.guard(50)[0]);
    expect(engine.tracking().phase).toBe('settling');
    expect(engine.sampleInput()).toBe(0);
    for (const f of synth.guard(1500)) {
      f.lm[LM.L_WRIST].v = 0;
      engine.push(f);
    }
    expect(engine.tracking().phase).toBe('looking');
    expect(engine.sampleInput()).toBe(0);
    engine.reset();
    for (const f of synth.guard(1500)) {
      for (const p of f.lm) p.x += Math.sin(f.t / 150) * 0.07;
      engine.push(f);
    }
    expect(engine.tracking().phase).not.toBe('ready');
  });

  it('ignores corrupt frames and requires a fresh stable window after a gap', () => {
    const engine = createAutomaticGestureEngine();
    for (const f of synth.guard(500)) engine.push(f);
    const bad = synth.guard(50)[0];
    bad.t = 600;
    bad.lm[LM.L_ELBOW].x = NaN;
    expect(() => engine.push(bad)).not.toThrow();
    expect(engine.tracking().phase).toBe('looking');
    for (const f of synth.guard(500)) engine.push({ ...f, t: f.t + 2000 });
    expect(engine.tracking().phase).not.toBe('ready');
    for (const f of synth.guard(1000)) engine.push({ ...f, t: f.t + 2500 });
    expect(engine.tracking().phase).toBe('ready');
  });

  it('honours southpaw selection and re-acquires after reset', () => {
    const engine = createAutomaticGestureEngine('southpaw');
    for (const f of synth.guard(1200)) engine.push(f);
    expect(engine.stance()).toBe('southpaw');
    engine.reset();
    expect(engine.tracking().phase).toBe('looking');
    expect(engine.sampleInput()).toBe(0);
  });

  it('reacquires without actions when phone orientation changes', () => {
    const engine = createAutomaticGestureEngine();
    for (const f of synth.guard(1200)) engine.push(f);
    expect(engine.tracking().phase).toBe('ready');
    const portrait = encodeAspect(synth.guard(1200), 1.7778).map(f => ({ ...f, t: f.t + 2000, imageAspect: 1.7778 }));
    expect(engine.push(portrait[0])).toEqual([]);
    expect(engine.tracking().phase).toBe('settling');
    expect(engine.sampleInput()).toBe(0);
    for (const f of portrait.slice(1)) engine.push(f);
    expect(engine.tracking().phase).toBe('ready');
    expect(engine.calibration().armLen.lead).toBeCloseTo(synth.ARM_LEN, 1);
  });

  it.each([0.5625, 1, 1.7778])('recovers the same anatomy at aspect %s', aspect => {
    // Keep the complete setup landmarks within all three crops.
    const frames = synth.guard(1300, { figure: { sw: 0.09, cy: 0.18 } });
    const engine = createAutomaticGestureEngine('orthodox', { aspect });
    for (const f of encodeAspect(frames, aspect)) engine.push(f);
    expect(engine.tracking().phase).toBe('ready');
    expect(engine.calibration().armLen.lead).toBeCloseTo(synth.ARM_LEN, 1);
  });
});
