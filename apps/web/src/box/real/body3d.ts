import type { Landmark } from "@spar/protocol";
import { BODY, JOINT, twoBone, type ArmLengths } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import type { TrackingResult } from "../../pov/tracking";
import { solveArm, type AimSetup, type AimSource } from "../read/aim";

/**
 * The player as a body in the ring: one to one.
 *
 * Everything is in the player's own room: the origin on the floor at their
 * spot, +x their right, +y up, +z toward the opponent, in game units (a body
 * whose shoulders are 0.4 wide and whose hips stand 1 high, so about metres).
 * Nothing is made larger than it was: a head that moved a hand's width moves
 * a hand's width, an arm that went out its whole length is drawn its whole
 * length out, and a step toward the screen is a step toward the opponent.
 *
 * Where the body is across the picture comes from the camera's picture. The
 * arms come from the body model's own three-dimensional estimate (its "world"
 * landmarks): which way the upper arm points, which way the forearm points.
 * Those two directions are laid out on bones of the player's own length. No
 * set-up gesture is asked for and nothing is guessed about which way a
 * forearm leans: the model has seen millions of arms and says so itself.
 *
 * This is what a real person's recording showed (14 Nov, Can's camera): the
 * model's arms were smooth and sensible (fists 28 cm in front of the
 * shoulders in a guard, 45 at full reach), while the arm solved from the
 * picture and a "reach out" set-up was rotated 38° by a set-up that was not
 * held, and stuck at full stretch because the bones had been measured in the
 * wrong unit.
 *
 * Size. The tracker's own unit calls the shoulders 0.4 wide, but the model's
 * shoulder points sit well inside a person's real shoulders (0.31 m on that
 * recording), so in that unit a person comes out a quarter too large. Here
 * everything is in metres: the tracker's unit is turned into metres by the
 * torso, which the model reports in metres (`createBodyScale`).
 *
 * (Without world landmarks the arm is solved from the picture: with an aim
 * set-up in real distances, see read/aim.ts; without one, along the camera's
 * own axis.)
 */
export interface Me3D {
  /** The pose's own time, ms. */
  t: number;
  /** The eyes. */
  head: Vec3;
  hips: Vec3;
  /** [left, right] */
  shoulders: [Vec3, Vec3];
  elbows: [Vec3, Vec3];
  wrists: [Vec3, Vec3];
  /** The middle of each glove: a hand's length past the wrist along the forearm. */
  gloves: [Vec3, Vec3];
  /** Each hand was seen in this pose; an unseen one is held where it last was against its shoulder. */
  seen: [boolean, boolean];
  /** The arms were solved in real distances; false: from the picture along the camera's own axis. */
  solved: boolean;
  bones: ArmLengths;
  /** For each forearm, 0 to 1: stood up as in a guard, or pointing at the screen as in a punch (see `ME.pointing`). */
  pointing: [number, number];
}
export const ME = {
  /** Wrist to the middle of the glove, and the glove's radius. */
  hand: 0.09,
  glove: 0.09,
  /** The eyes sit this far in front of the shoulder line and this far above the nose point. */
  eyeForward: 0.08,
  eyeUp: 0.04,
  /** A shoulder is never taken further in front of or behind the other than this by the model's depth alone. */
  shoulderTurn: 0.12,
  /**
   * One camera cannot tell a forearm that stands up (a guard) from one that
   * points at the screen (a punch) by its picture alone: seen from below both
   * look the same length. The elbow is not in doubt, and the two answers for
   * the wrist are a mirror of each other. The body model's own depth says
   * which: the wrist nearer the camera than the elbow by `from` is the start
   * of pointing, by `full` it is pointing. Eased over `easeMs` so that one
   * noisy pose does not throw the fist out and back.
   */
  pointing: { from: 0.04, full: 0.14, easeMs: 35 },
  /** Metres to one tracker unit until the body has been measured, the hips' height at the spot (the opponent's), and how sure the model must be of an elbow or a wrist. */
  metres: 0.78,
  hips: 0.98,
  worldSeen: 0.35,
};

