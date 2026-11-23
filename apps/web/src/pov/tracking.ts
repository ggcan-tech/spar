import { LM, type Landmark, type PoseFrame } from "@spar/protocol";
import { createMotionFilter, leadOf } from "./motionFilter";
import { JOINT, JOINT_COUNT, JOINT_LANDMARK } from "./body";

export interface PovVector {
  x: number;
  y: number;
  z: number;
}
export interface PovTrackingOptions {
  /** Establish a stable neutral pose from update() without a separate action. */
  automatic?: boolean;
  /** Map body proportions to a fixed avatar scale, not measured room metres. */
  scaleMode?: "body-relative";
  shoulderWidthM?: number;
  distanceM?: number;
  staleAfterMs?: number;
  smoothingMs?: number;
  maxYawRad?: number;
  maxSpanJumpRatio?: number;
  calibrationSamples?: number;
  calibrationMinMs?: number;
  bounds?: PovVector;
  /**
   * After setup, a head that is in the picture but hidden (gloves held in
   * front of the face) is placed from the shoulders, as one that has left the
   * picture is, instead of counting as a lost body. Off by default: the ball
   * game never hides the face on purpose.
   */
  hiddenHeadFromShoulders?: boolean;
}
export interface TrackingResult {
  valid: boolean;
  calibrated: boolean;
  confidence: number;
  units: "meters" | "normalized" | "game";
  calibrationProgress?: number;
  /** A bounded hold of the last observed pose during a brief detector dropout. */
  held?: boolean;
  /** Parts placed from the shoulders because they are outside the camera's view. */
  inferred?: ("hips" | "head")[];
  /** Delta from initial nose position; +x player's right, +y up, +z toward phone. */
  head: PovVector;
  /** Delta from initial hip midpoint, estimated from image projection. */
  root: PovVector;
  /** Change in nose position relative to hips, independent of root translation. */
  headRelativeTorso: PovVector;
  /** Current positions relative to current hip midpoint, not initial hand deltas. */
  leftHand: PovVector;
  rightHand: PovVector;
  /** Missing or implausible wrists do not invalidate head/torso movement. */
  leftHandTracked?: boolean;
  rightHandTracked?: boolean;
  outOfBounds: boolean;
  depthValid: boolean;
  reason: string | null;
  /**
   * Every body joint in JOINT order, relative to the current hip midpoint like
   * the hands. Image x/y is the direct observation; depth is model-estimated.
   */
  joints?: PovVector[];
  /** 0–1 per joint: 1 while observed, ramping to 0 when the camera loses it. */
  jointWeights?: number[];
  /** Estimated floor: lowest recent ankle height from the calibrated hip origin. */
  floorY?: number | null;
  /** Height of the [left, right] ankle above that floor; 0 when planted or unseen. */
  footLift?: [number, number];
}

interface Measurement {
  t: number;
  aspect: number;
  span: number;
  confidence: number;
  depthValid: boolean;
  depthReason?: string;
  hip: Landmark;
  nose: Landmark;
  /** Midpoint of the shoulders: the anchor when the hips or head leave the frame. */
  shoulder: Landmark;
  /** Shoulder line to hip line in the image, in image-height units. */
  torso: number;
  /** Hips or head placed from the shoulders because the camera could not see them. */
  inferred?: ("hips" | "head")[];
  left: Landmark | null;
  right: Landmark | null;
  world?: PoseFrame["world"];
  lm: Landmark[];
  capturedAt?: number;
  /** Evenly spaced time for speeds and filters; the frame's own time when none was given. */
  clock: number;
}
const vector = (x = 0, y = 0, z = 0): PovVector => ({ x, y, z });
const minus = (a: PovVector, b: PovVector) =>
  vector(a.x - b.x, a.y - b.y, a.z - b.z);
const plus = (a: PovVector, b: PovVector) =>
  vector(a.x + b.x, a.y + b.y, a.z + b.z);
const mix = (a: PovVector, b: PovVector, k: number) =>
  vector(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
const midpoint = (a: Landmark, b: Landmark): Landmark => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
  v: Math.min(a.v, b.v),
});
const finite = (p: Landmark | undefined): p is Landmark =>
  !!p && [p.x, p.y, p.z, p.v].every(Number.isFinite);
const visible = (
  p: Landmark | undefined,
  minVisibility = 0.6,
  margin = 0,
): p is Landmark =>
  finite(p) &&
  p.v >= minVisibility &&
  p.x >= -margin &&
  p.x <= 1 + margin &&
  p.y >= -margin &&
  p.y <= 1 + margin &&
  Math.abs(p.z) <= 3;
/** Depth of the head and hips: slower filter than sideways and vertical motion. */
const DEPTH_FILTER = { minCutoff: 1.5, beta: 3 };
/** Fastest the hips are believed to move, game units a second (a hard dodge is about 2.5). */
const MAX_BODY_SPEED = 6;
/** A jump smaller than this is never questioned, whatever the frame spacing. */
const GLITCH_JUMP = 0.12;
/** A second pose this close to a questioned one confirms it. */
const GLITCH_AGREE = 0.15;
/** Head and shoulders in view without hips for this long: set up on the upper body. */
const UPPER_BODY_SETUP_MS = 1500;
/**
 * Setup does not lock while the body is badly placed in the picture, for at
 * most this long. A setup that can never complete is worse than one that is
 * off-centre: play takes a new centre on the spot later (see recenter).
 */
const BAD_FRAMING_MAX_MS = 4000;
/** The middle of the shoulders across the picture, and their width in image heights. */
export const GOOD_FRAMING = { left: 0.3, right: 0.7, small: 0.07, large: 0.45 };
/**
 * After a loss, a body that comes back this different in size, or in build
 * (torso length over shoulder width, which distance does not change), is
 * someone else: a person walking behind, or another player stepping in. It is
 * not played. If it stays this long it is the player now and gets its own setup.
 */
