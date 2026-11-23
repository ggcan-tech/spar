import { describe, it, expect } from "vitest";
import {
  fitSensitivity,
  nearCameraEdge,
  trackedFingers,
  trackedPose,
} from "./input";
import { LM } from "@spar/protocol";
import {
  botThrow,
  createDuel,
  launchBall,
  neutralPose,
  stepDuel,
  validPose,
  FIXED_STEP,
} from "./duel";
import type { TrackingResult } from "./tracking";
import type { HandFrame } from "./hands";

describe("camera spaces to player space", () => {
  const observation = (x = 0, y = 0): TrackingResult => ({
    valid: true,
    calibrated: true,
    confidence: 1,
    units: "game",
    head: { x, y, z: 0 },
    root: { x, y, z: 0 },
    headRelativeTorso: { x: 0, y: 0, z: 0 },
    leftHand: { x: -0.25, y: 0.35, z: 0.65 },
    rightHand: { x: 0.25, y: 0.35, z: 0.65 },
    outOfBounds: false,
    depthValid: true,
    reason: null,
  });
  it.each([-1, 1])(
    "lets a smaller observed dodge clear a committed Duel throw (direction %s)",
    (direction) => {
      const play = (gain: number) => {
        const initial = createDuel();
        let s = launchBall(initial, 1, botThrow(initial, "duel"));
        for (let i = 0; i < 240; i++) {
          // Same delayed, continuous motion in both runs; only its game scale differs.
          const progress = Math.max(
            0,
            Math.min(1, (i * FIXED_STEP - 0.22) / 0.16),
          );
          s = stepDuel(s, [
            trackedPose(observation(direction * 0.2 * progress), gain),
            s.poses[1],
          ]);
        }
        return s;
      };
      expect(play(1).hp[0]).toBe(4);
      expect(play(1.8).hp[0]).toBe(5);
      expect(play(1.8).misses).toBe(1);
    },
  );
  it("amplifies displacement without stretching hands or changing depth", () => {
    const t = observation(0.15, -0.2);
    t.head.x += 0.04;
    t.root.z = t.head.z = 0.1;
    const p = trackedPose(t, 1.8);
    expect(p.root.x).toBeCloseTo(0.27);
    expect(p.head.x - p.root.x).toBeCloseTo(0.04 * 1.8);
    expect(p.root.y).toBeCloseTo(0.72);
    expect(p.head.y).toBeCloseTo(1.37);
    expect(p.root.z).toBe(0.1);
    expect(p.rightHand.x - p.root.x).toBeCloseTo(t.rightHand.x);
    expect(p.rightHand.y - p.root.y).toBeCloseTo(t.rightHand.y);
    expect(p.rightHand.z - p.root.z).toBeCloseTo(t.rightHand.z);
  });
  it("stays bounded at high sensitivity and returns to center without drift", () => {
    for (const x of [-0.6, 0.6]) {
      for (const y of [-1.2, 1.2]) {
        const p = trackedPose(observation(x, y), 2.5);
        expect(validPose(p)).toBe(true);
        // The limit is approached, never crossed.
        expect(p.root.x).toBeCloseTo(Math.sign(x) * 0.6, 4);
        expect(Math.abs(p.root.x)).toBeLessThanOrEqual(0.6);
      }
    }
    expect(trackedPose(observation(), 2.5)).toEqual(neutralPose());
    expect(trackedPose(observation(0.1), 1.8).head.x).toBeCloseTo(0.18);
    expect(trackedPose(observation(0.11), 1.8).head.x).toBeCloseTo(0.198);
  });
  it("warns before visible body landmarks leave the camera, without relying on missing points", () => {
    const lm = Array.from({ length: 33 }, () => ({
      x: 0.5,
      y: 0.5,
      z: 0,
      v: 0.9,
    }));
    expect(nearCameraEdge(lm)).toBe(false);
    lm[LM.R_SHOULDER].x = 0.09;
    expect(nearCameraEdge(lm)).toBe(true);
    lm[LM.R_SHOULDER].v = 0.1;
    expect(nearCameraEdge(lm)).toBe(false);
    lm[LM.NOSE].y = 0.13;
    expect(nearCameraEdge(lm)).toBe(true);
    lm[LM.NOSE].y = NaN;
    expect(nearCameraEdge(lm)).toBe(false);
    lm[LM.L_HIP].y = 0.93;
    expect(nearCameraEdge(lm)).toBe(true);
    expect(nearCameraEdge([])).toBe(false);
  });
  it("keeps root displacement, head lean and hand-local position separate", () => {
    const t: TrackingResult = {
      valid: true,
      calibrated: true,
      confidence: 1,
      units: "meters",
      head: { x: 0.13, y: -0.1, z: 0.1 },
      root: { x: 0.1, y: -0.2, z: 0.1 },
      headRelativeTorso: { x: 0.03, y: 0.1, z: 0 },
      leftHand: { x: -0.3, y: 0.5, z: 0.2 },
      rightHand: { x: 0.3, y: 0.5, z: 0.2 },
      outOfBounds: false,
      depthValid: true,
      reason: null,
    };
    const p = trackedPose(t);
    expect(p.head.x).toBe(0.13);
    expect(p.root.x).toBe(0.1);
    expect(p.rightHand.x).toBe(0.4);
    expect(p.rightHand.y).toBeCloseTo(1.3);
    expect(p.rightHand.z).toBeCloseTo(0.3);
  });
  const frame = (): HandFrame => ({
    t: 100,
    hands: [
      {
        side: "Right",
        confidence: 0.9,
        landmarks: [],
        world: Array.from({ length: 21 }, (_, i) => ({
          x: i * 0.003,
          y: i * 0.004,
          z: i * 0.001,
        })),
      },
    ],
  });
  it("anchors local hand geometry to the body wrist with camera axes converted", () => {
    const p = neutralPose(),
      visual = trackedFingers(frame(), p, 100)[0];
    expect(visual.points[0]).toEqual(p.rightHand);
    expect(visual.points[20].x).toBeCloseTo(p.rightHand.x - 0.06);
    expect(visual.points[20].y).toBeCloseTo(p.rightHand.y - 0.08);
    expect(visual.points[20].z).toBeCloseTo(p.rightHand.z - 0.02);
  });
  it("lets a deep observed crouch reach the floor without invalidating the whole body", () => {
    const pose = trackedPose({
      valid: true,
      calibrated: true,
      confidence: 1,
      units: "game",
      head: { x: 0, y: -1.45, z: 0 },
      root: { x: 0, y: -1.2, z: 0 },
      headRelativeTorso: { x: 0, y: -0.25, z: 0 },
      leftHand: { x: -0.2, y: 0.05, z: 0.3 },
      rightHand: { x: 0.2, y: 0.05, z: 0.3 },
      outOfBounds: false,
      depthValid: true,
      reason: null,
    });
    expect(pose.root.y).toBe(0.1);
    expect(pose.head.y).toBeCloseTo(0.2);
    expect(validPose(pose)).toBe(true);
  });
  it("hides unsynchronized, nonfinite and oversized hand geometry", () => {
    const p = neutralPose();
    expect(trackedFingers(frame(), p, 181)).toEqual([]);
    expect(trackedFingers({ ...frame(), t: NaN }, p, 100)).toEqual([]);
    const invalid = frame();
    invalid.hands[0].world[3].x = NaN;
    expect(trackedFingers(invalid, p, 100)).toEqual([]);
    const huge = frame();
    huge.hands[0].world[3].x = 5;
    expect(trackedFingers(huge, p, 100)).toEqual([]);
  });
});

