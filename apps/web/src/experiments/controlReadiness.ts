import { LM, type PoseFrame } from '@spar/protocol';

/** Conservative local-study gate; this is not a calibrated tracking-accuracy score. */
export function controlPauseReason(kind: 'camera' | 'keyboard', pose: PoseFrame | null, now: number, hidden: boolean, elapsed: number): string {
  if (hidden) return 'Paused while this window is hidden';
  if (kind === 'camera') {
    const age = pose ? now - pose.t : Infinity;
    const indices = [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP];
    const visible = pose && indices.every(i => {
      const p = pose.lm[i];
      return p && [p.x, p.y, p.z, p.v].every(Number.isFinite) && p.v >= .55;
    });
    if (!visible || !Number.isFinite(age) || age < 0 || age > 250) return 'Keep your head and hips in view — round paused';
  }
  if (!Number.isFinite(elapsed) || elapsed > 250 || elapsed < 0) return 'Catching up — the round is paused';
  return '';
}
