import {
  THROW_RAISED,
  assistedThrow,
  createAutoThrowTracker,
  opponentTarget,
  type ThrowTuning,
  type ThrowUpdate,
} from "./autoThrow";
import { JOINT } from "./body";
import { COURT_DISTANCE, type PlayerPose } from "./duel";
import type { TimestampedPlayerPose } from "./release";
import type { Vec3 } from "./physics";
import type { TrackingResult } from "./tracking";

/**
 * Aim marker. Where the right hand is held, relative to the right shoulder,
 * places a point on the opponent's side; the ball is thrown at that point.
 *
 * Only sideways and up/down hand position is used. Those are what one camera
 * sees directly, so the marker is steady and repeatable, and because the player
 * watches it move, they correct it themselves. Nothing here measures the
 * direction of the throw.
 *
 * Tuning constants below are design choices in game units, not measurements.
 */
export const AIM = {
  /** Hand position, relative to the shoulder, that aims at the centre of the court at torso height. */
  neutral: { x: 0.15, y: 0.1 },
  /** Marker travel per unit of hand travel. */
  gain: 3,
  /** Height the neutral hand aims at: the torso of a standing opponent. */
  height: 1.2,
  halfWidth: 0.9,
  floor: 0.3,
  ceiling: 2.2,
  /** Marker smoothing on top of the tracker's own filter. */
  smoothingMs: 50,
  /** A hand moving slower than this is being held, not thrown. */
  settledSpeed: 1,
  /**
   * A drive is recognised some way into it, so the aim is taken from at least
   * this long before, looking back no further than `lookbackMs`.
   */
  settleBackMs: 150,
  lookbackMs: 400,
} as const;
/** Where the right shoulder sits above the hips when the camera has not placed it. */
const CANONICAL_SHOULDER: Vec3 = { x: 0.2, y: 0.47, z: 0 };
const SPEED_WINDOW_MS = 110;
const MAX_GAP_MS = 200;

