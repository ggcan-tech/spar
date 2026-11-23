import type { FighterView, PoseFrame, PunchKind, Stance } from '@spar/protocol';
import { LANDMARK_COUNT, LM } from '@spar/protocol';
import { PUNCH_TABLE } from '@spar/sim';
import { clamp, lerp, smoothstep } from './theme';

/** A landmark in camera-image space: x,y in 0..1 (origin top-left, NOT mirrored), z < 0 = toward camera. */
export interface Pt {
  x: number;
  y: number;
  z: number;
  v: number;
}
export type Pose2 = Pt[];
export type Hand = 'L' | 'R';
export type PunchShape = 'straight' | 'hook' | 'upper';

export function leadHand(stance: Stance): Hand {
  return stance === 'orthodox' ? 'L' : 'R';
}

export function otherHand(h: Hand): Hand {
  return h === 'L' ? 'R' : 'L';
}

/** Which wrist throws `punch` for this stance (lead = left for orthodox). */
export function punchHand(punch: PunchKind | null | undefined, stance: Stance): Hand | null {
  if (!punch) return null;
  const lead = leadHand(stance);
  return punch === 'JAB' || punch === 'LEAD_HOOK' || punch === 'LEAD_UPPER' ? lead : otherHand(lead);
}

export function punchShape(punch: PunchKind): PunchShape {
  switch (punch) {
    case 'JAB':
    case 'CROSS':
      return 'straight';
    case 'LEAD_HOOK':
    case 'REAR_HOOK':
      return 'hook';
    default:
      return 'upper';
  }
}

/** 0..1 extension of the fighter's current punch, derived from phase + frames remaining. */
export function punchExtension(f: FighterView): number {
  if (!f.punch) return 0;
  const spec = PUNCH_TABLE[f.punch];
  switch (f.phase) {
    case 'STARTUP':
      return clamp(1 - f.phaseFrames / Math.max(1, spec.startup), 0, 1);
    case 'ACTIVE':
      return 1;
    case 'RECOVERY':
      return clamp(f.phaseFrames / Math.max(1, spec.recovery + (f.body ? 1 : 0)), 0, 1);
    default:
      return 0;
  }
}

export const WRIST: Record<Hand, number> = { L: LM.L_WRIST, R: LM.R_WRIST };
export const ELBOW: Record<Hand, number> = { L: LM.L_ELBOW, R: LM.R_ELBOW };
export const SHOULDER: Record<Hand, number> = { L: LM.L_SHOULDER, R: LM.R_SHOULDER };

/** Copies a PoseFrame's image landmarks; pads to 33 entries with invisible points. */
export function fromPoseFrame(p: PoseFrame): Pose2 {
  const out: Pose2 = new Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const l = p.lm[i];
    out[i] = l ? { x: l.x, y: l.y, z: l.z, v: l.v } : { x: 0.5, y: 0.5, z: 0, v: 0 };
  }
  return out;
}

/**
 * Canned boxer pose in camera-image space (person facing the camera: their own left = +x),
 * animated from the fighter's sim state: guard height, head slip/duck, punch phase (the correct
 * glove extends — straight toward the camera, hook laterally, upper from below), stun wobble.
 * Feed it through the same projection as a real pose so bot and human look consistent.
 */
