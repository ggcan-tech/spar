import { LM, type PoseFrame } from '@spar/protocol';

export interface RigPoint { x: number; y: number; z: number }
export interface PoseRig { points: Array<RigPoint | null>; source: 'world' | 'image' }
const valid = (p: RigPoint | undefined) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Hip-relative visual retargeting only. The sim, not monocular pose depth, owns ring distance. */
export function retargetPose(frame: PoseFrame | null): PoseRig | null {
  if (!frame) return null;
  const anchors = [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP];
  if (anchors.some(i => !valid(frame.lm[i]) || frame.lm[i].v < .55)) return null;
  const world = frame.world?.length === 33 && anchors.every(i => valid(frame.world[i]));
  const points = world ? frame.world : frame.lm;
  const aspect = frame.imageAspect;
  if (!world && (!aspect || !Number.isFinite(aspect) || aspect <= 0)) return null;
  const ls = points[LM.L_SHOULDER], rs = points[LM.R_SHOULDER];
  const width = world ? Math.hypot(ls.x - rs.x, ls.y - rs.y, ls.z - rs.z) : Math.hypot(ls.x - rs.x, (ls.y - rs.y) * aspect!);
  if (width < (world ? .12 : .05) || width > (world ? 1 : .85)) return null;
  const hip = { x: (points[LM.L_HIP].x + points[LM.R_HIP].x) / 2, y: (points[LM.L_HIP].y + points[LM.R_HIP].y) / 2, z: (points[LM.L_HIP].z + points[LM.R_HIP].z) / 2 };
  const scale = .48 / width;
  const out = Array.from({ length: 33 }, (_, i) => {
    const p = points[i];
    if (!valid(p) || !Number.isFinite(frame.lm[i]?.v) || frame.lm[i].v < .5) return null;
    const next = { x: (p.x - hip.x) * scale, y: .86 - (p.y - hip.y) * scale * (world ? 1 : aspect!), z: -(p.z - hip.z) * scale };
    if (Math.abs(next.x) > 1.6 || next.y < -.35 || next.y > 2.5 || Math.abs(next.z) > 1.5) return null;
    return next;
  });
  return { points: out, source: world ? 'world' : 'image' };
}
