import { describe, it, expect } from 'vitest';
import { LM, type PoseFrame } from '@spar/protocol';
import { controlPauseReason } from './controlReadiness';
const pose = (): PoseFrame => ({ t: 1000, lm: Array.from({length:33}, () => ({x:.5,y:.5,z:0,v:.9})), world: [] });
describe('local control study readiness', () => {
  it('allows fresh visible camera control but rejects old and future samples', () => {
    expect(controlPauseReason('camera', pose(), 1100, false, 16)).toBe('');
    expect(controlPauseReason('camera', pose(), 1300, false, 16)).not.toBe('');
    expect(controlPauseReason('camera', pose(), 900, false, 16)).not.toBe('');
  });
  it('pauses on absent, low visibility or invalid body anchors', () => {
    expect(controlPauseReason('camera', null, 1100, false, 16)).not.toBe('');
    const p = pose(); p.lm[LM.L_HIP].v = .1;
    expect(controlPauseReason('camera', p, 1100, false, 16)).not.toBe('');
    const q = pose(); q.lm[LM.NOSE].x = NaN;
    expect(controlPauseReason('camera', q, 1100, false, 16)).not.toBe('');
  });
  it('never catches up hidden or stalled time with unseen attacks, even on keyboard', () => {
    expect(controlPauseReason('keyboard', null, 1100, true, 16)).not.toBe('');
    expect(controlPauseReason('keyboard', null, 1100, false, 500)).not.toBe('');
    expect(controlPauseReason('keyboard', null, 1100, false, 16)).toBe('');
  });
});