export function synthPose(f: FighterView, nowMs: number, extOverride?: number): Pose2 {
  const P: Pose2 = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.6, z: 0, v: 0 }));
  const set = (i: number, x: number, y: number, z = 0) => {
    P[i] = { x, y, z, v: 1 };
  };
  const t = nowMs / 1000;
  const breathe = Math.sin((t * 2 * Math.PI) / 3.2) * 0.006;
  const sway = Math.sin((t * 2 * Math.PI) / 1.7) * 0.008;
  const lead = leadHand(f.stance);
  const stunned = f.phase === 'STUNNED';
  const down = f.phase === 'KNOCKDOWN';
  const guard = f.guardHigh && !stunned && !down;

  // ── head ──
  let hx = 0.5;
  let hy = 0.26 + breathe;
  let shY = 0.42 + breathe;
  const duck = f.head === 'DUCK' ? 1 : 0;
  if (f.head === 'SLIP_L') hx += 0.09;
  else if (f.head === 'SLIP_R') hx -= 0.09;
  hy += duck * 0.16;
  shY += duck * 0.08;
  if (stunned) {
    hx += 0.035 * Math.sin(t * 2 * Math.PI * 2.3);
    hy += 0.02 * Math.sin(t * 2 * Math.PI * 1.7);
  }
  if (down) {
    hy += 0.06;
    hx += 0.04;
  }
  set(LM.NOSE, hx, hy, -0.2);
  set(LM.L_EYE, hx + 0.03, hy - 0.02, -0.15);
  set(LM.R_EYE, hx - 0.03, hy - 0.02, -0.15);
  set(LM.L_EAR, hx + 0.06, hy, 0);
  set(LM.R_EAR, hx - 0.06, hy, 0);
  set(LM.MOUTH_L, hx + 0.02, hy + 0.045, -0.15);
  set(LM.MOUTH_R, hx - 0.02, hy + 0.045, -0.15);

  // ── torso / legs ──
  const shShift = f.head === 'SLIP_L' ? 0.03 : f.head === 'SLIP_R' ? -0.03 : 0;
  set(LM.L_SHOULDER, 0.64 + shShift, shY);
  set(LM.R_SHOULDER, 0.36 + shShift, shY);
  set(LM.L_HIP, 0.58, 0.8);
  set(LM.R_HIP, 0.42, 0.8);
  set(LM.L_KNEE, 0.59 + duck * 0.05, 1.06);
  set(LM.R_KNEE, 0.41 - duck * 0.05, 1.06);
  set(LM.L_ANKLE, 0.6, 1.3);
  set(LM.R_ANKLE, 0.4, 1.3);

  // ── arms ──
  const active = punchHand(f.punch, f.stance);
  const ext = extOverride ?? punchExtension(f);
  const arm = (hand: Hand) => {
    const s = hand === 'L' ? 1 : -1;
    const isLead = hand === lead;
    let ex: number, ey: number, ez: number, wx: number, wy: number, wz: number;
    if (guard) {
      ex = 0.5 + s * 0.22;
      ey = shY + 0.2;
      ez = -0.2;
      wx = 0.5 + s * (isLead ? 0.09 : 0.11);
      wy = hy + 0.12 + (isLead ? -0.01 : 0.01);
      wz = isLead ? -0.5 : -0.3;
    } else {
      ex = 0.5 + s * 0.2;
      ey = shY + 0.24;
      ez = -0.1;
      wx = 0.5 + s * 0.16;
      wy = shY + (down ? 0.42 : 0.36);
      wz = -0.15;
    }
    wx += sway * s * 0.5;
    wy += sway * 0.3;

    if (active === hand && ext > 0 && f.punch) {
      const e = smoothstep(ext);
      const bodyY = f.body ? 0.22 : 0;
      switch (punchShape(f.punch)) {
        case 'straight':
          wx = lerp(wx, 0.5 + s * 0.03, e);
          wy = lerp(wy, 0.34 + bodyY, e);
          wz = lerp(wz, -1.3, e);
          ex = lerp(ex, 0.5 + s * 0.09, e);
          ey = lerp(ey, 0.4 + bodyY, e);
          ez = lerp(ez, -0.7, e);
          break;
        case 'hook': {
          const arc = Math.sin(Math.PI * e);
          wx = lerp(wx, 0.5 - s * 0.1, e) + s * 0.16 * arc;
          wy = lerp(wy, 0.32 + bodyY, e);
          wz = lerp(wz, -0.9, e);
          ex = lerp(ex, 0.5 + s * 0.26, e);
          ey = lerp(ey, 0.38 + bodyY, e);
          ez = lerp(ez, -0.5, e);
          break;
        }
        case 'upper': {
          const dip = Math.sin(Math.PI * e);
          wx = lerp(wx, 0.5 + s * 0.05, e);
          wy = lerp(wy, 0.26 + bodyY, e) + 0.16 * dip;
          wz = lerp(wz, -0.9, e);
          ex = lerp(ex, 0.5 + s * 0.16, e);
          ey = lerp(ey, 0.5 + bodyY, e) + 0.06 * dip;
          ez = lerp(ez, -0.5, e);
          break;
        }
      }
    }
    set(ELBOW[hand], ex, ey, ez);
    set(WRIST[hand], wx, wy, wz);
  };
  arm('L');
  arm('R');
  return P;
}