/**
 * How large this player is, and how the camera is pitched, from the body
 * itself. The model reports the torso (the middle of the hips to the middle
 * of the shoulders) in metres; the tracker reports the same torso in its own
 * unit; their ratio turns that unit into metres. And an upright spine leans
 * in the model's world by exactly the camera's pitch. Both are the middle of
 * the last few seconds in which the hips were seen: one pose says little, and
 * a player bending or leaning for a moment does not move a middle.
 */
export function createBodyScale() {
  let ratios: number[] = [],
    tilts: number[] = [],
    uppers: number[] = [],
    highs: number[] = [];
  let metresHigh = 0;
  let metres = ME.metres,
    tilt = 0,
    count = 0;
  const middle = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  return {
    update(tracking: TrackingResult, world: readonly Landmark[] | null | undefined, picture?: { lm: readonly Landmark[]; aspect: number } | null) {
      const j = tracking.joints,
        w = tracking.jointWeights;
      if (!tracking.valid || !j || !w || !world || world.length < 25) return;
      // Hips that the tracker had to place from the shoulders are not a measurement.
      if (tracking.inferred?.includes("hips") || w[JOINT.L_HIP] < 1 || w[JOINT.R_HIP] < 1) return;
      const [sl, sr, hl, hr] = [world[11], world[12], world[23], world[24]];
      if (Math.min(sl.v, sr.v, hl.v, hr.v) < 0.6) return;
      const spine = { x: (sl.x + sr.x - hl.x - hr.x) / 2, y: (sl.y + sr.y - hl.y - hr.y) / 2, z: (sl.z + sr.z - hl.z - hr.z) / 2 };
      const inMetres = Math.hypot(spine.x, spine.y, spine.z);
      const a = j[JOINT.L_SHOULDER],
        b = j[JOINT.R_SHOULDER];
      // The hips are the tracker's origin: the shoulders' middle is the torso, as the picture has it.
      const inUnits = Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (!(inMetres > 0.25 && inMetres < 0.8 && inUnits > 0.2)) return;
      ratios.push(inMetres / inUnits);
      tilts.push(Math.atan2(spine.z, -spine.y));
      if (picture && picture.lm.length >= 25) {
        // The same torso in the picture: how many metres one picture height is where the body stands.
        const [a1, b1, c1, d1] = [picture.lm[11], picture.lm[12], picture.lm[23], picture.lm[24]];
        if (Math.min(a1.v, b1.v, c1.v, d1.v) >= 0.6) {
          const seenHigh = Math.hypot(((a1.x + b1.x - c1.x - d1.x) / 2) / (picture.aspect || 9 / 16), (a1.y + b1.y - c1.y - d1.y) / 2);
          if (seenHigh > 0.08) {
            highs.push(inMetres / seenHigh);
            if (highs.length > 40) highs.shift();
            // The middle of the last second or so: it follows a step toward the camera.
            metresHigh = middle(highs);
          }
        }
      }
      if (ratios.length > 150) {
        ratios.shift();
        tilts.shift();
      }
      if (++count % 5 === 0 || ratios.length < 5) {
        metres = clamp(middle(ratios), 0.5, 1.2);
        tilt = clamp(middle(tilts), -0.6, 0.6);
      }
      // The upper arm, as long as it was ever seen: a bone never looks longer than it is, and it hangs at the body's
      // own distance from the camera. (A forearm is held nearer the camera and looks up to a third longer than it is.)
      for (let i = 0; i < 2; i++) {
        if (w[JOINT.L_SHOULDER + i] < 1 || w[JOINT.L_ELBOW + i] < 1) continue;
        const sh = j[JOINT.L_SHOULDER + i],
          el = j[JOINT.L_ELBOW + i];
        uppers.push(Math.hypot(el.x - sh.x, el.y - sh.y));
      }
      while (uppers.length > 600) uppers.shift();
    },
    /**
     * The player's own arm bones, metres; null until the arms have been seen
     * for a few seconds. The upper arm is the high end of what was seen (19 in
     * 20, to stay clear of jitter); the forearm is taken as 0.88 of it, as
     * arms are built.
     */
    bones(): ArmLengths | null {
      if (uppers.length < 60) return null;
      const sorted = [...uppers].sort((x, y) => x - y);
      const upper = clamp(sorted[Math.floor((sorted.length - 1) * 0.95)] * metres, 0.24, 0.38);
      return { upperArm: upper, foreArm: upper * 0.88 };
    },
    /** Metres to one tracker unit. */
    metres: () => metres,
    /** Metres to one picture height where the body stands now; 0 until measured. */
    metresHigh: () => metresHigh,
    /** The camera's pitch, radians. */
    tilt: () => tilt,
    measured: () => ratios.length >= 5,
    reset() {
      ratios = [];
      tilts = [];
      uppers = [];
      highs = [];
      metresHigh = 0;
      metres = ME.metres;
      tilt = 0;
      count = 0;
    },
  };
}
export type BodyScale = ReturnType<typeof createBodyScale>;
const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
/** `b` moved onto the sphere of radius `l` about `a`, along the line it was on. */
const onBone = (a: Vec3, b: Vec3, l: number, fallback: Vec3): Vec3 => {
  const d = sub(b, a);
  const n = len(d);
  return add(a, n > 1e-6 ? mul(d, l / n) : mul(fallback, l));
};
/** An arm on its bones: the elbow one upper arm from the shoulder, the wrist one forearm from the elbow, the glove past the wrist. */
function arm(shoulder: Vec3, elbow: Vec3 | null, wrist: Vec3, bones: ArmLengths, side: number) {
  let e: Vec3;
  if (elbow) e = onBone(shoulder, elbow, bones.upperArm, v(0, -1, 0));
  else {
    // No elbow to go by: bent down and a little out, as an arm in a guard is.
    const reach = bones.upperArm + bones.foreArm;
    const d = sub(wrist, shoulder);
    const target = len(d) > reach ? add(shoulder, mul(d, reach / len(d))) : wrist;
    e = twoBone(shoulder, target, bones.upperArm, bones.foreArm, v(side * 0.35, -1, -0.3));
  }
  const w = onBone(e, wrist, bones.foreArm, v(0, 0, 1));
  const g = add(w, mul(sub(w, e), ME.hand / bones.foreArm));
  return { elbow: e, wrist: w, glove: g };
}

