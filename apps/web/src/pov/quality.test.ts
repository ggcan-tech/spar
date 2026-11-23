import { describe, expect, it } from "vitest";
import {
  createQualityLadder,
  createTierAdvisor,
  isModelTier,
  poseModelUrl,
} from "./quality";

describe("keeping up on a slow device", () => {
  const feed = (
    ladder: ReturnType<typeof createQualityLadder>,
    from: number,
    seconds: number,
    load: { renderFps: number; poseFps: number },
  ) => {
    let level = ladder.level(),
      t = from;
    for (; t < from + seconds * 1000; t += 500) level = ladder.update(load, t);
    return { level, t };
  };
  it("stays at full quality on a device that keeps up", () => {
    const ladder = createQualityLadder();
    expect(feed(ladder, 0, 120, { renderFps: 60, poseFps: 28 }).level).toBe(0);
    // No camera at all (keyboard preview) is not a slow device.
    expect(feed(ladder, 200000, 60, { renderFps: 60, poseFps: 0 }).level).toBe(0);
  });
  it("steps down after three seconds of not keeping up, one step at a time", () => {
    const ladder = createQualityLadder();
    expect(feed(ladder, 0, 2.5, { renderFps: 30, poseFps: 25 }).level).toBe(0);
    expect(feed(ladder, 2500, 1.5, { renderFps: 30, poseFps: 25 }).level).toBe(1);
    expect(feed(ladder, 4000, 4, { renderFps: 30, poseFps: 25 }).level).toBe(2);
    // Slow tracking alone counts too.
    const tracking = createQualityLadder();
    expect(feed(tracking, 0, 4, { renderFps: 60, poseFps: 12 }).level).toBe(1);
  });
  it("ignores a short hitch and comes back up only after a long good stretch", () => {
    const ladder = createQualityLadder();
    let at = feed(ladder, 0, 2, { renderFps: 20, poseFps: 25 });
    at = feed(ladder, at.t, 10, { renderFps: 60, poseFps: 28 });
    expect(at.level).toBe(0);
    at = feed(ladder, at.t, 8, { renderFps: 25, poseFps: 25 });
    expect(at.level).toBe(2);
    at = feed(ladder, at.t, 10, { renderFps: 60, poseFps: 28 });
    expect(at.level).toBe(2);
    at = feed(ladder, at.t, 8, { renderFps: 60, poseFps: 28 });
    expect(at.level).toBe(1);
    at = feed(ladder, at.t, 16, { renderFps: 60, poseFps: 28 });
    expect(at.level).toBe(0);
  });
});

describe("the body model that fits the device", () => {
  const ask = (
    tier: "lite" | "full",
    load: { inferenceMs: number; poseFps: number; cameraFps: number },
    times: number,
  ) => {
    const advisor = createTierAdvisor();
    let answer = null;
    for (let i = 0; i < times && !answer; i++)
      answer = advisor.advise(tier, load);
    return answer;
  };
  it("moves up to the larger model only with plenty of room, and not at once", () => {
    const fast = { inferenceMs: 8, poseFps: 30, cameraFps: 30 };
    expect(ask("lite", fast, 4)).toBeNull();
    expect(ask("lite", fast, 5)).toBe("full");
    // 14 ms on the small model would be 35 on the large: more than a frame.
    expect(ask("lite", { ...fast, inferenceMs: 14 }, 50)).toBeNull();
    // A 60 fps camera leaves no room: the rate is worth more than the model.
    expect(ask("lite", { inferenceMs: 8, poseFps: 58, cameraFps: 60 }, 50)).toBeNull();
    // Already dropping poses on the small model.
    expect(ask("lite", { ...fast, poseFps: 22 }, 50)).toBeNull();
    // No timing known (a scripted source): nothing is changed.
    expect(ask("lite", { inferenceMs: 0, poseFps: 30, cameraFps: 30 }, 50)).toBeNull();
  });
  it("goes back to the small model when the large one does not keep up", () => {
    expect(ask("full", { inferenceMs: 40, poseFps: 17, cameraFps: 30 }, 2)).toBeNull();
    expect(ask("full", { inferenceMs: 40, poseFps: 17, cameraFps: 30 }, 3)).toBe("lite");
    expect(ask("full", { inferenceMs: 20, poseFps: 29, cameraFps: 30 }, 50)).toBeNull();
    // One slow reading in between starts the count again.
    const advisor = createTierAdvisor();
    const slow = { inferenceMs: 40, poseFps: 17, cameraFps: 30 },
      fine = { inferenceMs: 20, poseFps: 29, cameraFps: 30 };
    expect(
      [slow, slow, fine, slow, slow].map((l) => advisor.advise("full", l)),
    ).toEqual([null, null, null, null, null]);
  });
  it("names the model files", () => {
    expect(poseModelUrl("full")).toContain("pose_landmarker_full.task");
    expect(isModelTier("lite")).toBe(true);
    expect(isModelTier("huge")).toBe(false);
  });
});
