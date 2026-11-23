import { JOINT } from "../../pov/body";
import type { Guard } from "../defence";
import { bodyPoint, handAhead, solveArm, type AimSetup, type AimSource, type Point } from "./aim";

/**
 * A physical guard: where the gloves and forearms are, and how much of an
 * incoming punch they keep out.
 *
 * Only in the plane that faces the opponent, never depth. The model's depth
 * for a wrist near the face is wrong by 5–10 cm, and one hand behind the other
 * is where it is worst. But the picture alone is wrong too: a glove held 11 cm
 * in front of the nose looks 7 cm higher against the face from a low table
 * and 2 cm lower from a shelf. So the arm is solved with its bone lengths
 * first (aim.ts) and turned by the tilt found in set-up, and only then laid
 * flat.
 *
 * One thing no picture says: whether a forearm that looks its full length
 * tips toward the camera or away. A guard settles it by what a guard is. A
 * forearm held up stands up; the upper arm of a hand held low hangs. So a
 * lead hand held well out in front (a long guard) reads a few centimetres
 * high from a low camera: the one guard the study's test does not hold for.
 *
 * The shapes are wide and their edges soft. Each glove is a disc of 7.5 cm
 * (the wrist plus 8 cm along the forearm); each forearm is a strip 9 cm wide
 * from elbow to wrist. A punch is kept out in full when its line passes 4 cm
 * inside a shape, not at all 4 cm outside, and smoothly between. A hard edge
 * would flip from one pose to the next: the place of a glove against a punch
 * is known to ±3 cm at best.
 *
 * Every place is the middle of the last three poses, so one wild pose moves
 * nothing.
 *
 * Sizes are in arm lengths; the centimetres are for an arm of 0.55 m.
 * Measured on the scripted person (guardShape.test.ts): the same guard keeps
 * out the same share of punches at the head, and at the body, within 10% from
 * six camera heights. One punch aimed right at a glove's edge is another
 * matter: there a glove read 2 cm out moves the share by a quarter.
 */
const CM = 1 / 55;
export const GUARD_SHAPE = {
  /** The glove: a disc of this radius, its middle this far past the wrist along the forearm. */
  glove: 7.5 * CM,
  gloveAhead: 8 * CM,
  /** The forearm: a strip of this half-width from elbow to wrist. */
  strip: 4.5 * CM,
  /** Full this far inside a shape's edge, none this far outside. */
  soft: 4 * CM,
  /** Places are the middle of this many poses, none older than this. */
  poses: 3,
  freshMs: 160,
  /** A glove in the guard is taken to be this far in front of its shoulder when the elbow cannot say; the nose this far in front of the shoulder line. */
  guardAhead: 0.36,
  noseAhead: 0.17,
  /** With the head hidden, the nose is this far above the shoulder line. */
  noseUp: 0.31,
  /** Hands up: the glove's middle no lower than this above the shoulder line, and within this of the body's middle. */
  upAbove: 0.04,
  upAcross: 0.6,
  /** Covering: the glove's middle this far above the nose; once covering, until it has come this far back down. */
  coverAboveNose: 0.11,
  coverHold: 0.06,
  /** Down at the body: the wrist at least this far below the shoulder line, this far above the hips, and within this of the middle. */
  lowBelow: 0.2,
  lowAboveHips: 0.17,
  lowAcross: 0.5,
};
export interface GloveShape {
  /** The glove's middle and the wrist, in the plane facing the opponent, from home, in arm lengths. */
  glove: Point;
  wrist: Point;
  /** The elbow; null when it could not be trusted, and then there is no strip. */
  elbow: Point | null;
}
export interface GuardShapes {
  t: number;
  /** [left, right]; null when that hand was not seen. */
  hands: [GloveShape | null, GloveShape | null];
  /** The nose, the middle of the shoulders and the middle of the hips, in the same plane. `headSeen` false: the nose is a guess from the shoulders. */
  head: Point;
  headSeen: boolean;
  shoulders: Point;
  hips: Point;
  /** The body was followed at all. */
  valid: boolean;
  /** One arm length in game units, for those who need the tracker's own units. */
  arm: number;
}
export interface GuardShare {
  /** How much of the punch the guard keeps out, 0 to 1: the best of the four shapes. */
  share: number;
  /** Each glove's share and each forearm's, [left, right]. */
  glove: [number, number];
  arm: [number, number];
}

