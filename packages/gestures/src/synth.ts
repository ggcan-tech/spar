/**
 * Synthetic MediaPipe-style pose sequences for tests and replays: a stick-figure boxer in guard
 * stance facing the camera. Coordinates follow MediaPipe conventions: image-normalized x,y in 0..1
 * (origin top-left, NOT mirrored, so the figure's own left is at larger x), z in the same scale as x
 * (smaller = closer to the camera).
 *
 * Geometry is expressed in body units (shoulder width = 1, mid-shoulder origin, +x = figure's left,
 * +y = down, −z = toward the camera) and then placed in the image by `Figure`.
 */
import { LANDMARK_COUNT, LM, type Landmark, type PoseFrame, type PunchKind, type Stance } from '@spar/protocol';

export interface Vec3 { x: number; y: number; z: number }
export type Hand = 'L' | 'R';

export interface Figure {
  stance: Stance;
  /** shoulder width in image-normalized units */
  sw: number;
  /** image position of the mid-shoulder at neutral */
  cx: number;
  cy: number;
  /** arm segment lengths, body units */
  upperArm: number;
  foreArm: number;
  femur: number;
  tibia: number;
  /** z offset of the lead shoulder toward the camera (bladed stance) */
  blade: number;
  /** nose position at neutral, body units */
  nose: Vec3;
}

export const FIGURE: Figure = {
  stance: 'orthodox',
  sw: 0.16,
  cx: 0.5,
  cy: 0.36,
  upperArm: 1.1,
  foreArm: 1.1,
  femur: 1.2,
  tibia: 1.15,
  blade: 0.15,
  nose: { x: 0, y: -0.65, z: -0.25 },
};
/** true wrist–shoulder reach of the default figure, body units */
export const ARM_LEN = FIGURE.upperArm + FIGURE.foreArm;

export interface ClipOpts { fps?: number; figure?: Partial<Figure> }
const DEFAULT_FPS = 30;

// ───────────── vector helpers ─────────────
const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.sqrt(dot(a, a));
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return mul(a, 1 / l); };
const lerp = (a: Vec3, b: Vec3, s: number): Vec3 => add(a, mul(sub(b, a), s));
/** sine ease-in-out: velocity profile ∝ sin(πs), peak 1.57× mean — roughly human */
export const ease = (s: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, s)));

