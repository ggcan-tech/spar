import type { Landmark } from "@spar/protocol";
import { JOINT, JOINT_COUNT } from "../pov/body";
import type { TrackingResult } from "../pov/tracking";
import { FIELD, SLING, ZONES } from "./tune";

/**
 * The player's body, flat, as the duel uses it.
 *
 * Two kinds of numbers are kept apart on purpose:
 * - **travel** (a step, a duck) is in the player's own real metres, one to one;
 * - **shape** (where a hand is against the hips) is drawn on one standard figure,
 *   the same size for everyone, so a child is not a smaller target than an adult.
 * Gates that judge a movement (a flick of 10 cm) use real metres.
 *
 * Mirror: x is the player's right, which is the right of their screen.
 */
export interface P2 {
  x: number;
  y: number;
}
export const p2 = (x = 0, y = 0): P2 => ({ x, y });
export const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);

export type Side = "left" | "right";
export const other = (s: Side): Side => (s === "left" ? "right" : "left");

/** One pose of the player in the picture plane, in their own room. */
export interface FlatPose {
  /** Even motion clock, ms: for speeds. */
  t: number;
  /** When the camera captured it, ms: for rule D. */
  cap: number;
  /** Joints, real metres, relative to the hip midpoint; JOINT order. */
  j: P2[];
  /** 0–1 per joint: 1 seen, falling to 0 when lost. */
  w: number[];
  /** Hips against the home spot, real metres. */
  root: P2;
  /** Real metres per tracker unit for this player. */
  metres: number;
  /** Each wrist's distance to the nearest side edge and to the top of the camera picture, metres; null when not measured. */
  edges: [Edge | null, Edge | null];
  /** The pose is a hold of an older one (the camera lost the body for a moment). */
  held: boolean;
}
export interface Edge {
  side: number;
  top: number;
}

/** The flat pose from the tracker's result. Null when the tracker has no body. */
export function flatPose(
  result: TrackingResult,
  t: number,
  cap: number,
  metres: number,
  picture: { lm: readonly Landmark[]; aspect: number; metresHigh: number } | null,
): FlatPose | null {
  if (!result.valid || !result.joints || !result.jointWeights || result.units === "normalized") return null;
  const m = metres > 0 ? metres : 0.78;
  const j = result.joints.map((q) => p2(q.x * m, q.y * m));
  const edges: [Edge | null, Edge | null] = [null, null];
  if (picture && picture.metresHigh > 0 && picture.lm.length > 16) {
    const high = picture.metresHigh,
      wide = high / (picture.aspect || 9 / 16);
    for (const [i, k] of [
      [0, 15],
      [1, 16],
    ] as const) {
      const lm = picture.lm[k];
      if (lm && Number.isFinite(lm.x) && Number.isFinite(lm.y))
        edges[i] = { side: Math.min(lm.x, 1 - lm.x) * wide, top: lm.y * high };
    }
  }
  return {
    t,
    cap,
    j,
    w: [...result.jointWeights],
    root: p2(result.root.x * m, result.root.y * m),
    metres: m,
    edges,
    held: !!result.held,
  };
}

/** Where a lane is: its middle and which way the opponent is (+1 to the right). */
export interface Lane {
  side: Side;
  middle: number;
  toward: 1 | -1;
}
export const laneOf = (side: Side): Lane =>
  side === "left" ? { side, middle: -FIELD.laneMiddle, toward: 1 } : { side, middle: FIELD.laneMiddle, toward: -1 };

/** A body drawn and judged in the field. */
export interface Figure {
  /** The 19 joints in field metres (floor at y = 0). */
  j: P2[];
  w: number[];
  /** Invented legs: the camera sees to mid-thigh. */
  knees: [P2, P2];
  feet: [P2, P2];
  hips: P2;
  shoulders: P2;
  head: { c: P2; r: number };
  /** The chest plate: x from x0 to x1, y from y0 (bottom) to y1 (top). */
  chest: { x0: number; x1: number; y0: number; y1: number };
  /** Tracking lost: drawn as stone, still hittable. */
  stone: boolean;
}

const mid = (a: P2, b: P2) => p2((a.x + b.x) / 2, (a.y + b.y) / 2);

/** Hand-made thighs and shins for the standard figure. */
const LEG = { thigh: 0.47, shin: 0.45, stance: 0.12 };

