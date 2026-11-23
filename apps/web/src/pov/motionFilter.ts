import type { PovVector } from "./tracking";

const blend = (a: PovVector, b: PovVector, k: number): PovVector => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
  z: a.z + (b.z - a.z) * k,
});
const alpha = (dt: number, cutoff: number) =>
  dt / (dt + 1 / (2 * Math.PI * cutoff));
/** Cutoff of the velocity average that decides whether a body is really moving. */
const STEADY_HZ = 1.5;

/** Speed-adaptive 1€ low-pass filter. Capture timestamps, never render timestamps.
 * Method: https://gery.casiez.net/1euro/ . Parameters are experimental game tuning.
 */
export function createMotionFilter(
  minCutoff: number,
  beta = 12,
  /**
   * Filter depth on its own, more heavily. Depth is the noisiest axis, and with
   * one shared cutoff its jitter opens the filter for sideways and vertical
   * motion too, so a still body shakes. Used for the points that move the
   * first-person camera.
   */
  depth?: { minCutoff: number; beta: number },
) {
  let raw: PovVector | null = null;
  let value: PovVector | null = null;
  let velocity: PovVector = { x: 0, y: 0, z: 0 };
  // The same velocity, averaged over about a tenth of a second. Landmark noise
  // flips sign from pose to pose and averages out; real movement persists.
  let steady: PovVector = { x: 0, y: 0, z: 0 };
  let previousT = -Infinity;
  return {
    update(point: PovVector, t: number, reset = false): PovVector {
      const dt = (t - previousT) / 1000;
      if (reset || !raw || !value || dt <= 0 || dt > 0.25) {
        raw = { ...point };
        value = { ...point };
        velocity = { x: 0, y: 0, z: 0 };
        steady = { x: 0, y: 0, z: 0 };
        previousT = t;
        return { ...value };
      }
      const delta = {
        x: (point.x - raw.x) / dt,
        y: (point.y - raw.y) / dt,
        z: (point.z - raw.z) / dt,
      };
      velocity = blend(velocity, delta, alpha(dt, 8));
      steady = blend(steady, delta, alpha(dt, STEADY_HZ));
      if (depth) {
        const planar = alpha(
          dt,
          minCutoff + beta * Math.hypot(velocity.x, velocity.y),
        );
        const along = alpha(
          dt,
          depth.minCutoff + depth.beta * Math.abs(velocity.z),
        );
        value = {
          x: value.x + (point.x - value.x) * planar,
          y: value.y + (point.y - value.y) * planar,
          z: value.z + (point.z - value.z) * along,
        };
      } else {
        const cutoff =
          minCutoff + beta * Math.hypot(velocity.x, velocity.y, velocity.z);
        value = blend(value, point, alpha(dt, cutoff));
      }
      raw = { ...point };
      previousT = t;
      return { ...value };
    },
    /** Smoothed velocity in units per second at the last update. */
    velocity: (): PovVector => ({ ...velocity }),
    /**
     * Sideways-and-vertical speed of sustained movement, units per second.
     * Near zero for a body that is only jittering, whatever `velocity` says.
     */
    steadySpeed: (): number => Math.hypot(steady.x, steady.y),
  };
}

export interface LeadOptions {
  /** Share of the pose's age to predict across, 0–1. */
  fraction: number;
  /** Longest age, in ms, that is predicted across. */
  maxMs: number;
  /** Largest displacement the prediction may add, in the filter's units. */
  maxDistance: number;
  /**
   * Sustained speed, in units per second, below which nothing is predicted;
   * the lead fades in up to 2.5× this. It keeps landmark noise from wobbling a
   * still pose.
   */
  restSpeed?: number;
  /** Longest time since the sample arrived that is predicted across in full, ms. */
  maxSinceMs?: number;
}
/**
 * How far a filtered point has probably moved since its last sample was
 * captured: smoothed velocity × age, bounded. Display only. A pose is `ageMs`
 * old by the time it is drawn; this estimates where the point is now.
 *
 * Deliberately a plain constant-velocity lead. On the motion bench
 * (motionBench.ts) Kalman constant-velocity and constant-acceleration filters
 * and a minimum-jerk reach model all overshot stops more, or wobbled more at
 * rest, for the same gain while moving.
 */
export function leadOf(
  filter: Pick<ReturnType<typeof createMotionFilter>, "velocity"> &
    Partial<Pick<ReturnType<typeof createMotionFilter>, "steadySpeed">>,
  ageMs: number,
  o: LeadOptions,
  /**
   * Time since the sample reached the game, ms. `ageMs` is then the sample's
   * age when it arrived. The part of the age before arrival is led by
   * `fraction` (a guess about a stale measurement); the time since arrival is
   * led in full, so the point keeps moving evenly between samples instead of
   * creeping and then jumping when the next one lands.
   */
  sinceMs = 0,
): PovVector {
  const zero = { x: 0, y: 0, z: 0 };
  const since = Number.isFinite(sinceMs)
    ? Math.max(0, Math.min(sinceMs, o.maxSinceMs ?? 60))
    : 0;
  if (!Number.isFinite(ageMs) || ageMs < 0 || (ageMs <= 0 && since <= 0))
    return zero;
  const v = filter.velocity();
  // Sideways and vertical only: depth is never predicted, and its jitter must
  // not wake the lead on a body that is standing still.
  const speed = Math.hypot(v.x, v.y);
  if (!(speed > 0)) return zero;
  const rest = o.restSpeed ?? 0;
  // Whether to lead at all is decided on sustained movement, so that jitter on
  // a still body is not led; how far is still the quick velocity.
  const moving = filter.steadySpeed?.() ?? speed;
  const awake =
    rest > 0 ? Math.max(0, Math.min(1, (moving - rest) / (1.5 * rest))) : 1;
  const seconds =
    ((Math.min(ageMs, o.maxMs) * Math.max(0, o.fraction) + since) * awake) /
    1000;
  const k = Math.min(seconds, o.maxDistance / speed);
  return { x: v.x * k, y: v.y * k, z: 0 };
}