/**
 * The arms on the camera's own sight lines.
 *
 * Each joint is somewhere on the line from the lens through where it shows
 * in the picture. The shoulder is put on its line at the body's distance;
 * the elbow on its line one upper arm from the shoulder; the wrist on its
 * line one forearm from the elbow. Each of those has two answers, one nearer
 * the camera and one further; the body model's own depth says which. This
 * does what a flat reading of the picture cannot: a fist half a metre nearer
 * the lens looks half as far again from the middle as it is, and here it is
 * put where it is.
 *
 * Then the aim. A player punches at what they see: the screen. The camera
 * sits on the screen. So "at the camera" is taken to be "at the opponent's
 * head": every arm is turned by the angle between the line from the
 * shoulders to the camera and the line from the shoulders to where its head
 * is drawn. Measured on a real recording, the fists went 20° down from the
 * shoulders, at a laptop on a desk; unturned, every punch would have landed
 * on its belt.
 *
 * Gives each arm as two vectors in the room, upper arm and forearm; null for
 * an arm that is not seen well enough.
 */
export const SIGHT = {
  /** The tangent of half the lens's angle from top to bottom: laptop cameras run 0.36–0.47. */
  lensTan: 0.4,
  /** The model's depth is believed about which way a bone points from this much, metres; under it the two answers are mixed. */
  sure: 0.05,
  /** Where the opponent's head is taken to be from the shoulders: this far up for this far forward. */
  headUp: 0.2,
  headOut: 0.62,
  seen: 0.5,
};
export function sightArms(
  lm: readonly Landmark[],
  aspect: number,
  world: readonly Landmark[],
  bones: ArmLengths,
  metresHigh: number,
): ({ upper: Vec3; fore: Vec3 } | null)[] {
  const k = 2 * SIGHT.lensTan;
  // How far the body is from the lens: one picture height is `k` of the distance.
  const d = metresHigh / k;
  type P = { x: number; y: number; z: number };
  /** The sight line of a landmark: across (the player's right), up, and 1 along the lens's axis. */
  const ray = (l: Landmark): P => ({ x: ((0.5 - l.x) * k) / (aspect || 9 / 16), y: (0.5 - l.y) * k, z: 1 });
  const dot = (a: P, b: P) => a.x * b.x + a.y * b.y + a.z * b.z;
  /** The point of `r` that is `bone` from `from`: the nearer or the further of the two, by what the model says of `dz` (further is positive). */
  const along = (from: P, r: P, bone: number, dz: number): P => {
    const rr = dot(r, r),
      ra = dot(r, from);
    const disc = ra * ra - rr * (dot(from, from) - bone * bone);
    // The line passes the bone's reach: the bone lies flat in the picture, as near to it as it gets.
    if (!(disc > 0)) return { x: (r.x * ra) / rr, y: (r.y * ra) / rr, z: ra / rr };
    const root = Math.sqrt(disc);
    const near = (ra - root) / rr,
      far = (ra + root) / rr;
    const c = clamp(0.5 - dz / (2 * SIGHT.sure), 0, 1);
    const D = far + (near - far) * (c * c * (3 - 2 * c));
    return { x: r.x * D, y: r.y * D, z: D };
  };
  const out: ({ upper: Vec3; fore: Vec3 } | null)[] = [null, null];
  const sl = lm[11],
    sr = lm[12];
  if (!sl || !sr || sl.v < SIGHT.seen || sr.v < SIGHT.seen) return out;
  // The shoulders, each on its line at the body's distance; a shoulder the model has nearer is nearer.
  const turn = (world[11].z - world[12].z) / 2;
  const shoulders: P[] = [sl, sr].map((l, i) => {
    const D = d + (i ? -turn : turn);
    const r = ray(l);
    return { x: r.x * D, y: r.y * D, z: D };
  });
  const mid: P = { x: (shoulders[0].x + shoulders[1].x) / 2, y: (shoulders[0].y + shoulders[1].y) / 2, z: (shoulders[0].z + shoulders[1].z) / 2 };
  // From the shoulders to the lens, with the room's forward as toward the lens: which way that is across, and how far up.
  const reach = Math.hypot(mid.x, mid.y, mid.z);
  const fx = -mid.x / reach,
    fy = -mid.y / reach,
    fz = mid.z / reach;
  const yaw = Math.atan2(fx, fz),
    pitch = Math.atan2(fy, Math.hypot(fx, fz));
  const lift = Math.atan2(SIGHT.headUp, SIGHT.headOut) - pitch;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cl = Math.cos(lift),
    sl2 = Math.sin(lift);
  /** A vector as the lens has it, in the room: toward the lens becomes toward the opponent's head. */
  const room = (a: P, b: P): Vec3 => {
    const x = b.x - a.x,
      y = b.y - a.y,
      z = -(b.z - a.z);
    const x1 = x * cy - z * sy,
      z1 = x * sy + z * cy;
    return v(x1, y * cl + z1 * sl2, -y * sl2 + z1 * cl);
  };
  for (let i = 0; i < 2; i++) {
    const e = lm[13 + i],
      w = lm[15 + i];
    const we = world[13 + i],
      ww = world[15 + i],
      ws = world[11 + i];
    if (!e || !w || e.v < SIGHT.seen || w.v < SIGHT.seen || !we || !ww || !ws) continue;
    const S = shoulders[i];
    const E = along(S, ray(e), bones.upperArm, we.z - ws.z);
    const W = along(E, ray(w), bones.foreArm, ww.z - we.z);
    out[i] = { upper: room(S, E), fore: room(E, W) };
  }
  return out;
}