/** A knee between hip and foot, bent outward (seen from the front, a squat spreads the knees). */
function knee(hip: P2, foot: P2, out: 1 | -1): P2 {
  const d = dist(hip, foot);
  const a = LEG.thigh,
    b = LEG.shin;
  const reach = Math.min(d, a + b - 1e-4);
  const along = (a * a - b * b + reach * reach) / (2 * reach);
  // Seen from the front, most of a knee's bend points at the camera: only part of it shows sideways.
  const h = 0.4 * Math.sqrt(Math.max(0, a * a - along * along));
  const ux = (foot.x - hip.x) / (d || 1),
    uy = (foot.y - hip.y) / (d || 1);
  // The perpendicular pointing outward.
  let px = -uy,
    py = ux;
  if (px * out < 0) {
    px = -px;
    py = -py;
  }
  return p2(hip.x + ux * along + px * h, hip.y + uy * along + py * h);
}

/** Zones and legs for a set of field joints. */
export function figureFrom(j: P2[], w: number[], stone = false): Figure {
  const hips = mid(j[JOINT.L_HIP], j[JOINT.R_HIP]);
  const shoulders = mid(j[JOINT.L_SHOULDER], j[JOINT.R_SHOULDER]);
  const feet: [P2, P2] = [p2(hips.x - LEG.stance, 0.04), p2(hips.x + LEG.stance, 0.04)];
  const knees: [P2, P2] = [knee(j[JOINT.L_HIP], feet[0], -1), knee(j[JOINT.R_HIP], feet[1], 1)];
  const nose = j[JOINT.NOSE];
  const y1 = shoulders.y - ZONES.chestBelowShoulders,
    y0 = y1 - ZONES.chestTall;
  // The plate follows the trunk: its middle sits on the shoulders-to-hips line at the plate's middle height.
  const k = (shoulders.y - (y0 + y1) / 2) / Math.max(0.05, shoulders.y - hips.y);
  const cx = shoulders.x + (hips.x - shoulders.x) * Math.max(0, Math.min(1, k));
  return {
    j,
    w,
    knees,
    feet,
    hips,
    shoulders,
    head: { c: p2(nose.x, nose.y + ZONES.headAboveNose), r: ZONES.headRadius },
    chest: { x0: cx - ZONES.chestWide / 2, x1: cx + ZONES.chestWide / 2, y0, y1 },
    stone,
  };
}

/**
 * The player's figure in their lane: travel one to one, shape on the standard
 * figure. `gain` (only in friend rooms, for small rooms) widens sideways travel.
 */
export function placeFigure(pose: FlatPose, lane: Lane, o: { gain?: number; stone?: boolean } = {}): Figure {
  const k = FIELD.figureUnit / pose.metres;
  const gx = lane.middle + pose.root.x * (o.gain ?? 1);
  const gy = FIELD.hipHeight + Math.min(0.15, pose.root.y);
  const j = pose.j.map((q) => p2(gx + q.x * k, gy + q.y * k));
  return figureFrom(j, pose.w, o.stone);
}

/** A standard figure posed by numbers: for bots, dummies and tests. */
export interface FigureSpec {
  /** Hips' x in the field. */
  x: number;
  /** How far the hips are lowered, metres. */
  duck?: number;
  /** Shoulders moved sideways against the hips, metres (+ to screen right). */
  lean?: number;
  /** Which way the figure's opponent is. */
  toward: 1 | -1;
  /** A sling held: launch angle in degrees and draw 0–1. Null: arms down. */
  sling?: { angle: number; draw: number } | null;
  /** The pulling hand flicked back (the moment after letting go). */
  flicked?: boolean;
  /** Hands on the head (an answer, or a cheer). */
  handsUp?: boolean;
}

/** Standard proportions, in field metres, for a figure built from numbers. */
const STD = {
  shoulderHalf: 0.19,
  hipHalf: 0.105,
  torso: 0.46,
  neck: 0.17,
  upper: 0.29,
  fore: 0.27,
};

