import type { FighterView } from '@spar/protocol';
import { LM } from '@spar/protocol';
import { COLORS, clamp, mixColor, withAlpha, type Vec } from './theme';
import { punchHand, type Hand, type Pose2, type Pt, WRIST } from './pose';

/** Maps image-space landmarks into the stage. `dy`/`tilt` sell knockdowns for real poses too. */
export interface Projection {
  cx: number;
  floorY: number;
  w: number;
  h: number;
  /** Flip horizontally (opponent faces us; local PiP behaves like a mirror). */
  mirror: boolean;
  dy?: number;
  /** Horizontal shear per stage-unit of height above the floor (lean). */
  tilt?: number;
}

export function project(p: Pt, proj: Projection): Vec {
  const nx = proj.mirror ? 1 - p.x : p.x;
  const ny = Math.min(p.y, 1); // feet below the frame stand on the floor line
  const y = proj.floorY - (1 - ny) * proj.h + (proj.dy ?? 0);
  let x = proj.cx + (nx - 0.5) * proj.w;
  if (proj.tilt) x += (proj.floorY - y) * proj.tilt;
  return { x, y };
}

export interface ShadowStyle {
  /** Corner colour: neon rim + glove tint. */
  color: string;
  /** Silhouette interior. */
  fill: string;
  glow: number;
}

export interface ShadowOpts {
  style: ShadowStyle;
  fighter: FighterView;
  nowMs: number;
  /** Extra head displacement in stage units (slip/duck exaggeration). */
  headShift: Vec;
  /** 0..1 stun wobble amount. */
  wobble: number;
  /** 0..1 how far the punching glove is pushed toward the camera. */
  punchBoost: number;
  /** Landmarks with visibility below this are skipped. */
  minVis?: number;
}

export interface ShadowAnchors {
  head: Vec & { r: number };
  body: Vec;
  wrists: Record<Hand, Vec>;
  gloveR: number;
}

const HEAD_IDX = [LM.NOSE, LM.L_EYE, LM.R_EYE, LM.L_EAR, LM.R_EAR, LM.MOUTH_L, LM.MOUTH_R];
const LEGS: Array<[number, number]> = [
  [LM.L_HIP, LM.L_KNEE],
  [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE],
  [LM.R_KNEE, LM.R_ANKLE],
];
const ARMS: Array<[number, number]> = [
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.R_ELBOW, LM.R_WRIST],
];

