import { describe, expect, it } from "vitest";
import { LM, type PoseFrame } from "@spar/protocol";
import {
  createPovTracker,
  missingBodyParts,
  type PovTrackingOptions,
} from "./tracking";
import { trackedPose } from "./input";
import {
  PERSON,
  syntheticFrame,
  type SyntheticMotion,
} from "./syntheticBody";
import { validPose } from "./duel";

function frame(t = 100): PoseFrame {
  const lm = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    v: 0.95,
  }));
  lm[LM.NOSE] = { x: 0.5, y: 0.2, z: -0.02, v: 0.95 };
  lm[LM.L_SHOULDER] = { x: 0.6, y: 0.35, z: 0, v: 0.95 };
  lm[LM.R_SHOULDER] = { x: 0.4, y: 0.35, z: 0, v: 0.95 };
  lm[LM.L_HIP] = { x: 0.56, y: 0.65, z: 0, v: 0.95 };
  lm[LM.R_HIP] = { x: 0.44, y: 0.65, z: 0, v: 0.95 };
  lm[LM.L_WRIST] = { x: 0.65, y: 0.45, z: -0.05, v: 0.95 };
  lm[LM.R_WRIST] = { x: 0.35, y: 0.45, z: -0.05, v: 0.95 };
  return { t, lm, world: [], imageAspect: 2 / 3 };
}
function ready(options: PovTrackingOptions = {}) {
  const tracker = createPovTracker({
    shoulderWidthM: 0.4,
    distanceM: 2,
    smoothingMs: 0,
    ...options,
  });
  for (let i = 0; i < 12; i++) tracker.calibrate(frame(100 + i * 40));
  expect(tracker.sample(540).calibrated).toBe(true);
  return tracker;
}
function translated(t: number, x: number, y = 0): PoseFrame {
  const f = frame(t);
  f.lm.forEach((p) => {
    p.x += x;
    p.y += y;
  });
  return f;
}

