import { describe, expect, it } from "vitest";
import {
  BODY,
  JOINT,
  JOINT_COUNT,
  blendBody,
  bodyOf,
  length,
  solveBody,
  sub,
  twoBone,
  validBody,
} from "./body";
import { blendPose, botPose, copyPose, neutralPose, validPose } from "./duel";

const dist = (a: { x: number; y: number; z: number }, b: typeof a) =>
  length(sub(a, b));

describe("solved avatar body", () => {
  it("lands the head and wrists exactly on the gameplay points", () => {
    const pose = neutralPose();
    const body = solveBody(pose);
    expect(body).toHaveLength(JOINT_COUNT);
    expect(body[JOINT.NOSE]).toEqual(pose.head);
    expect(body[JOINT.L_WRIST]).toEqual(pose.leftHand);
    expect(body[JOINT.R_WRIST]).toEqual(pose.rightHand);
    expect(validBody(body, pose.root)).toBe(true);
    // Anatomical left is the player's -x side.
    expect(body[JOINT.L_SHOULDER].x).toBeLessThan(body[JOINT.R_SHOULDER].x);
    expect(body[JOINT.L_HIP].x).toBeLessThan(body[JOINT.R_HIP].x);
  });
  it("stands on the floor with rigid legs and a small knee bend", () => {
    const body = solveBody(neutralPose());
    for (const i of [0, 1]) {
      const hip = body[JOINT.L_HIP + i],
        knee = body[JOINT.L_KNEE + i],
        ankle = body[JOINT.L_ANKLE + i];
      expect(ankle.y).toBeCloseTo(BODY.ankle);
      expect(dist(hip, knee)).toBeCloseTo(BODY.thigh);
      expect(dist(knee, ankle)).toBeCloseTo(BODY.shin);
      expect(knee.z).toBeGreaterThan(hip.z);
      expect(body[JOINT.L_TOE + i].y).toBeGreaterThan(0);
    }
  });
  it("bends the knees forward in a crouch and lifts the feet in a jump", () => {
    const crouch = neutralPose();
    crouch.root.y = 0.55;
    crouch.head.y = 1.15;
    crouch.leftHand.y -= 0.45;
    crouch.rightHand.y -= 0.45;
    const low = solveBody(crouch);
    for (const i of [0, 1]) {
      expect(low[JOINT.L_ANKLE + i].y).toBeCloseTo(BODY.ankle);
      expect(low[JOINT.L_KNEE + i].z).toBeGreaterThan(0.25);
      expect(dist(low[JOINT.L_HIP + i], low[JOINT.L_KNEE + i])).toBeCloseTo(
        BODY.thigh,
      );
    }
    const jump = neutralPose();
    jump.root.y = 1.3;
    jump.head.y = 1.95;
    const high = solveBody(jump);
    expect(high[JOINT.L_ANKLE].y).toBeCloseTo(BODY.ankle + 0.3, 1);
  });
  it("keeps the arm bones rigid within reach and stretches only beyond it", () => {
    const pose = neutralPose();
    pose.leftHand = { x: -0.3, y: 1.3, z: 0.25 };
    const body = solveBody(pose);
    expect(dist(body[JOINT.L_SHOULDER], body[JOINT.L_ELBOW])).toBeCloseTo(
      BODY.upperArm,
    );
    expect(dist(body[JOINT.L_ELBOW], body[JOINT.L_WRIST])).toBeCloseTo(
      BODY.foreArm,
    );
    // The training bot's release reaches far past arm's length.
    const reach = botPose(3, 0.05);
    const thrown = solveBody(reach);
    expect(thrown[JOINT.R_WRIST]).toEqual(reach.rightHand);
    expect(validBody(thrown, reach.root)).toBe(true);
    expect(thrown[JOINT.R_SHOULDER].z).toBeGreaterThan(0);
  });
  it("solves a two-bone chain to exact lengths on the pole side", () => {
    const a = { x: 0, y: 1, z: 0 },
      c = { x: 0, y: 0.4, z: 0 };
    const mid = twoBone(a, c, 0.4, 0.35, { x: 0, y: 0, z: 1 });
    expect(dist(a, mid)).toBeCloseTo(0.4);
    expect(dist(mid, c)).toBeCloseTo(0.35);
    expect(mid.z).toBeGreaterThan(0);
    const far = twoBone(a, { x: 0, y: -1, z: 0 }, 0.4, 0.35, { x: 0, y: 0, z: 1 });
    expect(far.z).toBeCloseTo(0);
    expect(far.y).toBeLessThan(1);
  });
});

describe("skeleton on the pose", () => {
  it("accepts a pose without a body and rejects a malformed one", () => {
    const pose = neutralPose();
    expect(validPose(pose)).toBe(true);
    expect(validPose({ ...pose, body: solveBody(pose) })).toBe(true);
    expect(validPose({ ...pose, body: solveBody(pose).slice(1) })).toBe(false);
    const broken = solveBody(pose);
    broken[JOINT.L_KNEE].y = NaN;
    expect(validPose({ ...pose, body: broken })).toBe(false);
    const far = solveBody(pose);
    far[JOINT.R_ELBOW].x = 9;
    expect(validPose({ ...pose, body: far })).toBe(false);
  });
  it("draws the tracked skeleton when present and the solved one otherwise", () => {
    const pose = neutralPose();
    expect(bodyOf(pose)).toEqual(solveBody(pose));
    const body = solveBody(pose);
    body[JOINT.R_ELBOW].y += 0.2;
    expect(bodyOf({ ...pose, body })[JOINT.R_ELBOW].y).toBe(
      body[JOINT.R_ELBOW].y,
    );
  });
  it("blends and copies the skeleton without sharing references", () => {
    const a = { ...neutralPose(), body: solveBody(neutralPose()) };
    const moved = neutralPose();
    moved.root.x = moved.head.x = 0.4;
    const b = { ...moved, body: solveBody(moved) };
    const half = blendPose(a, b, 0.5);
    expect(half.root.x).toBeCloseTo(0.2);
    expect(half.body![JOINT.L_HIP].x).toBeCloseTo(
      (a.body[JOINT.L_HIP].x + b.body[JOINT.L_HIP].x) / 2,
    );
    // A pose that has no skeleton yet adopts the newer one instead of dropping it.
    expect(blendPose(neutralPose(), b, 0.25).body).toEqual(b.body);
    expect(blendPose(a, neutralPose(), 0.25).body).toEqual(a.body);
    expect(blendBody(undefined, undefined, 0.5)).toBeUndefined();
    const copy = copyPose(a);
    copy.body![0].x = 99;
    expect(a.body[0].x).not.toBe(99);
    expect(copyPose(neutralPose()).body).toBeUndefined();
  });
});
