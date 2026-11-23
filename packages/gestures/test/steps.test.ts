import { describe, expect, it } from 'vitest';
import { BIT } from '@spar/protocol';
import { synth } from '../src/index';
import { FPS, SIGMA, noisyCalibration, run, count } from './helpers';

const cal = noisyCalibration();
const g = (ms: number) => synth.guard(ms, { fps: FPS });

describe('steps', () => {
  it('stepL emits STEP_L once; the return within 600 ms emits nothing', () => {
    const { events, inputs } = run(synth.withNoise(synth.sequence([g(500), synth.stepL({ fps: FPS }), g(800)], FPS), SIGMA, 41), cal);
    expect(count(events, 'STEP_L')).toBe(1);
    expect(count(events, 'STEP_R')).toBe(0);
    expect(inputs.filter((b) => b & BIT.STEP_L)).toHaveLength(1);
    expect(inputs.filter((b) => b & BIT.STEP_R)).toHaveLength(0);
    expect(events.filter((e) => /JAB|CROSS|HOOK|UPPER|SLIP|DUCK/.test(e.type))).toHaveLength(0);
  });

  it('stepR emits STEP_R once and a second step after the forgiveness window fires again', () => {
    const { events } = run(synth.sequence([g(500), synth.stepR({ fps: FPS }), g(800), synth.stepR({ fps: FPS }), g(800)], FPS), cal);
    expect(count(events, 'STEP_R')).toBe(2);
    expect(count(events, 'STEP_L')).toBe(0);
  });

  it('a slow drift does not step', () => {
    const { events } = run(synth.sequence([g(300), synth.stepL({ fps: FPS, moveMs: 1500, holdMs: 200, returnMs: 1500 })], FPS), cal);
    expect(count(events, 'STEP_L') + count(events, 'STEP_R')).toBe(0);
  });

  it('STEP_IN / STEP_OUT via shoulder scale with cooldown and re-arm', () => {
    const { events, inputs } = run(synth.withNoise(synth.sequence([g(500), synth.stepIn({ fps: FPS }), g(700), synth.stepOut({ fps: FPS }), g(700)], FPS), SIGMA, 42), cal);
    expect(events.filter((e) => e.type === 'STEP_IN' || e.type === 'STEP_OUT').map((e) => e.type)).toEqual(['STEP_IN', 'STEP_OUT']);
    expect(inputs.filter((b) => b & BIT.STEP_IN)).toHaveLength(1);
    expect(inputs.filter((b) => b & BIT.STEP_OUT)).toHaveLength(1);
    expect(count(events, 'DUCK')).toBe(0);
    expect(count(events, 'STEP_L') + count(events, 'STEP_R')).toBe(0);
  });

  it('staying stepped-in does not re-fire; returning re-arms', () => {
    const { events } = run(synth.sequence([g(500), synth.stepIn({ fps: FPS, holdMs: 1500 }), g(400), synth.stepIn({ fps: FPS }), g(400)], FPS), cal);
    expect(count(events, 'STEP_IN')).toBe(2);
    expect(count(events, 'STEP_OUT')).toBe(0);
  });
});

describe('GET_UP', () => {
  it('fires once after both wrists are above the nose for 300 ms', () => {
    const seq = synth.sequenceWithStarts([g(400), synth.getUp({ fps: FPS }), g(400)], FPS);
    const { events, inputs } = run(synth.withNoise(seq.frames, SIGMA, 43), cal);
    expect(count(events, 'GET_UP')).toBe(1);
    // wrists pass the nose ~100 ms into the 250 ms raise; the 300 ms hold counts from there
    const t = events.find((e) => e.type === 'GET_UP')!.t - seq.starts[1];
    expect(t).toBeGreaterThanOrEqual(100 + 300 - 40);
    expect(t).toBeLessThan(250 + 300 + 50);
    expect(inputs.filter((b) => b & BIT.GET_UP)).toHaveLength(1);
  });

  it('a short raise does not fire', () => {
    // hands are above the nose for ≈170 ms only
    const { events } = run(synth.sequence([g(300), synth.getUp({ fps: FPS, moveMs: 120, holdMs: 30, returnMs: 120 }), g(300)], FPS), cal);
    expect(count(events, 'GET_UP')).toBe(0);
  });
});
