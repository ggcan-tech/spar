import { BODY, JOINT, type ArmLengths } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import type { Hand } from "../punch";

/**
 * Where a punch goes, in real distances.
 *
 * The picture alone is 15–22 cm wrong up and down from a laptop on a desk: a
 * fist coming at a camera that looks up at it rises in the picture, and a
 * fist that comes nearer looks further from the shoulder than it is. So the
 * arm is solved instead. The shoulder is put on its sight line at the known
 * range, the elbow on its own sight line one upper arm from the shoulder, the
 * wrist on its own one forearm from the elbow, and the result is turned by
 * the camera's tilt. One second in set-up with both arms straight out at the
 * screen gives that tilt.
 *
 * Distances are in arm lengths. A range or a lens angle that is 10–15% out
 * then hardly matters: the arm and what it is measured in stretch together.
 *
 * What one camera can honestly tell is three heights and three sides. The
 * rules use six zones: head or body, by the player's left, middle, right.
 *
 * Measured on the scripted person through the real tracker (aim.test.ts):
 * within ±2–4 cm up and down from four camera heights at 1.5 cm of noise.
 * A real elbow is often hidden by the fist; then the wrist alone is put on a
 * sphere of arm's length, which is right at full stretch and rough before.
 */
export interface AimSource {
  joints?: readonly Vec3[];
  jointWeights?: readonly number[];
  /** The hips against where they were at set-up, in game units. */
  root: Vec3;
  leftHandTracked?: boolean;
  rightHandTracked?: boolean;
}
/** A point in the camera's own view: across (the player's right), up the picture, and away from the camera. */
interface Seen {
  x: number;
  y: number;
  d: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface AimSetup {
  /** For each arm, [left, right]: which way "straight out at the screen" points, as the camera saw it then. */
  forward: [Seen, Seen];
  /** Where each shoulder was in the picture then, against the hips' home, in game units. */
  at: [Point, Point];
  /** The middle of the shoulders then: the player's home, which every point is measured from. */
  home: Point;
  /** Each arm's length, shoulder to wrist, frozen at set-up, in game units. */
  reach: [number, number];
  bones: [ArmLengths, ArmLengths];
  /** The tilt as found: degrees the camera's line of sight to the shoulders rises (negative: it looks down at them). */
  tiltDeg: number;
  /** How far from their middle three in four poses of the second put the fist, in centimetres on a 0.55 m arm. Large: the arms were not still. */
  spreadCm: number;
  /** The range it was found at, in game units. */
  range: number;
}
export const AIM = {
  /** Poses needed for a set-up, and how far from their middle three in four of them may put the fist, in arm lengths. */
  poses: 6,
  still: 0.12,
  /** An arm held out for set-up is at least this straight: shoulder to wrist over the bones. */
  straight: 0.9,
  /**
   * And it points at the screen: at least this share of it is toward the
   * camera (0.7 is 45° off). Arms hanging at the sides are straight too, and
   * a set-up taken from them would call "down" straight ahead.
   */
  pointing: 0.7,
  /** A bone whose sight line passes its reach by more than this share of it cannot be trusted: a sleeve has slid, or the elbow is a guess. */
  tooLong: 0.15,
  /** A bone's lean toward or away from the camera is believed from this share of its length, and in full from this. */
  leanFrom: 0.15,
  leanFull: 0.4,
  /** In the guard, a wrist this far below its shoulder in the picture, or lower, is a hand held low: its upper arm hangs. This far above, or higher, it is a hand held up: its forearm stands. In arm lengths. */
  raisedFrom: -0.15,
  raisedFull: 0.05,
  /** A bone stood up or hung may be taken this much longer than the ruler says. */
  stretch: 1.12,
  /** The arm ruler's whole arm is believed within this much of the body's usual proportions. */
  bones: [0.92, 1.15],
  /** A sight line to the shoulders steeper than this: ask for the camera to be raised (the study's lowest table is 27°). */
  steepDeg: 30,
  /** Where zones sit, in arm lengths. Rows are this far apart, columns this far (24 cm and 12.5 cm on a 0.55 m arm). */
  rows: 0.44,
  columns: 0.23,
  /** Until this player's own punches say: a straight at the head ends this far above the shoulder line, and this far to its own side of the body's middle. */
  headUp: 0.2,
  ownSide: 0.08,
};
export type Level = "head" | "body";
export type Third = "left" | "middle" | "right";
export type Height = "head" | "chest" | "belly";
export interface Zone {
  level: Level;
  /** As the player sees the opponent. */
  third: Third;
  /** The finer height one camera can still tell. */
  height: Height;
}
/** Where zones sit for one player, in arm lengths from home. */
export interface AimMarks {
  /** The height of the head row's middle. */
  head: number;
  /** The middle column's middle, for the [left, right] hand. */
  middle: [number, number];
}
export const defaultMarks = (): AimMarks => ({ head: AIM.headUp, middle: [-AIM.ownSide, AIM.ownSide] });

export interface ArmAim {
  hand: Hand;
  /**
   * The fist against its own shoulder, in arm lengths: to the player's right,
   * up, and toward the opponent. Turned by the tilt, so "up" is up in the room.
   */
  across: number;
  up: number;
  fwd: number;
  /**
   * The same fist in the plane facing the opponent, from the player's home
   * (the middle of the shoulders at set-up), in arm lengths. It moves with a
   * slip or a duck: a punch thrown from a crouch goes to the body.
   */
  point: Point;
  /** The elbow in the same plane; null when the elbow was not used. */
  elbowAt: Point | null;
  /** The elbow against its own shoulder, in arm lengths, in the room's axes like `across`, `up`, `fwd`; null when the elbow was not used. */
  elbow3: { across: number; up: number; fwd: number } | null;
  /** Shoulder to wrist over the arm's length: 1 is straight. */
  stretch: number;
  /** The elbow was used. False: the wrist alone on a sphere of arm's length. */
  elbow: boolean;
}

const dot = (a: Seen, b: Seen) => a.x * b.x + a.y * b.y + a.d * b.d;
const cross = (a: Seen, b: Seen): Seen => ({
  x: a.y * b.d - a.d * b.y,
  y: a.d * b.x - a.x * b.d,
  d: a.x * b.y - a.y * b.x,
});
const unit = (a: Seen): Seen => {
  const n = Math.hypot(a.x, a.y, a.d) || 1;
  return { x: a.x / n, y: a.y / n, d: a.d / n };
};
const minus = (a: Seen, b: Seen): Seen => ({ x: a.x - b.x, y: a.y - b.y, d: a.d - b.d });
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/**
 * The two points on a sight line that are `length` from `from`: the nearer to
 * the camera and the further. When the line passes the sphere by, the point
 * of the line nearest to `from`, twice, and by how much it missed.
 */
function onSightLine(ray: Seen, from: Seen, length: number) {
  const rr = dot(ray, ray),
    rp = dot(ray, from),
    pp = dot(from, from);
  const disc = rp * rp - rr * (pp - length * length);
  const at = (k: number): Seen => ({ x: ray.x * k, y: ray.y * k, d: ray.d * k });
  if (disc <= 0) {
    const p = at(rp / rr);
    return { near: p, far: p, gap: 0, missed: Math.sqrt(Math.max(0, pp - (rp * rp) / rr)) - length };
  }
  const root = Math.sqrt(disc);
  return { near: at((rp - root) / rr), far: at((rp + root) / rr), gap: (2 * root) / Math.sqrt(rr), missed: 0 };
}
/** The point of a sight line that lies `distance` ahead of `from` along `f`. */
function ahead(ray: Seen, from: Seen, f: Seen, distance: number): Seen {
  const k = (distance + dot(from, f)) / dot(ray, f);
  return { x: ray.x * k, y: ray.y * k, d: ray.d * k };
}
/**
 * One bone: the far end on its sight line, the bone's length from the near
 * end. A bone seen short points at the camera or away from it, and the
 * picture cannot say which. The model's depth is not asked: near a face it is
 * 5–10 cm wrong, and leaving it out changed nothing measured here.
 *
 * - At the camera is the rule for a boxer's arm.
 * - A bone that looks nearly its full length lies about flat in the picture.
 *   How far it leans is then a small number made of two large ones, and a
 *   bone length that is 5% out turns it into 10 cm. So a lean is believed
 *   only as it becomes clear: none under a seventh of the bone, all of it
 *   from two fifths.
 *
 * `level`, for an arm that is guarding and not punching, replaces the rule by
 * its `share`: the far end is put no further forward than the near end, as
 * the room has it. A forearm held up in the guard stands up; an upper arm
 * with the hand down hangs. Seen from a low table, "at the camera" would tip
 * either half-way over. This does not lean on the bone's length at all, so a
 * bone a little too short may stretch by `stretch` to get there.
 *
 * `missed` is how far the sight line passes the bone's reach by, as a share
 * of the bone: a sleeve that slid, or a joint that is a guess.
 */
function bone(
  ray: Seen,
  from: Seen,
  length: number,
  level: { f: Seen; share: number } | null = null,
): { p: Seen; missed: number } {
  const hit = onSightLine(ray, from, length);
  // The point of the sight line nearest the near end: the bone flat in the picture.
  const foot: Seen = { x: (hit.near.x + hit.far.x) / 2, y: (hit.near.y + hit.far.y) / 2, d: (hit.near.d + hit.far.d) / 2 };
  const half = hit.gap / 2;
  let p = foot;
  if (half > 0) {
    const clear = clamp((half / length - AIM.leanFrom) / (AIM.leanFull - AIM.leanFrom), 0, 1);
    const k = clear * clear * (3 - 2 * clear);
    p = { x: foot.x + (hit.near.x - foot.x) * k, y: foot.y + (hit.near.y - foot.y) * k, d: foot.d + (hit.near.d - foot.d) * k };
  }
  const share = level ? clamp(level.share, 0, 1) : 0;
  if (level && share > 0) {
    const along = unit(ray);
    const flat = Math.hypot(foot.x - from.x, foot.y - from.y, foot.d - from.d);
    // How far along the sight line from the foot the bone may reach, stretched a little.
    const most = Math.sqrt(Math.max(0, (length * AIM.stretch) ** 2 - flat * flat));
    const want = dot(minus(ahead(ray, from, level.f, 0), foot), along);
    const to = clamp(want, -most, most);
    const stood: Seen = { x: foot.x + along.x * to, y: foot.y + along.y * to, d: foot.d + along.d * to };
    p = { x: p.x + (stood.x - p.x) * share, y: p.y + (stood.y - p.y) * share, d: p.d + (stood.d - p.d) * share };
  }
  return { p, missed: Math.max(0, hit.missed) / length };
}
/**
 * The bones the solve uses. The arm ruler measures each bone as the longest
 * it was seen, and from a camera well above or below, a hanging arm is never
 * seen at its full length: on the scripted person its bones were up to 9% out
 * one by one, but their sum within 3%. So the ruler's whole arm is kept,
 * split as arms are built, and held near the body's usual proportions.
 */
function boundedBones(bones: ArmLengths | null | undefined): ArmLengths {
  const usual = BODY.upperArm + BODY.foreArm;
  const [lo, hi] = AIM.bones;
  const whole = clamp(bones ? bones.upperArm + bones.foreArm : usual, usual * lo, usual * hi);
  return { upperArm: (whole * BODY.upperArm) / usual, foreArm: (whole * BODY.foreArm) / usual };
}

interface Raw {
  /** Wrist and elbow minus shoulder, in the camera's own view, game units. */
  v: Seen;
  e: Seen | null;
  /** The shoulder in the picture against the hips' home. */
  shoulder: Point;
  middle: Point;
}
const seenHand = (source: AimSource, hand: Hand) => {
  const i = hand === "left" ? 0 : 1;
  const w = source.jointWeights;
  return (
    !!source.joints &&
    !!w &&
    w[JOINT.L_SHOULDER + i] >= 0.6 &&
    w[JOINT.L_WRIST + i] >= 0.6 &&
    (hand === "left" ? source.leftHandTracked : source.rightHandTracked) !== false
  );
};
const placeOf = (source: AimSource, p: Vec3): Point => ({ x: source.root.x + p.x, y: source.root.y + p.y });
const middleOf = (source: AimSource): Point => {
  const l = source.joints![JOINT.L_SHOULDER],
    r = source.joints![JOINT.R_SHOULDER];
  return { x: source.root.x + (l.x + r.x) / 2, y: source.root.y + (l.y + r.y) / 2 };
};
/**
 * The arm as the camera's own view has it, before any tilt is taken out.
 * `guard`, for a hand that is not punching, gives which way the room's
 * forward lies at this shoulder: a raised forearm is then stood up, and the
 * upper arm of a low hand hung, instead of being pointed at the camera.
 */
function solveRaw(
  source: AimSource,
  hand: Hand,
  range: number,
  bones: ArmLengths,
  wristOnly = false,
  guard: Seen | null = null,
): Raw | null {
  if (!seenHand(source, hand) || !(range > 0)) return null;
  const joints = source.joints!,
    weights = source.jointWeights!;
  const i = hand === "left" ? 0 : 1;
  const s = joints[JOINT.L_SHOULDER + i],
    e = joints[JOINT.L_ELBOW + i],
    w = joints[JOINT.L_WRIST + i];
  const S: Seen = { x: 0, y: 0, d: range };
  const sight = (p: Vec3): Seen => ({ x: (p.x - s.x) / range, y: (p.y - s.y) / range, d: 1 });
  const full = bones.upperArm + bones.foreArm;
  // How far up the hand is held, as the picture has it.
  const raised = clamp(((w.y - s.y) / full - AIM.raisedFrom) / (AIM.raisedFull - AIM.raisedFrom), 0, 1);
  // The elbow is believed when it was seen and both bones can reach their
  // sight lines. A sleeve that slides, or a fist in front of the elbow, fails this.
  let W: Seen | null = null,
    E: Seen | null = null;
  if (!wristOnly && weights[JOINT.L_ELBOW + i] >= 0.6) {
    const upper = bone(sight(e), S, bones.upperArm, guard && { f: guard, share: 1 - raised });
    const fore = bone(sight(w), upper.p, bones.foreArm, guard && { f: guard, share: raised });
    if (upper.missed <= AIM.tooLong && fore.missed <= AIM.tooLong) {
      E = upper.p;
      W = fore.p;
    }
  }
  W ??= bone(sight(w), S, full).p;
  return { v: minus(W, S), e: E ? minus(E, S) : null, shoulder: placeOf(source, s), middle: middleOf(source) };
}
/**
 * The room's axes as a sight line has them now. Set-up found "forward" along
 * the sight line a shoulder had then; a shoulder that has moved across the
 * picture is looked at from a slightly different side.
 */
function axes(forward: Seen, moved: Point, range: number) {
  // The new sight line, in the old one's terms.
  const n = unit({ x: moved.x / range, y: moved.y / range, d: 1 });
  const ax = unit({ x: 1 - n.x * n.x, y: -n.x * n.y, d: -n.x * n.d });
  const ay = cross(n, ax);
  const f: Seen = { x: dot(forward, ax), y: dot(forward, ay), d: dot(forward, n) };
  // The camera is taken to be level from side to side: "right" is the picture's across, squared to forward.
  const right = unit({ x: 1 - f.x * f.x, y: -f.x * f.y, d: -f.x * f.d });
  let up = cross(right, f);
  if (up.y < 0) up = { x: -up.x, y: -up.y, d: -up.d };
  return { f, right, up };
}

/**
 * Set-up: a few poses with both arms straight out at the screen at shoulder
 * height. Gives the tilt (which way straight ahead points, for each arm) and
 * freezes each arm's length. Null when an arm was not seen, was not straight,
 * did not point at the screen or did not hold still: ask again.
 *
 * `range` is the shoulders' distance from the camera in game units (range.ts
 * gives it); `bones` the arm ruler's lengths.
 */
export function calibrateAim(
  poses: readonly AimSource[],
  range: number,
  bones: ArmLengths | null,
): AimSetup | null {
  const b = boundedBones(bones);
  const full = b.upperArm + b.foreArm;
  const forward: Seen[] = [],
    at: Point[] = [],
    homes: Point[] = [];
  let spread = 0;
  for (const hand of ["left", "right"] as const) {
    const seen: Raw[] = [];
    for (const p of poses) {
      const raw = solveRaw(p, hand, range, b);
      if (raw && raw.e && Math.hypot(raw.v.x, raw.v.y, raw.v.d) >= AIM.straight * full) seen.push(raw);
    }
    if (seen.length < AIM.poses) return null;
    const v: Seen = {
      x: median(seen.map((q) => q.v.x)),
      y: median(seen.map((q) => q.v.y)),
      d: median(seen.map((q) => q.v.d)),
    };
    // Three poses in four are within this of the middle: one wild pose does not spoil a set-up.
    const off = seen.map((q) => Math.hypot(q.v.x - v.x, q.v.y - v.y)).sort((p, q) => p - q);
    spread = Math.max(spread, off[Math.floor((off.length - 1) * 0.75)] / full);
    const f = unit(v);
    // Straight, but not at the screen: hanging, or held out to the side.
    if (-f.d < AIM.pointing) return null;
    forward.push(f);
    at.push({ x: median(seen.map((q) => q.shoulder.x)), y: median(seen.map((q) => q.shoulder.y)) });
    homes.push({ x: median(seen.map((q) => q.middle.x)), y: median(seen.map((q) => q.middle.y)) });
  }
  if (spread > AIM.still) return null;
  // A fist coming level at a camera that looks up at it rises in the picture.
  const tilt = (f: Seen) => Math.atan2(f.y, -f.d);
  return {
    forward: [forward[0], forward[1]],
    at: [at[0], at[1]],
    home: { x: (homes[0].x + homes[1].x) / 2, y: (homes[0].y + homes[1].y) / 2 },
    reach: [full, full],
    bones: [b, b],
    tiltDeg: (((tilt(forward[0]) + tilt(forward[1])) / 2) * 180) / Math.PI,
    spreadCm: spread * 55,
    range,
  };
}
/** The camera looks up or down at the player so steeply that aim and guard suffer: ask for it to be raised. */
export const tooSteep = (setup: AimSetup) => Math.abs(setup.tiltDeg) > AIM.steepDeg;
/**
 * The tracker took a new centre (`recenter`): the hips' home moved by `root`,
 * what the tracker's result said just before. Every place kept from set-up
 * moves with it.
 */
export function recentred(setup: AimSetup, root: Point): AimSetup {
  const shift = (p: Point): Point => ({ x: p.x - root.x, y: p.y - root.y });
  return { ...setup, at: [shift(setup.at[0]), shift(setup.at[1])], home: shift(setup.home) };
}

/**
 * Where one fist is now, in arm lengths, in the room's own up and across.
 * Null when the arm is not seen. `range` is the shoulders' distance now, in
 * game units. `wristOnly` leaves the elbow out whatever it looks like.
 * `guard` is for a hand that is not punching: a raised forearm is stood up
 * and a low hand's upper arm hung, instead of being pointed at the camera
 * (guardShape.ts uses it).
 */
export function solveArm(
  source: AimSource,
  hand: Hand,
  setup: AimSetup,
  range: number,
  o: { wristOnly?: boolean; guard?: boolean } = {},
): ArmAim | null {
  if (!seenHand(source, hand) || !(range > 0)) return null;
  const i = hand === "left" ? 0 : 1;
  const shoulder = placeOf(source, source.joints![JOINT.L_SHOULDER + i]);
  const { f, right, up } = axes(
    setup.forward[i],
    { x: shoulder.x - setup.at[i].x, y: shoulder.y - setup.at[i].y },
    range,
  );
  const raw = solveRaw(source, hand, range, setup.bones[i], o.wristOnly, o.guard ? f : null);
  if (!raw) return null;
  const reach = setup.reach[i];
  // Shoulders are a body's width apart at one distance: the picture is trusted for where the shoulder is.
  const base = { x: (raw.shoulder.x - setup.home.x) / reach, y: (raw.shoulder.y - setup.home.y) / reach };
  const across = dot(raw.v, right) / reach,
    high = dot(raw.v, up) / reach;
  return {
    hand,
    across,
    up: high,
    fwd: dot(raw.v, f) / reach,
    point: { x: base.x + across, y: base.y + high },
    elbowAt: raw.e ? { x: base.x + dot(raw.e, right) / reach, y: base.y + dot(raw.e, up) / reach } : null,
    elbow3: raw.e ? { across: dot(raw.e, right) / reach, up: dot(raw.e, up) / reach, fwd: dot(raw.e, f) / reach } : null,
    stretch: Math.hypot(raw.v.x, raw.v.y, raw.v.d) / reach,
    elbow: raw.e !== null,
  };
}
/**
 * A wrist put a set distance in front of its shoulder, in arm lengths, when
 * the elbow cannot say how far out it is: a glove held in the guard is about
 * a third of an arm in front. Gives the fist in the plane facing the opponent.
 */
export function handAhead(source: AimSource, hand: Hand, setup: AimSetup, range: number, forward: number): Point | null {
  if (!seenHand(source, hand) || !(range > 0)) return null;
  const i = hand === "left" ? 0 : 1;
  const s = source.joints![JOINT.L_SHOULDER + i],
    w = source.joints![JOINT.L_WRIST + i];
  const shoulder = placeOf(source, s);
  const { f, right, up } = axes(setup.forward[i], { x: shoulder.x - setup.at[i].x, y: shoulder.y - setup.at[i].y }, range);
  const reach = setup.reach[i];
  const S: Seen = { x: 0, y: 0, d: range };
  const v = minus(ahead({ x: (w.x - s.x) / range, y: (w.y - s.y) / range, d: 1 }, S, f, forward * reach), S);
  return {
    x: (shoulder.x - setup.home.x) / reach + dot(v, right) / reach,
    y: (shoulder.y - setup.home.y) / reach + dot(v, up) / reach,
  };
}
/**
 * Any point of the body in the plane facing the opponent, from home, in arm
 * lengths. `joint` is one of the tracker's joints (hip-relative); `forward`
 * says how far in front of the shoulder line it is taken to be, in arm
 * lengths (the nose is about 0.17 in front, the shoulders 0). Also returns
 * the middle of the shoulders now.
 */
export function bodyPoint(
  source: AimSource,
  joint: Vec3,
  setup: AimSetup,
  range: number,
  forward = 0,
): { point: Point; shoulders: Point } | null {
  if (!source.joints || !(range > 0)) return null;
  const middle = middleOf(source);
  const l = source.joints[JOINT.L_SHOULDER],
    r = source.joints[JOINT.R_SHOULDER];
  const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const reach = (setup.reach[0] + setup.reach[1]) / 2;
  // Between the two shoulders, straight ahead is between what each arm found.
  const fwd = unit({
    x: setup.forward[0].x + setup.forward[1].x,
    y: setup.forward[0].y + setup.forward[1].y,
    d: setup.forward[0].d + setup.forward[1].d,
  });
  const { f, right, up } = axes(fwd, { x: middle.x - setup.home.x, y: middle.y - setup.home.y }, range);
  const S: Seen = { x: 0, y: 0, d: range };
  const v = minus(ahead({ x: (joint.x - mid.x) / range, y: (joint.y - mid.y) / range, d: 1 }, S, f, forward * reach), S);
  const shoulders = { x: (middle.x - setup.home.x) / reach, y: (middle.y - setup.home.y) / reach };
  return { point: { x: shoulders.x + dot(v, right) / reach, y: shoulders.y + dot(v, up) / reach }, shoulders };
}

/** Which zone a point is in. `marks` moves the zones to where this player's own punches go, or to where the opponent is drawn. */
export function zoneOf(point: Point, hand: Hand, marks: AimMarks = defaultMarks()): Zone {
  const row = (marks.head - point.y) / AIM.rows;
  const column = (point.x - marks.middle[hand === "left" ? 0 : 1]) / AIM.columns;
  const height: Height = row < 0.5 ? "head" : row < 1.5 ? "chest" : "belly";
  return {
    level: height === "head" ? "head" : "body",
    third: column < -0.5 ? "left" : column > 0.5 ? "right" : "middle",
    height,
  };
}
/**
 * Where this player's own straight punches at the head end: the middle of a
 * few thrown in set-up, for each hand. The zones are then measured from
 * there, so a short person, a low camera and a habit of punching low all come
 * out the same.
 */
export function learnMarks(
  ends: readonly { hand: Hand; point: Point }[],
  before: AimMarks = defaultMarks(),
): AimMarks {
  const marks: AimMarks = { head: before.head, middle: [before.middle[0], before.middle[1]] };
  const ys = ends.map((e) => e.point.y);
  if (ys.length >= 3) marks.head = median(ys);
  for (const [i, hand] of (["left", "right"] as const).entries()) {
    const xs = ends.filter((e) => e.hand === hand).map((e) => e.point.x);
    if (xs.length >= 3) marks.middle[i] = median(xs);
  }
  return marks;
}