/** Two-bone IK: joint position for segments a (root→joint) and b (joint→tip), bending toward `hint`. */
export function ik(root: Vec3, tip: Vec3, a: number, b: number, hint: Vec3): Vec3 {
  const d = sub(tip, root);
  let dl = len(d);
  if (dl < 1e-9) return add(root, mul(norm(hint), a));
  const axis = mul(d, 1 / dl);
  dl = Math.min(dl, a + b - 1e-6);
  dl = Math.max(dl, Math.abs(a - b) + 1e-6);
  const x = (a * a - b * b + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const perpRaw = sub(hint, mul(axis, dot(hint, axis)));
  const perp = len(perpRaw) < 1e-6 ? v3(0, 1, 0) : norm(perpRaw);
  return add(add(root, mul(axis, x)), mul(perp, h));
}

// ───────────── figure ─────────────
const side = (h: Hand): number => (h === 'L' ? 1 : -1);
export const leadHand = (stance: Stance): Hand => (stance === 'orthodox' ? 'L' : 'R');
export const rearHand = (stance: Stance): Hand => (stance === 'orthodox' ? 'R' : 'L');

export function shoulder(fig: Figure, h: Hand): Vec3 {
  const lead = leadHand(fig.stance) === h;
  return v3(0.5 * side(h), 0, lead ? -fig.blade : fig.blade);
}
/** guard wrist: near the chin, forward of the shoulder (e ≈ 0.31 for the default figure) */
export function guardWrist(fig: Figure, h: Hand): Vec3 {
  return add(shoulder(fig, h), v3(-0.2 * side(h), -0.35, -0.55));
}
const guardHint = (h: Hand): Vec3 => v3(0.4 * side(h), 1, 0.1);

export interface Pose {
  wrist: Record<Hand, Vec3>;
  hint: Record<Hand, Vec3>;
  /** head offset from neutral, body units */
  head: Vec3;
  /** whole-figure translation (body units). `dy` does not move the ankles (knees bend via IK). */
  dx: number;
  dy: number;
  /** image scale about the image center (1 = neutral) — models stepping toward/away from the camera */
  scale: number;
}

export function neutralPose(fig: Figure): Pose {
  return {
    wrist: { L: guardWrist(fig, 'L'), R: guardWrist(fig, 'R') },
    hint: { L: guardHint('L'), R: guardHint('R') },
    head: v3(0, 0, 0),
    dx: 0,
    dy: 0,
    scale: 1,
  };
}

function withFigure(opts?: ClipOpts): Figure {
  return { ...FIGURE, ...(opts?.figure ?? {}), nose: { ...FIGURE.nose, ...(opts?.figure?.nose ?? {}) } };
}

/** Build the 33 landmarks for a pose. */
export function render(pose: Pose, fig: Figure): Landmark[] {
  const B: Vec3[] = new Array(LANDMARK_COUNT).fill(null).map(() => v3(0, 0, 0));
  const set = (i: number, p: Vec3) => { B[i] = p; };
  const nose = add(fig.nose, pose.head);
  set(LM.NOSE, nose);
  set(1, add(nose, v3(0.05, -0.08, 0.05)));       // L eye inner
  set(LM.L_EYE, add(nose, v3(0.09, -0.1, 0.05)));
  set(3, add(nose, v3(0.13, -0.1, 0.06)));        // L eye outer
  set(4, add(nose, v3(-0.05, -0.08, 0.05)));      // R eye inner
  set(LM.R_EYE, add(nose, v3(-0.09, -0.1, 0.05)));
  set(6, add(nose, v3(-0.13, -0.1, 0.06)));       // R eye outer
  set(LM.L_EAR, add(nose, v3(0.19, -0.05, 0.25)));
  set(LM.R_EAR, add(nose, v3(-0.19, -0.05, 0.25)));
  set(LM.MOUTH_L, add(nose, v3(0.06, 0.13, 0.05)));
  set(LM.MOUTH_R, add(nose, v3(-0.06, 0.13, 0.05)));

  for (const h of ['L', 'R'] as Hand[]) {
    const S = shoulder(fig, h);
    const W = pose.wrist[h];
    const E = ik(S, W, fig.upperArm, fig.foreArm, pose.hint[h]);
    const idx = h === 'L'
      ? { s: LM.L_SHOULDER, e: LM.L_ELBOW, w: LM.L_WRIST, pinky: 17, index: 19, thumb: 21, hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE, heel: 29, foot: 31 }
      : { s: LM.R_SHOULDER, e: LM.R_ELBOW, w: LM.R_WRIST, pinky: 18, index: 20, thumb: 22, hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE, heel: 30, foot: 32 };
    set(idx.s, S);
    set(idx.e, E);
    set(idx.w, W);
    const fwd = norm(sub(W, E));
    set(idx.pinky, add(W, add(mul(fwd, 0.12), v3(0.05 * side(h), 0, 0))));
    set(idx.index, add(W, add(mul(fwd, 0.13), v3(-0.04 * side(h), 0, 0))));
    set(idx.thumb, add(W, add(mul(fwd, 0.08), v3(-0.06 * side(h), -0.03, 0))));

    // legs: ankles stay on the floor, hips move with dy, knees via IK bending forward/outward
    const hipBase = v3(0.38 * side(h), 1.35, 0);
    const ankle = v3(0.38 * side(h), 1.35 + fig.femur + fig.tibia, 0);
    const hip = add(hipBase, v3(0, pose.dy, 0));
    const knee = ik(hip, ankle, fig.femur, fig.tibia, v3(0.3 * side(h), 0, -1));
    set(idx.hip, hip);
    set(idx.knee, knee);
    set(idx.ankle, ankle);
    set(idx.heel, add(ankle, v3(0, 0.12, 0.1)));
    set(idx.foot, add(ankle, v3(0.05 * side(h), 0.15, -0.25)));
  }

  const ankles = new Set<number>([LM.L_ANKLE, LM.R_ANKLE, 29, 30, 31, 32]);
  const kneesAndBelow = new Set<number>([LM.L_KNEE, LM.R_KNEE, ...ankles]);
  const out: Landmark[] = new Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = B[i];
    // dy is a whole-body drop; ankles are fixed on the floor and knees were solved above in absolute terms
    const dy = kneesAndBelow.has(i) ? 0 : pose.dy;
    let x = fig.cx + fig.sw * (p.x + pose.dx);
    let y = fig.cy + fig.sw * (p.y + dy);
    let z = fig.sw * p.z;
    x = 0.5 + (x - 0.5) * pose.scale;
    y = 0.5 + (y - 0.5) * pose.scale;
    z *= pose.scale;
    const inFrame = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    out[i] = { x, y, z, v: inFrame ? 0.98 : 0.3 };
  }
  return out;
}

