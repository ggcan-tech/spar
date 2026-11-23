import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@spar/protocol";
import { syntheticFrame } from "../pov/syntheticBody";
import { createPovTracker } from "../pov/tracking";
import { createFlashProbe, createStillMeter, describeProbe, jitterOf, type ProbeReport } from "./probe";
import { AT_REST, stance } from "./scriptedBoxer";

function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const bell = (random: () => number) => {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += random();
  return (sum - 3) * Math.SQRT2;
};

describe("measuring jitter", () => {
  it("finds the size of the noise, whatever slow drift or odd twitch rides on it", () => {
    const random = seeded(7);
    const noise = Array.from({ length: 400 }, () => 0.01 * bell(random));
    expect(jitterOf(noise)).toBeGreaterThan(0.0075);
    expect(jitterOf(noise)).toBeLessThan(0.0125);
    // The same noise on a hand that drifts 10 cm and twitches 5 cm now and then.
    const moving = noise.map((v, i) => v + 0.1 * (i / 400) + (i % 37 === 0 ? 0.05 : 0));
    expect(jitterOf(moving)).toBeGreaterThan(0.0075);
    expect(jitterOf(moving)).toBeLessThan(0.014);
    expect(jitterOf([0, 0, 0])).toBe(0);
  });
  it("reads a standing player's wrists through the real tracker, and twice the noise as about twice the jitter", () => {
    const measure = (scale: number, fps: number) => {
      const random = seeded(3);
      const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative" });
      const meter = createStillMeter();
      const noisy = (frame: PoseFrame): PoseFrame => ({
        ...frame,
        lm: frame.lm.map((p) => ({ ...p, x: p.x + bell(random) * 0.0016 * scale, y: p.y + bell(random) * 0.0016 * scale, z: p.z + bell(random) * 0.012 * scale })),
        world: frame.world!.map((p) => ({ ...p, x: p.x + bell(random) * 0.004 * scale, y: p.y + bell(random) * 0.004 * scale, z: p.z + bell(random) * 0.03 * scale })),
      });
      let t = 1000;
      const step = 1000 / fps;
      for (let i = 0; i < fps * 1.5; i++) tracker.update(noisy(syntheticFrame((t += step), AT_REST)), t);
      for (let i = 0; i < fps * 10; i++) {
        const result = tracker.update(noisy(syntheticFrame((t += step), stance())), t);
        if (i > fps) meter.pose(result, t, result.valid);
      }
      return meter.summary();
    };
    const usual = measure(1, 30),
      twice = measure(2, 30),
      fast = measure(1, 60);
    expect(usual.rate).toBeCloseTo(30, 0);
    expect(fast.rate).toBeCloseTo(60, 0);
    expect(usual.followed).toBeGreaterThan(0.95);
    expect(usual.seen[0]).toBeGreaterThan(0.95);
    // About half a centimetre at the usual noise, about double at twice it, the same at either rate.
    expect(usual.wristCm[0]).toBeGreaterThan(0.3);
    expect(usual.wristCm[0]).toBeLessThan(1.2);
    expect(twice.wristCm[0] / usual.wristCm[0]).toBeGreaterThan(1.5);
    expect(twice.wristCm[0] / usual.wristCm[0]).toBeLessThan(2.6);
    expect(fast.wristCm[0] / usual.wristCm[0]).toBeGreaterThan(0.6);
    expect(fast.wristCm[0] / usual.wristCm[0]).toBeLessThan(1.6);
    expect(usual.swapsPerMinute).toBe(0);
  });
});

describe("timing the screen in the camera's own picture", () => {
  const room = (delay: number, step: number, wobble: number, seed = 5) => {
    const random = seeded(seed);
    const probe = createFlashProbe();
    const flashes = [500, 1130, 1790, 2380, 3050, 3660, 4310, 4900];
    for (const at of flashes) probe.flash(at);
    // The camera's picture every 33 ms: a room at brightness 60, lifted for 70 ms by each flash, `delay` later.
    for (let t = 0; t < 5600; t += 33.3) {
      const lit = flashes.some((at) => t >= at + delay && t < at + delay + 70);
      probe.brightness(t, 60 + (lit ? step : 0) + wobble * bell(random));
    }
    return probe.result();
  };
  it("finds the delay to within a camera frame", () => {
    const r = room(120, 9, 0.4);
    expect(r.found).toBeGreaterThanOrEqual(7);
    expect(r.ms).not.toBeNull();
    expect(r.ms!).toBeGreaterThan(110);
    expect(r.ms!).toBeLessThan(160);
  });
  it("says so when the room is too bright for the flash to show", () => {
    expect(room(120, 0.5, 0.4).ms).toBeNull();
    // A flickering picture is not mistaken for flashes either.
    expect(room(120, 0, 3).ms).toBeNull();
  });
});

describe("the report in words", () => {
  it("says plainly whether the reading is clean", () => {
    const still = { seconds: 15, rate: 30, followed: 1, seen: [1, 1] as [number, number], wristCm: [0.5, 0.6] as [number, number], elbowCm: [0.6, 0.6] as [number, number], depthCm: [3, 4] as [number, number], swapsPerMinute: 0 };
    const report: ProbeReport = {
      at: "2026-11-13T20:00:00Z",
      camera: "1280×720 at 30 fps",
      screen: "1440×900",
      poseAgeMs: { middle: 95, worst: 140 },
      guard: still,
      tight: still,
      punches: { asked: 6, read: 6, called: ["left straight", "right straight"] },
      flash: { ms: 118, found: 11, flashes: 12, spreadMs: 16 },
      soundMs: 12,
    };
    const lines = describeProbe(report);
    expect(lines.join(" ")).toMatch(/6 of 6 read/);
    expect(lines.join(" ")).toMatch(/Screen to camera: 118 ms/);
    expect(lines.at(-1)).toMatch(/clean/);
    expect(describeProbe({ ...report, guard: { ...still, wristCm: [1.6, 1.1] }, flash: { ms: null, found: 1, flashes: 12, spreadMs: 0 } }).join(" ")).toMatch(/heavy jitter.*|did not show/);
  });
});