const SAME_PERSON = { size: [0.7, 1.45], build: [0.8, 1.25] } as const;
const STRANGER_MS = 1500;
/** Shoulder line above the hips over shoulder width, from the avatar's proportions (0.468 / 0.4). */
const TORSO_OVER_SHOULDERS = 1.17;
/** Setup frames that do not fit the rest for this long mean the body moved. */
const STRAY_MS = 120;
/** A tracked body part may sit this far outside the image and still be used. */
const FRAME_MARGIN = 0.05;
/** Closer than this to an image edge, or past it, a part counts as leaving the picture. */
const EDGE = 0.03;
const BODY_PARTS = [
  { name: "head", indices: [LM.NOSE] },
  { name: "shoulders", indices: [LM.L_SHOULDER, LM.R_SHOULDER] },
  { name: "hips", indices: [LM.L_HIP, LM.R_HIP] },
];
const required = BODY_PARTS.flatMap(({ indices }) => indices);
/** The same visibility contract is used for calibration and framing guidance. */
export function missingBodyParts(
  landmarks: Landmark[],
  minVisibility = 0.6,
  margin = 0,
): string[] {
  return BODY_PARTS.filter(({ indices }) =>
    indices.some((i) => !visible(landmarks?.[i], minVisibility, margin)),
  ).map(({ name }) => name);
}
/** The named part is at or beyond an edge of the image, rather than hidden inside it. */
function outOfView(landmarks: Landmark[], part: string): boolean {
  return (
    BODY_PARTS.find(({ name }) => name === part)?.indices.some((i) => {
      const p = landmarks[i];
      return (
        finite(p) &&
        (p.x < EDGE || p.x > 1 - EDGE || p.y < EDGE || p.y > 1 - EDGE)
      );
    }) ?? false
  );
}
/** Image-relative z is approximate; use coherent world coordinates when usable. */
export function shoulderOrientation(frame: PoseFrame) {
  const left = frame.lm?.[LM.L_SHOULDER],
    right = frame.lm?.[LM.R_SHOULDER];
  const imageYaw =
    finite(left) && finite(right)
      ? Math.atan2(Math.abs(left.z - right.z), Math.abs(left.x - right.x))
      : null;
  const wl = frame.world?.[LM.L_SHOULDER],
    wr = frame.world?.[LM.R_SHOULDER];
  const worldYaw =
    finite(wl) &&
    finite(wr) &&
    wl.v >= 0.6 &&
    wr.v >= 0.6 &&
    Math.hypot(wl.x - wr.x, wl.z - wr.z) > 0.05
      ? Math.atan2(Math.abs(wl.z - wr.z), Math.abs(wl.x - wr.x))
      : null;
  return { imageYaw, worldYaw, yaw: worldYaw ?? imageYaw };
}
const clampVector = (p: PovVector, limit: PovVector): PovVector =>
  vector(
    Math.max(-limit.x, Math.min(limit.x, p.x)),
    Math.max(-limit.y, Math.min(limit.y, p.y)),
    Math.max(-limit.z, Math.min(limit.z, p.z)),
  );
const beyond = (p: PovVector, limit: PovVector) =>
  Math.abs(p.x) > limit.x || Math.abs(p.y) > limit.y || Math.abs(p.z) > limit.z;

