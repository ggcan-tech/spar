import { describe, expect, it } from "vitest";
import { STOP_SHORT as FORMULA_STOP_SHORT } from "../opponentPose";
import { AIM, MAX_REACH, STOP_SHORT, aimWeight, armTo, bendOf, gloveTarget, keepClear, reachTo, settleTarget } from "./aim";
import { TEST_PACK } from "./fixture";
import { fromRig, gloveOf, sampleClip, toRig } from "./sampler";
import { SIZE, type Body } from "./types";
import { angleBetween, distance, sub, v3 } from "./vec";

/**
 * The aim warp: the glove reaches its target, the bend is shared between
 * hips, trunk and arm within their limits, and the glove keeps clear of
 * the player's eye.
 */
const cross = TEST_PACK.byId.get("cross_a")!;
const mark = cross.punches[0];
/** The cross at contact: its right glove is out. */
const atContact = (): Body => fromRig(toRig(sampleClip(cross, mark.events.contact)));
const glove = (b: Body, h: 0 | 1) => gloveOf(b.shoulders[h], b.wrists[h]);
const elbowAngle = (b: Body, h: 0 | 1) => angleBetween(sub(b.shoulders[h], b.elbows[h]), sub(b.wrists[h], b.elbows[h]));
const DEG = Math.PI / 180;

describe("reaching a target", () => {
  const b = atContact();
  const own = glove(b, 1);
  it("puts the glove on a target near its own line, exactly", () => {
    for (const by of [v3(0.1, 0, 0), v3(-0.12, 0.05, 0), v3(0, -0.1, -0.05), v3(0.06, 0.08, 0.04), v3(0, 0, -0.2)]) {
      const target = v3(own.x + by.x, own.y + by.y, own.z + by.z);
      const out = reachTo(b, 1, target);
      expect(distance(glove(out, 1), target), JSON.stringify(by)).toBeLessThan(1e-6);
    }
  });
  it("keeps every length of spine and arm", () => {
    const out = reachTo(b, 1, v3(own.x + 0.12, own.y + 0.08, own.z - 0.03));
    expect(distance(out.hips, out.chest)).toBeCloseTo(SIZE.chest, 9);
    expect(distance(out.chest, out.head)).toBeCloseTo(SIZE.head, 9);
    for (const h of [0, 1] as const) {
      expect(distance(out.shoulders[h], out.elbows[h])).toBeCloseTo(SIZE.upperArm, 6);
      expect(distance(out.elbows[h], out.wrists[h])).toBeCloseTo(SIZE.forearm, 6);
    }
    expect(distance(out.shoulders[0], out.shoulders[1])).toBeCloseTo(2 * SIZE.shoulder, 9);
  });
  it("shares the move: hips no more than 10 cm, the trunk no more than 8 degrees, the feet not at all", () => {
    for (const by of [v3(0.3, 0.2, 0.3), v3(-0.3, -0.3, 0.4), v3(0, 0, 0.5), v3(0, 0, -0.5), v3(0.05, 0, 0.02)]) {
      const out = reachTo(b, 1, v3(own.x + by.x, own.y + by.y, own.z + by.z));
      const hips = sub(out.hips, b.hips);
      expect(Math.hypot(hips.x, hips.z)).toBeLessThanOrEqual(AIM.hips + 1e-9);
      expect(hips.y).toBeCloseTo(0, 9);
      // The trunk's turn about the hips: the angle the spine moved through.
      expect(angleBetween(sub(out.chest, out.hips), sub(b.chest, b.hips))).toBeLessThanOrEqual(AIM.chest + 1e-9);
      expect(out.feet).toEqual(b.feet);
    }
    // A small move is shared too: the hips take some of it, the arm does not do it all.
    const small = reachTo(b, 1, v3(own.x, own.y, own.z + 0.06));
    expect(small.hips.z - b.hips.z).toBeGreaterThan(0.02);
    expect(small.hips.z - b.hips.z).toBeLessThan(0.04);
  });
  it("never straightens the elbow past 170 degrees, and stops short of a target it cannot reach", () => {
    const far = v3(own.x, own.y, own.z + 0.6);
    const out = reachTo(b, 1, far);
    expect(elbowAngle(out, 1)).toBeLessThanOrEqual(AIM.straight + 1e-6);
    expect(distance(out.shoulders[1], out.wrists[1])).toBeLessThanOrEqual(MAX_REACH + 1e-9);
    // It went toward it as far as hips, trunk and arm allow, and no further.
    expect(glove(out, 1).z).toBeGreaterThan(own.z + 0.05);
    expect(glove(out, 1).z).toBeLessThan(far.z);
  });
  it("leaves the body alone when the glove is already there", () => {
    expect(reachTo(b, 1, own)).toBe(b);
  });
  it("keeps the way the elbow swings", () => {
    const out = armTo(b, 1, v3(own.x + 0.05, own.y - 0.2, own.z - 0.25));
    // The elbow was below the line of the arm; bent further, it is still below it.
    const below = (x: Body) => x.elbows[1].y - (x.shoulders[1].y + x.wrists[1].y) / 2;
    expect(Math.sign(below(out))).toBe(Math.sign(below(b)));
  });
});

