import type { Vec3 } from "../../pov/physics";
import { twoBone } from "../../pov/body";
import { gloveOf, poleOf, wristFor } from "./sampler";
import { SIZE, type Body, type MotionLevel } from "./types";
import { add, angleBetween, clamp, cross, distance, dot, length, rotate, scale, smooth, sub, unit, v3 } from "./vec";

/**
 * Making the fist arrive.
 *
 * A recorded punch lands where the boxer threw it. The player's head is
 * somewhere else, by a little. So between the fist leaving and contact the
 * glove is bent toward a target, more and more, and at contact it is on it.
 *
 * What keeps this honest:
 *  - the target stops following the head at the commit (the player object
 *    does that), so a head that moves afterwards is missed;
 *  - the difference is shared: the hips shift up to 10 cm along the punch,
 *    the trunk turns up to 8 degrees, the arm does the rest;
 *  - a bend of more than 25 degrees at the shoulder is refused, and the
 *    punch plays its own line: over that the elbow snaps and it looks broken;
 *  - the glove is never nearer than 0.26 m to the player's eye, where it
 *    would fill the picture; a punch that would be jams with the elbow bent.
 */
export const AIM = {
  /** Metres the hips may shift along the punch, either way. */
  hips: 0.1,
  /** Radians the trunk may turn about the hips. */
  chest: (8 * Math.PI) / 180,
  /** Radians of bend at the shoulder beyond which the warp is refused. */
  bend: (25 * Math.PI) / 180,
  /** The glove's centre is never nearer the eye than this. */
  near: 0.26,
  /** A punch that misses passes at least this far from the eye. */
  pass: 0.2,
  /** The elbow is never straightened past this, radians. */
  straight: (170 * Math.PI) / 180,
};
export type AimLimits = typeof AIM;

/**
 * A punch stops this far short of the player's eye. The same number as
 * opponentPose.ts (a test holds the two together); written here so the
 * motion code does not pull the old rules in with it.
 */
export const STOP_SHORT = 0.3;
/** The longest a shoulder-to-wrist line may be: the arm with its elbow at 170 degrees. */
export const MAX_REACH = Math.sqrt(
  SIZE.upperArm ** 2 + SIZE.forearm ** 2 - 2 * SIZE.upperArm * SIZE.forearm * Math.cos(AIM.straight),
);
const MIN_REACH = 0.08;

/**
 * Where the glove should be at contact, from the player's eye in the
 * opponent's frame: 0.30 m short of the eye for a head punch, lower and
 * further out for a body punch (the numbers opponentPose.ts uses).
 */
export function gloveTarget(eye: Vec3, level: MotionLevel): Vec3 {
  if (level === "body") return v3(eye.x * 0.5, eye.y - 0.26, eye.z - 0.5);
  return v3(eye.x, eye.y, eye.z - STOP_SHORT);
}

/**
 * How much of the warp is on at a time of the clip: none until the fist
 * leaves, all of it at contact, then let go over the first part of the way
 * home so the recorded recovery takes over.
 */
export function aimWeight(clipTime: number, t: { launch: number; contact: number; guard: number }): number {
  if (clipTime <= t.launch) return 0;
  if (clipTime <= t.contact) return smooth((clipTime - t.launch) / Math.max(1e-6, t.contact - t.launch));
  return 1 - smooth((clipTime - t.contact) / Math.max(1e-6, 0.6 * (t.guard - t.contact)));
}

/** How far the arm must be bent, radians at the shoulder, to land on `target` instead of where the clip lands (`own`). */
export const bendOf = (shoulder: Vec3, own: Vec3, target: Vec3): number =>
  angleBetween(sub(own, shoulder), sub(target, shoulder));

/**
 * Where the glove ends, given where the head is now. `frozen` is the target
 * fixed at the commit and `aimedAt` the eye as it was then. If the head has
 * since left that place the punch has missed: it does not stop where the
 * head was but goes on past, wide of the ear, as opponentPose.ts has it. A
 * body punch stops where it was aimed.
 */
export function settleTarget(frozen: Vec3, aimedAt: Vec3, eye: Vec3, level: MotionLevel): Vec3 {
  if (level === "body") return frozen;
  const off = Math.hypot(aimedAt.x - eye.x, aimedAt.y - eye.y);
  const past = smooth((off - 0.08) / 0.08);
  if (past <= 0) return frozen;
  const wide = Math.max(0, AIM.pass - Math.abs(frozen.x - eye.x)) * past;
  const over = frozen.y - eye.y > 0 ? Math.max(0, AIM.pass - (frozen.y - eye.y)) * past : 0;
  // On the side of the eye it already is; dead level, the side the head left it on.
  const side = frozen.x !== eye.x ? Math.sign(frozen.x - eye.x) : Math.sign(aimedAt.x - eye.x) || 1;
  return v3(frozen.x + side * wide, frozen.y + over, frozen.z + (STOP_SHORT + 0.2) * past);
}

