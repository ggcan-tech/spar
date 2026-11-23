import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOURCE_FPS, TRIALS, boneLengthSpread, readTrial } from "../../../../../tools/anim/asf.mjs";

/**
 * The reader of the CMU recordings (tools/anim/asf.mjs). If it placed a
 * joint wrongly, bones would change length as the boxer moves.
 */
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The raw CMU files are fetched once and never committed (tools/anim/source/).
const hasSource = existsSync(new URL("../../../../../tools/anim/source/cmu/17.asf", import.meta.url));

describe.skipIf(!hasSource)("the motion capture reader", () => {
  // The shortest trial: 23 seconds.
  const trial = hasSource ? readTrial("17_10") : (null as unknown as ReturnType<typeof readTrial>);
  it("reads every frame of a trial", () => {
    expect(TRIALS).toContain("17_10");
    expect(SOURCE_FPS).toBe(120);
    expect(trial.frames.length).toBe(2783);
  });
  it("keeps every bone's length constant over the trial", () => {
    // Measured: about one part in two million, which is rounding.
    expect(boneLengthSpread(trial)).toBeLessThan(1e-5);
    // And the same said plainly for one arm and one leg.
    for (const [a, b] of [["rclavicle", "rhumerus"], ["rhumerus", "rradius"], ["lhipjoint", "lfemur"], ["lfemur", "ltibia"]]) {
      const lengths = trial.frames.map((f) => dist(f[a], f[b]));
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-6);
    }
  });
  it("gives a person of human size, in metres, standing on a floor", () => {
    const hips = trial.frames.map((f) => f.root[1]).sort((x, y) => x - y);
    const head = trial.frames.map((f) => f.head[1]).sort((x, y) => x - y);
    const ankles = trial.frames.map((f) => Math.min(f.ltibia[1], f.rtibia[1]));
    // The pelvis about a metre up, the top of the head about 1.6 m, the ankles a few centimetres off the floor.
    expect(hips[hips.length >> 1]).toBeGreaterThan(0.8);
    expect(hips[hips.length >> 1]).toBeLessThan(1.1);
    expect(head[head.length - 1]).toBeGreaterThan(1.5);
    expect(head[head.length - 1]).toBeLessThan(1.9);
    expect(Math.min(...ankles)).toBeGreaterThan(0.02);
    expect(Math.min(...ankles)).toBeLessThan(0.12);
    // Upper arm and thigh of ordinary length.
    const f = trial.frames[0];
    expect(dist(f.rclavicle, f.rhumerus)).toBeGreaterThan(0.24);
    expect(dist(f.rclavicle, f.rhumerus)).toBeLessThan(0.38);
    expect(dist(f.lhipjoint, f.lfemur)).toBeGreaterThan(0.35);
    expect(dist(f.lhipjoint, f.lfemur)).toBeLessThan(0.5);
  });
});