function mid(a: Vec, b: Vec): Vec {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Draws the opponent as a neon-rimmed shadow: capsule limbs, torso polygon, head disc, gloves.
 * Two passes (glow rim, then dark interior) so the silhouette reads as one solid shape.
 */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  pose: Pose2,
  proj: Projection,
  opts: ShadowOpts,
): ShadowAnchors {
  const minVis = opts.minVis ?? 0.35;
  const vis = (i: number) => (pose[i]?.v ?? 0) >= minVis;
  const wob = opts.wobble > 0 ? opts.wobble * 14 * Math.sin(opts.nowMs / 45) : 0;

  const S: Vec[] = new Array(pose.length);
  for (let i = 0; i < pose.length; i++) {
    const q = project(pose[i], proj);
    if (wob !== 0) q.x += (wob * (proj.floorY - q.y)) / proj.h;
    S[i] = q;
  }
  for (const i of HEAD_IDX) {
    S[i].x += opts.headShift.x;
    S[i].y += opts.headShift.y;
  }

  const shoulderMid = mid(S[LM.L_SHOULDER], S[LM.R_SHOULDER]);
  const hipMid = mid(S[LM.L_HIP], S[LM.R_HIP]);
  const limbW = 0.085 * proj.h;
  const earSpan = vis(LM.L_EAR) && vis(LM.R_EAR) ? dist(S[LM.L_EAR], S[LM.R_EAR]) : 0;
  const headR = earSpan > 0 ? clamp(earSpan * 0.9, 0.08 * proj.h, 0.14 * proj.h) : 0.1 * proj.h;
  const head = vis(LM.NOSE) ? S[LM.NOSE] : { x: shoulderMid.x, y: shoulderMid.y - 0.16 * proj.h };

  const torso = (): void => {
    const l = S[LM.L_SHOULDER];
    const r = S[LM.R_SHOULDER];
    const lh = S[LM.L_HIP];
    const rh = S[LM.R_HIP];
    const dx = Math.sign(l.x - r.x || 1) * limbW * 0.35;
    ctx.beginPath();
    ctx.moveTo(l.x + dx, l.y);
    ctx.lineTo(r.x - dx, r.y);
    ctx.lineTo(rh.x - dx * 0.6, rh.y);
    ctx.lineTo(lh.x + dx * 0.6, lh.y);
    ctx.closePath();
  };

  const strokeSegments = (segs: Array<[number, number]>): void => {
    for (const [a, b] of segs) {
      if (!vis(a) || !vis(b)) continue;
      ctx.beginPath();
      ctx.moveTo(S[a].x, S[a].y);
      ctx.lineTo(S[b].x, S[b].y);
      ctx.stroke();
    }
  };

  const neck = (): void => {
    ctx.beginPath();
    ctx.moveTo(shoulderMid.x, shoulderMid.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
  };

  const headDisc = (): void => {
    ctx.beginPath();
    ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
  };

  const pass = (rim: boolean): void => {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (rim) {
      ctx.shadowColor = opts.style.color;
      ctx.shadowBlur = opts.style.glow;
      ctx.strokeStyle = opts.style.color;
      ctx.fillStyle = opts.style.color;
      ctx.lineWidth = limbW + 7;
    } else {
      ctx.strokeStyle = opts.style.fill;
      ctx.fillStyle = opts.style.fill;
      ctx.lineWidth = limbW;
    }
    strokeSegments(LEGS);
    torso();
    ctx.fill();
    if (rim) {
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.lineWidth = limbW + 7;
    }
    strokeSegments(ARMS);
    ctx.lineWidth = rim ? limbW * 0.7 + 7 : limbW * 0.7;
    neck();
    headDisc();
    ctx.fill();
    if (rim) {
      ctx.lineWidth = 6;
      ctx.stroke();
    }
    ctx.restore();
  };

  pass(true);
  pass(false);

  // ── gloves ──
  const active = punchHand(opts.fighter.punch, opts.fighter.stance);
  const gloveBase = 0.075 * proj.h;
  const wrists: Record<Hand, Vec> = { L: S[LM.L_WRIST], R: S[LM.R_WRIST] };
  for (const hand of ['L', 'R'] as const) {
    const idx = WRIST[hand];
    if (!vis(idx)) continue;
    const p = pose[idx];
    const q = S[idx];
    const zScale = clamp(1 - 0.4 * p.z, 0.75, 1.55);
    const boosted = active === hand ? opts.punchBoost : 0;
    const r = gloveBase * zScale * (1 + 0.3 * boosted);
    ctx.save();
    ctx.shadowColor = opts.style.color;
    ctx.shadowBlur = opts.style.glow * 0.8 + 24 * boosted;
    ctx.beginPath();
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    ctx.fillStyle = boosted > 0 ? mixColor(opts.style.color, '#ffffff', 0.25 * boosted) : '#23262f';
    ctx.globalAlpha = boosted > 0 ? 0.6 + 0.4 * boosted : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = withAlpha(opts.style.color, 0.95);
    ctx.stroke();
    // thumb / knuckle highlight
    ctx.beginPath();
    ctx.arc(q.x - r * 0.3, q.y - r * 0.3, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha('#ffffff', 0.08 + 0.25 * boosted);
    ctx.fill();
    ctx.restore();
  }

  return {
    head: { x: head.x, y: head.y, r: headR },
    body: mid(shoulderMid, hipMid),
    wrists,
    gloveR: gloveBase,
  };
}

/** Thin stick figure for the local PiP (mirror-style). */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  pose: Pose2,
  proj: Projection,
  color: string,
  minVis = 0.35,
): void {
  const vis = (i: number) => (pose[i]?.v ?? 0) >= minVis;
  const S: Vec[] = pose.map((p) => project(p, proj));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, proj.h * 0.018);
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  const seg = (a: number, b: number) => {
    if (!vis(a) || !vis(b)) return;
    ctx.beginPath();
    ctx.moveTo(S[a].x, S[a].y);
    ctx.lineTo(S[b].x, S[b].y);
    ctx.stroke();
  };
  for (const [a, b] of LEGS) seg(a, b);
  for (const [a, b] of ARMS) seg(a, b);
  seg(LM.L_SHOULDER, LM.R_SHOULDER);
  seg(LM.L_HIP, LM.R_HIP);
  seg(LM.L_SHOULDER, LM.L_HIP);
  seg(LM.R_SHOULDER, LM.R_HIP);
  if (vis(LM.NOSE) && vis(LM.L_SHOULDER) && vis(LM.R_SHOULDER)) {
    const sm = mid(S[LM.L_SHOULDER], S[LM.R_SHOULDER]);
    ctx.beginPath();
    ctx.moveTo(sm.x, sm.y);
    ctx.lineTo(S[LM.NOSE].x, S[LM.NOSE].y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(S[LM.NOSE].x, S[LM.NOSE].y, proj.h * 0.075, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = COLORS.text;
  for (const i of [LM.L_WRIST, LM.R_WRIST, LM.L_ELBOW, LM.R_ELBOW, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP]) {
    if (!vis(i)) continue;
    ctx.beginPath();
    ctx.arc(S[i].x, S[i].y, i === LM.L_WRIST || i === LM.R_WRIST ? proj.h * 0.03 : proj.h * 0.014, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
