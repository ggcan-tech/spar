import { describe, expect, it } from "vitest";
import { neutralPose } from "./duel";
import { cameraKick, flinch } from "./impact";

describe("hit response", () => {
  it("kicks the camera back and away from the struck side, then settles", () => {
    const start = cameraKick(0, 1);
    expect(start.back).toBeCloseTo(0.07);
    expect(start.roll).toBeLessThan(0);
    expect(cameraKick(0, -1).roll).toBeGreaterThan(0);
    expect(cameraKick(90, 1).back).toBeLessThan(start.back / 2);
    expect(cameraKick(600, 1)).toEqual({ back: 0, roll: 0 });
    expect(cameraKick(-5, 1)).toEqual({ back: 0, roll: 0 });
    expect(cameraKick(Number.NaN, 1)).toEqual({ back: 0, roll: 0 });
  });

  it("recoils the opponent from exactly their pose and returns them to it", () => {
    const pose = neutralPose();
    expect(flinch(pose, 0)).toEqual(pose);
    const peak = flinch(pose, 60);
    expect(peak.head.z).toBeCloseTo(pose.head.z - 0.2);
    expect(peak.root.z).toBeCloseTo(pose.root.z - 0.08);
    expect(peak.rightHand.y).toBeGreaterThan(pose.rightHand.y);
    const late = flinch(pose, 400);
    expect(Math.abs(late.head.z - pose.head.z)).toBeLessThan(0.02);
    expect(flinch(pose, 700)).toBe(pose);
  });

  it("leaves a player with a tracked skeleton alone", () => {
    const pose = { ...neutralPose(), body: [] };
    expect(flinch(pose, 60)).toBe(pose);
  });
});