describe("fitting the dodge gain to the picture", () => {
  it("keeps the default when there is room in the picture", () => {
    // Laptop, 16:9, centred, shoulders 16% of the height wide.
    expect(fitSensitivity(0.5, 0.16, 16 / 9)).toBe(1.8);
    // Unusable numbers fall back to the default.
    expect(fitSensitivity(Number.NaN, 0.16, 16 / 9)).toBe(1.8);
    expect(fitSensitivity(0.5, 0, 16 / 9)).toBe(1.8);
  });
  it("raises it when the picture is narrow or the player stands off-centre", () => {
    // Phone held upright, 9:16.
    const upright = fitSensitivity(0.5, 0.16, 9 / 16);
    expect(upright).toBeGreaterThan(1.8);
    expect(upright).toBeLessThanOrEqual(2.5);
    // A quarter of the way across a wide picture still leaves room;
    // close to its edge does not.
    expect(fitSensitivity(0.25, 0.16, 16 / 9)).toBe(1.8);
    expect(fitSensitivity(0.18, 0.16, 16 / 9)).toBeGreaterThan(1.8);
    // No room at all: as much as is allowed.
    expect(fitSensitivity(0.12, 0.16, 16 / 9)).toBe(2.5);
    // Closer to the camera (wider shoulders in the picture) needs more.
    expect(fitSensitivity(0.5, 0.3, 9 / 16)).toBeGreaterThanOrEqual(upright);
  });
});
