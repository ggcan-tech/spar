import type { HandFrame } from "./hands";
import { validPose, type PlayerPose, type ThrowInput } from "./duel";
import type { Vec3 } from "./physics";

export interface ReleaseOptions {
  /** Detector LABEL associated with anatomical right. Validate on unmirrored input. */
  side?: "Left" | "Right";
  maxAgeMs?: number;
}
export interface ReleaseResult {
  holding: boolean;
  shot: ThrowInput | null;
  reason: string | null;
  /** Palm-plane angular estimate only, not measured spin of a physical ball. */
  spinEstimated: boolean;
}
/** Pose capture timestamp is required; render-time samples cannot measure hand velocity. */
export type TimestampedPlayerPose = PlayerPose & { t?: number };
interface Sample {
  t: number;
  point: Vec3;
}
interface PalmSample {
  t: number;
  normal: Vec3;
}
const finite = (p: Vec3 | undefined): p is Vec3 =>
  !!p && [p.x, p.y, p.z].every(Number.isFinite);
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const length = (p: Vec3) => Math.hypot(p.x, p.y, p.z);
const mul = (p: Vec3, k: number): Vec3 => ({
  x: p.x * k,
  y: p.y * k,
  z: p.z * k,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });

function handShape(
  hand: HandFrame["hands"][number],
): { ratio: number; normal: Vec3 } | null {
  if (
    !hand ||
    !Array.isArray(hand.landmarks) ||
    !Array.isArray(hand.world) ||
    !Number.isFinite(hand.confidence) ||
    hand.confidence < 0.7 ||
    hand.confidence > 1 ||
    hand.landmarks.length !== 21 ||
    hand.world.length !== 21 ||
    !hand.landmarks.every(
      (p) =>
        finite(p) &&
        p.x >= 0 &&
        p.x <= 1 &&
        p.y >= 0 &&
        p.y <= 1 &&
        Math.abs(p.z) <= 2,
    ) ||
    !hand.world.every((p) => finite(p) && length(p) <= 2)
  )
    return null;
  const w = hand.world;
  const width = length(sub(w[5], w[17]));
  if (width < 0.025 || width > 0.2) return null;
  const ratio = length(sub(w[4], w[8])) / width;
  // Camera coordinates are x image-right, y down, z away. Our local polar axes
  // negate all three; cross the transformed edges so angular/axial signs follow
  // the reflection correctly. Do not apply a preview mirror a second time.
  const edgeA = mul(sub(w[5], w[0]), -1),
    edgeB = mul(sub(w[17], w[0]), -1);
  const normal = cross(edgeA, edgeB),
    n = length(normal);
  if (n < 0.0001 || !Number.isFinite(ratio) || ratio > 4) return null;
  return { ratio, normal: mul(normal, 1 / n) };
}
function regressionVelocity(samples: Sample[]): Vec3 | null {
  if (samples.length < 3) return null;
  const last = samples[samples.length - 1],
    selected = samples.filter((p) => last.t - p.t <= 140);
  if (selected.length < 3 || last.t - selected[0].t < 80) return null;
  const meanTime =
    selected.reduce((sum, p) => sum + (p.t - last.t) / 1000, 0) /
    selected.length;
  const denominator = selected.reduce(
    (sum, p) => sum + ((p.t - last.t) / 1000 - meanTime) ** 2,
    0,
  );
  if (denominator <= 1e-9) return null;
  const v = zero();
  for (const p of selected) {
    const weight = ((p.t - last.t) / 1000 - meanTime) / denominator;
    v.x += weight * p.point.x;
    v.y += weight * p.point.y;
    v.z += weight * p.point.z;
  }
  return v;
}
function estimatedSpin(samples: PalmSample[]): Vec3 {
  const last = samples[samples.length - 1];
  const first = samples.find((p) => last.t - p.t >= 50 && last.t - p.t <= 140);
  if (!first) return zero();
  const axis = cross(first.normal, last.normal),
    sine = length(axis);
  const cosine = Math.max(-1, Math.min(1, dot(first.normal, last.normal)));
  if (sine < 1e-6 || cosine < -0.5) return zero(); // Ambiguous normal flip is not spin.
  const rate = Math.atan2(sine, cosine) / ((last.t - first.t) / 1000);
  return mul(axis, Math.min(100, rate) / sine);
}

/**
 * Pinch grip → open release, with no velocity/power added by the game.
 * Handedness score is classification confidence, NOT per-joint confidence.
 * Both detector handedness and body/hand timestamp alignment require real-device
 * validation. Changing side changes the detector label only: the ball still
 * launches from anatomical pose.rightHand, matching the server contract.
 */
