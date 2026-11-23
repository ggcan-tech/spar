import { describe, expect, it } from "vitest";
import {
  SCENARIOS,
  filterEstimator,
  runBench,
  type BenchPipeline,
  type BenchResult,
  type Estimator,
} from "./motionBench";
import { createMotionFilter, leadOf } from "./motionFilter";

/** The lead the game draws with: 0.3 of the pose's age at arrival, all the time since, still poses left alone. */
const GAME_LEAD = {
  fraction: 0.3,
  maxMs: 120,
  maxDistance: 0.3,
  restSpeed: 0.15,
};
const SLOW: BenchPipeline = { fps: 28, delayMs: 110, noise: 0.004 };
const FAST: BenchPipeline = { fps: 60, delayMs: 60, noise: 0.004 };
const scenario = (name: string) =>
  SCENARIOS.find((s) => s.name.startsWith(name))!;
/** Mean over several noise seeds, so a threshold is not one lucky draw. */
function mean(name: string, pipeline: BenchPipeline, make: () => Estimator) {
  const total: BenchResult = { rms: 0, moving: 0, rest: 0, overshoot: 0 };
  const seeds = 10;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = runBench(scenario(name), { ...pipeline, seed }, make());
    for (const key of Object.keys(total) as (keyof BenchResult)[])
      total[key] += r[key] / seeds;
  }
  return total;
}
const hold = () => filterEstimator(null);
const lead = () => filterEstimator(GAME_LEAD);

describe("motion bench: what delay costs and what prediction buys", () => {
  it("is deterministic for a given seed", () => {
    const run = () => runBench(scenario("sway"), { ...FAST, seed: 3 }, lead());
    expect(run()).toEqual(run());
  });
  it("scores a perfect, instant estimate as zero error", () => {
    const truth = scenario("dodge");
    let now = 0;
    const perfect: Estimator = {
      observe() {},
      at: (ms) => ((now = ms), truth.at(ms / 1000)),
    };
    const r = runBench(truth, { fps: 60, delayMs: 0, noise: 0 }, perfect);
    expect(now).toBeGreaterThan(0);
    expect(r.rms).toBeCloseTo(0, 9);
    expect(r.overshoot).toBeCloseTo(0, 9);
  });
  it("shows the cost of delay: an undelayed, noise-free pose is far closer than a late one", () => {
    const ideal = mean("sway", { fps: 60, delayMs: 0, noise: 0 }, hold);
    const late = mean("sway", SLOW, hold);
    expect(late.rms).toBeGreaterThan(0.1);
    expect(ideal.rms).toBeLessThan(late.rms / 4);
  });
  it("about a fifth less error in steady movement with the game's lead", () => {
    // Less than the third a half-age lead gave: the lead was cut back so the
    // drawn point runs no further past a stop now that it also advances
    // between poses.
    for (const pipeline of [SLOW, FAST]) {
      const before = mean("sway", pipeline, hold),
        after = mean("sway", pipeline, lead);
      expect(after.moving).toBeLessThan(before.moving * 0.85);
    }
  });
  it("keeps a still body calm: the lead adds under 2 mm of wobble", () => {
    for (const pipeline of [SLOW, FAST]) {
      const before = mean("still", pipeline, hold),
        after = mean("still", pipeline, lead);
      expect(after.rest).toBeLessThan(before.rest + 0.002);
      expect(after.rest).toBeLessThan(0.006);
    }
  });
  it("bounds how far the drawn point runs past a stop", () => {
    // Overshoot is the price of any lead: the stop is seen `delay` late.
    expect(mean("dodge", FAST, lead).overshoot).toBeLessThan(0.04);
    expect(mean("dodge", SLOW, lead).overshoot).toBeLessThan(0.11);
    // A full-age lead would overshoot much further; that is why the game uses 0.3.
    const full = () => filterEstimator({ ...GAME_LEAD, fraction: 1 });
    expect(mean("dodge", SLOW, full).overshoot).toBeGreaterThan(
      mean("dodge", SLOW, lead).overshoot * 1.6,
    );
  });
  it("finds a faster pipeline worth more than prediction on a quick dodge", () => {
    // 60 poses/s at 60 ms with no prediction beats 28 poses/s at 110 ms with it.
    expect(mean("dodge", FAST, hold).moving).toBeLessThan(
      mean("dodge", SLOW, lead).moving,
    );
    expect(mean("throw", FAST, hold).moving).toBeLessThan(
      mean("throw", SLOW, lead).moving,
    );
  });
});

describe("bounded velocity lead", () => {
  const moving = (speed: number) => {
    const f = createMotionFilter(4.5);
    for (let i = 0; i <= 40; i++)
      f.update({ x: (speed * i) / 60, y: 0, z: 0 }, (i * 1000) / 60);
    return f;
  };
  it("leads along the velocity by a share of the age", () => {
    const d = leadOf(moving(1), 80, {
      fraction: 0.5,
      maxMs: 120,
      maxDistance: 1,
    });
    expect(d.x).toBeCloseTo(0.04, 2);
    expect(d.y).toBe(0);
  });
  it("caps the age, the distance and never leads a still or stale point", () => {
    const f = moving(2);
    expect(
      leadOf(f, 500, { fraction: 1, maxMs: 100, maxDistance: 9 }).x,
    ).toBeCloseTo(0.2, 1);
    expect(
      leadOf(f, 500, { fraction: 1, maxMs: 100, maxDistance: 0.05 }).x,
    ).toBeCloseTo(0.05);
    expect(leadOf(f, 0, GAME_LEAD)).toEqual({ x: 0, y: 0, z: 0 });
    expect(leadOf(f, -20, GAME_LEAD)).toEqual({ x: 0, y: 0, z: 0 });
    expect(leadOf(f, NaN, GAME_LEAD)).toEqual({ x: 0, y: 0, z: 0 });
    expect(leadOf(moving(0.05), 100, GAME_LEAD)).toEqual({ x: 0, y: 0, z: 0 });
    // Between the rest speed and 2.5× it, the lead fades in rather than switching on.
    const partial = leadOf(moving(0.175), 100, GAME_LEAD).x;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.175 * 0.05);
  });
});