const smooth = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
/** Full `soft` inside the edge, none `soft` outside; `distance` is from the shape's middle line. */
export const coverOf = (distance: number, edge: number, soft = GUARD_SHAPE.soft) =>
  smooth((edge + soft - distance) / (2 * soft));
const mid3 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const middleOf = (points: Point[]): Point => ({ x: mid3(points.map((p) => p.x)), y: mid3(points.map((p) => p.y)) });
/** The shortest distance between two line pieces in the plane. Either may be a single point. */
function between(a: Point, b: Point, c: Point, d: Point): number {
  const toPiece = (p: Point, q: Point, r: Point) => {
    const vx = r.x - q.x,
      vy = r.y - q.y;
    const len = vx * vx + vy * vy;
    const k = len > 0 ? Math.max(0, Math.min(1, ((p.x - q.x) * vx + (p.y - q.y) * vy) / len)) : 0;
    return Math.hypot(p.x - q.x - vx * k, p.y - q.y - vy * k);
  };
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  // Crossing pieces touch.
  if (
    side(a, b, c) * side(a, b, d) < 0 &&
    side(c, d, a) * side(c, d, b) < 0
  )
    return 0;
  return Math.min(toPiece(a, c, d), toPiece(b, c, d), toPiece(c, a, b), toPiece(d, a, b));
}

interface Raw {
  t: number;
  wrists: [Point | null, Point | null];
  elbows: [Point | null, Point | null];
  head: Point | null;
  shoulders: Point;
  hips: Point;
}
/**
 * Follows the gloves and forearms. Call `update` once for each pose with the
 * tracker's result, the range now (game units) and the pose's time; it gives
 * the shapes as the middle of the last three poses.
 */
export function createGuardShapes(setup: AimSetup) {
  let aim = setup;
  let kept: Raw[] = [];
  let shapes: GuardShapes | null = null;
  return {
    /** A new set-up, or the old one moved (see `recentred`). */
    setSetup(next: AimSetup) {
      aim = next;
      kept = [];
    },
    update(source: AimSource & { valid?: boolean }, range: number, t: number): GuardShapes | null {
      const joints = source.joints,
        weights = source.jointWeights;
      if (source.valid === false || !joints || !weights || !(range > 0)) {
        kept = kept.filter((k) => t - k.t <= GUARD_SHAPE.freshMs);
        shapes = shapes ? { ...shapes, t, valid: false, hands: [null, null] } : null;
        return shapes;
      }
      const body = bodyPoint(source, { x: 0, y: 0, z: 0 }, aim, range, 0);
      if (!body) return shapes;
      const noseSeen = weights[JOINT.NOSE] >= 0.6;
      const nose = noseSeen ? bodyPoint(source, joints[JOINT.NOSE], aim, range, GUARD_SHAPE.noseAhead) : null;
      const raw: Raw = { t, wrists: [null, null], elbows: [null, null], head: nose?.point ?? null, shoulders: body.shoulders, hips: body.point };
      for (const [i, hand] of (["left", "right"] as const).entries()) {
        const arm = solveArm(source, hand, aim, range, { guard: true });
        if (!arm) continue;
        if (arm.elbow) {
          raw.wrists[i] = arm.point;
          raw.elbows[i] = arm.elbowAt;
        } else raw.wrists[i] = handAhead(source, hand, aim, range, GUARD_SHAPE.guardAhead);
      }
      kept.push(raw);
      kept = kept.filter((k) => t - k.t <= GUARD_SHAPE.freshMs).slice(-GUARD_SHAPE.poses);
      const shoulders = middleOf(kept.map((k) => k.shoulders));
      const heads = kept.map((k) => k.head).filter((p): p is Point => p !== null);
      const hands: [GloveShape | null, GloveShape | null] = [null, null];
      for (let i = 0; i < 2; i++) {
        // A hand must be in the newest pose, and is placed from every recent pose that had it.
        if (!raw.wrists[i]) continue;
        const wrist = middleOf(kept.map((k) => k.wrists[i]).filter((p): p is Point => p !== null));
        const elbows = kept.map((k) => k.elbows[i]).filter((p): p is Point => p !== null);
        const elbow = raw.elbows[i] && elbows.length ? middleOf(elbows) : null;
        let glove: Point;
        if (elbow) {
          // Along the forearm as it lies in the plane: a forearm pointing at the opponent puts the glove on the wrist.
          const fore = aim.bones[i].foreArm / aim.reach[i];
          glove = {
            x: wrist.x + ((wrist.x - elbow.x) / fore) * GUARD_SHAPE.gloveAhead,
            y: wrist.y + ((wrist.y - elbow.y) / fore) * GUARD_SHAPE.gloveAhead,
          };
        } else
          // No elbow: a raised hand's forearm is taken to be upright.
          glove = { x: wrist.x, y: wrist.y + (wrist.y > shoulders.y - 0.1 ? GUARD_SHAPE.gloveAhead : 0) };
        hands[i] = { glove, wrist, elbow };
      }
      shapes = {
        t,
        hands,
        head: heads.length ? middleOf(heads) : { x: shoulders.x, y: shoulders.y + GUARD_SHAPE.noseUp },
        headSeen: heads.length > 0,
        shoulders,
        hips: middleOf(kept.map((k) => k.hips)),
        valid: true,
        arm: (aim.reach[0] + aim.reach[1]) / 2,
      };
      return shapes;
    },
    shapes: () => shapes,
    reset() {
      kept = [];
      shapes = null;
    },
  };
}
export type GuardShapeReader = ReturnType<typeof createGuardShapes>;

