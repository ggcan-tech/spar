import {
  COURT_DISTANCE,
  solveFlight,
  validPose,
  type PlayerPose,
  type ThrowInput,
} from "./duel";
import type { TimestampedPlayerPose } from "./release";
import type { Vec3 } from "./physics";

type Sample = { t: number; point: Vec3 };
export type ThrowCue = "bring-back" | "throw-forward" | "released";
/** Why the last update did not throw. Shown in the playtest notes. */
export type ThrowState =
  "no-pose" | "hand-not-seen" | "raise-hand" | "ready" | "driving" | "released";
export interface ThrowUpdate {
  shot: ThrowInput | null;
  cue: ThrowCue;
  state: ThrowState;
  /** Hand speed over the last window, game units per second. */
  speed: number;
  /**
   * Set on the one update at which a throwing motion ended without throwing:
   * the hand moved the way a throw goes but too gently, or from below the
   * waist. Without it a failed throw is silence and the player has no idea why.
   */
  hint?: ThrowHint;
}
export type ThrowHint = "too-soft" | "hand-low";
export interface ThrowOptions {
  /** False when the camera does not see the right wrist in this pose. */
  handTracked?: boolean;
  /** Where to send the ball, in the thrower's own frame. Default: straight ahead. */
  target?: Vec3;
  /**
   * The wrist relative to the hips as the camera measured it. The gameplay
   * hand also carries the dodge gain's share of a lean, which must not read as
   * a throw; without this the gameplay hand is used.
   */
  hand?: Vec3;
}

/** Wrist this far above the hips counts as raised (roughly waist height). */
export const THROW_RAISED = 0.15;
const RAISED_MS = 70;
/** A throw seen only in its follow-through may dip below the waist before it registers. */
const READY_GRACE_MS = 250;
/** The drive is judged over this much recent motion; hand speed over the shorter one. */
const TRAVEL_WINDOW_MS = 180;
const SPEED_WINDOW_MS = 110;
const MIN_WINDOW_MS = 50;
const MAX_GAP_MS = 200;
const MAX_AGE_MS = 250;
/**
 * Throw-ward travel inside the window that starts a throw, and the least hand
 * speed. Reported depth jitters by several centimetres from pose to pose, so a
 * held hand shows phantom motion; requiring a travelled distance as well as a
 * speed keeps clear of that. Chosen by the sweep in throwPipeline.test.ts
 * (SWEEP=1) on scripted throws with landmark noise, not on recorded players.
 */
export const THROW_TUNING = { driveTravel: 0.2, driveSpeed: 2 };
export type ThrowTuning = typeof THROW_TUNING;
/**
 * A motion at least this fast and this far throw-ward, but short of a throw,
 * counts as an attempt. Set close under the throw's own thresholds: moving the
 * hand about to aim must not be told to throw harder.
 */
const ATTEMPT_SPEED = 1.6;
const ATTEMPT_TRAVEL = 0.14;
/** The attempt is over when the hand slows to this. */
const ATTEMPT_SETTLED = 0.7;
const HINT_EVERY_MS = 1500;
/** Release once the hand has slowed to this share of its peak, or after this long. */
const RELEASE_AT = 0.85;
const MAX_DRIVE_MS = 140;
const MAX_SPEED = 8;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const length = (p: Vec3) => Math.hypot(p.x, p.y, p.z);
/**
 * How far a right hand travelled the way a throw goes: toward the opponent,
 * downward and across the body. Raising the hand, drawing it back and moving it
 * outward score negative. Depth is the camera model's guess and is often
 * under-reported, so the downward and inward parts, which the camera sees
 * directly, must be able to carry a throw on their own.
 */
const forward = (d: Vec3) => d.z - 0.6 * d.y - 0.4 * d.x;

/** The opponent's torso, in the thrower's frame. */
export function opponentTarget(opponent: PlayerPose): Vec3 {
  return {
    x: -opponent.root.x,
    y: opponent.root.y + 0.2,
    z: COURT_DISTANCE - opponent.root.z,
  };
}

/**
 * Assisted throw: the ball goes to `target` and hand speed only sets how fast it
 * gets there. One camera cannot measure the direction of a throw well enough
 * to aim with it at eight metres, so direction is not taken from the hand.
 */
export function assistedThrow(
  origin: Vec3,
  target: Vec3,
  speed: number,
): ThrowInput {
  const flight = clamp(0.95 - (speed - 1.5) * 0.09, 0.58, 0.95);
  return solveFlight({ ...origin }, { ...target }, flight);
}

/**
 * Camera-only throw. Raise the right hand above the waist, then drive it: the
 * ball leaves as the hand slows at the end of the drive. No button or pinch.
 *
 * The drive is read from how far the wrist travels over the last few poses, not
 * from where it is, so it does not depend on the model reporting true depth, on
 * the shoulders staying square to the camera, or on a particular pose rate. A
 * missing wrist for a few poses is skipped rather than treated as a restart.
 */
