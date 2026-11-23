import { describe, expect, it } from "vitest";
import { TEST_PACK } from "./fixture";
import { applyBlend, decay, startBlend } from "./inertial";
import { fromRig, sampleClip, toRig } from "./sampler";
import { SIZE, type Rig } from "./types";
import { angleBetween, distance, length } from "./vec";

/**
 * Inertial blending: the leftover from a switch dies away with no pop (it
 * starts where the screen was, moving as it was) and no overshoot (it never
 * crosses the new motion), and is gone on time.
 */
describe("a leftover dying away", () => {
  // Starting offset and speed: still, closing, heading away, the other sign, closing very fast.
  const cases: [number, number][] = [
    [0.2, 0],
    [0.2, -1.5],
    [0.2, 2.0],
    [-0.1, 0.8],
    [-0.1, -0.8],
    [0.05, -3],
    [1.2, -0.4],
  ];
  it("starts at the offset it was given and lands on nothing, with no speed left", () => {
    for (const [x0, v0] of cases) {
      const d = decay(x0, v0, 0.2);
      expect(d.at(0)).toBeCloseTo(x0, 12);
      expect(d.at(d.t1)).toBe(0);
      expect(d.at(d.t1 + 1)).toBe(0);
      expect(d.t1).toBeLessThanOrEqual(0.2 + 1e-12);
      // Speed and acceleration at the end, by differences.
      const h = 1e-4;
      const speed = (d.at(d.t1 - h) - d.at(d.t1 - 2 * h)) / h;
      expect(Math.abs(speed)).toBeLessThan(1e-3 * Math.max(1, Math.abs(x0) / 0.2));
    }
  });
  it("never overshoots: it does not cross zero, and does not grow past where it began", () => {
    for (const [x0, v0] of cases) {
      const d = decay(x0, v0, 0.2);
      let before = Math.abs(x0);
      for (let i = 0; i <= 400; i++) {
        const x = d.at((d.t1 * i) / 400);
        // Same side as it started, or exactly gone.
        expect(x * Math.sign(x0)).toBeGreaterThanOrEqual(0);
        // And always shrinking: a speed heading away is not followed.
        expect(Math.abs(x)).toBeLessThanOrEqual(before + 1e-12);
        before = Math.abs(x);
      }
    }
  });
  it("keeps the speed it had when that speed is closing", () => {
    const d = decay(0.2, -1.5, 0.2);
    const h = 1e-5;
    expect((d.at(h) - d.at(0)) / h).toBeCloseTo(-1.5, 2);
  });
  it("finishes sooner than asked when it is already closing fast", () => {
    expect(decay(0.05, -3, 0.2).t1).toBeCloseTo((5 * 0.05) / 3, 9);
  });
  it("is nothing when there is nothing left over", () => {
    expect(decay(0, 5, 0.2).at(0.01)).toBe(0);
    expect(decay(0.3, 0, 0).at(0)).toBe(0);
  });
});

describe("a blend between two clips", () => {
  const guard = TEST_PACK.byId.get("guard_a")!;
  const cross = TEST_PACK.byId.get("cross_a")!;
  const dt = 1 / 60;
  // On screen: the guard, mid-loop. Switching to: the cross from its first frame.
  const shown = toRig(sampleClip(guard, 40));
  const before = toRig(sampleClip(guard, 39));
  const at = (t: number): Rig => toRig(sampleClip(cross, t * 60));
  const T = 0.1;
  const blend = startBlend(shown, before, at(0), at(-dt), dt, T, 5);
  const parts = (r: Rig) => [r.spine, r.neck, r.across, r.upper[0], r.upper[1], r.fore[0], r.fore[1]];

  it("starts exactly on what was on screen: no pop", () => {
    const first = applyBlend(blend, at(0), 5);
    expect(distance(first.hips, shown.hips)).toBeLessThan(1e-9);
    expect(distance(first.feet[0], shown.feet[0])).toBeLessThan(1e-9);
    parts(first).forEach((d, i) => expect(angleBetween(d, parts(shown)[i])).toBeLessThan(1e-6));
  });
  it("lands exactly on the new clip, with no offset left, by the time allowed", () => {
    const end = applyBlend(blend, at(T), 5 + T);
    const clip = at(T);
    expect(distance(end.hips, clip.hips)).toBe(0);
    parts(end).forEach((d, i) => expect(angleBetween(d, parts(clip)[i])).toBe(0));
  });
  it("closes on the new clip all the way, never passing it, and never changes a bone's length", () => {
    let last = Infinity;
    const lefts: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = (T * i) / 60;
      const out = applyBlend(blend, at(t), 5 + t);
      const clip = at(t);
      // How far what is shown is from the bare clip: every bone's angle and the hips' distance.
      const left = distance(out.hips, clip.hips) + parts(out).reduce((n, d, k) => n + angleBetween(d, parts(clip)[k]), 0);
      lefts.push(left);
      expect(left).toBeLessThanOrEqual(last + 1e-9);
      last = left;
      for (const d of parts(out)) expect(length(d)).toBeCloseTo(1, 9);
      const body = fromRig(out);
      expect(distance(body.hips, body.chest)).toBeCloseTo(SIZE.chest, 9);
      expect(distance(body.chest, body.head)).toBeCloseTo(SIZE.head, 9);
      expect(distance(body.shoulders[1], body.elbows[1])).toBeCloseTo(SIZE.upperArm, 9);
    }
    expect(lefts[0]).toBeGreaterThan(0.1);
    expect(lefts[lefts.length - 1]).toBe(0);
  });
  it("stacks: a second switch part-way through starts from what is on screen then", () => {
    const hook = TEST_PACK.byId.get("hook_lead_a")!;
    const t = 0.04;
    const onScreen = applyBlend(blend, at(t), 5 + t);
    const onScreenBefore = applyBlend(blend, at(t - dt), 5 + t - dt);
    const hookAt = (s: number): Rig => toRig(sampleClip(hook, s * 60));
    const second = startBlend(onScreen, onScreenBefore, hookAt(0), hookAt(-dt), dt, T, 5 + t);
    const first = applyBlend(second, hookAt(0), 5 + t);
    expect(distance(first.hips, onScreen.hips)).toBeLessThan(1e-9);
    parts(first).forEach((d, i) => expect(angleBetween(d, parts(onScreen)[i])).toBeLessThan(1e-6));
    const end = applyBlend(second, hookAt(T), 5 + t + T);
    expect(distance(end.hips, hookAt(T).hips)).toBe(0);
  });
});