function toWorld(lm: Landmark[], fig: Figure): Landmark[] {
  const hx = (lm[LM.L_HIP].x + lm[LM.R_HIP].x) / 2;
  const hy = (lm[LM.L_HIP].y + lm[LM.R_HIP].y) / 2;
  const hz = (lm[LM.L_HIP].z + lm[LM.R_HIP].z) / 2;
  const k = 0.39 / fig.sw; // shoulder width ≈ 0.39 m
  return lm.map((p) => ({ x: (p.x - hx) * k, y: (p.y - hy) * k, z: (p.z - hz) * k, v: p.v }));
}

/** Sample `poseAt(tMs)` over [0, durationMs] at `fps`; frames start at t = 0. */
export function animate(durationMs: number, poseAt: (tMs: number) => Pose, opts?: ClipOpts): PoseFrame[] {
  const fps = opts?.fps ?? DEFAULT_FPS;
  const fig = withFigure(opts);
  const dt = 1000 / fps;
  const n = Math.max(1, Math.floor(durationMs / dt + 1e-9) + 1);
  const frames: PoseFrame[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const lm = render(poseAt(t), fig);
    frames.push({ t, lm, world: toWorld(lm, fig) });
  }
  return frames;
}

// ───────────── clips ─────────────
export function guard(durationMs: number, opts?: ClipOpts): PoseFrame[] {
  const fig = withFigure(opts);
  const p = neutralPose(fig);
  return animate(durationMs, () => p, opts);
}

/** Straight punch target: `extension` × armLen from the shoulder, mostly forward (−z), small lateral travel. */
export function straightTarget(fig: Figure, h: Hand, extension: number, body: boolean): Vec3 {
  const S = shoulder(fig, h);
  const dir = norm(v3(-0.1 * side(h), body ? 0.5 : -0.12, -1));
  return add(S, mul(dir, extension * (fig.upperArm + fig.foreArm)));
}

export interface PunchOpts extends ClipOpts {
  /** time from guard to peak extension */
  durationMs?: number;
  /** time from peak back to guard */
  returnMs?: number;
  /** fraction of armLen reached at the peak (straights) */
  extension?: number;
}

/** Straight: wrist from guard to `extension`·armLen along the forward direction. Peak at t = durationMs. */
export function straight(h: Hand, o: PunchOpts & { body?: boolean } = {}): PoseFrame[] {
  const fig = withFigure(o);
  const dur = o.durationMs ?? 150;
  const ret = o.returnMs ?? Math.round(dur * 1.4);
  const G = guardWrist(fig, h);
  const T = straightTarget(fig, h, o.extension ?? 0.95, !!o.body);
  const hint = v3(0.5 * side(h), 1, 0);
  return animate(dur + ret, (t) => {
    const p = neutralPose(fig);
    const s = t <= dur ? ease(t / dur) : 1 - ease((t - dur) / ret);
    p.wrist[h] = lerp(G, T, s);
    p.hint[h] = lerp(guardHint(h), hint, s);
    return p;
  }, o);
}

export const jab = (h: Hand, o: PunchOpts = {}): PoseFrame[] => straight(h, o);
export const bodyPunch = (h: Hand, o: PunchOpts = {}): PoseFrame[] => straight(h, { ...o, body: true });

/**
 * Hook: elbow stays bent (≈107° at the peak), the fist swings out to the side and forward, then
 * sweeps across the midline at chin height (quadratic arc). Peak at t = durationMs.
 */
export function hook(h: Hand, o: PunchOpts & { elbowDeg?: number } = {}): PoseFrame[] {
  const fig = withFigure(o);
  const dur = o.durationMs ?? 180;
  const ret = o.returnMs ?? Math.round(dur * 1.4);
  const S = shoulder(fig, h);
  const G = guardWrist(fig, h);
  // peak wrist–shoulder distance from the elbow angle (law of cosines), direction across the midline
  const elbow = ((o.elbowDeg ?? 107) * Math.PI) / 180;
  const reach = Math.sqrt(fig.upperArm ** 2 + fig.foreArm ** 2 - 2 * fig.upperArm * fig.foreArm * Math.cos(elbow));
  const T = add(S, mul(norm(v3(-0.5 * side(h), -0.18, -1)), reach));
  const C = add(S, v3(1.0 * side(h), -0.3, -0.9));      // control point: fist out to the side, forward
  const hint = v3(1 * side(h), -0.15, 0.1);
  const arc = (s: number): Vec3 => add(add(mul(G, (1 - s) ** 2), mul(C, 2 * (1 - s) * s)), mul(T, s * s));
  return animate(dur + ret, (t) => {
    const p = neutralPose(fig);
    if (t <= dur) {
      const s = ease(t / dur);
      p.wrist[h] = arc(s);
      p.hint[h] = lerp(guardHint(h), hint, Math.min(1, s * 2));
    } else {
      const s = ease((t - dur) / ret);
      p.wrist[h] = lerp(T, G, s);
      p.hint[h] = lerp(hint, guardHint(h), s);
    }
    return p;
  }, o);
}