export interface BodyOptions {
  /** The pose's time, ms. */
  t: number;
  /** How much further from the screen than their spot the player stands, game units (negative: nearer). 0 when not measured. */
  away?: number;
  /** The aim set-up and the shoulders' distance from the camera now, for arms in real distances. */
  setup?: AimSetup | null;
  range?: number;
  /** The player's own arm bones; the rig's until measured. */
  arms?: ArmLengths | null;
  /** The pose before, for a hand that is not seen in this one. */
  previous?: Me3D | null;
  /**
   * The body model's own three-dimensional landmarks for this pose, metres,
   * about the hips, in the camera's axes (x to the picture's right, y down,
   * z away from the camera). Given, the arms are laid out from them.
   */
  world?: readonly Landmark[] | null;
  /** Metres to one of the tracker's units, and the camera's pitch as an upright spine shows it, radians (see `createBodyScale`). */
  metres?: number;
  tilt?: number;
  /** The player's own arm bones in metres, as `createBodyScale` measured them; `arms` (in the tracker's unit) is used when not given. */
  bones?: ArmLengths | null;
  /**
   * The picture's own landmarks for this pose (0 to 1 across and down) with
   * the picture's height over its width, and how many metres one picture
   * height is at the body (`createBodyScale`). Given with `world`, the arms
   * are solved on the camera's sight lines (`sightArms`).
   */
  picture?: { lm: readonly Landmark[]; aspect: number; metresHigh: number } | null;
}
/** The player's body from one pose of the tracker. Null when the body is not followed. */
export function bodyOf(tracking: TrackingResult, o: BodyOptions): Me3D | null {
  const j = tracking.joints,
    w = tracking.jointWeights;
  if (!tracking.valid || !j || !w || j.length <= JOINT.R_WRIST) return null;
  const world = o.world && o.world.length >= 25 ? o.world : null;
  const setup = !world && o.setup && (o.range ?? 0) > 0 ? o.setup : null;
  // Metres to a tracker unit: with world landmarks everything is in metres.
  const m = world ? (o.metres ?? ME.metres) : 1;
  const given = o.arms ?? { upperArm: BODY.upperArm, foreArm: BODY.foreArm };
  const bones: ArmLengths = setup ? setup.bones[0] : world && o.bones ? o.bones : { upperArm: given.upperArm * m, foreArm: given.foreArm * m };
  // The hips stand as high as the opponent's at the spot; a step toward the screen is a step toward the opponent.
  const root = v(tracking.root.x * m, (world ? ME.hips : 1) + tracking.root.y * m, -(o.away ?? 0) * m);
  const sl = j[JOINT.L_SHOULDER],
    sr = j[JOINT.R_SHOULDER];
  // The camera's pitch, taken out of everything the model says about depth.
  const tilt = world ? clamp(o.tilt ?? 0, -0.6, 0.6) : 0;
  const cosT = Math.cos(tilt),
    sinT = Math.sin(tilt);
  /** A direction or an offset of the model's world, in the room: the picture's right is the player's left, down is down, away is back. */
  const room = (dx: number, dy: number, dz: number): Vec3 => {
    const X = -dx,
      Y = -dy,
      Z = -dz;
    return v(X, Y * cosT - Z * sinT, Y * sinT + Z * cosT);
  };
  const wl = world ? world[11] : null,
    wr = world ? world[12] : null;
  const turned = (i: number): number => {
    // Which shoulder is forward: from the model's world when it has both, else from its depth.
    if (wl && wr && wl.v >= 0.5 && wr.v >= 0.5) {
      const me = i ? wr : wl,
        other = i ? wl : wr;
      return clamp(room((me.x - other.x) / 2, (me.y - other.y) / 2, (me.z - other.z) / 2).z, -ME.shoulderTurn, ME.shoulderTurn);
    }
    return clamp(((i ? sr.z : sl.z) - (sl.z + sr.z) / 2) * m, -ME.shoulderTurn, ME.shoulderTurn);
  };
  const shoulders = [sl, sr].map((p, i) => v(root.x + p.x * m, root.y + p.y * m, root.z + turned(i))) as [Vec3, Vec3];
  const nose = j[JOINT.NOSE];
  const head =
    w[JOINT.NOSE] > 0
      ? v(root.x + nose.x * m, root.y + nose.y * m + ME.eyeUp, root.z + ME.eyeForward)
      : v(tracking.head.x * m, (world ? ME.hips + 0.67 : 1.65) + tracking.head.y * m, root.z + ME.eyeForward);
  const sights = world && o.picture && o.picture.metresHigh > 0 ? sightArms(o.picture.lm, o.picture.aspect, world, bones, o.picture.metresHigh) : null;
  const elbows: Vec3[] = [],
    wrists: Vec3[] = [],
    gloves: Vec3[] = [];
  const seen: [boolean, boolean] = [false, false];
  const pointing: [number, number] = [o.previous?.pointing[0] ?? 0, o.previous?.pointing[1] ?? 0];
  let solved = setup !== null || world !== null;
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const S = shoulders[i];
    const tracked = (i ? tracking.rightHandTracked : tracking.leftHandTracked) !== false && w[JOINT.L_WRIST + i] > 0;
    seen[i] = tracked;
    let made: ReturnType<typeof arm> | null = null;
    const ws = world ? world[11 + i] : null,
      we = world ? world[13 + i] : null,
      ww = world ? world[15 + i] : null;
    const sight = sights ? sights[i] : null;
    if (tracked && sight) {
      // On the camera's own sight lines, with the player's own bones: true to the centimetre across, and as far out as the arm really is.
      made = arm(S, add(S, sight.upper), add(add(S, sight.upper), sight.fore), bones, side);
      pointing[i] = clamp(sight.fore.z / Math.max(1e-6, len(sight.fore)), 0, 1);
    } else if (tracked && ws && we && ww && we.v >= ME.worldSeen && ww.v >= ME.worldSeen) {
      // The model's own arm: which way each bone points, on bones of the player's own length.
      const upper = room(we.x - ws.x, we.y - ws.y, we.z - ws.z),
        fore = room(ww.x - we.x, ww.y - we.y, ww.z - we.z);
      const elbow = add(S, mul(upper, bones.upperArm / Math.max(1e-6, len(upper))));
      const wrist = add(elbow, mul(fore, bones.foreArm / Math.max(1e-6, len(fore))));
      made = arm(S, elbow, wrist, bones, side);
      pointing[i] = clamp(fore.z / Math.max(1e-6, len(fore)), 0, 1);
    } else if (tracked && world) {
      // The model is not sure of this arm in this pose: it stays where it was against its shoulder.
      seen[i] = false;
      if (o.previous) {
        const P = o.previous.shoulders[i];
        made = { elbow: add(S, sub(o.previous.elbows[i], P)), wrist: add(S, sub(o.previous.wrists[i], P)), glove: add(S, sub(o.previous.gloves[i], P)) };
      } else made = arm(S, null, add(S, v(-side * 0.05, -0.2, 0.22)), bones, side);
    } else if (tracked) {
      const source = tracking as TrackingResult & AimSource;
      const hand = i ? "right" : "left";
      const a = setup ? solveArm(source, hand, setup, o.range!) : null;
      if (a) {
        const R = setup!.reach[i];
        const at = (q: { across: number; up: number; fwd: number }) => add(S, v(q.across * R, q.up * R, q.fwd * R));
        let wrist = at(a);
        if (a.elbow3) {
          // Stood up or pointing: the model's depth for the wrist against the elbow says which, eased.
          const stood = solveArm(source, hand, setup!, o.range!, { guard: true });
          const dz = j[JOINT.L_WRIST + i].z - j[JOINT.L_ELBOW + i].z;
          const c = clamp((dz - ME.pointing.from) / (ME.pointing.full - ME.pointing.from), 0, 1);
          const target = c * c * (3 - 2 * c);
          const before = o.previous?.pointing[i];
          const dt = o.previous ? o.t - o.previous.t : Infinity;
          pointing[i] = before === undefined || !(dt > 0) || dt > 250 ? target : before + (target - before) * (1 - Math.exp(-dt / ME.pointing.easeMs));
          if (stood) {
            const back = at(stood);
            const k = pointing[i];
            wrist = v(back.x + (wrist.x - back.x) * k, back.y + (wrist.y - back.y) * k, back.z + (wrist.z - back.z) * k);
          }
        } else pointing[i] = 1;
        const elbow = a.elbow3 ? at(a.elbow3) : null;
        made = arm(S, elbow, wrist, setup!.bones[i], side);
      } else {
        // From the picture: each bone keeps what it showed across the picture and gets the depth its length allows, toward the screen.
        solved = false;
        const sj = j[JOINT.L_SHOULDER + i],
          ej = j[JOINT.L_ELBOW + i],
          wj = j[JOINT.L_WRIST + i];
        const deep = (a0: Vec3, b0: Vec3, bone: number): Vec3 => {
          const dx = b0.x - a0.x,
            dy = b0.y - a0.y;
          const flat = Math.hypot(dx, dy);
          if (flat >= bone) return v((dx * bone) / flat, (dy * bone) / flat, 0);
          return v(dx, dy, Math.sqrt(bone * bone - flat * flat));
        };
        const up = w[JOINT.L_ELBOW + i] > 0 ? deep(sj, ej, bones.upperArm) : null;
        const elbow = up ? add(S, up) : null;
        const wrist = elbow ? add(elbow, deep(ej, wj, bones.foreArm)) : add(S, v(wj.x - sj.x, wj.y - sj.y, Math.max(0, wj.z - sj.z)));
        made = arm(S, elbow, wrist, bones, side);
      }
    } else if (o.previous) {
      // Not seen: held where it was against its shoulder.
      const P = o.previous.shoulders[i];
      made = {
        elbow: add(S, sub(o.previous.elbows[i], P)),
        wrist: add(S, sub(o.previous.wrists[i], P)),
        glove: add(S, sub(o.previous.gloves[i], P)),
      };
    } else made = arm(S, null, add(S, v(-side * 0.05, -0.2, 0.22)), bones, side);
    elbows.push(made.elbow);
    wrists.push(made.wrist);
    gloves.push(made.glove);
  }
  return {
    t: o.t,
    head,
    hips: v(root.x, root.y, root.z),
    shoulders,
    elbows: elbows as [Vec3, Vec3],
    wrists: wrists as [Vec3, Vec3],
    gloves: gloves as [Vec3, Vec3],
    seen,
    solved,
    bones,
    pointing,
  };
}

