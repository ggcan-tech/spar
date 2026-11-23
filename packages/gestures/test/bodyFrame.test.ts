import { describe, expect, it } from 'vitest';
import { LM, type PoseFrame } from '@spar/protocol';
import { synth, toBodyFrame } from '../src/index';

/** similarity transform of image x,y about (0.5, 0.5): scale s, rotate θ, translate (tx, ty) */
function transform(frame: PoseFrame, s: number, theta: number, tx: number, ty: number): PoseFrame {
  const c = Math.cos(theta), sn = Math.sin(theta);
  return {
    ...frame,
    lm: frame.lm.map((p) => {
      const x = p.x - 0.5, y = p.y - 0.5;
      return { x: 0.5 + s * (c * x - sn * y) + tx, y: 0.5 + s * (sn * x + c * y) + ty, z: p.z * s, v: p.v };
    }),
  };
}

describe('toBodyFrame', () => {
  const base = synth.guard(0)[0];

  it('maps shoulders to (+0.5,0) [left] and (−0.5,0) [right] and keeps +x = fighter left', () => {
    const bf = toBodyFrame(base);
    expect(bf.valid).toBe(true);
    expect(bf.pts[LM.L_SHOULDER].x).toBeCloseTo(0.5, 9);
    expect(bf.pts[LM.L_SHOULDER].y).toBeCloseTo(0, 9);
    expect(bf.pts[LM.R_SHOULDER].x).toBeCloseTo(-0.5, 9);
    expect(bf.pts[LM.R_SHOULDER].y).toBeCloseTo(0, 9);
    // image x of the left shoulder is larger (person faces camera, not mirrored)
    expect(base.lm[LM.L_SHOULDER].x).toBeGreaterThan(base.lm[LM.R_SHOULDER].x);
    // nose is above the shoulders (y down), hips below
    expect(bf.pts[LM.NOSE].y).toBeLessThan(0);
    expect(bf.pts[LM.L_HIP].y).toBeGreaterThan(0);
    expect(bf.shoulderWidthPx).toBeCloseTo(synth.FIGURE.sw, 9);
  });

  it('is invariant to scale, rotation and translation of the input', () => {
    const ref = toBodyFrame(base);
    for (const [s, th, tx, ty] of [[1.7, 0.4, 0.1, -0.05], [0.6, -0.9, -0.2, 0.15], [1.0, Math.PI / 2, 0, 0]]) {
      const bf = toBodyFrame(transform(base, s, th, tx, ty));
      expect(bf.valid).toBe(true);
      expect(bf.pts[LM.L_SHOULDER].x).toBeCloseTo(0.5, 6);
      expect(bf.pts[LM.L_SHOULDER].y).toBeCloseTo(0, 6);
      expect(bf.pts[LM.R_SHOULDER].x).toBeCloseTo(-0.5, 6);
      expect(bf.pts[LM.R_SHOULDER].y).toBeCloseTo(0, 6);
      for (const i of [LM.NOSE, LM.L_WRIST, LM.R_WRIST, LM.L_ELBOW, LM.L_HIP, LM.R_KNEE]) {
        expect(bf.pts[i].x).toBeCloseTo(ref.pts[i].x, 6);
        expect(bf.pts[i].y).toBeCloseTo(ref.pts[i].y, 6);
        expect(bf.pts[i].z).toBeCloseTo(ref.pts[i].z, 6);
      }
      expect(bf.shoulderWidthPx).toBeCloseTo(synth.FIGURE.sw * s, 6);
    }
  });

  it('applies the aspect ratio to y so a 16:9 frame is isotropic', () => {
    const aspect = 9 / 16;
    const squashed: PoseFrame = { ...base, lm: base.lm.map((p) => ({ ...p, y: p.y / aspect })) };
    const bf = toBodyFrame(squashed, aspect);
    const ref = toBodyFrame(base);
    expect(bf.pts[LM.NOSE].y).toBeCloseTo(ref.pts[LM.NOSE].y, 6);
    expect(bf.pts[LM.L_WRIST].y).toBeCloseTo(ref.pts[LM.L_WRIST].y, 6);
  });

  it('flags frames whose shoulders are not visible', () => {
    const f = synth.withVisibility([base], [LM.L_SHOULDER])[0];
    expect(toBodyFrame(f).valid).toBe(false);
  });

  it('exposes hip center x in shoulder-width units', () => {
    const bf = toBodyFrame(base);
    const hipImg = (base.lm[LM.L_HIP].x + base.lm[LM.R_HIP].x) / 2;
    expect(bf.hipCenterXImg).toBeCloseTo(hipImg, 9);
    expect(bf.hipCenterX).toBeCloseTo(hipImg / synth.FIGURE.sw, 9);
    expect(bf.hipVisible).toBe(true);
  });
});
