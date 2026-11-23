import { describe, expect, it } from 'vitest';
import { BIT, LM } from '@spar/protocol';
import { synth } from '../src';
import { noisyCalibration, run } from './helpers';

const hipIndices = new Set([LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, 29, 30, 31, 32]);
const neutral = synth.guard(0)[0];

describe('torso lean versus body translation', () => {
  for (const dir of ['L', 'R'] as const) {
    it(`recognizes a ${dir} torso slip with head and shoulders moving together over stationary hips`, () => {
      const motion = dir === 'L' ? synth.stepL({ amount: 0.55 }) : synth.stepR({ amount: 0.55 });
      const lean = motion.map(f => ({ ...f, lm: f.lm.map((p, i) => hipIndices.has(i) ? neutral.lm[i] : p) }));
      const result = run(synth.sequence([synth.guard(500), lean, synth.guard(500)]), noisyCalibration());
      expect(result.events.filter(e => e.type === `SLIP_${dir}`)).toHaveLength(1);
      expect(result.events.filter(e => e.type.startsWith('STEP'))).toEqual([]);
      expect(result.held.at(-1)! & (BIT.SLIP_L | BIT.SLIP_R)).toBe(0);
    });
  }

  it('recognizes a torso pivot over the hips while the head stays aligned with the shoulders', () => {
    const cx = (neutral.lm[LM.L_HIP].x + neutral.lm[LM.R_HIP].x) / 2;
    const cy = (neutral.lm[LM.L_HIP].y + neutral.lm[LM.R_HIP].y) / 2;
    const frames = synth.guard(1700).map(f => {
      const progress = f.t < 500 ? 0 : f.t < 800 ? (f.t - 500) / 300 : f.t < 1100 ? 1 : Math.max(0, 1 - (f.t - 1100) / 300);
      const angle = progress * Math.PI / 9;
      return { ...f, lm: f.lm.map((p, i) => hipIndices.has(i) ? p : {
        ...p,
        x: cx + (p.x - cx) * Math.cos(angle) - (p.y - cy) * Math.sin(angle),
        y: cy + (p.x - cx) * Math.sin(angle) + (p.y - cy) * Math.cos(angle),
      }) };
    });
    const result = run(frames, noisyCalibration());
    expect(result.events.filter(e => e.type === 'SLIP_L')).toHaveLength(1);
    expect(result.events.filter(e => e.type.startsWith('STEP'))).toEqual([]);
    expect(result.held.at(-1)! & BIT.SLIP_L).toBe(0);
  });

  it('keeps whole-body sideways steps distinct from slips', () => {
    const result = run(synth.sequence([synth.guard(500), synth.stepL(), synth.guard(500), synth.stepR(), synth.guard(500)]), noisyCalibration());
    expect(result.events.filter(e => e.type === 'STEP_L' || e.type === 'STEP_R').map(e => e.type)).toEqual(['STEP_L', 'STEP_R']);
    expect(result.events.filter(e => e.type.startsWith('SLIP'))).toEqual([]);
  });
});