export interface AimMarker {
  /** Target in the thrower's own frame. */
  point: Vec3;
  /** True once a throw has started and the target can no longer move. */
  locked: boolean;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** The point a held hand aims at. `hand` and `shoulder` share any one frame. */
export function aimFromHand(hand: Vec3, shoulder: Vec3, planeZ: number): Vec3 {
  return {
    x: clamp(
      (hand.x - shoulder.x - AIM.neutral.x) * AIM.gain,
      -AIM.halfWidth,
      AIM.halfWidth,
    ),
    y: clamp(
      AIM.height + (hand.y - shoulder.y - AIM.neutral.y) * AIM.gain,
      AIM.floor,
      AIM.ceiling,
    ),
    z: planeZ,
  };
}

/**
 * Follows the held hand, and fixes the target when a throw starts. A throw
 * moves the hand, so the target is the marker from just before the drive: the
 * most recent moment the hand was held still, or failing that the stillest
 * moment of the wind-up.
 */
export function createAimTracker() {
  let hands: { t: number; point: Vec3 }[] = [];
  let samples: { t: number; aim: Vec3; speed: number }[] = [];
  let shown: Vec3 | null = null;
  let frozen: Vec3 | null = null;
  let visible = false;
  let lastT = -Infinity;
  function reset() {
    hands = [];
    samples = [];
    shown = frozen = null;
    visible = false;
    lastT = -Infinity;
  }
  function settled(t: number): Vec3 | null {
    for (let i = samples.length - 1; i >= 0; i--)
      if (
        samples[i].t <= t - AIM.settleBackMs &&
        samples[i].speed <= AIM.settledSpeed
      )
        return samples[i].aim;
    let stillest = samples[0];
    for (const s of samples) if (s.speed < stillest.speed) stillest = s;
    return stillest?.aim ?? shown;
  }
  const marker = (): AimMarker | null =>
    frozen
      ? { point: { ...frozen }, locked: true }
      : visible && shown
        ? { point: { ...shown }, locked: false }
        : null;
  return {
    reset,
    update(
      hand: Vec3,
      shoulder: Vec3,
      t: number,
      state: { raised: boolean; driving: boolean; planeZ: number },
    ): AimMarker | null {
      if (!Number.isFinite(t) || t < lastT || t - lastT > MAX_GAP_MS) reset();
      // A drive is reported between poses, so fix the target before anything else.
      if (!state.driving) frozen = null;
      else if (!frozen) frozen = settled(t);
      if (t === lastT) return marker();
      const dt = t - lastT;
      lastT = t;
      hands.push({ t, point: { ...hand } });
      hands = hands.filter((h) => t - h.t <= SPEED_WINDOW_MS);
      samples = samples.filter((s) => t - s.t <= AIM.lookbackMs);
      const first = hands[0];
      const speed =
        hands.length >= 2 && t - first.t >= 30
          ? Math.hypot(
              hand.x - first.point.x,
              hand.y - first.point.y,
              hand.z - first.point.z,
            ) /
            ((t - first.t) / 1000)
          : Infinity;
      visible = state.raised;
      if (!state.raised) {
        // Keep recent samples: a throw can register after the hand has dropped.
        if (!samples.length) shown = null;
        return marker();
      }
      const raw = aimFromHand(hand, shoulder, state.planeZ);
      const k =
        shown && Number.isFinite(dt) ? 1 - Math.exp(-dt / AIM.smoothingMs) : 1;
      shown = shown
        ? {
            x: shown.x + (raw.x - shown.x) * k,
            y: shown.y + (raw.y - shown.y) * k,
            z: raw.z,
          }
        : raw;
      samples.push({ t, aim: { ...shown }, speed });
      return marker();
    },
  };
}

export interface ThrowControlUpdate extends ThrowUpdate {
  /** The aim marker to draw, or null when there is nothing to aim. */
  marker: AimMarker | null;
}

/**
 * Everything between a tracked pose and a thrown ball: the aim marker, the
 * throw detector and the hand-off of the fixed target to the throw. The screen
 * and the pipeline tests both go through this.
 */
/** A throw finished this long before the ball may be released still counts. */
const EARLY_THROW_MS = 250;

export function createThrowControl(tuning: Partial<ThrowTuning> = {}) {
  const detector = createAutoThrowTracker(tuning),
    aim = createAimTracker();
  let driving = false;
  // A throw made before the ball may be released, kept for the first legal frame.
  let early: { target: Vec3; speed: number; at: number } | null = null;
  return {
    reset() {
      detector.reset();
      aim.reset();
      driving = false;
      early = null;
    },
    /**
     * `sample` is the tracker's measured result and `pose` the gameplay pose made
     * from it, stamped with the camera frame's time. `canFire` is false while the
     * player holds the ball but may not release yet. The marker shows and the
     * throw is still read during that time: a throw that finishes just before
     * the ball is free leaves the hand on the first frame it may, instead of
     * being lost.
     */
    update(
      sample: TrackingResult,
      pose: TimestampedPlayerPose,
      now: number,
      opponent: PlayerPose,
      canFire = true,
    ): ThrowControlUpdate {
      const handTracked = sample.rightHandTracked !== false;
      const hand = sample.rightHand;
      const seen =
        (sample.jointWeights?.[JOINT.R_SHOULDER] ?? 0) >= 0.5
          ? sample.joints?.[JOINT.R_SHOULDER]
          : undefined;
      const marker =
        typeof pose.t === "number"
          ? aim.update(hand, seen ?? CANONICAL_SHOULDER, pose.t, {
              raised: handTracked && hand.y >= THROW_RAISED,
              driving,
              planeZ: COURT_DISTANCE - opponent.root.z,
            })
          : null;
      if (early && now - early.at > EARLY_THROW_MS) {
        // Too early to count. Start over so the player can throw again.
        early = null;
        detector.reset();
      }
      if (early) {
        const waiting: AimMarker = { point: { ...early.target }, locked: true };
        if (!canFire)
          return {
            shot: null,
            cue: "released",
            state: "released",
            speed: early.speed,
            marker: waiting,
          };
        // Launch from where the hand is now: the game only accepts a ball that
        // starts at the hand.
        const shot = assistedThrow(pose.rightHand, early.target, early.speed);
        const speed = early.speed;
        early = null;
        return {
          shot,
          cue: "released",
          state: "released",
          speed,
          marker: null,
        };
      }
      // No marker means the hand was never held up: send it at the opponent.
      const target = marker?.point ?? opponentTarget(opponent);
      const result = detector.update(pose, now, { handTracked, target, hand });
      driving = result.state === "driving";
      if (result.shot && !canFire) {
        early = { target, speed: result.speed, at: now };
        return {
          ...result,
          shot: null,
          marker: { point: { ...target }, locked: true },
        };
      }
      return { ...result, marker: result.shot ? null : marker };
    },
  };
}