describe("the limits of the warp", () => {
  const b = atContact();
  const own = glove(b, 1);
  it("measures the bend at the shoulder: 0.16 m off at this reach is under 15 degrees, 0.35 m is over 25", () => {
    const shoulder = b.shoulders[1];
    expect(bendOf(shoulder, own, own)).toBe(0);
    const slip = bendOf(shoulder, own, v3(own.x + 0.16, own.y, own.z));
    expect(slip / DEG).toBeGreaterThan(8);
    expect(slip / DEG).toBeLessThan(18);
    expect(bendOf(shoulder, own, v3(own.x + 0.35, own.y, own.z))).toBeGreaterThan(AIM.bend);
    expect(AIM.bend / DEG).toBeCloseTo(25, 9);
    expect(AIM.chest / DEG).toBeCloseTo(8, 9);
  });
  it("has no weight until the fist leaves, all of it at contact, and lets go on the way home", () => {
    const t = { launch: 0.25, contact: 0.45, guard: 0.85 };
    expect(aimWeight(0, t)).toBe(0);
    expect(aimWeight(0.25, t)).toBe(0);
    expect(aimWeight(0.35, t)).toBeCloseTo(0.5, 9);
    expect(aimWeight(0.45, t)).toBe(1);
    expect(aimWeight(0.85, t)).toBe(0);
    let last = 0;
    for (let c = 0.25; c <= 0.45; c += 0.01) {
      expect(aimWeight(c, t)).toBeGreaterThanOrEqual(last);
      last = aimWeight(c, t);
    }
  });
  it("uses the same stop-short as the formula body", () => {
    expect(STOP_SHORT).toBe(FORMULA_STOP_SHORT);
    const eye = v3(0.1, 1.6, 1.3);
    expect(gloveTarget(eye, "head")).toEqual(v3(0.1, 1.6, 1.3 - STOP_SHORT));
    // The body: lower, nearer the middle, further out: opponentPose.ts's numbers.
    expect(gloveTarget(eye, "body")).toEqual(v3(0.05, 1.6 - 0.26, 0.8));
  });
});

describe("the eye", () => {
  it("is never nearer than 0.26 m to a glove: a punch that would be jams with the elbow bent", () => {
    const b = atContact();
    const own = glove(b, 1);
    // The player has leaned in until the glove is 10 cm from the eye.
    for (const eye of [v3(own.x, own.y, own.z + 0.1), v3(own.x + 0.05, own.y - 0.05, own.z + 0.02), v3(own.x, own.y, own.z)]) {
      const out = keepClear(b, eye);
      expect(distance(glove(out, 1), eye)).toBeGreaterThanOrEqual(AIM.near - 1e-6);
      expect(distance(glove(out, 0), eye)).toBeGreaterThanOrEqual(AIM.near - 1e-6);
      expect(distance(out.shoulders[1], out.elbows[1])).toBeCloseTo(SIZE.upperArm, 6);
      expect(distance(out.hips, out.chest)).toBeCloseTo(SIZE.chest, 9);
    }
    // Leaned straight into it: the glove is pushed back along the punch, so the elbow is more bent than it was.
    const jammed = keepClear(b, v3(own.x, own.y, own.z + 0.1));
    expect(elbowAngle(jammed, 1)).toBeLessThan(elbowAngle(b, 1));
    expect(glove(jammed, 1).z).toBeLessThan(own.z);
  });
  it("is left alone when the gloves are clear of it", () => {
    const b = atContact();
    expect(keepClear(b, v3(0, 1.65, 1.3))).toBe(b);
  });
  it("is passed by at least 0.20 m when the head has left the line: the punch goes on past, wide of the ear", () => {
    const was = v3(0, 1.6, 1.3);
    for (const frozen of [gloveTarget(was, "head"), v3(0.06, 1.5, 0.88)]) {
      // Still there: the glove stops short of the eye, where it was aimed.
      expect(settleTarget(frozen, was, was, "head")).toEqual(frozen);
      // A small move is not a miss yet.
      expect(settleTarget(frozen, was, v3(0.05, 1.6, 1.3), "head")).toEqual(frozen);
      for (const moved of [0.16, 0.2, 0.3, -0.16, -0.25]) {
        const eye = v3(moved, 1.6, 1.3);
        const end = settleTarget(frozen, was, eye, "head");
        // Past where the head was, and at least 0.20 m to the side of the eye, on the side it already was.
        expect(end.z).toBeGreaterThan(eye.z);
        expect(Math.abs(end.x - eye.x)).toBeGreaterThanOrEqual(AIM.pass - 1e-9);
        expect(Math.sign(end.x - eye.x)).toBe(-Math.sign(moved));
        expect(distance(end, eye)).toBeGreaterThanOrEqual(AIM.pass);
      }
    }
    // Ducked under it: it passes over, at least 0.20 m above the eye.
    const frozen = gloveTarget(was, "head");
    const ducked = settleTarget(frozen, was, v3(0, 1.4, 1.3), "head");
    expect(ducked.y - 1.4).toBeGreaterThanOrEqual(AIM.pass - 1e-9);
    // A body punch stops where it was aimed.
    const body = gloveTarget(was, "body");
    expect(settleTarget(body, was, v3(0.4, 1.6, 1.3), "body")).toEqual(body);
  });
});