/**
 * Uppercut: short dip below the chest, then the wrist rises fast to above the shoulder line with the
 * elbow bent (≈113° at the peak). Peak at t = dipMs + durationMs.
 */
export function uppercut(h: Hand, o: PunchOpts & { dipMs?: number } = {}): PoseFrame[] {
  const fig = withFigure(o);
  const dip = o.dipMs ?? 100;
  const dur = o.durationMs ?? 150;
  const ret = o.returnMs ?? Math.round(dur * 1.5);
  const S = shoulder(fig, h);
  const G = guardWrist(fig, h);
  const D = add(S, v3(-0.1 * side(h), 0.6, -0.5));
  const T = add(S, v3(-0.3 * side(h), -0.75, -1.65));  // |T−S| ≈ 1.84 → e ≈ 0.835
  const hintDip = v3(0.3 * side(h), 1, 0.2);
  const hintUp = v3(0.3 * side(h), 1, -0.4);
  return animate(dip + dur + ret, (t) => {
    const p = neutralPose(fig);
    if (t <= dip) {
      const s = ease(t / dip);
      p.wrist[h] = lerp(G, D, s);
      p.hint[h] = lerp(guardHint(h), hintDip, s);
    } else if (t <= dip + dur) {
      const s = ease((t - dip) / dur);
      p.wrist[h] = lerp(D, T, s);
      p.hint[h] = lerp(hintDip, hintUp, s);
    } else {
      const s = ease((t - dip - dur) / ret);
      p.wrist[h] = lerp(T, G, s);
      p.hint[h] = lerp(hintUp, guardHint(h), s);
    }
    return p;
  }, o);
}

/** Build the clip for a `PunchKind` given the stance (lead/rear → physical hand). */
export function punch(kind: PunchKind, stance: Stance = 'orthodox', o: PunchOpts & { body?: boolean } = {}): PoseFrame[] {
  const lead = kind === 'JAB' || kind === 'LEAD_HOOK' || kind === 'LEAD_UPPER';
  const h = lead ? leadHand(stance) : rearHand(stance);
  switch (kind) {
    case 'JAB': case 'CROSS': return straight(h, o);
    case 'LEAD_HOOK': case 'REAR_HOOK': return hook(h, o);
    case 'LEAD_UPPER': case 'REAR_UPPER': return uppercut(h, o);
  }
}
/** Time of peak extension within a `punch()` clip, ms from its first frame. */
export function punchPeakMs(kind: PunchKind, o: PunchOpts & { dipMs?: number } = {}): number {
  const dur = o.durationMs ?? (kind === 'JAB' || kind === 'CROSS' ? 150 : kind.endsWith('HOOK') ? 180 : 150);
  return kind.endsWith('UPPER') ? (o.dipMs ?? 100) + dur : dur;
}

export interface MoveOpts extends ClipOpts { moveMs?: number; holdMs?: number; returnMs?: number }

function outAndBack(total: (o: MoveOpts) => [number, number, number], apply: (p: Pose, s: number) => void, o: MoveOpts): PoseFrame[] {
  const fig = withFigure(o);
  const [move, hold, ret] = total(o);
  return animate(move + hold + ret, (t) => {
    const p = neutralPose(fig);
    const s = t <= move ? ease(t / move) : t <= move + hold ? 1 : 1 - ease((t - move - hold) / ret);
    apply(p, s);
    return p;
  }, o);
}
const timing = (o: MoveOpts, m: number, h: number, r: number): [number, number, number] => [o.moveMs ?? m, o.holdMs ?? h, o.returnMs ?? r];

/** Slip: head moves 0.5 units toward the figure's own side (`'L'` = +x image), shoulders stay. */
export function slip(dir: 'L' | 'R', o: MoveOpts & { amount?: number } = {}): PoseFrame[] {
  const amt = (o.amount ?? 0.5) * (dir === 'L' ? 1 : -1);
  return outAndBack((oo) => timing(oo, 200, 300, 200), (p, s) => { p.head = v3(amt * s, 0.05 * s, 0); }, o);
}

/** Duck: whole upper body drops `amount` shoulder widths (knees bend, ankles fixed), head tucks a bit more. */
export function duck(o: MoveOpts & { amount?: number } = {}): PoseFrame[] {
  const amt = o.amount ?? 0.5;
  return outAndBack((oo) => timing(oo, 220, 300, 220), (p, s) => { p.dy = amt * s; p.head = v3(0, 0.1 * s, 0.05 * s); }, o);
}

