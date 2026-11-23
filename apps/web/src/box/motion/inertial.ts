import type { Vec3 } from "../../pov/physics";
import type { Rig } from "./types";
import { angleBetween, cross, dot, rotate, unit, v3 } from "./vec";

/**
 * Inertial blending: when the motion switches from one clip to another, the
 * new clip plays as itself from its first frame, and what is left over (the
 * difference between what was on screen and where the new clip starts) dies
 * away on its own, keeping the speed it had. A cross-fade would show half of
 * each clip for a while: the fist swims. This does not.
 *
 * From David Bollo's talk on Gears of War 4 (2018), as written out in the
 * animation study. Here it works on bone directions and on the positions of
 * hips and feet, so no bone changes length while a blend runs.
 */

/** How long a switch takes to settle, seconds, by what it is. */
export const BLEND = {
  /** Into a punch. */
  punch: 0.1,
  /** A punch of a combination into the next. */
  chain: 0.14,
  /** Back to the guard. */
  guard: 0.22,
  /** One guard loop into the next. */
  loop: 0.3,
  /** Cut short by a hit. */
  hit: 0.06,
  /** Into and out of the fall. */
  fall: 0.2,
  /** The longest any switch may take, however far apart the two motions are. */
  most: 0.45,
};

/** A leftover dying away: its size at `t` seconds after the switch, and when it is gone. */
export interface Decay {
  at(t: number): number;
  t1: number;
}
const NONE: Decay = { at: () => 0, t1: 0 };

/**
 * A leftover of `x0` moving at `v0` a second, gone within `T` seconds. It
 * ends with no offset, no speed and no acceleration, and never crosses zero:
 * no pop and no overshoot.
 */
export function decay(x0: number, v0: number, T: number): Decay {
  // Worked on a positive leftover; the sign is put back at the end.
  const sign = x0 < 0 ? -1 : 1;
  const x = Math.abs(x0);
  if (x < 1e-9 || T <= 0) return NONE;
  let v = sign * v0;
  // Never head away from the target first.
  if (v > 0) v = 0;
  // Already closing fast: finish sooner than asked, or it would overshoot.
  const t1 = v < 0 ? Math.min(T, (-5 * x) / v) : T;
  if (t1 < 1e-5) return NONE;
  const t2 = t1 * t1;
  const a0 = Math.max(0, (-8 * v * t1 - 20 * x) / t2);
  const A = -(a0 * t2 + 6 * v * t1 + 12 * x) / (2 * t2 * t2 * t1);
  const B = (3 * a0 * t2 + 16 * v * t1 + 30 * x) / (2 * t2 * t2);
  const C = -(3 * a0 * t2 + 12 * v * t1 + 20 * x) / (2 * t2 * t1);
  return {
    t1,
    at(t: number): number {
      if (t >= t1) return 0;
      if (t <= 0) return sign * x;
      const value = ((((A * t + B) * t + C) * t + a0 / 2) * t + v) * t + x;
      // Rounding must not carry it across zero in the last instant.
      return sign * Math.max(0, value);
    },
  };
}

/** A point's leftover, one decay per axis. */
type PointLeft = [Decay, Decay, Decay];
/** A direction's leftover: a turn about one axis that dies away. */
interface TurnLeft {
  axis: Vec3;
  angle: Decay;
}
/** Everything left over from one switch. */
export interface RigBlend {
  since: number;
  until: number;
  hips: PointLeft;
  feet: [PointLeft, PointLeft];
  spine: TurnLeft;
  neck: TurnLeft;
  across: TurnLeft;
  upper: [TurnLeft, TurnLeft];
  fore: [TurnLeft, TurnLeft];
}

function pointLeft(shown: Vec3, before: Vec3, next: Vec3, nextBefore: Vec3, dt: number, T: number): PointLeft {
  const one = (s: number, b: number, n: number, nb: number): Decay => {
    const x0 = s - n;
    return decay(x0, dt > 0 ? (x0 - (b - nb)) / dt : 0, T);
  };
  return [
    one(shown.x, before.x, next.x, nextBefore.x),
    one(shown.y, before.y, next.y, nextBefore.y),
    one(shown.z, before.z, next.z, nextBefore.z),
  ];
}
function turnLeft(shown: Vec3, before: Vec3, next: Vec3, nextBefore: Vec3, dt: number, T: number): TurnLeft {
  // The shortest turn that takes the new direction to the one on screen.
  const x0 = angleBetween(next, shown);
  if (x0 < 1e-6) return { axis: v3(0, 1, 0), angle: NONE };
  const axis = unit(cross(next, shown), v3(0, 1, 0));
  // The same one frame earlier, measured about the same axis.
  const earlier = angleBetween(nextBefore, before);
  const about = earlier > 1e-6 ? earlier * dot(unit(cross(nextBefore, before), axis), axis) : 0;
  return { axis, angle: decay(x0, dt > 0 ? (x0 - about) / dt : 0, T) };
}

/**
 * Start a blend at a switch. `shown` and `before` are what was on screen now
 * and a frame ago (with any earlier blend still in them, so blends stack);
 * `next` and `nextBefore` are what the new motion gives now and would have
 * given a frame ago. `T` is how long it may take.
 */
export function startBlend(shown: Rig, before: Rig, next: Rig, nextBefore: Rig, dt: number, T: number, now: number): RigBlend {
  const turn = (pickDirection: (r: Rig) => Vec3) =>
    turnLeft(pickDirection(shown), pickDirection(before), pickDirection(next), pickDirection(nextBefore), dt, T);
  const point = (pickPoint: (r: Rig) => Vec3) =>
    pointLeft(pickPoint(shown), pickPoint(before), pickPoint(next), pickPoint(nextBefore), dt, T);
  return {
    since: now,
    until: now + T,
    hips: point((r) => r.hips),
    feet: [point((r) => r.feet[0]), point((r) => r.feet[1])],
    spine: turn((r) => r.spine),
    neck: turn((r) => r.neck),
    across: turn((r) => r.across),
    upper: [turn((r) => r.upper[0]), turn((r) => r.upper[1])],
    fore: [turn((r) => r.fore[0]), turn((r) => r.fore[1])],
  };
}

/** The new motion's bones with what is left of the blend laid over them. */
export function applyBlend(blend: RigBlend | null, rig: Rig, now: number): Rig {
  if (!blend) return rig;
  const t = now - blend.since;
  if (t >= blend.until - blend.since) return rig;
  const point = (p: Vec3, left: PointLeft): Vec3 => v3(p.x + left[0].at(t), p.y + left[1].at(t), p.z + left[2].at(t));
  const turn = (d: Vec3, left: TurnLeft): Vec3 => {
    const angle = left.angle.at(t);
    return angle === 0 ? d : rotate(d, left.axis, angle);
  };
  return {
    hips: point(rig.hips, blend.hips),
    feet: [point(rig.feet[0], blend.feet[0]), point(rig.feet[1], blend.feet[1])],
    spine: turn(rig.spine, blend.spine),
    neck: turn(rig.neck, blend.neck),
    across: turn(rig.across, blend.across),
    upper: [turn(rig.upper[0], blend.upper[0]), turn(rig.upper[1], blend.upper[1])],
    fore: [turn(rig.fore[0], blend.fore[0]), turn(rig.fore[1], blend.fore[1])],
  };
}

/** Nothing is left of it. */
export const blendOver = (blend: RigBlend | null, now: number): boolean => !blend || now >= blend.until;