/** Experimental calibrated RGB projection estimate, not a metric tracking sensor. */
export function createPovTracker(options: PovTrackingOptions = {}) {
  for (const key of ["shoulderWidthM", "distanceM"] as const) {
    if (
      options[key] !== undefined &&
      (!Number.isFinite(options[key]) || options[key]! <= 0)
    )
      throw new RangeError(`${key} must be positive`);
  }
  const bodyRelative = options.scaleMode === "body-relative";
  // How long the last pose is kept when body landmarks drop out. It has to be
  // longer than one pose interval plus pipeline time (about 81 ms at 28 poses/s
  // and 45 ms), or a single weak frame pauses the round; 80 ms never engaged.
  const continuityMs = bodyRelative && options.automatic ? 250 : 0;
  const metric =
    !bodyRelative &&
    options.shoulderWidthM !== undefined &&
    options.distanceM !== undefined;
  // Canonical avatar proportions are game design choices. They do not infer the
  // player's physical shoulder width, camera distance, or unobstructed room size.
  const scaleWidth = bodyRelative ? 0.4 : metric ? options.shoulderWidthM! : 1;
  const scaleDistance = bodyRelative ? 2 : metric ? options.distanceM! : 1;
  const scaled = bodyRelative || metric;
  const staleAfterMs = options.staleAfterMs ?? 250;
  const smoothingMs = options.smoothingMs ?? 35;
  const maxYawRad = options.maxYawRad ?? 0.35;
  const maxSpanJumpRatio = options.maxSpanJumpRatio ?? 0.15;
  const calibrationSamples = options.calibrationSamples ?? 12;
  const calibrationMinMs =
    options.calibrationMinMs ?? (options.automatic ? 700 : 400);
  const bounds = options.bounds ?? vector(0.6, 1.2, 0.25);
  if (
    !Number.isFinite(staleAfterMs) ||
    staleAfterMs <= 0 ||
    !Number.isFinite(smoothingMs) ||
    smoothingMs < 0 ||
    !Number.isFinite(maxYawRad) ||
    maxYawRad <= 0 ||
    maxYawRad >= Math.PI / 2 ||
    !Number.isFinite(maxSpanJumpRatio) ||
    maxSpanJumpRatio <= 0 ||
    maxSpanJumpRatio >= 1 ||
    !Number.isInteger(calibrationSamples) ||
    calibrationSamples < 2 ||
    !Number.isFinite(calibrationMinMs) ||
    calibrationMinMs < 0 ||
    ![bounds.x, bounds.y, bounds.z].every((n) => Number.isFinite(n) && n > 0)
  )
    throw new RangeError("Invalid tracking configuration");
  const headBounds = vector(bounds.x + 0.25, bounds.y + 0.25, bounds.z + 0.15);
  const units = bodyRelative ? "game" : metric ? "meters" : "normalized";
  const empty = (): TrackingResult => ({
    valid: false,
    held: false,
    calibrated: false,
    calibrationProgress: 0,
    confidence: 0,
    units,
    head: vector(),
    root: vector(),
    headRelativeTorso: vector(),
    leftHand: vector(),
    rightHand: vector(),
    leftHandTracked: false,
    rightHandTracked: false,
    outOfBounds: false,
    depthValid: false,
    reason: "uncalibrated",
    joints: Array.from({ length: JOINT_COUNT }, () => vector()),
    jointWeights: Array<number>(JOINT_COUNT).fill(0),
    floorY: null,
    footLift: [0, 0],
  });
  let result = empty();
  let baseline: Measurement | null = null;
  let samples: Measurement[] = [];
  /** When setup frames first stopped fitting the rest, or -1; see calibrate(). */
  let strayFrom = -1;
  /** When setup first saw head and shoulders without hips, or -1. */
  let hipsMissingSince = -1;
  /** When setup first had enough samples but the body badly placed, or -1. */
  let badFramingSince = -1;
  /** When a body unlike the player's first came back after a loss, or -1. */
  let strangerSince = -1;
  /** The last accepted measurements, for taking a new centre on the spot. */
  let recent: Measurement[] = [];
  /** The shoulders' depth and width over the last quarter second, for a turn that is not one noisy reading. */
  let turns: { t: number; dz: number; dx: number }[] = [];
  /**
   * How far the shoulders are turned from the camera. The model's depth for a
   * shoulder jitters by centimetres, and one reading of it used to count as a
   * turn: with noisy depth, setup was sent back to the start again and again
   * and never finished. A real turn keeps its side for longer than a pose; so
   * the depth and the width are each averaged, signs kept, over a quarter of a
   * second, and the turn is read from the averages.
   */
  const steadyYaw = (frame: PoseFrame): number => {
    const wl = frame.world?.[LM.L_SHOULDER],
      wr = frame.world?.[LM.R_SHOULDER];
    const world =
      finite(wl) && finite(wr) && wl.v >= 0.6 && wr.v >= 0.6 && Math.hypot(wl.x - wr.x, wl.z - wr.z) > 0.05;
    const l = world ? wl! : frame.lm[LM.L_SHOULDER],
      r = world ? wr! : frame.lm[LM.R_SHOULDER];
    if (turns.length && turns[turns.length - 1].t === frame.t) turns.pop();
    turns.push({ t: frame.t, dz: l.z - r.z, dx: l.x - r.x });
    turns = turns.filter((p) => frame.t >= p.t && frame.t - p.t <= 250);
    const dz = turns.reduce((a, p) => a + p.dz, 0) / turns.length,
      dx = turns.reduce((a, p) => a + p.dx, 0) / turns.length;
    return Math.atan2(Math.abs(dz), Math.abs(dx));
  };
  let lastFrameT = -Infinity;
  let lastObservationT = -Infinity;
  let lastArrival = -Infinity;
  let lastGoodCapture = -Infinity;
  /** True camera capture time of the newest pose when known, else its frame time. */
  let lastSeenAt = -Infinity;
  let lastSpan = 0;
  let previousValid = false;
  // The last accepted hip position, and a jump away from it seen once and not
  // yet believed. See the glitch gate in update().
  let lastPlanar: { x: number; y: number; t: number } | null = null;
  let suspect: { x: number; y: number } | null = null;
  const filter = {
    // Head and hips move the first-person camera: depth is filtered on its own.
    root: createMotionFilter(
      1000 / (2 * Math.PI * (smoothingMs || 1)),
      12,
      DEPTH_FILTER,
    ),
    head: createMotionFilter(
      1000 / (2 * Math.PI * (smoothingMs || 1)),
      12,
      DEPTH_FILTER,
    ),
    left: createMotionFilter(1000 / (2 * Math.PI * (smoothingMs || 1))),
    right: createMotionFilter(1000 / (2 * Math.PI * (smoothingMs || 1))),
  };
  const jointFilters = Array.from({ length: JOINT_COUNT }, () =>
    createMotionFilter(1000 / (2 * Math.PI * (smoothingMs || 1))),
  );
  let jointSeen: boolean[] = Array<boolean>(JOINT_COUNT).fill(false);
  let lastJointT = -Infinity;
  let floorY: number | null = null;
  const clearJoints = () => {
    jointSeen = Array<boolean>(JOINT_COUNT).fill(false);
    lastJointT = -Infinity;
    floorY = null;
  };
  let motion: {
    t: number;
    clock: number;
    head: PovVector;
    root: PovVector;
  } | null = null;
  let velocity = { head: vector(), root: vector() };
  const copy = (): TrackingResult => ({
    ...result,
    head: { ...result.head },
    root: { ...result.root },
    headRelativeTorso: { ...result.headRelativeTorso },
    leftHand: { ...result.leftHand },
    rightHand: { ...result.rightHand },
    joints: result.joints?.map((p) => ({ ...p })),
    jointWeights: result.jointWeights ? [...result.jointWeights] : undefined,
    footLift: result.footLift ? [...result.footLift] : undefined,
  });
  function invalidate(reason: string): TrackingResult {
    previousValid = false;
    lastPlanar = suspect = null;
    motion = null;
    velocity = { head: vector(), root: vector() };
    if (!baseline && reason !== "calibrating") samples = [];
    result = {
      ...result,
      valid: false,
      held: false,
      calibrated: baseline !== null,
      calibrationProgress: baseline
        ? 1
        : samples.length
          ? Math.min(
              1,
              samples.length / calibrationSamples,
              calibrationMinMs === 0
                ? 1
                : (samples[samples.length - 1].t - samples[0].t) /
                    calibrationMinMs,
            )
          : 0,
      confidence: 0,
      depthValid: false,
      leftHandTracked: false,
      rightHandTracked: false,
      reason,
    };
    return copy();
  }
  function measure(frame: PoseFrame): Measurement | string {
    if (
      !Number.isFinite(frame.t) ||
      !Number.isFinite(frame.imageAspect) ||
      frame.imageAspect! <= 0 ||
      frame.imageAspect! > 5
    )
      return "invalid-frame";
    const minVisibility =
      continuityMs && baseline && previousValid ? 0.45 : 0.6;
    if (!Array.isArray(frame.lm)) return "occluded-or-invalid-landmark";
    // Setup needs the whole upper body properly in frame. After that, a duck
    // or a jump that takes the hips or the head out of the picture must not
    // stop play: the shoulders carry on, and the missing part is placed from
    // them as it sat at setup.
    const missing = missingBodyParts(
      frame.lm,
      minVisibility,
      baseline ? FRAME_MARGIN : 0,
    );
    // Setup without hips. On a laptop on a desk the hips are often below the
    // picture or behind the desk, and setup, which waited for them, never
    // finished. If the head and shoulders have been in view without hips for a
    // moment, setup goes ahead on the upper body, with the hips placed where
    // the avatar's own proportions put them under the shoulders.
    let upperBodySetup = false;
    if (!baseline) {
      if (missing.length === 1 && missing[0] === "hips") {
        if (hipsMissingSince < 0) hipsMissingSince = frame.t;
        upperBodySetup = frame.t - hipsMissingSince >= UPPER_BODY_SETUP_MS;
      } else hipsMissingSince = -1;
    }
    // After setup, a part is placed from the shoulders if it has left the
    // picture, or if setup itself never saw it. One that is in the picture but
    // hidden (an arm across a hip) is a brief occlusion and keeps the short
    // hold instead.
    if (
      missing.length &&
      !upperBodySetup &&
      (!baseline ||
        missing.includes("shoulders") ||
        missing.some(
          (part) =>
            !outOfView(frame.lm, part) &&
            !baseline!.inferred?.includes(part as "hips" | "head") &&
            !(part === "head" && options.hiddenHeadFromShoulders),
        ))
    )
      return "occluded-or-invalid-landmark";
    const left = frame.lm[LM.L_SHOULDER],
      right = frame.lm[LM.R_SHOULDER];
    // Existing PoseFrame producers publish H/W (videoHeight / videoWidth).
    // Convert to W/H internally so x and z can use image-height units with y.
    const aspect = 1 / frame.imageAspect!;
    const span = Math.hypot((left.x - right.x) * aspect, left.y - right.y);
    if (span < 0.04) return "shoulder-span-too-small";
    // World coordinates have coherent axes. Approximate image-z is a fallback,
    // not an independent veto on the world orientation. Neither gives room position.
    const yaw = steadyYaw(frame);
    // A frontal baseline is required to establish scale. After calibration,
    // shoulder yaw invalidates depth, not the still-observed x/y body movement.
    if (yaw > maxYawRad && !baseline) return "shoulder-yaw";
    const shoulder = midpoint(left, right);
    // Where a part sat relative to the shoulders at setup, at today's size.
    const fromShoulders = (was: Landmark): Landmark => {
      if (!baseline)
        // Upper-body setup: the avatar's hips sit this far under its shoulders.
        return { ...shoulder, y: shoulder.y + span * TORSO_OVER_SHOULDERS };
      const k = span / baseline!.span;
      return {
        x: shoulder.x + (was.x - baseline!.shoulder.x) * k,
        y: shoulder.y + (was.y - baseline!.shoulder.y) * k,
        z: shoulder.z + (was.z - baseline!.shoulder.z) * k,
        v: shoulder.v,
      };
    };
    const inferred = missing as ("hips" | "head")[];
    const hipSeen = inferred.includes("hips")
      ? null
      : midpoint(frame.lm[LM.L_HIP], frame.lm[LM.R_HIP]);
    const torso = hipSeen
      ? Math.hypot((shoulder.x - hipSeen.x) * aspect, shoulder.y - hipSeen.y)
      : 0;
    // Body size is read from the shoulders. Turning them, or raising an arm,
    // makes them look narrower without the body having moved away: the avatar
    // grew and the first-person camera backed off. The torso's length does not
    // foreshorten in a turn, so the larger of the two readings is used; in a
    // crouch or a forward lean the torso shortens and the shoulders hold.
    const size =
      baseline && baseline.torso > 0 && torso > 0
        ? Math.max(span, (torso * baseline.span) / baseline.torso)
        : span;
    return {
      t: frame.t,
      aspect,
      span: size,
      torso,
      confidence: Math.min(
        ...required
          .filter(
            (i) =>
              !(
                (inferred.includes("hips") &&
                  (i === LM.L_HIP || i === LM.R_HIP)) ||
                (inferred.includes("head") && i === LM.NOSE)
              ),
          )
          .map((i) => frame.lm[i].v),
        1,
      ),
      depthValid: yaw <= maxYawRad,
      hip: inferred.includes("hips")
        ? fromShoulders(baseline?.hip ?? shoulder)
        : midpoint(frame.lm[LM.L_HIP], frame.lm[LM.R_HIP]),
      nose: inferred.includes("head")
        ? fromShoulders(baseline?.nose ?? shoulder)
        : { ...frame.lm[LM.NOSE] },
      shoulder,
      ...(inferred.length ? { inferred } : {}),
      // A wrist is picked up at 0.6 and kept down to 0.4, and may sit a little
      // outside the picture: one that hovers at the threshold used to blink
      // the hand, and the ball in it, on every pose.
      left: visible(
        frame.lm[LM.L_WRIST],
        result.leftHandTracked ? 0.4 : 0.6,
        FRAME_MARGIN,
      )
        ? { ...frame.lm[LM.L_WRIST] }
        : null,
      right: visible(
        frame.lm[LM.R_WRIST],
        result.rightHandTracked ? 0.4 : 0.6,
        FRAME_MARGIN,
      )
        ? { ...frame.lm[LM.R_WRIST] }
        : null,
      world: frame.world,
      lm: frame.lm,
      clock:
        typeof frame.motionT === "number" &&
        Number.isFinite(frame.motionT) &&
        Math.abs(frame.motionT - frame.t) <= 60
          ? frame.motionT
          : frame.t,
      capturedAt:
        typeof frame.capturedAt === "number" &&
        Number.isFinite(frame.capturedAt) &&
        frame.capturedAt <= frame.t
          ? frame.capturedAt
          : undefined,
    };
  }
  function scale(m: Measurement) {
    return scaleWidth / m.span;
  }
  function local(p: Landmark, m: Measurement): PovVector {
    const s = scale(m);
    return vector(
      -(p.x - m.hip.x) * m.aspect * s,
      -(p.y - m.hip.y) * s,
      -(p.z - m.hip.z) * m.aspect * s,
    );
  }
  function hand(p: Landmark, index: number, m: Measurement): PovVector {
    const v = local(p, m);
    const world = m.world;
    if (!world) return v;
    const w = world[index],
      a = world[LM.L_HIP],
      b = world[LM.R_HIP],
      l = world[LM.L_SHOULDER],
      r = world[LM.R_SHOULDER];
    if (![w, a, b, l, r].every((q) => finite(q) && q.v >= 0.6)) return v;
    const width = Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z);
    if (width <= 0.05) return v;
    const z = (-(w.z - (a.z + b.z) / 2) * scaleWidth) / width;
    // Optional body-local wrist depth remains model-estimated. Reject an outlier
    // rather than letting it become a large projectile launch offset.
    if (Number.isFinite(z) && Math.abs(z) <= (scaled ? 1.5 : 3.5)) v.z = z;
    return v;
  }
  /** Image x/y is the precise observation; depth is the model's body-local estimate. */
  function jointPoint(p: Landmark, index: number, m: Measurement): PovVector {
    const v = local(p, m);
    const world = m.world;
    const w = world?.[index],
      a = world?.[LM.L_HIP],
      b = world?.[LM.R_HIP],
      l = world?.[LM.L_SHOULDER],
      r = world?.[LM.R_SHOULDER];
    if (finite(w) && [a, b, l, r].every((q) => finite(q) && q.v >= 0.6)) {
      const width = Math.hypot(l!.x - r!.x, l!.y - r!.y, l!.z - r!.z);
      const z = (-(w.z - (a!.z + b!.z) / 2) * scaleWidth) / width;
      if (width > 0.05 && Number.isFinite(z)) v.z = z;
    }
    const limit = scaled ? 1.2 : 3.5;
    v.z = Math.max(-limit, Math.min(limit, v.z));
    return v;
  }
  function render(m: Measurement, now: number): TrackingResult {
    const b = baseline!;
    const s = scale(m),
      bs = scale(b);
    const root = vector(
      -(m.hip.x - 0.5) * m.aspect * s + (b.hip.x - 0.5) * b.aspect * bs,
      -(m.hip.y - 0.5) * s + (b.hip.y - 0.5) * bs,
      m.depthValid ? scaleDistance * (1 - b.span / m.span) : result.root.z,
    );
    const relative = minus(local(m.nose, m), local(b.nose, b));
    const head = plus(root, relative);
    const leftHand = m.left ? hand(m.left, LM.L_WRIST, m) : result.leftHand,
      rightHand = m.right ? hand(m.right, LM.R_WRIST, m) : result.rightHand;
    const handLimit = scaled ? 1.5 : 3.5;
    const handBounds = vector(handLimit, handLimit, handLimit);
    const usableHand = (p: PovVector) =>
      [p.x, p.y, p.z].every(Number.isFinite) &&
      !beyond(p, handBounds) &&
      Math.hypot(p.x, p.y, p.z) <= (scaled ? 1.6 : 4);
    const leftHandTracked = !!m.left && usableHand(leftHand);
    const rightHandTracked = !!m.right && usableHand(rightHand);
    const outOfBounds = beyond(root, bounds) || beyond(head, headBounds);
    // Mark bounds on RAW measurements, before smoothing. Never disguise boundary
    // crossing as a changed motion gain. Consumer pauses/recenters when flagged.
    const boundedRoot = clampVector(root, bounds),
      boundedHead = clampVector(head, headBounds);
    const dt = Math.max(0, Math.min(staleAfterMs, now - lastArrival));
    const alpha =
      !previousValid || smoothingMs === 0 ? 1 : 1 - Math.exp(-dt / smoothingMs);
    if (
      [root, head, relative].some(
        (v) => ![v.x, v.y, v.z].every(Number.isFinite),
      )
    )
      return invalidate("invalid-projection");
    const adaptive = options.automatic && smoothingMs > 0;
    const filteredRoot = adaptive
      ? filter.root.update(boundedRoot, m.clock, !previousValid)
      : mix(result.root, boundedRoot, alpha);
    const filteredHead = adaptive
      ? filter.head.update(boundedHead, m.clock, !previousValid)
      : mix(result.head, boundedHead, alpha);
    const motionDt = motion ? (m.clock - motion.clock) / 1000 : 0;
    const speed = (p: PovVector, old: PovVector) =>
      vector((p.x - old.x) / motionDt, (p.y - old.y) / motionDt, 0);
    velocity =
      previousValid &&
      motion &&
      motionDt >= 0.008 &&
      motionDt <= 0.12 &&
      !outOfBounds
        ? { head: speed(head, motion.head), root: speed(root, motion.root) }
        : { head: vector(), root: vector() };
    motion = { t: m.t, clock: m.clock, head, root };
    // A joint the camera loses keeps its last value while its weight ramps to
    // zero, so the avatar cross-fades to a solved limb instead of popping.
    const stepS = previousValid
      ? Math.min(0.1, Math.max(0, (m.clock - lastJointT) / 1000))
      : 0;
    lastJointT = m.clock;
    const joints = result.joints!.map((p) => ({ ...p }));
    const jointWeights = [...result.jointWeights!];
    for (let j = 0; j < JOINT_COUNT; j++) {
      const index = JOINT_LANDMARK[j],
        p = m.lm[index];
      let seen = false;
      if (
        finite(p) &&
        p.v >= (jointSeen[j] ? 0.4 : 0.6) &&
        p.x >= -0.03 &&
        p.x <= 1.03 &&
        p.y >= -0.03 &&
        p.y <= 1.03 &&
        Math.abs(p.z) <= 3
      ) {
        const raw = jointPoint(p, index, m);
        if (
          [raw.x, raw.y, raw.z].every(Number.isFinite) &&
          Math.hypot(raw.x, raw.y, raw.z) <= (scaled ? 2.2 : 5)
        ) {
          seen = true;
          joints[j] = adaptive
            ? jointFilters[j].update(
                raw,
                m.clock,
                !previousValid || !jointSeen[j],
              )
            : mix(joints[j], raw, previousValid && jointSeen[j] ? alpha : 1);
        }
      }
      jointWeights[j] = !previousValid
        ? seen
          ? 1
          : 0
        : Math.max(
            0,
            Math.min(1, jointWeights[j] + ((seen ? 1 : -1) * stepS) / 0.15),
          );
      jointSeen[j] = seen;
    }
    // Foot height is read at the calibration scale, not the live shoulder scale:
    // a crouch tips the shoulders toward the camera, which would otherwise shrink
    // the legs and float the feet. Only a confident in-frame ankle counts.
    const heights = [0, 1].map((i) => {
      const p = m.lm[JOINT_LANDMARK[JOINT.L_ANKLE + i]];
      return finite(p) && p.v >= 0.7 && p.y >= 0 && p.y <= 1
        ? -(p.y - b.hip.y) * bs
        : NaN;
    });
    const lowest = Math.min(...heights.filter(Number.isFinite));
    // The floor is the lowest an ankle has been. The planted foot keeps
    // re-anchoring it; the upward drift forgets an outlier or a step back.
    if (lowest !== Infinity)
      floorY =
        floorY === null ? lowest : Math.min(floorY + 0.12 * stepS, lowest);
    const settle =
      !previousValid || smoothingMs === 0
        ? 1
        : 1 - Math.exp((-stepS * 1000) / smoothingMs);
    const footLift = heights.map((h, i) => {
      const old = result.footLift?.[i] ?? 0;
      return Number.isFinite(h) && floorY !== null
        ? old + (Math.max(0, h - floorY) - old) * settle
        : old * 0.8;
    }) as [number, number];
    result = {
      valid: true,
      held: false,
      calibrated: true,
      calibrationProgress: 1,
      confidence: m.confidence,
      units,
      root: filteredRoot,
      head: filteredHead,
      headRelativeTorso: minus(filteredHead, filteredRoot),
      leftHand: leftHandTracked
        ? adaptive
          ? filter.left.update(
              leftHand,
              m.clock,
              !previousValid || !result.leftHandTracked,
            )
          : mix(result.leftHand, leftHand, result.leftHandTracked ? alpha : 1)
        : result.leftHand,
      rightHand: rightHandTracked
        ? adaptive
          ? filter.right.update(
              rightHand,
              m.clock,
              !previousValid || !result.rightHandTracked,
            )
          : mix(
              result.rightHand,
              rightHand,
              result.rightHandTracked ? alpha : 1,
            )
        : result.rightHand,
      leftHandTracked,
      rightHandTracked,
      outOfBounds,
      depthValid: m.depthValid,
      reason: outOfBounds
        ? "out-of-bounds"
        : m.depthValid
          ? null
          : (m.depthReason ?? "shoulder-yaw"),
      joints,
      jointWeights,
      floorY,
      footLift,
      inferred: m.inferred,
    };
    lastArrival = now;
    lastGoodCapture = m.t;
    lastSeenAt = Math.min(m.t, m.capturedAt ?? m.t);
    lastSpan = m.span;
    previousValid = true;
    return copy();
  }

  const api = {
    /** Visual-only bounded look-ahead. Never feed this into throws or collisions. */
    present(nowMs: number, maxLead = 0.06): TrackingResult {
      const shown = api.sample(nowMs);
      if (!shown.valid || shown.outOfBounds || !motion || nowMs - motion.t > 80)
        return shown;
      const seconds = Math.min(30, Math.max(0, nowMs - motion.t)) / 1000;
      const lead = (p: PovVector, v: PovVector, limit: PovVector) => {
        const magnitude = Math.hypot(v.x, v.y);
        // Consumers with gameplay gain can tighten the pre-gain lead budget.
        const limitLead = Number.isFinite(maxLead)
          ? Math.max(0, Math.min(0.06, maxLead))
          : 0;
        const k = magnitude ? Math.min(seconds, limitLead / magnitude) : 0;
        return clampVector(vector(p.x + v.x * k, p.y + v.y * k, p.z), limit);
      };
      shown.root = lead(shown.root, velocity.root, bounds);
      shown.head = lead(shown.head, velocity.head, headBounds);
      shown.headRelativeTorso = minus(shown.head, shown.root);
      return shown;
    },
    /**
     * Where the whole body probably is now. Every pose is already old when it is
     * drawn (camera delay plus model time); this leads each point by part of that
     * age along its smoothed velocity. Display only: never feed it to collisions,
     * throws or the network, which must use measured poses from sample().
     *
     * Only sideways and vertical motion is led. Depth is too noisy to extrapolate.
     * A still body is not led at all, so landmark noise cannot make it wobble.
     */
    predict(
      nowMs: number,
      o: {
        fraction?: number;
        maxMs?: number;
        /** Speed below which nothing is predicted. */
        restSpeed?: number;
        /** Lead in full across the time since the pose arrived. */
        sinceArrival?: boolean;
      } = {},
    ): TrackingResult {
      const shown = api.sample(nowMs);
      const adaptive = !!options.automatic && smoothingMs > 0;
      const age = nowMs - lastSeenAt;
      if (
        !adaptive ||
        !shown.valid ||
        shown.held ||
        shown.outOfBounds ||
        !previousValid ||
        !(age > 0) ||
        age >= staleAfterMs
      )
        return shown;
      const lead = (
        f: ReturnType<typeof createMotionFilter>,
        maxDistance: number,
      ) => {
        // Half of the pose's age when it arrived, then every millisecond since.
        const split = o.sinceArrival ?? true;
        const d = leadOf(
          f,
          split ? Math.max(0, lastArrival - lastSeenAt) : age,
          {
            // 0.3 of the age at arrival, plus all the time since. More than
            // that runs further past a stop (motionBench.test.ts).
            fraction: o.fraction ?? 0.3,
            maxMs: o.maxMs ?? 120,
            maxDistance,
            // Sustained speed below which the body counts as still. Chosen on
            // the sweep in tracking.test.ts (SWEEP=1): the lowest value at which
            // the drawn head is no shakier than the measured one.
            restSpeed: o.restSpeed ?? 0.15,
          },
          split ? nowMs - lastArrival : 0,
        );
        return vector(d.x, d.y, 0);
      };
      shown.root = clampVector(
        plus(shown.root, lead(filter.root, 0.12)),
        bounds,
      );
      shown.head = clampVector(
        plus(shown.head, lead(filter.head, 0.12)),
        headBounds,
      );
      shown.headRelativeTorso = minus(shown.head, shown.root);
      if (shown.leftHandTracked)
        shown.leftHand = plus(shown.leftHand, lead(filter.left, 0.3));
      if (shown.rightHandTracked)
        shown.rightHand = plus(shown.rightHand, lead(filter.right, 0.3));
      shown.joints = shown.joints?.map((p, j) =>
        (shown.jointWeights?.[j] ?? 0) > 0
          ? plus(p, lead(jointFilters[j], 0.3))
          : p,
      );
      return shown;
    },
    /** Age in ms of the newest pose at `nowMs`, from capture when the browser reports it. */
    poseAge: (nowMs: number): number =>
      Number.isFinite(lastSeenAt) ? Math.max(0, nowMs - lastSeenAt) : 0,
    calibrate(frame: PoseFrame): TrackingResult {
      if (baseline) {
        baseline = null;
        samples = [];
        lastFrameT = -Infinity;
        lastObservationT = -Infinity;
        lastArrival = -Infinity;
        lastGoodCapture = -Infinity;
        lastSeenAt = -Infinity;
        lastSpan = 0;
        previousValid = false;
        result = empty();
        clearJoints();
      }
      if (Number.isFinite(frame.t)) lastObservationT = frame.t;
      const m = measure(frame);
      if (typeof m === "string") {
        samples = [];
        return invalidate(m);
      }
      if (m.t <= lastFrameT) {
        samples = [];
        return invalidate("non-monotonic-frame");
      }
      lastFrameT = m.t;
      const first = samples[0];
      if (
        first &&
        (m.t - samples[samples.length - 1].t >= staleAfterMs ||
          Math.abs(m.aspect - first.aspect) > 0.001)
      ) {
        samples = [];
        strayFrom = -1;
      }
      if (samples.length) {
        // Compare with the middle of what has been collected, not with the
        // first sample, and drop a lone outlier instead of starting over: one
        // jittery frame used to restart setup from zero, which is why it
        // could take seconds. Strays that persist mean the body really moved.
        // Counted in time, not frames, so a faster camera is not stricter.
        const middle = (pick: (p: Measurement) => number) => {
          const sorted = samples.map(pick).sort((a, b) => a - b);
          return sorted[sorted.length >> 1];
        };
        const moved =
          Math.abs(m.span / middle((p) => p.span) - 1) > 0.05 ||
          Math.hypot(
            (m.hip.x - middle((p) => p.hip.x)) * m.aspect,
            m.hip.y - middle((p) => p.hip.y),
          ) > 0.025 ||
          Math.hypot(
            (m.nose.x - middle((p) => p.nose.x)) * m.aspect,
            m.nose.y - middle((p) => p.nose.y),
          ) > 0.025;
        if (moved) {
          if (strayFrom < 0) strayFrom = m.t;
          if (m.t - strayFrom < STRAY_MS) return invalidate("calibrating");
          samples = [];
        }
        strayFrom = -1;
      }
      samples.push(m);
      if (samples.length > 256) samples.shift();
      if (
        samples.length < calibrationSamples ||
        m.t - samples[0].t < calibrationMinMs
      )
        return invalidate("calibrating");
      // Still, but in a bad place: off to one side (a dodge that way leaves
      // the picture), very small, or filling it. The stage is telling the
      // player where to go; setup waits for them, but not for ever.
      const badly =
        m.shoulder.x < GOOD_FRAMING.left ||
        m.shoulder.x > GOOD_FRAMING.right ||
        m.span < GOOD_FRAMING.small ||
        m.span > GOOD_FRAMING.large;
      if (badly) {
        if (badFramingSince < 0) badFramingSince = m.t;
        if (m.t - badFramingSince < BAD_FRAMING_MAX_MS)
          return invalidate("calibrating");
      }
      badFramingSince = -1;
      const average = (key: "hip" | "nose" | "shoulder"): Landmark => ({
        x: samples.reduce((a, p) => a + p[key].x, 0) / samples.length,
        y: samples.reduce((a, p) => a + p[key].y, 0) / samples.length,
        z: samples.reduce((a, p) => a + p[key].z, 0) / samples.length,
        v: Math.min(...samples.map((p) => p[key].v)),
      });
      baseline = {
        ...m,
        hip: average("hip"),
        nose: average("nose"),
        shoulder: average("shoulder"),
        span: samples.reduce((a, p) => a + p.span, 0) / samples.length,
        torso: samples.reduce((a, p) => a + p.torso, 0) / samples.length,
      };
      samples = [];
      previousValid = false;
      return render(m, m.t);
    },
    update(frame: PoseFrame, nowMs = frame.t): TrackingResult {
      if (
        !Number.isFinite(nowMs) ||
        !Number.isFinite(frame.t) ||
        nowMs < lastArrival ||
        frame.t > nowMs + 50
      )
        return invalidate("invalid-clock");
      if (nowMs - frame.t >= staleAfterMs) return invalidate("stale");
      if (!baseline)
        return options.automatic
          ? api.calibrate(frame)
          : invalidate("uncalibrated");
      if (frame.t <= lastFrameT) return invalidate("non-monotonic-frame");
      lastFrameT = frame.t;
      lastObservationT = frame.t;
      const m = measure(frame);
      if (typeof m === "string") {
        // Coast on the last good pose, measured from when it arrived. Bad frames
        // never extend the budget, and nothing is invented: no dodge, no release.
        // A longer loss still pauses the game with an explicit message.
        if (
          m === "occluded-or-invalid-landmark" &&
          result.valid &&
          continuityMs > 0 &&
          nowMs - lastArrival <= continuityMs
        ) {
          motion = null;
          velocity = { head: vector(), root: vector() };
          result = {
            ...result,
            held: true,
            depthValid: false,
            leftHandTracked: false,
            rightHandTracked: false,
            reason: "brief-occlusion",
          };
          return copy();
        }
        return invalidate(m);
      }
      if (Math.abs(m.aspect - baseline.aspect) > 0.001) {
        if (options.automatic) {
          api.reset();
          return api.calibrate(frame);
        }
        return invalidate("aspect-changed-recalibrate");
      }
      // As seen, before the scale is steadied below: the same-person check
      // needs the size this body really has in the picture.
      const seenSpan = m.span,
        seenSquare = m.depthValid;
      // Retain the last trustworthy projection scale while turned. Otherwise
      // shoulder foreshortening creates fake fore/aft translation and gain changes.
      if (!m.depthValid) m.span = lastSpan || baseline.span;
      if (lastSpan > 0 && Math.abs(m.span / lastSpan - 1) > maxSpanJumpRatio) {
        if (!continuityMs) return invalidate("shoulder-span-jump");
        m.span = lastSpan;
        m.depthValid = false;
        m.depthReason = "scale-uncertain";
      }
      if (nowMs - lastArrival >= staleAfterMs) previousValid = false;
      // The same person. Judged only on a body seen square-on with its hips in
      // view, against a setup that also had them; otherwise it is let through.
      if (continuityMs && !previousValid && result.calibrated && lastSpan > 0) {
        const size = seenSpan / lastSpan;
        const judged =
          seenSquare &&
          !m.inferred?.length &&
          !baseline.inferred?.length &&
          baseline.span > 0 &&
          seenSpan > 0;
        const build = judged
          ? m.torso / seenSpan / (baseline.torso / baseline.span)
          : 1;
        const stranger =
          seenSquare &&
          (size < SAME_PERSON.size[0] ||
            size > SAME_PERSON.size[1] ||
            build < SAME_PERSON.build[0] ||
            build > SAME_PERSON.build[1]);
        if (stranger) {
          if (strangerSince < 0) strangerSince = m.t;
          if (m.t - strangerSince >= STRANGER_MS && options.automatic) {
            api.reset();
            return api.calibrate(frame);
          }
          return invalidate("different-person");
        }
      }
      strangerSince = -1;
      // Glitch gate. A body cannot cross a fifth of a metre between two poses;
      // a detector can, for one frame (a mis-detection, someone walking behind).
      // Such a jump is not drawn or played until a second pose agrees with it.
      const planar = {
        x: -(m.hip.x - 0.5) * m.aspect * scale(m),
        y: -(m.hip.y - 0.5) * scale(m),
        t: m.t,
      };
      if (continuityMs && previousValid && lastPlanar && m.t > lastPlanar.t) {
        const jump = Math.hypot(
          planar.x - lastPlanar.x,
          planar.y - lastPlanar.y,
        );
        const confirmed =
          suspect !== null &&
          Math.hypot(planar.x - suspect.x, planar.y - suspect.y) < GLITCH_AGREE;
        if (
          jump > GLITCH_JUMP &&
          jump / ((m.t - lastPlanar.t) / 1000) > MAX_BODY_SPEED &&
          !confirmed &&
          nowMs - lastArrival <= continuityMs
        ) {
          suspect = planar;
          result = { ...result, held: true, reason: "implausible-jump" };
          return copy();
        }
      }
      suspect = null;
      lastPlanar = planar;
      recent.push(m);
      if (recent.length > 12) recent.shift();
      return render(m, nowMs);
    },
    /**
     * Take where the body is now as the new centre, at once and without going
     * through setup again. For a player who was set up on the way to their
     * spot: sending them back through setup could leave them there for good,
     * if the spot is one where setup's stricter view of the body cannot be had.
     * Returns false when there is nothing recent to centre on.
     */
    recenter(): boolean {
      if (!baseline || !recent.length) return false;
      const mean = (pick: (p: Measurement) => number) =>
        recent.reduce((a, p) => a + pick(p), 0) / recent.length;
      const average = (key: "hip" | "nose" | "shoulder"): Landmark => ({
        x: mean((p) => p[key].x),
        y: mean((p) => p[key].y),
        z: mean((p) => p[key].z),
        v: Math.min(...recent.map((p) => p[key].v)),
      });
      const latest = recent[recent.length - 1];
      baseline = {
        ...latest,
        hip: average("hip"),
        nose: average("nose"),
        shoulder: average("shoulder"),
        span: mean((p) => p.span),
        // Read the torso only from frames that saw the hips.
        torso: recent.some((p) => p.torso > 0)
          ? recent.reduce((a, p) => a + p.torso, 0) /
            recent.filter((p) => p.torso > 0).length
          : 0,
        // Parts setup never saw stay inferred.
        inferred: baseline.inferred,
      };
      lastSpan = baseline.span;
      previousValid = false;
      lastPlanar = suspect = null;
      motion = null;
      velocity = { head: vector(), root: vector() };
      result = {
        ...result,
        root: vector(),
        head: vector(),
        headRelativeTorso: vector(),
        outOfBounds: false,
      };
      return true;
    },
    sample(nowMs: number): TrackingResult {
      if (!Number.isFinite(nowMs) || nowMs < lastArrival)
        return invalidate("invalid-clock");
      if (result.held && nowMs - lastArrival > continuityMs)
        return invalidate("stale");
      // Calibration has fresh observations before a baseline/lastArrival exists.
      // A render poll must not erase its progress or its precise rejection reason.
      if (
        (!baseline || !result.valid) &&
        Number.isFinite(lastObservationT) &&
        nowMs >= lastObservationT &&
        nowMs - lastObservationT < staleAfterMs
      )
        return copy();
      if (nowMs - lastArrival >= staleAfterMs)
        return invalidate(baseline ? "stale" : "uncalibrated");
      return copy();
    },
    reset() {
      motion = null;
      velocity = { head: vector(), root: vector() };
      baseline = null;
      samples = [];
      lastFrameT = -Infinity;
      lastObservationT = -Infinity;
      lastArrival = -Infinity;
      lastGoodCapture = -Infinity;
      lastSeenAt = -Infinity;
      lastSpan = 0;
      previousValid = false;
      lastPlanar = suspect = null;
      recent = [];
      turns = [];
      strayFrom = hipsMissingSince = badFramingSince = strangerSince = -1;
      result = empty();
      clearJoints();
    },
  };
  return api;
}
