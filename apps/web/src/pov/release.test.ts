import { describe, expect, it } from "vitest";
import { createReleaseTracker, type TimestampedPlayerPose } from "./release";
import type { HandFrame } from "./hands";
import { neutralPose } from "./duel";

function handFrame(t: number, ratio: number, angle = 0): HandFrame {
  const world = Array.from({ length: 21 }, () => ({ x: 0, y: 0.02, z: 0 }));
  world[0] = { x: 0, y: 0, z: 0 };
  world[5] = { x: -0.04, y: 0.04, z: 0 };
  world[17] = { x: 0.04, y: 0.04, z: 0 };
  world[4] = { x: 0, y: 0.1, z: 0 };
  world[8] = { x: 0.08 * ratio, y: 0.1, z: 0 };
  for (const p of world) {
    const y = p.y;
    p.y = y * Math.cos(angle);
    p.z = y * Math.sin(angle);
  }
  return {
    t,
    hands: [
      {
        side: "Right",
        confidence: 0.95,
        world,
        landmarks: world.map((p) => ({ x: 0.5 + p.x, y: 0.5 + p.y, z: p.z })),
      },
    ],
  };
}
function pose(t: number, speed = 3): TimestampedPlayerPose {
  const p = neutralPose();
  p.rightHand.z = 0.35 + (speed * (t - 100)) / 1000;
  return { ...p, t };
}
function hold(tracker: ReturnType<typeof createReleaseTracker>, speed = 3) {
  for (const t of [100, 133, 166])
    tracker.update(handFrame(t, 0.2), pose(t, speed), t);
}
function release(
  tracker: ReturnType<typeof createReleaseTracker>,
  speed = 3,
  angleRate = 0,
) {
  let result = tracker.update(
    handFrame(199, 0.9, angleRate * 0.099),
    pose(199, speed),
    199,
  );
  for (const t of [232, 265])
    result = tracker.update(
      handFrame(t, 0.9, (angleRate * (t - 100)) / 1000),
      pose(t, speed),
      t,
    );
  return result;
}