/** Lateral step: the whole figure translates `amount` shoulder widths in image x (+ = figure's left). */
export function step(dir: 'L' | 'R', o: MoveOpts & { amount?: number } = {}): PoseFrame[] {
  const amt = (o.amount ?? 0.75) * (dir === 'L' ? 1 : -1);
  return outAndBack((oo) => timing(oo, 250, 200, 250), (p, s) => { p.dx = amt * s; }, o);
}
export const stepL = (o: MoveOpts & { amount?: number } = {}): PoseFrame[] => step('L', o);
export const stepR = (o: MoveOpts & { amount?: number } = {}): PoseFrame[] => step('R', o);

/** Step toward (`ratio` > 1) or away from the camera: image scale about the image center. */
export function stepScale(ratio: number, o: MoveOpts = {}): PoseFrame[] {
  return outAndBack((oo) => timing(oo, 300, 300, 300), (p, s) => { p.scale = 1 + (ratio - 1) * s; }, o);
}
export const stepIn = (o: MoveOpts & { ratio?: number } = {}): PoseFrame[] => stepScale(o.ratio ?? 1.16, o);
export const stepOut = (o: MoveOpts & { ratio?: number } = {}): PoseFrame[] => stepScale(o.ratio ?? 0.86, o);

/** Both wrists raised above the head for `holdMs` (default 400 ms). */
export function getUp(o: MoveOpts = {}): PoseFrame[] {
  return outAndBack((oo) => timing(oo, 250, 400, 250), (p, s) => {
    for (const h of ['L', 'R'] as Hand[]) {
      const G = p.wrist[h];
      p.wrist[h] = lerp(G, v3(0.35 * side(h), -1.4, -0.4), s);
      p.hint[h] = lerp(guardHint(h), v3(0.8 * side(h), 0.2, 0), s);
    }
  }, o);
}

/** Calibration clip: guard, full extension of each hand, guard. ≈2.2 s. */
export function calibrationClip(o: ClipOpts & { stance?: Stance } = {}): PoseFrame[] {
  const oo: ClipOpts = { ...o, figure: { ...(o.figure ?? {}), ...(o.stance ? { stance: o.stance } : {}) } };
  return sequence([
    guard(600, oo),
    straight('L', { ...oo, durationMs: 250, returnMs: 300, extension: 1.0 }),
    guard(250, oo),
    straight('R', { ...oo, durationMs: 250, returnMs: 300, extension: 1.0 }),
    guard(300, oo),
  ]);
}

// ───────────── composition ─────────────
/** Concatenate clips with continuous timestamps. `starts[i]` = absolute start time of clip i. */
export function sequenceWithStarts(clips: PoseFrame[][], fps = DEFAULT_FPS): { frames: PoseFrame[]; starts: number[] } {
  const dt = 1000 / fps;
  const frames: PoseFrame[] = [];
  const starts: number[] = [];
  let offset = 0;
  for (const clip of clips) {
    starts.push(offset);
    if (clip.length === 0) continue;
    const t0 = clip[0].t;
    for (const f of clip) frames.push({ t: offset + (f.t - t0), lm: f.lm, world: f.world });
    offset += clip[clip.length - 1].t - t0 + dt;
  }
  return { frames, starts };
}
export function sequence(clips: PoseFrame[][], fps = DEFAULT_FPS): PoseFrame[] {
  return sequenceWithStarts(clips, fps).frames;
}

/** Deterministic xorshift-based uniform RNG in [0,1). */
export function rng(seed = 1): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Add Gaussian jitter (image units) to x,y and 2·sigma to z (MediaPipe depth is noisier). */
export function withNoise(frames: PoseFrame[], sigma: number, seed = 1): PoseFrame[] {
  const r = rng(seed);
  const gauss = () => {
    const u = Math.max(r(), 1e-12), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return frames.map((f) => ({
    t: f.t,
    world: f.world,
    lm: f.lm.map((p) => ({ x: p.x + gauss() * sigma, y: p.y + gauss() * sigma, z: p.z + gauss() * sigma * 2, v: p.v })),
  }));
}

/** Set visibility of the given landmark indices to `v` (default 0.2) on every frame. */
export function withVisibility(frames: PoseFrame[], indices: number[], v = 0.2): PoseFrame[] {
  const set = new Set(indices);
  return frames.map((f) => ({ ...f, lm: f.lm.map((p, i) => (set.has(i) ? { ...p, v } : p)) }));
}