export function createReleaseTracker(options: ReleaseOptions = {}) {
  const side = options.side ?? "Right";
  const maxAgeMs = options.maxAgeMs ?? 200;
  if (
    (side !== "Right" && side !== "Left") ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    maxAgeMs > 200
  )
    throw new RangeError("Invalid release configuration");
  let holding = false,
    closeSince = -1,
    openSince = -1,
    closeFrames = 0,
    openFrames = 0;
  let lastHandT = -Infinity,
    lastPoseT = -Infinity,
    lastNow = -Infinity;
  let poses: Sample[] = [],
    palms: PalmSample[] = [];
  const output = (
    reason: string | null = null,
    shot: ThrowInput | null = null,
  ): ReleaseResult => ({ holding, shot, reason, spinEstimated: shot !== null });
  function disarm(reason: string): ReleaseResult {
    holding = false;
    closeSince = openSince = -1;
    closeFrames = openFrames = 0;
    poses = [];
    palms = [];
    return output(reason);
  }
  return {
    update(
      frame: HandFrame | null,
      pose: TimestampedPlayerPose,
      nowMs: number,
    ): ReleaseResult {
      if (!Number.isFinite(nowMs) || nowMs < lastNow)
        return disarm("invalid-clock");
      lastNow = nowMs;
      if (
        !frame ||
        !Number.isFinite(frame.t) ||
        frame.t > nowMs + 30 ||
        nowMs - frame.t >= maxAgeMs
      )
        return disarm("hand-tracking-lost");
      if (!validPose(pose)) return disarm("invalid-pose");
      if (!Number.isFinite(pose.t)) return disarm("pose-timestamp-required");
      const poseT = pose.t!;
      if (
        poseT > nowMs + 30 ||
        nowMs - poseT >= maxAgeMs ||
        Math.abs(poseT - frame.t) > 100
      )
        return disarm("pose-stale-or-unsynchronized");
      if (frame.t < lastHandT || poseT < lastPoseT)
        return disarm("non-monotonic-frame");
      if (
        (Number.isFinite(lastHandT) && frame.t - lastHandT >= maxAgeMs) ||
        (Number.isFinite(lastPoseT) && poseT - lastPoseT > 100)
      ) {
        lastHandT = frame.t;
        lastPoseT = poseT;
        return disarm("tracking-gap");
      }
      if (poseT > lastPoseT) {
        lastPoseT = poseT;
        poses.push({ t: poseT, point: { ...pose.rightHand } });
        poses = poses.filter((p) => poseT - p.t <= 140).slice(-32);
      } else if (
        poses.length &&
        length(sub(poses[poses.length - 1].point, pose.rightHand)) > 1e-6
      ) {
        return disarm("pose-timestamp-reused");
      }
      if (frame.t === lastHandT) return output(); // Repeated render frame cannot debounce a gesture.
      lastHandT = frame.t;
      if (!Array.isArray(frame.hands)) return disarm("invalid-hand-frame");
      const matches = frame.hands.filter((h) => h && h.side === side);
      if (matches.length !== 1) return disarm("throwing-hand-not-found");
      const shape = handShape(matches[0]);
      if (!shape) return disarm("invalid-hand-shape");
      palms.push({ t: frame.t, normal: shape.normal });
      palms = palms.filter((p) => frame.t - p.t <= 140).slice(-32);
      if (!holding) {
        openSince = -1;
        openFrames = 0;
        if (shape.ratio < 0.35) {
          if (closeSince < 0) closeSince = frame.t;
          closeFrames++;
          if (closeFrames >= 2 && frame.t - closeSince >= 50) {
            holding = true;
            closeSince = -1;
            closeFrames = 0;
          }
        } else {
          closeSince = -1;
          closeFrames = 0;
        }
        return output(holding ? null : "pinch-to-hold");
      }
      if (shape.ratio <= 0.65) {
        openSince = -1;
        openFrames = 0;
        return output();
      }
      if (openSince < 0) openSince = frame.t;
      openFrames++;
      if (openFrames < 2 || frame.t - openSince < 50) return output();
      holding = false;
      openSince = closeSince = -1;
      openFrames = closeFrames = 0;
      const velocity = regressionVelocity(poses);
      if (!velocity) return output("insufficient-motion-history");
      const latest = poses[poses.length - 1],
        previous = poses[poses.length - 2];
      const recent = mul(
        sub(latest.point, previous.point),
        1000 / (latest.t - previous.t),
      );
      const speed = length(velocity),
        recentSpeed = length(recent);
      if (
        !finite(velocity) ||
        !finite(recent) ||
        velocity.z <= 0 ||
        recent.z <= 0 ||
        speed < 2 ||
        speed > 18 ||
        recentSpeed > 18
      )
        return output("forward-throw-required");
      const spin = estimatedSpin(palms);
      // Exact current anatomical right-hand origin, with no aim assistance,
      // forward-speed floor, orbit charge, or conversion of pinching to power.
      return output(null, { origin: { ...pose.rightHand }, velocity, spin });
    },
    reset() {
      holding = false;
      closeSince = openSince = -1;
      closeFrames = openFrames = 0;
      lastHandT = lastPoseT = lastNow = -Infinity;
      poses = [];
      palms = [];
    },
  };
}