describe("experimental continuous POV tracking", () => {
  it("preserves planar motion when automatic shoulder scale briefly jumps", () => {
    const tracker = ready({
      automatic: true,
      scaleMode: "body-relative",
      calibrationMinMs: 400,
    });
    const f = translated(580, -0.04);
    f.lm[LM.L_SHOULDER].x += 0.06;
    f.lm[LM.R_SHOULDER].x -= 0.06;
    const result = tracker.update(f);
    expect(result).toMatchObject({
      valid: true,
      depthValid: false,
      reason: "scale-uncertain",
    });
    expect(result.root.x).toBeCloseTo(0.08);
    expect(result.root.z).toBeCloseTo(0);
  });
  it("bridges one briefly obscured body frame without resetting the match or inventing motion", () => {
    const tracker = ready({
      automatic: true,
      scaleMode: "body-relative",
      calibrationMinMs: 400,
    });
    const before = tracker.sample(540);
    const obscured = frame(580);
    obscured.lm[LM.L_HIP].v = 0.1;
    const held = tracker.update(obscured);
    expect(held).toMatchObject({
      valid: true,
      held: true,
      depthValid: false,
      rightHandTracked: false,
    });
    expect(held.head).toEqual(before.head);
    expect(held.root).toEqual(before.root);
    // Still coasting well past one pose interval, and gone once the budget ends.
    expect(tracker.sample(621)).toMatchObject({ valid: true, held: true });
    expect(tracker.sample(789).valid).toBe(true);
    expect(tracker.sample(791).valid).toBe(false);
  });
  it("returns from a brief hold on the next good frame", () => {
    const tracker = ready({
      automatic: true,
      scaleMode: "body-relative",
      calibrationMinMs: 400,
    });
    const obscured = frame(580);
    obscured.lm[LM.L_HIP].v = 0.1;
    expect(tracker.update(obscured).held).toBe(true);
    expect(tracker.update(frame(620))).toMatchObject({
      valid: true,
      held: false,
    });
  });
  it("rides out one weak frame at a real camera's pace without ever going invalid", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    // 28 poses a second, each arriving 45 ms after its frame, drawn at 60 Hz.
    const step = 1000 / 28,
      delay = 45;
    let t = 1000,
      index = 0,
      invalid = 0;
    for (; index < 60; index++, t += step) tracker.update(frame(t), t + delay);
    expect(tracker.sample(t - step + delay).valid).toBe(true);
    for (; index < 90; index++, t += step) {
      const f = frame(t);
      if (index === 70) f.lm[LM.L_HIP].v = 0.3;
      tracker.update(f, t + delay);
      for (let now = t + delay; now < t + delay + step; now += 1000 / 60)
        if (!tracker.sample(now).valid) invalid++;
    }
    expect(invalid).toBe(0);
  });
  it("does not renew the hold budget on repeated bad frames", () => {
    const tracker = ready({
      automatic: true,
      scaleMode: "body-relative",
      calibrationMinMs: 400,
    });
    for (const t of [580, 660, 740, 789]) {
      const f = frame(t);
      f.lm[LM.NOSE].v = 0.1;
      expect(tracker.update(f).valid).toBe(true);
    }
    const lost = frame(791);
    lost.lm[LM.NOSE].v = 0.1;
    expect(tracker.update(lost).valid).toBe(false);
  });
  it("measures the hold budget from when the last good pose arrived", () => {
    const tracker = ready({
      automatic: true,
      scaleMode: "body-relative",
      calibrationMinMs: 400,
    });
    tracker.update(frame(580), 630);
    const obscured = frame(620);
    obscured.lm[LM.L_HIP].v = 0.1;
    expect(tracker.update(obscured, 670).valid).toBe(true);
    const late = frame(840);
    late.lm[LM.L_HIP].v = 0.1;
    expect(tracker.update(late, 881).valid).toBe(false);
  });
  it("sustains a visible moving body across moderate confidence dips after setup", () => {
    const tracker = ready({
      automatic: true,
      scaleMode: "body-relative",
      calibrationMinMs: 400,
    });
    const f = translated(580, -0.04);
    f.lm[LM.L_HIP].v = 0.5;
    expect(tracker.update(f)).toMatchObject({ valid: true, held: false });
    expect(tracker.sample(590).root.x).toBeCloseTo(0.08);
  });
  it("uses reliable 3D shoulders for orientation instead of vetoing them with image-relative depth", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    for (let i = 0; i <= 18; i++) {
      const f = frame(100 + i * 40);
      f.lm[LM.L_SHOULDER].z = 0.18;
      f.world = f.lm.map((p) => ({ ...p, x: (p.x - 0.5) * 2, z: 0 }));
      tracker.update(f);
    }
    expect(tracker.sample(830)).toMatchObject({
      valid: true,
      calibrated: true,
      depthValid: true,
    });
  });
  it("still rejects turned 3D shoulders even when image depth looks frontal", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    const f = frame();
    f.world = f.lm.map((p) => ({ ...p, x: (p.x - 0.5) * 2, z: 0 }));
    f.world[LM.L_SHOULDER].z = 0.4;
    expect(tracker.update(f).reason).toBe("shoulder-yaw");
  });
  it("does not trust missing or low-confidence world shoulders over the image estimate", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    const f = frame();
    f.lm[LM.L_SHOULDER].z = 0.18;
    f.world = f.lm.map((p) => ({ ...p, x: (p.x - 0.5) * 2, z: 0, v: 0.1 }));
    expect(tracker.update(f).reason).toBe("shoulder-yaw");
  });
  it("identifies the actual missing calibration parts without requiring wrists", () => {
    const f = frame();
    f.lm[LM.R_WRIST].v = 0;
    expect(missingBodyParts(f.lm)).toEqual([]);
    f.lm[LM.L_HIP].y = 1.2;
    expect(missingBodyParts(f.lm)).toEqual(["hips"]);
    f.lm[LM.NOSE].v = 0.2;
    f.lm[LM.R_SHOULDER].x = NaN;
    expect(missingBodyParts(f.lm)).toEqual(["head", "shoulders", "hips"]);
    expect(missingBodyParts([])).toEqual(["head", "shoulders", "hips"]);
  });
  it("keeps observed planar movement during shoulder yaw without inventing a depth change", () => {
    const tracker = ready();
    // A turn is read from a quarter of a second of poses, so that one noisy
    // depth reading is not a turn: hold it for that long.
    let r = tracker.update(frame(560));
    const depths: number[] = [];
    for (let t = 580; t <= 860; t += 40) {
      const turn = translated(t, -0.04, 0.06);
      turn.lm[LM.L_SHOULDER].z = 0.3;
      r = tracker.update(turn);
      depths.push(r.root.z);
    }
    expect(r).toMatchObject({
      valid: true,
      depthValid: false,
      reason: "shoulder-yaw",
    });
    expect(r.root.x).toBeCloseTo(0.08);
    expect(r.root.y).toBeLessThan(0);
    // No depth was invented on the way, before or after the turn was recognised.
    for (const z of depths) expect(z).toBeCloseTo(0);
    // Facing the camera again, for as long: depth is believed again.
    for (let t = 900; t <= 1180; t += 40) r = tracker.update(frame(t));
    expect(r).toMatchObject({
      valid: true,
      depthValid: true,
    });
  });
  it("does not take one noisy depth reading of a shoulder for a turn", () => {
    const tracker = ready();
    tracker.update(frame(560));
    const jolt = frame(580);
    jolt.lm[LM.L_SHOULDER].z = 0.3;
    expect(tracker.update(jolt)).toMatchObject({ valid: true, depthValid: true });
    expect(tracker.update(frame(620))).toMatchObject({ valid: true, depthValid: true });
  });
  it("still requires a frontal view to establish the initial scale", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    for (let i = 0; i < 24; i++) {
      const f = frame(100 + i * 40);
      f.lm[LM.L_SHOULDER].z = 0.3;
      expect(tracker.update(f)).toMatchObject({
        calibrated: false,
        valid: false,
        reason: "shoulder-yaw",
      });
    }
  });
  it("bounds visual prediction, stops leading once motion stops, and never changes the gameplay sample", () => {
    const tracker = ready();
    tracker.update(translated(580, -0.03));
    const measured = tracker.sample(600);
    const shown = tracker.present(600);
    expect(shown.head.x).toBeGreaterThan(measured.head.x);
    expect(shown.head.x - measured.head.x).toBeLessThanOrEqual(0.06);
    expect(tracker.sample(600).head).toEqual(measured.head);
    tracker.update(translated(620, -0.03));
    expect(tracker.present(640).head).toEqual(tracker.sample(640).head);
    expect(tracker.present(710).head).toEqual(tracker.sample(710).head);
    expect(tracker.present(1000).valid).toBe(false);
  });
  it("keeps the final visual lead within its budget when gameplay amplifies movement", () => {
    const tracker = ready();
    tracker.update(translated(580, -0.03));
    const observed = tracker.sample(610);
    for (const gain of [1, 1.8, 2.5]) {
      const pose = trackedPose(observed, gain);
      const visual = trackedPose(tracker.present(610, 0.06 / gain), gain);
      expect(visual.head.x).toBeGreaterThan(pose.head.x);
      expect(
        Math.hypot(visual.head.x - pose.head.x, visual.head.y - pose.head.y),
      ).toBeLessThanOrEqual(0.060001);
      expect(
        Math.hypot(visual.root.x - pose.root.x, visual.root.y - pose.root.y),
      ).toBeLessThanOrEqual(0.060001);
    }
    expect(tracker.present(610, 0).head).toEqual(observed.head);
    expect(tracker.sample(610).head).toEqual(observed.head);
  });
  it("keeps body motion valid when a wrist disappears or has an invalid projection", () => {
    const tracker = ready();
    const extended = translated(580, -0.05);
    extended.lm[LM.R_WRIST].v = 0.1;
    extended.lm[LM.L_WRIST].x = NaN;
    const r = tracker.update(extended);
    expect(r).toMatchObject({
      valid: true,
      outOfBounds: false,
      leftHandTracked: false,
      rightHandTracked: false,
    });
    expect(r.head.x).toBeCloseTo(0.1);
    expect(validPose(trackedPose(r))).toBe(true);
    expect(tracker.update(frame(620))).toMatchObject({
      leftHandTracked: true,
      rightHandTracked: true,
    });
  });
  it("can establish body calibration without requiring wrists in view", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    for (let i = 0; i <= 18; i++) {
      const f = frame(100 + i * 40);
      f.lm[LM.L_WRIST].v = f.lm[LM.R_WRIST].v = 0;
      tracker.update(f);
    }
    expect(tracker.sample(830)).toMatchObject({
      valid: true,
      calibrated: true,
      rightHandTracked: false,
    });
  });
  it("renders a jump and deep crouch within the shared game height envelope", () => {
    const projectVertical = (t: number, dy: number) => {
      const f = frame(t);
      // Wider camera view leaves sufficient headroom and floor space.
      f.lm.forEach((p) => {
        p.x = 0.5 + (p.x - 0.5) * 0.4;
        p.y = 0.5 + (p.y - 0.5) * 0.4 + dy;
      });
      return f;
    };
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
      smoothingMs: 0,
    });
    for (let i = 0; i <= 18; i++)
      tracker.update(projectVertical(100 + i * 40, 0));
    const jump = tracker.update(projectVertical(860, -0.21));
    expect(jump.head.y).toBeCloseTo(0.7);
    expect(jump.outOfBounds).toBe(false);
    expect(validPose(trackedPose(jump))).toBe(true);
    // From the top of a jump to a deep crouch in one pose is not believed until
    // a second pose agrees (the glitch gate); this test is about the range.
    expect(tracker.update(projectVertical(900, 0.24)).held).toBe(true);
    const crouch = tracker.update(projectVertical(940, 0.24));
    expect(crouch.head.y).toBeCloseTo(-0.8);
    expect(crouch.outOfBounds).toBe(false);
    expect(validPose(trackedPose(crouch))).toBe(true);
  });
  it("preserves a fresh body rejection reason instead of overwriting it with stale", () => {
    const tracker = ready();
    const cropped = frame(1000);
    cropped.lm[LM.L_HIP].v = 0;
    tracker.update(cropped);
    expect(tracker.sample(1010).reason).toBe("occluded-or-invalid-landmark");
    expect(tracker.sample(1300).reason).toBe("stale");
  });
  it("automatically establishes a body-relative origin from stable camera updates", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
      smoothingMs: 0,
    });
    expect(tracker.update(frame(100)).reason).toBe("calibrating");
    for (let i = 1; i <= 9; i++) tracker.update(frame(100 + i * 40));
    const halfway = tracker.sample(470);
    expect(halfway.calibrated).toBe(false);
    expect(halfway.calibrationProgress).toBeGreaterThan(0.4);
    expect(halfway.calibrationProgress).toBeLessThan(0.6);
    for (let i = 10; i <= 18; i++) tracker.update(frame(100 + i * 40));
    expect(tracker.sample(830)).toMatchObject({
      valid: true,
      calibrated: true,
      units: "game",
      calibrationProgress: 1,
    });
    // Normal movement must retain the original center, never auto-recenter.
    expect(tracker.update(translated(860, -0.05)).root.x).toBeCloseTo(0.1);
    expect(tracker.update(translated(900, -0.05)).root.x).toBeCloseTo(0.1);
  });
  it("restarts automatic progress when the player moves, then finishes once still", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    for (let i = 0; i <= 9; i++) tracker.update(frame(100 + i * 40));
    // One frame out of place is treated as a stray: progress is kept.
    const stray = tracker.update(translated(500, 0.1));
    expect(stray.calibrated).toBe(false);
    expect(stray.calibrationProgress).toBeGreaterThan(0.5);
    // Out of place for more than a tenth of a second means the player moved:
    // setup starts again from there.
    tracker.update(translated(540, 0.1));
    tracker.update(translated(580, 0.1));
    const moved = tracker.update(translated(620, 0.1));
    expect(moved.calibrated).toBe(false);
    expect(moved.calibrationProgress).toBeLessThan(0.2);
    for (let i = 1; i <= 18; i++) tracker.update(translated(620 + i * 40, 0.1));
    const settled = tracker.sample(1350);
    expect(settled.valid).toBe(true);
    // The saved neutral position is where they stopped, not where they started.
    expect(Math.abs(settled.root.x)).toBeLessThan(0.01);
  });
  it("does not auto-calibrate stale, cropped, or repeated observations", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    expect(tracker.update(frame(100), 1000).reason).toBe("stale");
    const cropped = frame(1000);
    cropped.lm[LM.L_HIP].v = 0.1;
    expect(tracker.update(cropped).reason).toBe("occluded-or-invalid-landmark");
    tracker.update(frame(1040));
    expect(tracker.update(frame(1040)).reason).toBe("non-monotonic-frame");
    expect(tracker.sample(1050)).toMatchObject({
      calibrated: false,
      calibrationProgress: 0,
    });
  });
  it("preserves the automatic origin after tracking loss but re-establishes it after explicit reset", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
      smoothingMs: 0,
    });
    for (let i = 0; i <= 18; i++) tracker.update(frame(100 + i * 40));
    expect(tracker.sample(1200)).toMatchObject({
      valid: false,
      calibrated: true,
    });
    expect(tracker.update(translated(1240, -0.05)).root.x).toBeCloseTo(0.1);
    tracker.reset();
    expect(tracker.update(translated(1280, -0.05))).toMatchObject({
      calibrated: false,
      reason: "calibrating",
    });
    for (let i = 1; i <= 18; i++)
      tracker.update(translated(1280 + i * 40, -0.05));
    expect(tracker.sample(2010).root.x).toBeCloseTo(0);
  });
  it("automatically repeats setup when camera framing changes", () => {
    const tracker = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    for (let i = 0; i <= 18; i++) tracker.update(frame(100 + i * 40));
    const portrait = (t: number) => ({ ...frame(t), imageAspect: 3 / 2 });
    expect(tracker.update(portrait(860))).toMatchObject({
      calibrated: false,
      valid: false,
    });
    for (let i = 1; i <= 18; i++) tracker.update(portrait(860 + i * 40));
    expect(tracker.sample(1590)).toMatchObject({
      calibrated: true,
      valid: true,
    });
  });
  it("preserves the reason a visible camera frame cannot calibrate", () => {
    const tracker = createPovTracker({ shoulderWidthM: 0.4, distanceM: 2 });
    const cropped = frame(100);
    cropped.lm[LM.L_HIP].v = 0.1;
    tracker.calibrate(cropped);
    expect(tracker.sample(110).reason).toBe("occluded-or-invalid-landmark");
  });
  it("keeps calibration progress visible when the render loop polls between camera frames", () => {
    const tracker = createPovTracker({ shoulderWidthM: 0.4, distanceM: 2 });
    tracker.calibrate(frame(100));
    expect(tracker.sample(110).reason).toBe("calibrating");
    for (let i = 1; i < 12; i++) {
      tracker.calibrate(frame(100 + i * 40));
      tracker.sample(110 + i * 40);
    }
    expect(tracker.sample(550).valid).toBe(true);
  });
  it("requires a stable multi-frame calibration and labels missing measurements normalized", () => {
    const tracker = createPovTracker();
    expect(tracker.calibrate(frame()).calibrated).toBe(false);
    for (let i = 1; i < 12; i++) tracker.calibrate(frame(100 + i * 40));
    const r = tracker.sample(540);
    expect(r.valid).toBe(true);
    expect(r.units).toBe("normalized");
    expect(r.head.x).toBeCloseTo(0);
    expect(r.root.z).toBeCloseTo(0);
    expect(ready({ distanceM: undefined }).sample(540).units).toBe(
      "normalized",
    );
  });
  it("resets calibration accumulation when the body is moving", () => {
    const tracker = createPovTracker({ shoulderWidthM: 0.4, distanceM: 2 });
    for (let i = 0; i < 11; i++) tracker.calibrate(frame(100 + i * 40));
    expect(tracker.calibrate(translated(540, 0.1)).calibrated).toBe(false);
  });
  it("maps unmirrored image movement to player-right with aspect-correct scale, without lanes", () => {
    const tracker = ready();
    const a = tracker.update(translated(580, -0.05));
    expect(a.units).toBe("meters");
    expect(a.root.x).toBeCloseTo(0.1);
    expect(a.head.x).toBeCloseTo(0.1);
    expect(a.headRelativeTorso.x).toBeCloseTo(0);
    const b = tracker.update(translated(620, -0.051));
    expect(b.root.x).toBeCloseTo(0.102);
    expect(b.root.z).toBeCloseTo(0);
    expect(b.leftHand.x).toBeCloseTo(-0.3);
    expect(b.rightHand.x).toBeCloseTo(0.3);
    expect(b.leftHand.y).toBeCloseTo((0.2 * 0.4) / 0.3);
  });
  it("separates head lean from whole-body root translation", () => {
    const tracker = ready();
    const f = frame(580);
    f.lm[LM.NOSE].x -= 0.06;
    const r = tracker.update(f);
    expect(r.root.x).toBeCloseTo(0);
    expect(r.root.z).toBeCloseTo(0);
    expect(r.head.x).toBeCloseTo(0.12);
    expect(r.headRelativeTorso.x).toBeCloseTo(0.12);
  });
  it("recovers the same physical displacement in portrait and landscape H/W frames", () => {
    const project = (
      t: number,
      width: number,
      height: number,
      rootX = 0,
      rootY = 0,
      leanX = 0,
    ): PoseFrame => {
      const f = frame(t);
      f.imageAspect = height / width;
      const p = (x: number, y: number) => ({
        x: 0.5 - ((x + rootX) * 1000) / (width * 2),
        y: 0.5 - ((y + rootY) * 1000) / (height * 2),
        z: 0,
        v: 0.95,
      });
      f.lm[LM.L_SHOULDER] = p(-0.2, 0.4);
      f.lm[LM.R_SHOULDER] = p(0.2, 0.4);
      f.lm[LM.L_HIP] = p(-0.1, 0);
      f.lm[LM.R_HIP] = p(0.1, 0);
      f.lm[LM.NOSE] = p(leanX, 0.7);
      f.lm[LM.L_WRIST] = p(-0.3, 0.2);
      f.lm[LM.R_WRIST] = p(0.3, 0.2);
      return f;
    };
    for (const [width, height] of [
      [1600, 900],
      [900, 1600],
    ]) {
      const tracker = createPovTracker({
        shoulderWidthM: 0.4,
        distanceM: 2,
        smoothingMs: 0,
      });
      for (let i = 0; i < 12; i++)
        tracker.calibrate(project(100 + i * 40, width, height));
      const r = tracker.update(project(580, width, height, 0.1, 0.04, 0.03));
      expect(r.valid).toBe(true);
      expect(r.root.x).toBeCloseTo(0.1);
      expect(r.root.y).toBeCloseTo(0.04);
      expect(r.head.x).toBeCloseTo(0.13);
      expect(r.head.y).toBeCloseTo(0.04);
      expect(r.headRelativeTorso.x).toBeCloseTo(0.03);
      expect(r.leftHand.x).toBeCloseTo(-0.3);
      expect(r.leftHand.y).toBeCloseTo(0.2);
    }
  });
  it("estimates modest fore/aft from perspective scale while removing apparent lateral and vertical drift", () => {
    const tracker = ready();
    const f = frame(580);
    f.lm.forEach((p) => {
      p.x = 0.5 + (p.x - 0.5) * 1.1;
      p.y = 0.5 + (p.y - 0.5) * 1.1;
      p.z *= 1.1;
    });
    const r = tracker.update(f);
    expect(r.valid).toBe(true);
    expect(r.depthValid).toBe(true);
    expect(r.root.z).toBeCloseTo(2 - 2 / 1.1);
    expect(r.root.x).toBeCloseTo(0);
    expect(r.root.y).toBeCloseTo(0);
    expect(r.headRelativeTorso.y).toBeCloseTo(0);
  });
  it("suspends depth during shoulder yaw instead of interpreting foreshortening as backward movement", () => {
    const tracker = ready();
    let r = tracker.update(frame(560));
    // Held for a quarter of a second: that is how long a turn takes to be believed.
    for (let t = 580; t <= 860; t += 40) {
      const f = frame(t);
      f.lm[LM.L_SHOULDER].x = 0.57;
      f.lm[LM.R_SHOULDER].x = 0.43;
      f.lm[LM.L_SHOULDER].z = 0.08;
      f.lm[LM.R_SHOULDER].z = -0.08;
      r = tracker.update(f);
      // Narrower shoulders are never read as a step back: the torso's length has not changed.
      expect(r.root.z).toBeCloseTo(0);
    }
    expect(r.valid).toBe(true);
    expect(r.depthValid).toBe(false);
    expect(r.reason).toBe("shoulder-yaw");
  });
  it("rejects abrupt shoulder span jumps and aspect changes", () => {
    const tracker = ready();
    const f = frame(580);
    f.lm[LM.L_SHOULDER].x = 0.65;
    f.lm[LM.R_SHOULDER].x = 0.35;
    expect(tracker.update(f).reason).toBe("shoulder-span-jump");
    const g = frame(620);
    g.imageAspect = 1;
    expect(tracker.update(g).reason).toBe("aspect-changed-recalibrate");
  });
  it("reports raw boundary crossings immediately even with smoothing", () => {
    const tracker = ready({ smoothingMs: 100 });
    const r = tracker.update(translated(580, -0.32));
    expect(r.outOfBounds).toBe(true);
    expect(r.reason).toBe("out-of-bounds");
    expect(Math.abs(r.root.x)).toBeLessThanOrEqual(0.6);
  });
  it("smooths causally without changing the eventual gain or predicting future motion", () => {
    const tracker = ready({ smoothingMs: 35 });
    const first = tracker.update(translated(580, -0.05));
    expect(first.root.x).toBeGreaterThan(0);
    expect(first.root.x).toBeLessThan(0.1);
    for (let i = 1; i <= 20; i++)
      tracker.update(translated(580 + i * 40, -0.05));
    const final = tracker.sample(1380);
    expect(final.root.x).toBeCloseTo(0.1, 6);
    expect(tracker.sample(1400).root.x).toBe(final.root.x);
  });
  it("invalidates stale, non-monotonic, NaN and occluded input and does not extrapolate", () => {
    const tracker = ready();
    const before = tracker.update(translated(580, -0.05));
    const stale = tracker.sample(840);
    expect(stale.valid).toBe(false);
    expect(stale.reason).toBe("stale");
    expect(stale.root).toEqual(before.root);
    const bad = frame(880);
    bad.lm[LM.NOSE].x = NaN;
    expect(tracker.update(bad).valid).toBe(false);
    const hidden = frame(920);
    hidden.lm[LM.L_WRIST].v = 0.1;
    expect(tracker.update(hidden)).toMatchObject({
      valid: true,
      leftHandTracked: false,
    });
    expect(tracker.update(frame(960)).valid).toBe(true);
    expect(tracker.update(frame(960)).reason).toBe("non-monotonic-frame");
    expect(tracker.update(frame(1000), 1300).reason).toBe("stale");
  });
  it("uses world data only for relative wrist depth/yaw, never absolute room translation", () => {
    const tracker = ready();
    const make = (t: number, offset: number) => {
      const f = frame(t);
      f.world = f.lm.map((p) => ({
        x: (p.x - 0.5) * 2 + offset,
        y: p.y + offset,
        z: offset,
        v: 1,
      }));
      f.world[LM.L_WRIST].z -= 0.3;
      f.world[LM.R_WRIST].z -= 0.2;
      return f;
    };
    const a = tracker.update(make(580, 0)),
      b = tracker.update(make(620, 100));
    expect(b.root.x).toBeCloseTo(0);
    expect(b.root.z).toBeCloseTo(0);
    expect(b.leftHand.z).toBeCloseTo(0.3);
    expect(b.rightHand.z).toBeCloseTo(0.2);
    expect(b.head).toEqual(a.head);
  });
  it("returns snapshots that callers cannot mutate and resets all calibration state", () => {
    const tracker = ready();
    const r = tracker.sample(540);
    r.root.x = 100;
    expect(tracker.sample(550).root.x).toBeCloseTo(0);
    tracker.reset();
    expect(tracker.update(frame(1000)).calibrated).toBe(false);
    expect(() => createPovTracker({ shoulderWidthM: NaN })).toThrow();
  });
  it("requires another stable window for recentering and bounds hand outliers", () => {
    const tracker = ready();
    const f = frame(580);
    f.lm[LM.L_WRIST].z = -2;
    const r = tracker.update(f);
    expect(r.outOfBounds).toBe(false);
    expect(r.leftHandTracked).toBe(false);
    expect(r.leftHand.z).toBeLessThanOrEqual(1.5);
    const recenter = tracker.calibrate(frame(620));
    expect(recenter.calibrated).toBe(false);
    expect(recenter.reason).toBe("calibrating");
  });
  describe("the drawn view", () => {
    const seeded = (seed: number) => {
      let state = seed >>> 0 || 1;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
    };
    /** 28 poses a second arriving 45 ms late, drawn at 60 Hz, as on the measured Mac. */
    function draw(
      motion: (seconds: number) => number,
      noise?: number,
      lead: Parameters<ReturnType<typeof createPovTracker>["predict"]>[1] = {},
    ): { drawn: number[]; measured: number[] } {
      const random = noise === undefined ? null : seeded(noise);
      const gauss = () => {
        let sum = 0;
        for (let i = 0; i < 6; i++) sum += random!();
        return (sum - 3) * Math.SQRT2;
      };
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
      });
      const step = 1000 / 28,
        delay = 45;
      const observe = (t: number, x: number) => {
        const f = syntheticFrame(t, { step: x });
        if (!random) return f;
        return {
          ...f,
          lm: f.lm.map((p) => ({
            ...p,
            x: p.x + gauss() * 0.0016,
            y: p.y + gauss() * 0.0016,
            z: p.z + gauss() * 0.012,
          })),
          world: f.world!.map((p) => ({ ...p, z: p.z + gauss() * 0.03 })),
        };
      };
      let t = 1000;
      for (let i = 0, ok = 0; i < 600 && ok < 10; i++, t += step)
        if (tracker.update(observe(t, 0), t + delay).calibrated) ok++;
      const start = t,
        drawn: number[] = [],
        measured: number[] = [];
      let next = start;
      for (let now = start + delay; now < start + 2200; now += 1000 / 60) {
        while (next + delay <= now) {
          tracker.update(
            observe(next, motion((next - start) / 1000)),
            next + delay,
          );
          next += step;
        }
        drawn.push(tracker.predict(now, lead).head.x);
        measured.push(tracker.sample(now).head.x);
      }
      return { drawn, measured };
    }
    const steps = (values: number[]) =>
      values.slice(1).map((v, i) => Math.abs(v - values[i]));
    const rms = (values: number[]) => {
      const mean = values.reduce((a, v) => a + v, 0) / values.length;
      return Math.sqrt(
        values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length,
      );
    };
    /** The scene's eye blend (scene.ts EYE_BLEND_MS) applied at 60 Hz. */
    const blended = (values: number[]) => {
      const k = 1 - Math.exp(-(1000 / 60) / 18);
      let eye = values[0];
      return values.map((v) => (eye += (v - eye) * k));
    };
    const unevenness = (values: number[]) => {
      const st = steps(values).slice(30);
      const second = st.slice(1).map((v, i) => v - st[i]);
      const typical = st.reduce((a, v) => a + v, 0) / st.length;
      return (
        Math.sqrt(second.reduce((a, v) => a + v * v, 0) / second.length) /
        typical
      );
    };
    const sway = (s: number) => 0.2 * Math.sin(2 * Math.PI * 0.5 * s);
    const restJitter = (
      lead: Parameters<ReturnType<typeof createPovTracker>["predict"]>[1],
      eye: boolean,
    ) => {
      let sum = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const d = draw(() => 0, seed, lead);
        sum +=
          rms((eye ? blended(d.drawn) : d.drawn).slice(30)) /
          rms(d.measured.slice(30));
      }
      return sum / 6;
    };
    it("advances evenly while the player moves, far more so than before", () => {
      const before = unevenness(
        draw(sway, undefined, {
          sinceArrival: false,
          restSpeed: 0.1,
          fraction: 0.5,
        }).drawn,
      );
      const now = unevenness(blended(draw(sway).drawn));
      console.log(
        `view unevenness during a sway: ${before.toFixed(2)} before, ${now.toFixed(2)} now`,
      );
      expect(now).toBeLessThan(0.55);
      expect(now).toBeLessThan(before / 2);
    });
    it("is no shakier than the measurement when the player stands still", () => {
      const before = restJitter(
          { sinceArrival: false, restSpeed: 0.1, fraction: 0.5 },
          false,
        ),
        now = restJitter({}, true);
      console.log(
        `still head, drawn jitter over measured: ${before.toFixed(2)} before, ${now.toFixed(2)} now`,
      );
      expect(now).toBeLessThanOrEqual(1);
      expect(before).toBeGreaterThan(1.1);
    });
    it.skipIf(!process.env.SWEEP)(
      "prints evenness and rest jitter for each lead setting",
      () => {
        const rows = (
          [
            ["no lead", { fraction: 0, sinceArrival: false }],
            [
              "whole age by half, rest 0.1",
              { sinceArrival: false, restSpeed: 0.1, fraction: 0.5 },
            ],
            ["since arrival in full, rest 0.08", { restSpeed: 0.08 }],
            ["since arrival in full, rest 0.12", { restSpeed: 0.12 }],
            ["since arrival in full, rest 0.15", { restSpeed: 0.15 }],
            ["since arrival in full, rest 0.2", { restSpeed: 0.2 }],
            ["since arrival in full, rest 0.25", { restSpeed: 0.25 }],
          ] as const
        ).map(([setting, lead]) => {
          const moving = draw(sway, undefined, lead).drawn;
          return {
            setting,
            unevenness: unevenness(moving).toFixed(2),
            "with eye blend": unevenness(blended(moving)).toFixed(2),
            "rest jitter": restJitter(lead, false).toFixed(2),
            "rest, eye blend": restJitter(lead, true).toFixed(2),
          };
        });
        console.table(rows);
      },
    );
  });
  describe("automatic setup with jittery landmarks", () => {
    it("completes in about a second for a person standing still, every time", () => {
      const times: number[] = [];
      for (let seed = 1; seed <= 60; seed++) {
        let state = seed >>> 0;
        const random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 2 ** 32;
        };
        const gauss = () => {
          let sum = 0;
          for (let i = 0; i < 6; i++) sum += random();
          return (sum - 3) * Math.SQRT2;
        };
        const tracker = createPovTracker({
          automatic: true,
          scaleMode: "body-relative",
        });
        const step = 1000 / 28;
        let t = 1000,
          done = -1;
        for (let i = 0; i < 280 && done < 0; i++, t += step) {
          const f = syntheticFrame(t);
          f.lm = f.lm.map((p) => ({
            ...p,
            x: p.x + gauss() * 0.0016,
            y: p.y + gauss() * 0.0016,
            z: p.z + gauss() * 0.012,
          }));
          if (tracker.update(f, t + 45).calibrated) done = (i + 1) * step;
        }
        times.push(done < 0 ? Infinity : done);
      }
      times.sort((a, b) => a - b);
      console.log(
        `setup time with jitter over 60 runs: median ${(times[30] / 1000).toFixed(2)} s, slowest ${(times[59] / 1000).toFixed(2)} s`,
      );
      // It took from under 1 s to over 7 s when one stray frame restarted it.
      expect(times[59]).toBeLessThan(1500);
    });
    it("still starts over when the person is walking", () => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
      });
      let t = 1000,
        calibrated = false;
      // Walking sideways at 0.5 m/s for two seconds: never still.
      for (let i = 0; i < 56; i++, t += 1000 / 28)
        calibrated ||= tracker.update(
          syntheticFrame(t, { step: -0.5 + (0.5 * i) / 28 }),
          t,
        ).calibrated;
      expect(calibrated).toBe(false);
      // Stops: setup completes at the place they stopped.
      for (let i = 0; i < 40; i++, t += 1000 / 28)
        calibrated ||= tracker.update(
          syntheticFrame(t, { step: 0.5 }),
          t,
        ).calibrated;
      expect(calibrated).toBe(true);
      expect(Math.abs(tracker.sample(t - 1000 / 28).root.x)).toBeLessThan(0.02);
    });
  });
  describe("setting up and re-centring on a real desk", () => {
    it("sets up on the upper body when the hips never come into view", () => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
      });
      // A laptop on a desk, player close: the hips are below the picture.
      const view = { height: 1.75, distance: 1.6 };
      let t = 1000,
        calibratedAt = -1;
      for (let i = 0; i < 120 && calibratedAt < 0; i++, t += 33) {
        const frame = syntheticFrame(t, {}, 1, view);
        expect(frame.lm[LM.L_HIP].y).toBeGreaterThan(1);
        if (tracker.update(frame, t).calibrated) calibratedAt = t - 1000;
      }
      // 1.5 s of waiting for hips, then the usual 0.7 s of standing still.
      expect(calibratedAt).toBeGreaterThan(1500);
      expect(calibratedAt).toBeLessThan(3000);
      // Play continues without hips: a sidestep is followed, a duck does not stop it.
      let last = tracker.sample(t - 33);
      expect(last).toMatchObject({ valid: true, inferred: ["hips"] });
      for (let i = 0; i < 20; i++, t += 33)
        last = tracker.update(
          syntheticFrame(t, { step: 0.01 * i, crouch: 0.01 * i }, 1, view),
          t,
        );
      expect(last.valid).toBe(true);
      expect(last.root.x).toBeGreaterThan(0.15);
      expect(last.root.y).toBeLessThan(-0.1);
    });
    it("does not skip the hips while they are merely slow to appear", () => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
      });
      let t = 1000;
      // Hips missing for a second (walking back), then in view.
      for (let i = 0; i < 30; i++, t += 33)
        tracker.update(
          syntheticFrame(t, {}, 1, { height: 1.75, distance: 1.6 }),
          t,
        );
      let result = tracker.sample(t - 33);
      expect(result.calibrated).toBe(false);
      for (let i = 0; i < 30; i++, t += 33)
        result = tracker.update(syntheticFrame(t), t);
      expect(result.calibrated).toBe(true);
      expect(result.inferred).toBeUndefined();
    });
    it("takes a new centre on the spot without going through setup", () => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
        smoothingMs: 0,
      });
      let t = 1000;
      for (let i = 0; i < 40; i++, t += 33)
        tracker.update(syntheticFrame(t), t);
      // Walks half a metre to the side and back a little, then stands.
      let moved = tracker.sample(t - 33);
      for (let i = 0; i < 20; i++, t += 33)
        moved = tracker.update(
          syntheticFrame(t, { step: 0.5 }, 1, { distance: 3 }),
          t,
        );
      expect(Math.abs(moved.root.x)).toBeGreaterThan(0.4);
      expect(tracker.recenter()).toBe(true);
      const centred = tracker.update(
        syntheticFrame(t, { step: 0.5 }, 1, { distance: 3 }),
        t,
      );
      // Still set up, still tracked, and now at the centre.
      expect(centred).toMatchObject({
        valid: true,
        calibrated: true,
        outOfBounds: false,
      });
      expect(Math.abs(centred.root.x)).toBeLessThan(0.02);
      expect(Math.abs(centred.root.z)).toBeLessThan(0.02);
      // A step from the new centre reads as a step.
      t += 33;
      let stepped = centred;
      for (let i = 0; i < 4; i++, t += 33)
        stepped = tracker.update(
          syntheticFrame(t, { step: 0.5 + 0.05 * (i + 1) }, 1, { distance: 3 }),
          t,
        );
      expect(stepped.root.x).toBeGreaterThan(0.15);
    });
    it("has nothing to centre on before setup", () => {
      expect(
        createPovTracker({
          automatic: true,
          scaleMode: "body-relative",
        }).recenter(),
      ).toBe(false);
    });
  });
  describe("body size and wrists under real movement", () => {
    const live = () => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
        smoothingMs: 0,
      });
      let t = 1000;
      const see = (motion: Parameters<typeof syntheticFrame>[1] = {}) => {
        t += 33;
        return tracker.update(syntheticFrame(t, motion), t);
      };
      for (let i = 0; i < 40; i++) see();
      return see;
    };
    it("does not back the camera away or grow the body when the shoulders turn", () => {
      const see = live();
      const square = see();
      let worstDepth = 0,
        worstHeight = 0;
      // Up to 0.33 rad: under the angle at which depth is suspended anyway.
      for (let i = 1; i <= 12; i++) {
        const turned = see({ twist: 0.0275 * i });
        worstDepth = Math.max(worstDepth, Math.abs(turned.root.z));
        worstHeight = Math.max(
          worstHeight,
          Math.abs(turned.head.y - square.head.y),
        );
      }
      // It was 0.11 back and 5.5% taller at 0.33 rad.
      expect(worstDepth).toBeLessThan(0.03);
      expect(worstHeight).toBeLessThan(0.012);
    });
    it("still reads a real step toward or away from the camera", () => {
      const see = live();
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
        smoothingMs: 0,
      });
      let t = 1000;
      for (let i = 0; i < 40; i++, t += 33)
        tracker.update(syntheticFrame(t), t);
      let nearer = tracker.sample(t - 33);
      for (let i = 1; i <= 6; i++, t += 33)
        nearer = tracker.update(
          syntheticFrame(t, {}, 1, { distance: 2.6 - 0.03 * i }),
          t,
        );
      expect(nearer.root.z).toBeGreaterThan(0.1);
      void see;
    });
    it("keeps hold of a wrist whose visibility hovers at the threshold", () => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
      });
      let t = 1000;
      for (let i = 0; i < 40; i++, t += 33)
        tracker.update(syntheticFrame(t), t);
      let flips = 0,
        last = true;
      for (let i = 0; i < 30; i++, t += 33) {
        const frame = syntheticFrame(t, {
          rightHand: { x: 0.14, y: 0.12, z: -0.18 },
        });
        frame.lm[LM.R_WRIST] = {
          ...frame.lm[LM.R_WRIST],
          v: i % 2 ? 0.62 : 0.58,
        };
        const tracked = tracker.update(frame, t).rightHandTracked !== false;
        if (tracked !== last) flips++;
        last = tracked;
      }
      // It flipped on every one of the 30 poses.
      expect(flips).toBe(0);
      // A wrist that is really gone is still let go.
      const gone = syntheticFrame(t, {});
      gone.lm[LM.R_WRIST] = { ...gone.lm[LM.R_WRIST], v: 0.2 };
      expect(tracker.update(gone, t).rightHandTracked).toBe(false);
    });
  });
  describe("one-frame glitches", () => {
    const live = () =>
      ready({
        automatic: true,
        scaleMode: "body-relative",
        calibrationMinMs: 400,
      });
    it("does not move the body for a pose that jumps away for one frame and comes back", () => {
      const tracker = live();
      const before = tracker.update(frame(580));
      // The detector lands on something 30% of the image away, once.
      const glitch = tracker.update(translated(616, -0.3));
      expect(glitch).toMatchObject({ valid: true, held: true });
      expect(glitch.root.x).toBeCloseTo(before.root.x, 6);
      const after = tracker.update(frame(652));
      expect(after).toMatchObject({ valid: true, held: false });
      expect(Math.abs(after.root.x - before.root.x)).toBeLessThan(0.01);
    });
    it("believes a jump that a second pose confirms", () => {
      const tracker = live();
      tracker.update(frame(580));
      expect(tracker.update(translated(616, -0.3)).held).toBe(true);
      const moved = tracker.update(translated(652, -0.3));
      expect(moved).toMatchObject({ valid: true, held: false });
      expect(moved.root.x).toBeGreaterThan(0.3);
    });
    it("leaves a hard real dodge alone", () => {
      const tracker = live();
      let held = 0;
      // 2.5 game units a second, 28 poses a second.
      for (let i = 1; i <= 8; i++) {
        const result = tracker.update(
          translated(580 + i * 36, -0.0113 * i),
          580 + i * 36,
        );
        if (result.held) held++;
      }
      expect(held).toBe(0);
    });
  });
  describe("when the camera cannot see the whole upper body", () => {
    /** Game units per metre for the scripted person. */
    const K = 0.4 / (2 * PERSON.shoulderHalf);
    /** The scripted person seen by a camera at `height`, calibrated standing still. */
    const framed = (height: number) => {
      const tracker = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
        smoothingMs: 0,
      });
      let t = 1000;
      const see = (crouch = 0, jump = 0) => {
        t += 33;
        return tracker.update(
          syntheticFrame(t, { crouch, jump }, 1, { height }),
          t,
        );
      };
      for (let i = 0; i < 40; i++) see();
      expect(tracker.sample(t).calibrated).toBe(true);
      return see;
    };
    it("keeps playing through a duck that takes the hips below the frame", () => {
      // A laptop on a desk: the standing hips are 14 cm above the bottom edge.
      const see = framed(2);
      const standing = see();
      expect(standing).toMatchObject({ valid: true });
      expect(standing.inferred).toBeUndefined();
      let invalid = 0,
        deepest = standing;
      for (let i = 0; i <= 30; i++) {
        const result = see(0.32 * Math.sin((Math.PI * i) / 30));
        if (!result.valid) invalid++;
        if (result.root.y < deepest.root.y) deepest = result;
      }
      expect(invalid).toBe(0);
      expect(deepest.inferred).toEqual(["hips"]);
      // The hips really dropped 32 cm; placed from the shoulders they read a
      // little lower, because the torso tips forward in a crouch.
      expect(deepest.root.y).toBeLessThan(-0.3 * K);
      expect(deepest.root.y).toBeGreaterThan(-0.42 * K);
      // Back up: the real hips are used again.
      const up = see();
      expect(up.inferred).toBeUndefined();
      expect(Math.abs(up.root.y)).toBeLessThan(0.02);
    });
    it("keeps playing through a jump that takes the head above the frame", () => {
      // Camera low and close to the top of the head: a jump leaves the frame.
      const see = framed(0.52);
      expect(see().inferred).toBeUndefined();
      let invalid = 0,
        seen: string[] = [];
      for (let i = 0; i <= 20; i++) {
        const result = see(0, 0.3 * Math.sin((Math.PI * i) / 20));
        if (!result.valid) invalid++;
        if (result.inferred) seen = result.inferred;
      }
      expect(invalid).toBe(0);
      expect(seen).toEqual(["head"]);
    });
    it("still needs the shoulders, and still needs the whole upper body for setup", () => {
      const see = framed(2);
      // Shoulders gone as well: nothing to stand on once the short hold runs out.
      let last = see(1.2);
      for (let i = 0; i < 10; i++) last = see(1.2);
      expect(last.valid).toBe(false);
      const fresh = createPovTracker({
        automatic: true,
        scaleMode: "body-relative",
      });
      let t = 1000;
      let calibrated = false;
      for (let i = 0; i < 60; i++, t += 33)
        calibrated ||= fresh.update(
          syntheticFrame(t, { crouch: 0.32 }, 1, { height: 2 }),
          t,
        ).calibrated;
      expect(calibrated).toBe(false);
    });
  });
});

