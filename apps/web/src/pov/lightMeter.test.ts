import { describe, expect, it } from "vitest";
import { DIM, createDimLatch, createLightMeter, meanLuma } from "./lightMeter";

describe("is the picture too dark", () => {
  it("measures brightness the way an eye weighs colour", () => {
    expect(meanLuma([0, 0, 0, 255, 255, 255, 255, 255])).toBeCloseTo(127.5);
    // Green counts for most, blue for little.
    expect(meanLuma([0, 255, 0, 255])).toBeGreaterThan(
      meanLuma([255, 0, 0, 255]),
    );
    expect(meanLuma([0, 0, 255, 255])).toBeLessThan(20);
    expect(meanLuma([])).toBe(0);
  });
  it("calls it dim only after a couple of dark seconds, and clears only when clearly brighter", () => {
    const latch = createDimLatch();
    expect(latch.update(30, 0)).toBe(false);
    expect(latch.update(30, DIM.afterMs - 100)).toBe(false);
    expect(latch.update(30, DIM.afterMs)).toBe(true);
    // Hovering just above the line does not clear it.
    expect(latch.update(DIM.below + 5, DIM.afterMs + 1000)).toBe(true);
    expect(latch.update(DIM.clear + 1, DIM.afterMs + 2000)).toBe(false);
    // A dark moment (a hand over the lens) is not dim light.
    expect(latch.update(10, 10000)).toBe(false);
    expect(latch.update(120, 10500)).toBe(false);
    expect(latch.update(10, 11000)).toBe(false);
    expect(latch.update(10, 12000)).toBe(false);
  });
  it("does without a canvas", () => {
    const meter = createLightMeter();
    expect(meter.read(null, 0)).toEqual({ luma: null, dim: false });
    const video = { readyState: 4, videoWidth: 640 } as HTMLVideoElement;
    // No document here: the meter gives up quietly and stays that way.
    expect(meter.read(video, 2000)).toEqual({ luma: null, dim: false });
    expect(meter.read(video, 4000)).toEqual({ luma: null, dim: false });
  });
});
