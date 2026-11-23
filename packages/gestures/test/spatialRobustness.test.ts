import { describe, expect, it } from 'vitest';
import { LM, type PoseFrame } from '@spar/protocol';
import { synth, toBodyFrame } from '../src/index';
import { FPS, noisyCalibration, run } from './helpers';

const depthSteps = (frames: PoseFrame[]) => run(frames, noisyCalibration()).events.filter(e => e.type === 'STEP_IN' || e.type === 'STEP_OUT');

describe('spatial evidence', () => {
  it('rejects stationary shoulder yaw and its return, including prolonged rotation', () => {
    const frames = synth.guard(7000, { fps: FPS }).map(f => {
      const blend = f.t < 500 ? 0 : f.t < 1000 ? (f.t - 500) / 500 : f.t < 5500 ? 1 : Math.max(0, 1 - (f.t - 5500) / 500);
      const scale = 1 - blend * 0.35;
      const center = (f.lm[LM.L_SHOULDER].x + f.lm[LM.R_SHOULDER].x) / 2;
      return { ...f, lm: f.lm.map(p => ({ ...p, x: center + (p.x - center) * scale })) };
    });
    expect(depthSteps(frames)).toEqual([]);
  });

  it('retains real approach and retreat where independent body-size cues agree', () => {
    const frames = synth.sequence([synth.guard(500), synth.stepIn(), synth.guard(700), synth.stepOut(), synth.guard(700)]);
    expect(depthSteps(frames).map(e => e.type)).toEqual(['STEP_IN', 'STEP_OUT']);
  });

  it('does not turn a cropped upper-body displacement into a lateral step', () => {
    const frames = synth.withVisibility(synth.sequence([synth.guard(500), synth.stepL(), synth.guard(500)]), [LM.L_HIP, LM.R_HIP], 0);
    expect(run(frames, noisyCalibration()).events.filter(e => e.type.startsWith('STEP'))).toEqual([]);
  });

  it('does not guess depth when hips are unavailable', () => {
    const frames = synth.withVisibility(synth.sequence([synth.guard(500), synth.stepIn()]), [LM.L_HIP, LM.R_HIP], 0);
    expect(depthSteps(frames)).toEqual([]);
  });
});

describe('finite geometry', () => {
  it('marks missing or nonfinite shoulders invalid and keeps output finite', () => {
    const base = synth.guard(0)[0];
    const malformed = [
      { ...base, lm: [] },
      { ...base, lm: base.lm.map((p, i) => i === LM.L_SHOULDER ? { ...p, x: NaN } : p) },
      { ...base, lm: base.lm.map((p, i) => i === LM.R_SHOULDER ? { ...p, z: Infinity } : p) },
    ];
    for (const frame of malformed) {
      const body = toBodyFrame(frame);
      expect(body.valid).toBe(false);
      expect(body.pts.every(p => [p.x, p.y, p.z].every(Number.isFinite))).toBe(true);
    }
    expect(toBodyFrame(base, NaN).valid).toBe(false);
  });

  it('invalidates nonfinite individual joints without poisoning subsequent frames', () => {
    const frames = synth.guard(1000).map((f, i) => i === 10 ? {
      ...f, lm: f.lm.map((p, j) => j === LM.L_WRIST ? { ...p, y: NaN } : p),
    } : f);
    expect(toBodyFrame(frames[10]).vis[LM.L_WRIST]).toBe(0);
    const result = run(frames, noisyCalibration());
    expect(result.events.filter(e => /JAB|CROSS|HOOK|UPPER/.test(e.type))).toEqual([]);
    const hand = result.engine.debug().hands.L;
    expect([hand.e, hand.eDot, hand.vy, hand.elbowAngle].every(Number.isFinite)).toBe(true);
  });
});