describe("who and where the tracker sets up for", () => {
  const STEP = 33;
  const make = () =>
    createPovTracker({ automatic: true, scaleMode: "body-relative" });
  /** Feed the scripted person for `ms`; returns the last result and the time. */
  const run = (
    tracker: ReturnType<typeof make>,
    from: number,
    ms: number,
    view: { distance?: number; height?: number } = {},
    motion: SyntheticMotion = {},
  ) => {
    let t = from,
      result = tracker.sample(t);
    for (; t < from + ms; t += STEP)
      result = tracker.update(syntheticFrame(t, motion, 1, view), t);
    return { result, t };
  };
  const gone = (tracker: ReturnType<typeof make>, from: number, ms: number) => {
    let t = from;
    for (; t < from + ms; t += STEP) {
      const frame = syntheticFrame(t);
      frame.lm = frame.lm.map((p) => ({ ...p, v: 0.05 }));
      tracker.update(frame, t);
    }
    return t;
  };

  it("takes the same player back at once after a loss, a little nearer or further", () => {
    for (const distance of [2.6, 2.3, 3.1]) {
      const tracker = make();
      const set = run(tracker, 1000, 1500);
      expect(set.result.valid).toBe(true);
      const back = gone(tracker, set.t, 800);
      expect(tracker.sample(back).valid).toBe(false);
      const again = run(tracker, back, 200, { distance });
      expect(again.result.valid).toBe(true);
      expect(again.result.reason).not.toBe("different-person");
    }
  });

  it("does not play a body of another size that appears after a loss, then sets up for it if it stays", () => {
    const tracker = make();
    const set = run(tracker, 1000, 1500);
    const back = gone(tracker, set.t, 800);
    // Someone twice as far away: half the size in the picture.
    const other = run(tracker, back, 1000, { distance: 5.2 });
    expect(other.result.valid).toBe(false);
    expect(other.result.reason).toBe("different-person");
    // The player steps back in before the stranger is adopted.
    const mine = run(tracker, other.t, 200);
    expect(mine.result.valid).toBe(true);
    // A stranger who stays is the player now: a fresh setup, then play.
    const back2 = gone(tracker, mine.t, 800);
    const stays = run(tracker, back2, 4000, { distance: 5.2 });
    expect(stays.result.valid).toBe(true);
    expect(stays.result.calibrated).toBe(true);
  });

  it("waits for a player standing off to one side before locking setup, but not for ever", () => {
    // Shifted well to the side of the picture.
    const side: SyntheticMotion = { step: 1 };
    const frame = syntheticFrame(0, side);
    const mid = (frame.lm[11].x + frame.lm[12].x) / 2;
    expect(mid < 0.3 || mid > 0.7).toBe(true);
    const tracker = make();
    const early = run(tracker, 1000, 2500, {}, side);
    expect(early.result.calibrated).toBe(false);
    expect(early.result.reason).toBe("calibrating");
    // They walk to the middle: setup completes there, promptly.
    const centred = run(tracker, early.t, 1500);
    expect(centred.result.calibrated).toBe(true);
    expect(Math.abs(centred.result.root.x)).toBeLessThan(0.05);
    // Someone who never moves is not left waiting.
    const stuck = make();
    expect(run(stuck, 1000, 6000, {}, side).result.calibrated).toBe(true);
  });
});