export function createAutoThrowTracker(tuning: Partial<ThrowTuning> = {}) {
  const { driveTravel, driveSpeed } = { ...THROW_TUNING, ...tuning };
  let history: Sample[] = [];
  let raisedSince = -1;
  let readyUntil = -Infinity;
  let drive: { since: number; peak: number } | null = null;
  let fired = false;
  let lastT = -Infinity;
  let lastNow = -Infinity;
  let speed = 0;
  let attempt: { low: boolean } | null = null;
  let hint: ThrowHint | undefined;
  let lastHintAt = -Infinity;
  function reset() {
    history = [];
    raisedSince = -1;
    readyUntil = -Infinity;
    drive = null;
    fired = false;
    lastT = lastNow = -Infinity;
    speed = 0;
    attempt = null;
    hint = undefined;
  }
  const result = (
    state: ThrowState,
    shot: ThrowInput | null = null,
  ): ThrowUpdate => ({
    shot,
    state,
    speed,
    ...(hint ? { hint } : {}),
    cue: fired
      ? "released"
      : state === "ready" || state === "driving"
        ? "throw-forward"
        : "bring-back",
  });
  const idle = (t: number): ThrowState =>
    fired
      ? "released"
      : drive
        ? "driving"
        : t <= readyUntil
          ? "ready"
          : "raise-hand";
  return {
    reset,
    update(
      pose: TimestampedPlayerPose,
      now: number,
      options: ThrowOptions = {},
    ): ThrowUpdate {
      const t = pose.t;
      // A hint is said once, on the update that found it.
      hint = undefined;
      if (
        !validPose(pose) ||
        typeof t !== "number" ||
        !Number.isFinite(t) ||
        !Number.isFinite(now) ||
        now < lastNow ||
        t < lastT ||
        t > now + 30 ||
        now - t >= MAX_AGE_MS
      ) {
        reset();
        return result("no-pose");
      }
      lastNow = now;
      if (t === lastT || fired) return result(idle(t));
      lastT = t;
      const previous = history.at(-1);
      if (previous && t - previous.t > MAX_GAP_MS) {
        history = [];
        raisedSince = -1;
        readyUntil = -Infinity;
        drive = null;
        speed = 0;
      }
      if (options.handTracked === false)
        return result(drive ? "driving" : "hand-not-seen");
      // Relative to the hips, so a sidestep, duck or approach is not a throw.
      const point = options.hand
        ? { ...options.hand }
        : sub(pose.rightHand, pose.root);
      history.push({ t, point });
      history = history.filter((p) => t - p.t <= MAX_GAP_MS);
      if (point.y >= THROW_RAISED) {
        if (raisedSince < 0) raisedSince = t;
        if (t - raisedSince >= RAISED_MS) readyUntil = t + READY_GRACE_MS;
      } else raisedSince = -1;
      // At least three poses, reaching back as far as the window when the rate allows.
      const recent = (ms: number) => {
        const within = history.filter((p) => t - p.t <= ms);
        return within.length >= 3 ? within : history.slice(-3);
      };
      const fast = recent(SPEED_WINDOW_MS),
        long = recent(TRAVEL_WINDOW_MS);
      const last = history.at(-1)!,
        before = history.at(-2);
      if (
        long.length < 3 ||
        !before ||
        last.t - fast[0].t < MIN_WINDOW_MS ||
        last.t - long[0].t > MAX_GAP_MS
      ) {
        speed = 0;
        return result(idle(t));
      }
      speed = Math.min(
        MAX_SPEED,
        length(sub(last.point, fast[0].point)) / ((last.t - fast[0].t) / 1000),
      );
      if (!drive) {
        const started =
          t <= readyUntil &&
          forward(sub(last.point, long[0].point)) >= driveTravel &&
          speed >= driveSpeed &&
          // Still moving the way a throw does, so a hand that has already
          // stopped, or one bad depth reading, does not start a throw.
          forward(sub(last.point, before.point)) > 0;
        if (!started) {
          // A throwing motion that is not a throw: remember it while it lasts,
          // and when the hand settles say what was missing.
          const throwward = forward(sub(last.point, long[0].point));
          if (speed >= ATTEMPT_SPEED && throwward >= ATTEMPT_TRAVEL)
            attempt = { low: t > readyUntil };
          else if (attempt && speed < ATTEMPT_SETTLED) {
            if (t - lastHintAt >= HINT_EVERY_MS) {
              hint = attempt.low ? "hand-low" : "too-soft";
              lastHintAt = t;
            }
            attempt = null;
          }
          return result(idle(t));
        }
        attempt = null;
        drive = { since: t, peak: speed };
        return result("driving");
      }
      drive.peak = Math.max(drive.peak, speed);
      // Once a drive has started the ball will leave; this only picks the moment.
      if (speed > drive.peak * RELEASE_AT && t - drive.since < MAX_DRIVE_MS)
        return result("driving");
      fired = true;
      speed = drive.peak;
      const target = options.target ?? {
        x: pose.rightHand.x,
        y: 1.2,
        z: COURT_DISTANCE,
      };
      return result(
        "released",
        assistedThrow(pose.rightHand, target, drive.peak),
      );
    },
  };
}
