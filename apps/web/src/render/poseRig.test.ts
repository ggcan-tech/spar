import { describe, expect, it } from 'vitest';
import { LM, type PoseFrame } from '@spar/protocol';
import { encodePose, decodePose } from '../net/poseStream';
import { retargetPose } from './poseRig';
const frame = (): PoseFrame => {
  const lm = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, v: 1 }));
  lm[LM.L_SHOULDER] = { x: .65, y: .35, z: 0, v: 1 };
  lm[LM.R_SHOULDER] = { x: .35, y: .35, z: 0, v: 1 };
  lm[LM.L_HIP] = { x: .6, y: .7, z: 0, v: 1 };
  lm[LM.R_HIP] = { x: .4, y: .7, z: 0, v: 1 };
  return { t: 1, lm, world: [], imageAspect: .75 };
};
describe('visual pose retargeting', () => {
  it('retargets a received pose packet with its sender aspect and respects occlusion', () => {
    const source = frame(); source.lm[LM.L_WRIST].v = 0;
    const received = decodePose(encodePose(1, source))!.pose;
    const rig = retargetPose(received)!;
    expect(rig.source).toBe('image');
    expect(rig.points[LM.L_SHOULDER]!.y).toBeCloseTo(retargetPose(source)!.points[LM.L_SHOULDER]!.y);
    expect(rig.points[LM.L_WRIST]).toBeNull();
  });
  it('removes image translation so camera framing cannot move a fighter around the ring', () => {
    const a = frame(), b = frame(); b.lm.forEach(p => { p.x += .1; p.y += .1; p.z += .1; });
    const x = retargetPose(a)!, y = retargetPose(b)!;
    x.points.forEach((p, i) => { if (p) { expect(y.points[i]!.x).toBeCloseTo(p.x); expect(y.points[i]!.y).toBeCloseTo(p.y); expect(y.points[i]!.z).toBeCloseTo(p.z); } });
  });
  it('uses aspect-correct image coordinates and refuses unknown aspect', () => {
    const a = frame(); const b = frame(); b.imageAspect = 1.5;
    expect(retargetPose(b)!.points[LM.L_SHOULDER]!.y - .86).toBeCloseTo((retargetPose(a)!.points[LM.L_SHOULDER]!.y - .86) * 2);
    a.imageAspect = undefined; expect(retargetPose(a)).toBeNull();
  });
  it('uses world coordinates without interpreting hip position as absolute room position', () => {
    const a = frame(); a.world = a.lm.map(p => ({ ...p })); a.imageAspect = undefined;
    expect(retargetPose(a)?.source).toBe('world');
    expect(retargetPose(a)!.points[LM.L_HIP]!.y).toBe(.86);
  });
  it('rejects low-confidence torso, malformed limbs, and implausible outliers', () => {
    const a = frame(); a.lm[LM.L_SHOULDER].v = .1; expect(retargetPose(a)).toBeNull();
    a.lm[LM.L_SHOULDER].v = 1; a.lm[LM.L_WRIST].x = NaN; a.lm[LM.R_WRIST].x = 30;
    expect(retargetPose(a)!.points[LM.L_WRIST]).toBeNull(); expect(retargetPose(a)!.points[LM.R_WRIST]).toBeNull();
  });
});