/**
 * The guard as the rules' own words, from where the gloves really are: up
 * (by the chin or higher, in front of the body), covering (at brow height),
 * down at the ribs. A glove that is out punching is none of them.
 */
export function guardOfBody(me: Me3D): { guard: import("../defence").Guard; out: [boolean, boolean] } {
  const high: [boolean, boolean] = [false, false],
    low: [boolean, boolean] = [false, false],
    up: [boolean, boolean] = [false, false],
    out: [boolean, boolean] = [false, false];
  const heights: [number | null, number | null] = [null, null];
  const reach = me.bones.upperArm + me.bones.foreArm;
  for (let i = 0; i < 2; i++) {
    const g = me.gloves[i],
      s = me.shoulders[i];
    const forward = g.z - s.z;
    const stretch = len(sub(me.wrists[i], s)) / reach;
    // Out: most of the arm's length away from its shoulder, and in front.
    out[i] = stretch >= 0.8 && forward >= 0.3;
    heights[i] = me.wrists[i].y - s.y;
    if (out[i]) continue;
    const across = Math.abs(g.x - me.head.x);
    if (g.y >= s.y - 0.1 && across <= 0.3) {
      up[i] = true;
      if (g.y >= me.head.y - 0.07) high[i] = true;
    } else if (g.y <= s.y - 0.18 && g.y >= me.hips.y + 0.12 && across <= 0.35) low[i] = true;
  }
  const n = (pair: [boolean, boolean]) => (pair[0] ? 1 : 0) + (pair[1] ? 1 : 0);
  return {
    guard: { high: n(high), low: n(low), up: n(up), heights, sides: { high, low, up }, known: me.seen[0] && me.seen[1] },
    out,
  };
}