/** Everything above the feet moved by `by`. */
function shiftTrunk(b: Body, by: Vec3): Body {
  const m = (p: Vec3) => add(p, by);
  return {
    ...b,
    hips: m(b.hips),
    chest: m(b.chest),
    head: m(b.head),
    shoulders: [m(b.shoulders[0]), m(b.shoulders[1])],
    elbows: [m(b.elbows[0]), m(b.elbows[1])],
    wrists: [m(b.wrists[0]), m(b.wrists[1])],
  };
}
/** Everything above the hips turned about them. */
function turnTrunk(b: Body, axis: Vec3, angle: number): Body {
  const m = (p: Vec3) => add(b.hips, rotate(sub(p, b.hips), axis, angle));
  return {
    ...b,
    chest: m(b.chest),
    head: m(b.head),
    shoulders: [m(b.shoulders[0]), m(b.shoulders[1])],
    elbows: [m(b.elbows[0]), m(b.elbows[1])],
    wrists: [m(b.wrists[0]), m(b.wrists[1])],
  };
}
/** One arm solved to put its glove on `glove`, keeping the way the elbow swings. Short of it if it cannot reach. */
export function armTo(b: Body, hand: 0 | 1, glove: Vec3): Body {
  const shoulder = b.shoulders[hand];
  let wrist = wristFor(shoulder, glove);
  const far = distance(wrist, shoulder);
  // Never straight past 170 degrees, never folded into the shoulder.
  const reach = clamp(far, MIN_REACH, MAX_REACH);
  if (far > 1e-6 && reach !== far) wrist = add(shoulder, scale(sub(wrist, shoulder), reach / far));
  const pole = poleOf(shoulder, b.elbows[hand], b.wrists[hand]);
  const elbow = twoBone(shoulder, wrist, SIZE.upperArm, SIZE.forearm, pole);
  const elbows: [Vec3, Vec3] = [b.elbows[0], b.elbows[1]];
  const wrists: [Vec3, Vec3] = [b.wrists[0], b.wrists[1]];
  elbows[hand] = elbow;
  wrists[hand] = wrist;
  return { ...b, elbows, wrists };
}

/**
 * The body with one glove moved to `glove`, the move shared between hips,
 * trunk and arm. The hips take half of what lies along the punch, up to
 * their limit; the trunk turns half of the angle that is left, up to its
 * limit; the arm takes the rest. If the arm cannot do its share (it would
 * have to straighten past its limit), the hips take what it lacks, and
 * when they are at their limit too the trunk gives its whole share.
 */
export function reachTo(b: Body, hand: 0 | 1, glove: Vec3, limits: AimLimits = AIM): Body {
  const from = gloveOf(b.shoulders[hand], b.wrists[hand]);
  const move = sub(glove, from);
  if (length(move) < 1e-6) return b;
  // Along the punch, level with the floor.
  const line = unit(v3(from.x - b.shoulders[hand].x, 0, from.z - b.shoulders[hand].z), v3(0, 0, 1));
  const solve = (carried: number, share: number): Body => {
    const hips = scale(line, carried);
    let out = shiftTrunk(b, hips);
    const arm = sub(add(from, hips), out.hips);
    const want = sub(glove, out.hips);
    const turn = Math.min(limits.chest, share * angleBetween(arm, want));
    if (turn > 1e-5) out = turnTrunk(out, unit(cross(arm, want), v3(0, 1, 0)), turn);
    return armTo(out, hand, glove);
  };
  /** How far short of the target the glove is, and which way along the punch the rest lies. */
  const lacking = (x: Body) => {
    const left = sub(glove, gloveOf(x.shoulders[hand], x.wrists[hand]));
    return { by: length(left), way: dot(left, line) >= 0 ? 1 : -1 };
  };
  let carried = clamp(0.5 * dot(move, line), -limits.hips, limits.hips);
  let out = solve(carried, 0.5);
  let lack = lacking(out);
  // What the arm lacks, the hips carry: exactly as much, so the body moves
  // no faster than the target does.
  for (let i = 0; i < 4 && lack.by > 1e-6; i++) {
    const more = clamp(carried + lack.way * lack.by, -limits.hips, limits.hips);
    if (more === carried) break;
    carried = more;
    out = solve(carried, 0.5);
    lack = lacking(out);
  }
  if (lack.by <= 1e-6) return out;
  // Hips at their limit and still short: the trunk gives the rest of its
  // share, all of it by the time the glove is 4 cm short.
  return solve(carried, 0.5 + 0.5 * smooth(lack.by / 0.04));
}

/** Both gloves kept clear of the eye: one that is nearer than `near` is pushed straight out to that distance, arm bent. */
export function keepClear(b: Body, eye: Vec3, near: number = AIM.near): Body {
  if (near <= 0) return b;
  let out = b;
  for (const hand of [0, 1] as const) {
    const glove = gloveOf(out.shoulders[hand], out.wrists[hand]);
    const gap = distance(glove, eye);
    if (gap >= near) continue;
    // Straight away from the eye; dead on it, back toward the opponent.
    const away = unit(sub(glove, eye), v3(0, 0, -1));
    out = armTo(out, hand, add(eye, scale(away, near)));
    // The arm may not reach that far out: then the shoulder is too near, and the trunk gives way.
    const now = gloveOf(out.shoulders[hand], out.wrists[hand]);
    const short = near - distance(now, eye);
    if (short > 1e-4) out = shiftTrunk(out, scale(unit(sub(now, eye), v3(0, 0, -1)), short));
  }
  return out;
}