describe("timestamped pinch-to-release adapter", () => {
  it("emits exactly one forward throw with measured velocity and exact current right-hand origin", () => {
    const tracker = createReleaseTracker();
    hold(tracker);
    const r = release(tracker);
    expect(r.holding).toBe(false);
    expect(r.shot).not.toBeNull();
    expect(r.shot!.velocity.z).toBeCloseTo(3);
    expect(r.shot!.velocity.x).toBeCloseTo(0);
    expect(r.shot!.origin).toEqual(pose(265).rightHand);
    expect(r.shot!.spin).toEqual({ x: 0, y: 0, z: 0 });
    expect(tracker.update(handFrame(298, 0.9), pose(298), 298).shot).toBeNull();
  });
  it("does not turn slow or stationary opening into invented forward speed", () => {
    for (const speed of [0, 0.5, 1.99]) {
      const tracker = createReleaseTracker();
      hold(tracker, speed);
      const r = release(tracker, speed);
      expect(r.shot).toBeNull();
      expect(r.reason).toBe("forward-throw-required");
    }
  });
  it("does not throw backward or after the hand has stopped at release", () => {
    const tracker = createReleaseTracker();
    hold(tracker, -3);
    expect(release(tracker, -3).shot).toBeNull();
    tracker.reset();
    hold(tracker);
    tracker.update(handFrame(199, 0.9), pose(199), 199);
    tracker.update(handFrame(232, 0.9), pose(232), 232);
    const stopped = pose(265);
    stopped.rightHand = { ...pose(232).rightHand };
    expect(tracker.update(handFrame(265, 0.9), stopped, 265).shot).toBeNull();
  });
  it("requires duration and distinct frames for both grip and release", () => {
    const tracker = createReleaseTracker();
    tracker.update(handFrame(100, 0.2), pose(100), 100);
    expect(tracker.update(handFrame(133, 0.2), pose(133), 133).holding).toBe(
      false,
    );
    expect(tracker.update(handFrame(166, 0.2), pose(166), 166).holding).toBe(
      true,
    );
    expect(tracker.update(handFrame(199, 0.9), pose(199), 199).shot).toBeNull();
    expect(tracker.update(handFrame(199, 0.9), pose(199), 250).shot).toBeNull();
    expect(tracker.update(handFrame(199, 0.9), pose(199), 260).holding).toBe(
      true,
    );
  });
  it("uses hysteresis rather than flickering at one threshold", () => {
    const tracker = createReleaseTracker();
    hold(tracker);
    for (const t of [199, 232, 265]) {
      const r = tracker.update(handFrame(t, 0.5), pose(t), t);
      expect(r.holding).toBe(true);
      expect(r.shot).toBeNull();
    }
  });
  it("never releases when hand tracking disappears or returns open", () => {
    const tracker = createReleaseTracker();
    hold(tracker);
    const lost = tracker.update(null, pose(199), 199);
    expect(lost.holding).toBe(false);
    expect(lost.shot).toBeNull();
    for (const t of [232, 265, 298])
      expect(tracker.update(handFrame(t, 0.9), pose(t), t).shot).toBeNull();
  });
  it("disarms stale frames, sampling gaps, mismatched clocks and missing pose timestamps", () => {
    const tracker = createReleaseTracker();
    hold(tracker);
    expect(tracker.update(handFrame(166, 0.9), pose(166), 366).reason).toBe(
      "hand-tracking-lost",
    );
    tracker.reset();
    hold(tracker);
    expect(tracker.update(handFrame(400, 0.9), pose(400), 400).reason).toBe(
      "tracking-gap",
    );
    tracker.reset();
    expect(tracker.update(handFrame(100, 0.2), neutralPose(), 100).reason).toBe(
      "pose-timestamp-required",
    );
    expect(tracker.update(handFrame(200, 0.2), pose(100), 220).holding).toBe(
      false,
    );
    expect(tracker.update(handFrame(250, 0.2), pose(100), 250).reason).toBe(
      "pose-stale-or-unsynchronized",
    );
  });
  it("rejects nonfinite pose/hand geometry and degenerate palm shape without crashing", () => {
    const tracker = createReleaseTracker();
    const invalid = pose(100);
    invalid.rightHand.z = NaN;
    expect(tracker.update(handFrame(100, 0.2), invalid, 100).reason).toBe(
      "invalid-pose",
    );
    tracker.reset();
    const bad = handFrame(100, 0.2);
    bad.hands[0].world[4].x = Infinity;
    expect(tracker.update(bad, pose(100), 100).reason).toBe(
      "invalid-hand-shape",
    );
    tracker.reset();
    const flat = handFrame(100, 0.2);
    flat.hands[0].world[0] = { ...flat.hands[0].world[5] };
    expect(tracker.update(flat, pose(100), 100).reason).toBe(
      "invalid-hand-shape",
    );
    tracker.reset();
    const missing = handFrame(100, 0.2);
    missing.hands[0].world = [];
    expect(tracker.update(missing, pose(100), 100).reason).toBe(
      "invalid-hand-shape",
    );
  });
  it("estimates bounded spin from palm-plane orientation, not how often the hand circles", () => {
    const tracker = createReleaseTracker();
    for (const t of [100, 133, 166])
      tracker.update(handFrame(t, 0.2, (2 * (t - 100)) / 1000), pose(t), t);
    const r = release(tracker, 3, 2);
    expect(r.shot).not.toBeNull();
    expect(r.spinEstimated).toBe(true);
    expect(r.shot!.spin.x).toBeCloseTo(2);
    expect(Math.hypot(...Object.values(r.shot!.spin))).toBeLessThanOrEqual(100);
  });
  it("allows explicit detector-label correction without changing the right-hand server origin", () => {
    const tracker = createReleaseTracker({ side: "Left" });
    let result;
    for (const t of [100, 133, 166, 199, 232, 265]) {
      const f = handFrame(t, t < 199 ? 0.2 : 0.9);
      f.hands[0].side = "Left";
      result = tracker.update(f, pose(t), t);
    }
    expect(result!.shot!.origin).toEqual(pose(265).rightHand);
  });
  it("does not accept mutated coordinates reusing one pose timestamp", () => {
    const tracker = createReleaseTracker();
    hold(tracker);
    const changed = pose(166);
    changed.rightHand.x += 0.1;
    expect(tracker.update(handFrame(199, 0.9), changed, 199).reason).toBe(
      "pose-timestamp-reused",
    );
  });
});
