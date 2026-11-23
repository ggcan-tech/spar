import { describe, expect, it } from "vitest";
import { laneOf, laneLinear } from "./input";
import { createCameraRig, DODGE_PRESETS, THROW_CAM } from "./cameraRig";
import { readFlick, flickVelocity, terrace } from "./flick";
import { createRally, launchBall, solveFlight, stepDuel, FIXED_STEP, neutralPose, type DuelState } from "./duel";
import { MATCH_PHYSICS } from "./physics";

describe("stage 1: the movement curve (CORE.md 2.5)", () => {
  // His body unit, measured: 0.767 m.
  const u = (m: number) => m / 0.767;
  it("is exact in the middle and carries further near the edge, stopping softly at the wall", () => {
    expect(laneOf(u(0.1))).toBeCloseTo(0.25, 1);
    expect(laneOf(u(0.3))).toBeCloseTo(0.88, 1);
    expect(laneOf(u(0.4))).toBeCloseTo(1.26, 1);
    expect(laneOf(u(0.6))).toBeLessThanOrEqual(1.6);
    expect(laneOf(u(0.6))).toBeGreaterThan(1.5);
    expect(laneOf(-u(0.3))).toBeCloseTo(-0.88, 1);
    // The middle is the dodgeball's 1.8.
    expect(laneOf(0.01) / 0.01).toBeCloseTo(1.8, 1);
    expect(laneLinear(u(0.2))).toBeCloseTo(0.47, 1);
  });
});

describe("stage 1: the camera rig (CORE.md 2.1)", () => {
  it("shows the throw camera on your turn and the chosen dodge camera otherwise, blending between", () => {
    const rig = createCameraRig(1);
    expect(rig.shot(0, false, false)).toEqual(DODGE_PRESETS[1]);
    const mid = rig.shot(1000, true, false)!;
    expect(mid.eye.y).toBeCloseTo(DODGE_PRESETS[1].eye.y, 3);
    expect(rig.shot(1350, true, false)!.eye.z).not.toBeCloseTo(DODGE_PRESETS[1].eye.z, 2);
    expect(rig.shot(1800, true, false)).toEqual(THROW_CAM);
    rig.setKey(4);
    expect(rig.shot(1900, false, false)).toBeNull();
  });
  it("never moves the dodge camera while a ball is coming", () => {
    const rig = createCameraRig(2);
    const a = rig.shot(0, false, false);
    rig.setKey(1);
    const b = rig.shot(10, false, true);
    expect(b).toEqual(a);
  });
});

describe("stage 1: the flick (CORE.md 2.6)", () => {
  /** A phone flick: a drive up the screen, then the last 40 ms at the release speed; CSS px and ms. */
  const stroke = (releasePxPerMs: number, risePx: number) => {
    const samples = [];
    const before = Math.max(0, risePx - releasePxPerMs * 40);
    for (let i = 0; i <= 10; i++) samples.push({ t: i * 10, x: 400, y: 600 - (before * i) / 10 });
    const last = samples[samples.length - 1];
    for (let i = 1; i <= 4; i++) samples.push({ t: last.t + i * 10, x: last.x, y: last.y - releasePxPerMs * 10 * i });
    return samples;
  };
  it("the terrace: low release a line, middle an arc, high a lob, with flat zones", () => {
    expect(terrace(0.2)).toBeCloseTo(4, 0);
    expect(terrace(0.45)).toBeCloseTo(4, 0);
    expect(terrace(0.9)).toBeCloseTo(14, 0);
    expect(terrace(1.6)).toBeCloseTo(26, 0);
  });
  it("on a phone: a fast short flick is a hard line; a slow high one is a soft lob; too slow is no throw", () => {
    // 5 px/ms × 0.16 mm/px = 800 mm/s; released 200 px (32 mm, 0.53 H) up.
    const fast = readFlick(stroke(5, 200), { x: 400, y: 600 }, "touch")!;
    expect(fast.drop).toBe(false);
    expect(fast.shot).toBe("line");
    expect(fast.power).toBeGreaterThan(0.8);
    const lob = readFlick(stroke(2.2, 560), { x: 400, y: 600 }, "touch")!;
    expect(lob.shot).toBe("lob");
    expect(lob.power).toBeLessThan(fast.power);
    expect(readFlick(stroke(0.5, 120), { x: 400, y: 600 }, "touch")!.drop).toBe(true);
  });
  it("throws toward the opponent, up, at the read speed", () => {
    const f = readFlick(stroke(4, 300), { x: 400, y: 600 }, "touch")!;
    const v = flickVelocity(f);
    expect(v.z).toBeGreaterThan(0);
    expect(v.y).toBeGreaterThan(0);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(f.launchSpeed, 5);
  });
});

describe("stage 1: the court's ball (CORE.md 2.7)", () => {
  it("a 1.0 s ball at the chest under match gravity arrives where it was aimed and stays low", () => {
    const hand = { x: 0.2, y: 1.45, z: 0.3 };
    const aim = { x: 0, y: 1.35, z: 8 };
    const shot = solveFlight(hand, aim, 1.0, MATCH_PHYSICS);
    let s: DuelState = { ...createRally(0, 0), physics: MATCH_PHYSICS };
    s = launchBall(s, 0, shot);
    let top = 0;
    for (let i = 0; i < 1.0 / FIXED_STEP && s.balls.length; i++) {
      s = stepDuel(s, [neutralPose(), { ...neutralPose(), root: { x: 1.5, y: 1, z: 0 }, head: { x: 1.5, y: 1.65, z: 0 } }], FIXED_STEP);
      if (s.balls[0]) top = Math.max(top, s.balls[0].position.y);
    }
    // A flat-ish ball: it rises well under a metre above the line.
    expect(top).toBeLessThan(2.2);
  });
});
