import { describe, expect, it } from "vitest";
import { createMotionFilter } from "./motionFilter";
const p = (x: number) => ({ x, y: 0, z: 0 });
describe("speed-adaptive motion filtering", () => {
  it("attenuates standing jitter while following quick movement more closely than a fixed 35 ms filter", () => {
    const filter = createMotionFilter(1000 / (2 * Math.PI * 35));
    filter.update(p(0), 0);
    let max = 0;
    for (let i = 1; i <= 60; i++)
      max = Math.max(
        max,
        Math.abs(filter.update(p(i % 2 ? 0.002 : -0.002), i * 16).x),
      );
    expect(max).toBeLessThan(0.001);
    const fast = filter.update(p(0.12), 976).x;
    const fixed = 0.12 * (1 - Math.exp(-16 / 35));
    expect(fast).toBeGreaterThan(fixed * 1.5);
    expect(fast).toBeLessThanOrEqual(0.12);
  });
  it("converges without overshoot on a stop and resets after gaps", () => {
    const filter = createMotionFilter(4.5);
    filter.update(p(0), 0);
    filter.update(p(0.1), 33);
    for (let i = 2; i < 20; i++)
      expect(filter.update(p(0.1), i * 33).x).toBeLessThanOrEqual(0.1);
    expect(filter.update(p(-0.2), 2000).x).toBe(-0.2);
  });
});
