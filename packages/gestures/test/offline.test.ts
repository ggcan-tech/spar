import { describe, expect, it } from 'vitest';
import { BIT, PUNCH_MASK, HELD_MASK } from '@spar/protocol';
import { framesToInputs, synth } from '../src/index';
import { FPS, SIGMA, noisyCalibration, punchTicks } from './helpers';

const cal = noisyCalibration();
const g = (ms: number) => synth.guard(ms, { fps: FPS });

describe('framesToInputs', () => {
  it('yields a punch bit exactly once per synthetic punch at 60 Hz', () => {
    const frames = synth.withNoise(synth.sequence([
      g(800), synth.jab('L', { fps: FPS }), g(400), synth.straight('R', { fps: FPS }), g(400),
      synth.hook('L', { fps: FPS }), g(400), synth.uppercut('R', { fps: FPS }), g(400), synth.bodyPunch('L', { fps: FPS }), g(500),
    ], FPS), SIGMA, 51);
    const inputs = framesToInputs(frames, cal, 60);
    const span = frames[frames.length - 1].t - frames[0].t;
    expect(inputs.length).toBe(Math.ceil(span / (1000 / 60) - 1e-9) + 1);
    expect(punchTicks(inputs)).toBe(5);
    const order = inputs.filter((b) => b & PUNCH_MASK).map((b) => b & PUNCH_MASK);
    expect(order).toEqual([BIT.JAB, BIT.CROSS, BIT.LEAD_HOOK, BIT.REAR_UPPER, BIT.JAB]);
    expect(inputs.filter((b) => b & BIT.BODY)).toHaveLength(1);
    // held bits repeat: guard is high for most of the recording
    const highTicks = inputs.filter((b) => b & BIT.GUARD_HIGH).length;
    expect(highTicks / inputs.length).toBeGreaterThan(0.7);
    for (const b of inputs) expect(b & ~0xffff).toBe(0);
    void HELD_MASK;
  });

  it('is deterministic and handles an empty recording', () => {
    const frames = synth.sequence([g(300), synth.jab('L', { fps: FPS }), g(300)], FPS);
    expect(framesToInputs(frames, cal)).toEqual(framesToInputs(frames, cal));
    expect(framesToInputs([], cal)).toEqual([]);
  });

  it('a punch in the very last frame is still flushed into a tick', () => {
    const frames = synth.sequence([g(300), synth.jab('L', { fps: FPS, returnMs: 1 })], FPS);
    expect(punchTicks(framesToInputs(frames, cal, 60))).toBe(1);
  });
});
