import { describe, expect, it } from "vitest";
import { createCaptureClock } from "./captureClock";

/** A seeded source of jitter in [-1, 1]. */
function jitter(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 2 - 1;
  };
}
/** Spread of the speed read from stamps, for a point moving at exactly 1 unit a second. */
function speedSpread(times: number[], captured: number[]) {
  const speeds: number[] = [];
  for (let i = 1; i < times.length; i++)
    speeds.push((captured[i] - captured[i - 1]) / (times[i] - times[i - 1]));
  const mean = speeds.reduce((a, v) => a + v, 0) / speeds.length;
  return Math.sqrt(
    speeds.reduce((a, v) => a + (v - mean) ** 2, 0) / speeds.length,
  );
}

describe("an even clock for motion", () => {
  const PERIOD = 1000 / 30;
  const frames = (n: number, seed = 3) => {
    const noise = jitter(seed);
    const captured = Array.from({ length: n }, (_, i) => 5000 + i * PERIOD);
    // The page notices each frame 40 ms later, give or take 7.
    const page = captured.map((c) => c + 40 + noise() * 7);
    return { captured, page };
  };

  it("removes the page's jitter when the camera gives its own frame time", () => {
    const { captured, page } = frames(200);
    const clock = createCaptureClock();
    // The camera's clock need not be the page's: here it starts at zero.
    const even = page.map((p, i) => clock.stamp(p, captured[i] - 5000));
    const before = speedSpread(page, captured),
      after = speedSpread(even.slice(20), captured.slice(20));
    expect(before).toBeGreaterThan(0.08);
    expect(after).toBeLessThan(before / 8);
    // Still the page's clock: within a few milliseconds of its own stamps.
    for (let i = 20; i < even.length; i++)
      expect(Math.abs(even[i] - page[i])).toBeLessThan(10);
  });

  it("fits an even beat when the camera gives nothing, through a skipped frame", () => {
    const { captured, page } = frames(200, 9);
    // Frames 80 and 81 never reached the page.
    const kept = page.map((_, i) => i).filter((i) => i !== 80 && i !== 81);
    const clock = createCaptureClock();
    const even = kept.map((i) => clock.stamp(page[i]));
    const before = speedSpread(
        kept.map((i) => page[i]),
        kept.map((i) => captured[i]),
      ),
      after = speedSpread(
        even.slice(30),
        kept.slice(30).map((i) => captured[i]),
      );
    expect(after).toBeLessThan(before / 2.5);
    for (let i = 30; i < even.length; i++)
      expect(Math.abs(even[i] - page[kept[i]])).toBeLessThan(16);
  });

  it("never goes backwards and starts again after a pause", () => {
    const clock = createCaptureClock();
    let last = -Infinity;
    const noise = jitter(1);
    for (let i = 0; i < 300; i++) {
      // A camera whose own stamps are erratic.
      const page = 1000 + i * 33 + noise() * 15;
      const out = clock.stamp(page, i * 33 + noise() * 30);
      expect(out).toBeGreaterThan(last);
      last = out;
    }
    // Half a second with no frames: the next stamp is the page's own.
    expect(clock.stamp(last + 600)).toBeCloseTo(last + 600, 5);
  });
});