/**
 * How much of a punch the guard keeps out. `to` is where the punch will
 * arrive, in the same plane as the shapes (from home, in arm lengths): the
 * head's place when the fist left, a point on the body. `from`, when given, is
 * where its line starts in that plane: a hook comes in from the side, an
 * uppercut from below, and is stopped by anything on that line. A straight
 * punch comes down the line of sight and is a point. `out` marks hands that
 * are out punching: they guard nothing.
 */
export function guardShare(
  shapes: GuardShapes | null,
  to: Point,
  from: Point | null = null,
  out: readonly [boolean, boolean] = [false, false],
): GuardShare {
  const result: GuardShare = { share: 0, glove: [0, 0], arm: [0, 0] };
  if (!shapes || !shapes.valid) return result;
  const start = from ?? to;
  for (let i = 0; i < 2; i++) {
    const hand = shapes.hands[i];
    if (!hand || out[i]) continue;
    result.glove[i] = coverOf(between(start, to, hand.glove, hand.glove), GUARD_SHAPE.glove);
    if (hand.elbow) result.arm[i] = coverOf(between(start, to, hand.elbow, hand.wrist), GUARD_SHAPE.strip);
  }
  result.share = Math.max(result.glove[0], result.glove[1], result.arm[0], result.arm[1]);
  return result;
}

/**
 * The same reading as the rules' own `Guard`: which glove is by the chin,
 * which is covering, which is down at the body, for each side. Heights are
 * measured against the nose and the shoulder line after the tilt is taken
 * out, so the same guard reads the same from a low table and from a shelf.
 * `known` is false when a hand was not seen: a hand that was not seen is not
 * known to be down. `out` marks hands that are out punching; `held` the
 * gloves that were covering at the last pose.
 */
export function guardFromShapes(
  shapes: GuardShapes | null,
  out: readonly [boolean, boolean] = [false, false],
  held: readonly [boolean, boolean] = [false, false],
): Guard {
  const guard: Guard = {
    high: 0,
    low: 0,
    up: 0,
    heights: [null, null],
    sides: { high: [false, false], low: [false, false], up: [false, false] },
    known: true,
  };
  if (!shapes || !shapes.valid) return { ...guard, known: false };
  const g = GUARD_SHAPE;
  for (let i = 0; i < 2; i++) {
    const hand = shapes.hands[i];
    if (!hand && !out[i]) guard.known = false;
    if (!hand || out[i]) continue;
    const high = hand.glove.y - shapes.shoulders.y,
      across = Math.abs(hand.glove.x - shapes.shoulders.x);
    // In game units, as `readGuard` gives them.
    guard.heights[i] = (hand.wrist.y - shapes.shoulders.y) * shapes.arm;
    if (high >= g.upAbove && across <= g.upAcross) {
      guard.up++;
      guard.sides!.up![i] = true;
      if (hand.glove.y >= shapes.head.y + g.coverAboveNose - (held[i] ? g.coverHold : 0)) {
        guard.high++;
        guard.sides!.high[i] = true;
      }
    } else if (
      hand.wrist.y <= shapes.shoulders.y - g.lowBelow &&
      hand.wrist.y >= shapes.hips.y + g.lowAboveHips &&
      Math.abs(hand.wrist.x - shapes.shoulders.x) <= g.lowAcross
    ) {
      guard.low++;
      guard.sides!.low[i] = true;
    }
  }
  return guard;
}