export function standardFigure(s: FigureSpec): Figure {
  const duck = Math.max(0, s.duck ?? 0);
  const hips = p2(s.x, FIELD.hipHeight - duck);
  const lean = s.lean ?? 0;
  const top = p2(hips.x + lean, hips.y + Math.sqrt(Math.max(0.01, STD.torso ** 2 - lean ** 2)));
  const j: P2[] = Array.from({ length: JOINT_COUNT }, () => p2());
  j[JOINT.L_HIP] = p2(hips.x - STD.hipHalf, hips.y);
  j[JOINT.R_HIP] = p2(hips.x + STD.hipHalf, hips.y);
  j[JOINT.L_SHOULDER] = p2(top.x - STD.shoulderHalf, top.y);
  j[JOINT.R_SHOULDER] = p2(top.x + STD.shoulderHalf, top.y);
  j[JOINT.NOSE] = p2(top.x + lean * 0.4, top.y + STD.neck);
  j[JOINT.L_EAR] = p2(j[JOINT.NOSE].x - 0.07, j[JOINT.NOSE].y + 0.01);
  j[JOINT.R_EAR] = p2(j[JOINT.NOSE].x + 0.07, j[JOINT.NOSE].y + 0.01);
  // Arms: down by default.
  const arm = (shoulder: P2, wrist: P2, out: 1 | -1) => {
    const d = Math.min(dist(shoulder, wrist), STD.upper + STD.fore - 1e-3);
    const along = (STD.upper ** 2 - STD.fore ** 2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, STD.upper ** 2 - along * along));
    const ux = (wrist.x - shoulder.x) / (dist(shoulder, wrist) || 1),
      uy = (wrist.y - shoulder.y) / (dist(shoulder, wrist) || 1);
    // Elbows bend down and outward.
    let px = -uy,
      py = ux;
    if (py > 0 || (Math.abs(py) < 1e-6 && px * out < 0)) {
      px = -px;
      py = -py;
    }
    return p2(shoulder.x + ux * along + px * h, shoulder.y + uy * along + py * h);
  };
  const L = j[JOINT.L_SHOULDER],
    R = j[JOINT.R_SHOULDER];
  let lw = p2(L.x - 0.06, L.y - 0.52),
    rw = p2(R.x + 0.06, R.y - 0.52);
  if (s.handsUp) {
    lw = p2(j[JOINT.NOSE].x - 0.09, j[JOINT.NOSE].y + 0.12);
    rw = p2(j[JOINT.NOSE].x + 0.09, j[JOINT.NOSE].y + 0.12);
  } else if (s.sling) {
    // The sling arm points toward the opponent; the other hand pulls back to the chin.
    const slingIsLeft = s.toward < 0;
    const shoulder = slingIsLeft ? L : R;
    // The hand line that gives this launch angle (the inverse of flight.launchAngle).
    const rad = ((s.sling.angle - SLING.angleBase + SLING.ownLevel) * Math.PI) / 180;
    const reach = (STD.upper + STD.fore) * 0.97;
    const sw = p2(shoulder.x + s.toward * Math.cos(rad) * reach, shoulder.y + Math.sin(rad) * reach);
    const chin = p2(j[JOINT.NOSE].x - s.toward * 0.04, j[JOINT.NOSE].y - 0.1);
    // Draw 0: only the sling arm is out; the other hangs at rest.
    const restPull = slingIsLeft ? rw : lw;
    const pulled = s.sling.draw <= 0 && !s.flicked
      ? restPull
      : s.flicked
      ? p2(chin.x - s.toward * 0.22, chin.y + 0.06)
      : p2(sw.x + (chin.x - sw.x) * (0.35 + 0.65 * s.sling.draw), sw.y + (chin.y - sw.y) * (0.35 + 0.65 * s.sling.draw));
    if (slingIsLeft) {
      lw = sw;
      rw = pulled;
    } else {
      rw = sw;
      lw = pulled;
    }
  }
  j[JOINT.L_WRIST] = lw;
  j[JOINT.R_WRIST] = rw;
  j[JOINT.L_ELBOW] = arm(L, lw, -1);
  j[JOINT.R_ELBOW] = arm(R, rw, 1);
  j[JOINT.L_KNUCKLE] = p2(lw.x + (lw.x - j[JOINT.L_ELBOW].x) * 0.3, lw.y + (lw.y - j[JOINT.L_ELBOW].y) * 0.3);
  j[JOINT.R_KNUCKLE] = p2(rw.x + (rw.x - j[JOINT.R_ELBOW].x) * 0.3, rw.y + (rw.y - j[JOINT.R_ELBOW].y) * 0.3);
  const w = Array<number>(JOINT_COUNT).fill(1);
  return figureFrom(j, w);
}
