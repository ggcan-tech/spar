import { createMotionFilter, leadOf, type LeadOptions } from "./motionFilter";

/**
 * Motion-quality bench. It plays a known movement through a simulated camera
 * pipeline (frame rate, delay, landmark noise) and scores what would be drawn
 * against where the point really is at that instant. Synthetic: it ranks
 * filters and predictors against each other; it does not measure a real camera.
 */
export interface BenchPipeline {
  /** Poses per second coming out of the camera and model. */
  fps: number;
  /** Capture-to-available delay in ms: camera plus inference. */
  delayMs: number;
  /** Landmark noise, one standard deviation, in game units (≈ metres). */
  noise: number;
  renderHz?: number;
  seed?: number;
}
export interface Scenario {
  name: string;
  seconds: number;
  /** True position along one axis at time t (seconds). */
  at(t: number): number;
}
export interface BenchResult {
  /** RMS distance from the truth over the whole run. */
  rms: number;
  /** RMS distance while the point is moving. */
  moving: number;
  /** RMS wobble around the truth once it has been still for 0.4 s. */
  rest: number;
  /** Furthest the estimate runs past a stop, in the direction of travel. */
  overshoot: number;
}
/** Smooth point-to-point movement: the usual model of a human reach. */
export const reach = (t: number, start: number, duration: number) => {
  const k = Math.max(0, Math.min(1, (t - start) / duration));
  return k * k * k * (10 - 15 * k + 6 * k * k);
};
export const SCENARIOS: Scenario[] = [
  { name: "still", seconds: 3, at: () => 0 },
  { name: "sway 1 Hz", seconds: 4, at: (t) => 0.2 * Math.sin(2 * Math.PI * t) },
  {
    name: "dodge 30 cm / 250 ms",
    seconds: 3.2,
    at: (t) => 0.3 * (reach(t, 0.6, 0.25) - reach(t, 1.9, 0.25)),
  },
  {
    name: "throw 60 cm / 150 ms",
    seconds: 2,
    at: (t) => 0.6 * reach(t, 0.6, 0.15),
  },
];
function gaussian(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () =>
    Math.sqrt(-2 * Math.log(uniform() + 1e-12)) *
    Math.cos(2 * Math.PI * uniform());
}
export interface Estimator {
  /** A pose sample captured at `captureMs` became available at `arrivedMs`. */
  observe(value: number, captureMs: number, arrivedMs?: number): void;
  /** Best estimate of the point at `nowMs`. */
  at(nowMs: number): number;
}
/** The game's filter, with an optional lead across the pose's age. */
export function filterEstimator(
  lead: LeadOptions | null,
  minCutoff = 1000 / (2 * Math.PI * 35),
  beta = 12,
): Estimator {
  const filter = createMotionFilter(minCutoff, beta);
  let value = 0,
    captured = -Infinity,
    arrived = -Infinity;
  return {
    observe(v, captureMs, arrivedMs = captureMs) {
      value = filter.update({ x: v, y: 0, z: 0 }, captureMs).x;
      captured = captureMs;
      arrived = arrivedMs;
    },
    // As the game draws: the sample's age when it arrived by `fraction`, then
    // the time since it arrived in full.
    at: (nowMs) =>
      lead
        ? value + leadOf(filter, arrived - captured, lead, nowMs - arrived).x
        : value,
  };
}
export function runBench(
  scenario: Scenario,
  pipeline: BenchPipeline,
  estimator: Estimator,
): BenchResult {
  const noise = gaussian(pipeline.seed ?? 7);
  const frame = 1 / pipeline.fps,
    delay = pipeline.delayMs / 1000,
    tick = 1 / (pipeline.renderHz ?? 60);
  let next = 0,
    sum = 0,
    count = 0,
    movingSum = 0,
    movingCount = 0,
    restSum = 0,
    restCount = 0,
    overshoot = 0,
    stillFor = 0,
    heading = 0;
  for (let now = 0; now <= scenario.seconds; now += tick) {
    // Deliver every frame whose capture + delay has passed, in order.
    while (next * frame + delay <= now) {
      const captured = next++ * frame;
      estimator.observe(
        scenario.at(captured) + noise() * pipeline.noise,
        captured * 1000,
        (captured + delay) * 1000,
      );
    }
    if (now < 0.3) continue;
    const truth = scenario.at(now);
    const speed =
      Math.abs(scenario.at(now + 0.001) - scenario.at(now - 0.001)) / 0.002;
    const error = estimator.at(now * 1000) - truth;
    sum += error * error;
    count++;
    if (speed > 0.2) {
      movingSum += error * error;
      movingCount++;
      stillFor = 0;
      heading = Math.sign(scenario.at(now + 0.001) - scenario.at(now - 0.001));
    } else {
      stillFor += tick;
      // Past a stop, error in the direction of travel is overshoot.
      if (stillFor < 0.4 && heading)
        overshoot = Math.max(overshoot, error * heading);
      if (stillFor >= 0.4) {
        restSum += error * error;
        restCount++;
      }
    }
  }
  const rms = (s: number, n: number) => (n ? Math.sqrt(s / n) : 0);
  return {
    rms: rms(sum, count),
    moving: rms(movingSum, movingCount),
    rest: rms(restSum, restCount),
    overshoot,
  };
}
