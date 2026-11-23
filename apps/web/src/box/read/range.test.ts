import { describe, expect, it } from "vitest";
import type { SyntheticMotion } from "../../pov/syntheticBody";
import { stance } from "../scriptedBoxer";
import { RANGE, bodySizes, createRangeReader } from "./range";
import { M, TAN, cam, ease, f0, f1, frameOf, mean, runBoxer, skeleton, spread, type Cam, type Extra, type Noise } from "./rig";

/**
 * The perception study's range table (finding 6), kept as a test. The
 * scripted person stands in the guard, does one thing between 1.0 s and
 * about 1.3 s, and holds it. Trunk noise as in the study: 0.4 cm on every
 * landmark. Measured on a scripted person; a camera will differ.
 */
interface Scenario {
  name: string;
  /** How much further the body truly is, cm. */
  truly: number;
  seconds: number;
  at: (k: number) => { m: SyntheticMotion; extra: Extra };
}
const SCENARIOS: Scenario[] = [
  { name: "step back 20 cm", truly: 20, seconds: 0.3, at: (k) => ({ m: stance(), extra: { forward: -0.2 * k } }) },
  { name: "step back 40 cm", truly: 40, seconds: 0.4, at: (k) => ({ m: stance(), extra: { forward: -0.4 * k } }) },
  { name: "lean back 20 cm", truly: 20, seconds: 0.25, at: (k) => ({ m: stance(), extra: { leanBack: 0.2 * k } }) },
  { name: "turn 30° and step back 20 cm", truly: 20, seconds: 0.3, at: (k) => ({ m: { ...stance(), twist: 0.52 * k }, extra: { forward: -0.2 * k } }) },
  { name: "turn 30°, no step", truly: 0, seconds: 0.2, at: (k) => ({ m: { ...stance(), twist: 0.52 * k }, extra: {} }) },
  { name: "crouch 15 cm", truly: 0, seconds: 0.25, at: (k) => ({ m: stance({ crouch: 0.15 * k }), extra: {} }) },
  { name: "slip 15 cm to the side", truly: 0, seconds: 0.2, at: (k) => ({ m: stance({ lean: 0.15 * k }), extra: {} }) },
  { name: "step in 20 cm", truly: -20, seconds: 0.3, at: (k) => ({ m: stance(), extra: { forward: 0.2 * k } }) },
  { name: "step in 40 cm", truly: -40, seconds: 0.4, at: (k) => ({ m: stance(), extra: { forward: 0.4 * k } }) },
];
const CAMERAS: [string, Cam][] = [
  ["chest height", cam(1.0, 2.6, 1.0)],
  ["desk laptop", cam(0.75, 2.0)],
];
interface Result {
  /** What it read while the new place was held, cm from home. */
  held: number[];
  /** What the shoulders alone would have read. */
  shoulders: number[];
  /** Runs in which it said "pulled back" at all, and the share of the held time it said so. */
  backRuns: number;
  backShare: number;
  backAt: number[];
  nearRuns: number;
  flips: number;
  runs: number;
}
function play(sc: Scenario, c: Cam, noise: Omit<Noise, "seed">, seeds: number[]): Result {
  const r: Result = { held: [], shoulders: [], backRuns: 0, backShare: 0, backAt: [], nearRuns: 0, flips: 0, runs: seeds.length };
  let said = 0,
    poses = 0;
  for (const seed of seeds) {
    const range = createRangeReader({ lensTan: TAN });
    let was = false,
      back = false,
      near = false,
      on = -1,
      base = 0;
    runBoxer(
      (s) => sc.at(ease((s - 1) / sc.seconds)).m,
      2.8,
      { fps: 30, cam: c, noise: { seed, ...noise }, extra: (s) => sc.at(ease((s - 1) / sc.seconds)).extra },
      (p) => {
        const reading = range.update(p.frame, p.t);
        if (!reading.ready) return;
        const wide = bodySizes(p.frame.lm, p.frame.imageAspect).shoulders!;
        if (p.s < 0.95) base = base ? base + 0.2 * (wide - base) : wide;
        if (reading.back !== was) {
          r.flips++;
          was = reading.back;
          if (reading.back && on < 0) on = (p.s - 1) * 1000;
        }
        back ||= reading.back;
        near ||= reading.near;
        if (p.s >= 1 + sc.seconds + 0.6) {
          r.held.push(reading.away * M * 100);
          r.shoulders.push((c.distance * (base / wide) - c.distance) * 100);
          poses++;
          if (reading.back) said++;
        }
      },
    );
    if (back) r.backRuns++;
    if (near) r.nearRuns++;
    if (on >= 0) r.backAt.push(on);
  }
  r.backShare = said / poses;
  return r;
}

describe("one coarse range", () => {
  it("reads steps and leans, and does not read a turn, a crouch or a slip as a step (the study's table)", () => {
    const rows: string[] = [];
    for (const [camName, c] of CAMERAS)
      for (const sc of SCENARIOS) {
        const r = play(sc, c, { sigma: 0.004, depth: 0.03, all: true }, [1, 2, 3, 4]);
        rows.push(
          `${camName} | ${sc.name} (truly ${f0(sc.truly)} cm): reads ${f1(mean(r.held))} ± ${f1(spread(r.held))} cm (shoulders alone ${f0(mean(r.shoulders))}) | pulled back in ${r.backRuns} of ${r.runs} runs${r.backAt.length ? `, from ${f0(mean(r.backAt))} ms` : ""}, ${f0(100 * r.backShare)}% of the held time | too near in ${r.nearRuns}`,
        );
        const error = mean(r.held) - sc.truly;
        if (sc.name.startsWith("step back") || sc.name.startsWith("turn 30° and step")) {
          // A step back is a pull back, every time, and stays one. The study: it reads 2–6 cm short.
          expect(r.backRuns).toBe(r.runs);
          expect(r.backShare).toBeGreaterThanOrEqual(0.95);
          expect(error).toBeGreaterThan(-6);
          expect(error).toBeLessThan(2);
          expect(r.nearRuns).toBe(0);
        } else if (sc.name.startsWith("lean back")) {
          // A lean cannot be told from a step: the same defence.
          expect(r.backRuns).toBe(r.runs);
          expect(r.backShare).toBeGreaterThanOrEqual(0.95);
        } else if (sc.truly === 0) {
          // A turn of the shoulders, a crouch and a slip are not a step back, in any run.
          expect(r.backRuns).toBe(0);
          expect(r.nearRuns).toBe(0);
          expect(r.flips).toBe(0);
          expect(Math.abs(mean(r.held))).toBeLessThan(sc.name.startsWith("crouch") ? 12 : 4);
        } else if (sc.truly === -40) {
          expect(r.nearRuns).toBe(r.runs);
          expect(r.backRuns).toBe(0);
        } else {
          // 20 cm nearer is not yet too near.
          expect(r.nearRuns).toBe(0);
          expect(r.backRuns).toBe(0);
        }
        // Why three measures: the shoulders alone read a turn as a long step back.
        if (sc.name === "turn 30°, no step") expect(mean(r.shoulders)).toBeGreaterThan(20);
      }
    console.log("range, scripted person, trunk noise 0.4 cm, 30 poses a second\n" + rows.join("\n"));
  });

  it("holds up with 1 cm of noise on a long step, and never calls a turn a step", () => {
    const rows: string[] = [];
    for (const [camName, c] of CAMERAS)
      for (const sc of [SCENARIOS[1], SCENARIOS[4], SCENARIOS[0]]) {
        const r = play(sc, c, { sigma: 0.01, depth: 0.04, all: true }, [1, 2, 3, 4]);
        rows.push(
          `${camName} | ${sc.name}: reads ${f1(mean(r.held))} ± ${f1(spread(r.held))} cm | pulled back in ${r.backRuns} of ${r.runs} runs, ${f0(100 * r.backShare)}% of the held time, ${r.flips} changes`,
        );
        if (sc.truly === 40) {
          expect(r.backRuns).toBe(r.runs);
          expect(r.backShare).toBeGreaterThanOrEqual(0.95);
        } else if (sc.truly === 0) expect(r.backRuns).toBe(0);
        // A 20 cm step at 1 cm of noise reads 3–4 cm short and sits near the 15 cm line: it is
        // called in every run but not held all the time. Reported, and held to no more than that.
        else expect(r.backRuns).toBe(r.runs);
      }
    console.log("range, trunk noise 1 cm\n" + rows.join("\n"));
  });

  it("is not capped, and follows a step in about a tenth of a second", () => {
    const c = cam(1.0, 2.6, 1.0);
    const at = (forward: number) => frameOf(0, skeleton(stance(), { forward }), c);
    const step = (to: number) => {
      const range = createRangeReader({ lensTan: TAN });
      let t = 0;
      for (let i = 0; i < 30; i++) range.update(at(0), (t += 33));
      expect(range.home() * M).toBeCloseTo(2.6, 1);
      const seen: number[] = [];
      for (let i = 0; i < 24; i++) seen.push((range.update(at(to), (t += 33)).away * M) / -to);
      return seen;
    };
    // A step of 70 cm at once, each way. The old tracker's range stopped at 25–32 cm.
    const back = step(-0.7),
      forward = step(0.7);
    console.log(
      `range, a 70 cm step at once: share read after 100 / 200 / 400 / 800 ms — back ${[2, 5, 11, 23].map((i) => f0(100 * back[i])).join(" / ")}%, forward ${[2, 5, 11, 23].map((i) => f0(100 * forward[i])).join(" / ")}%`,
    );
    expect(back[23]).toBeGreaterThan(0.94);
    expect(back[23]).toBeLessThan(1.03);
    expect(forward[23]).toBeGreaterThan(0.97);
    // Forward, the body's own size leads: two smoothings of 45 ms, about 80 ms in all.
    expect(forward[2]).toBeGreaterThan(0.5);
    expect(forward[5]).toBeGreaterThan(0.9);
    // Back, the largest measure is the last to shrink, and the head is smoothed over 200 ms: slower, but there in 400 ms.
    expect(back[5]).toBeGreaterThan(0.4);
    expect(back[11]).toBeGreaterThan(0.8);
  });

  it("gives an answer for at least 150 ms, with a dead band between pulled back and forward again", () => {
    const c = cam(1.0, 2.6, 1.0);
    const range = createRangeReader({ lensTan: TAN });
    const at = (forward: number) => frameOf(0, skeleton(stance(), { forward }), c);
    let t = 0;
    for (let i = 0; i < 30; i++) range.update(at(0), (t += 33));
    const stand = (forward: number, poses: number) => {
      let r = range.update(at(forward), (t += 33));
      for (let i = 1; i < poses; i++) r = range.update(at(forward), (t += 33));
      return r;
    };
    // 12 cm back: under the line. 20 cm: pulled back.
    expect(stand(-0.12, 20).back).toBe(false);
    expect(stand(-0.2, 20).back).toBe(true);
    // Forward again to 11 cm back: inside the dead band, so still pulled back. No flicker at the line.
    expect(stand(-0.11, 20).back).toBe(true);
    expect(stand(-0.03, 20).back).toBe(false);
    expect(RANGE.back - RANGE.backOff).toBeGreaterThan(0.05);
    // Stepping back and forward faster than anyone can: no two changes closer than the hold.
    const changes: number[] = [];
    let was = false;
    for (let i = 0; i < 120; i++) {
      const r = range.update(at(Math.floor(i / 4) % 2 ? -0.45 : 0.05), (t += 33));
      if (r.back !== was) {
        changes.push(t);
        was = r.back;
      }
    }
    expect(changes.length).toBeGreaterThan(2);
    for (let i = 1; i < changes.length; i++) expect(changes[i] - changes[i - 1]).toBeGreaterThanOrEqual(RANGE.holdMs);
  });

  it("keeps a home that follows a player who settles further back and never moves nearer by itself", () => {
    const c = cam(1.0, 2.6, 1.0);
    const range = createRangeReader({ lensTan: TAN });
    const at = (forward: number) => frameOf(0, skeleton(stance(), { forward }), c);
    let t = 0;
    for (let i = 0; i < 30; i++) range.update(at(0), (t += 33));
    const home = range.home();
    // Creeping 25 cm toward the screen and staying there for ten seconds: home does not come with them.
    let r = range.update(at(0.25), (t += 33));
    for (let i = 0; i < 300; i++) r = range.update(at(0.25), (t += 33));
    expect(range.home()).toBe(home);
    expect(r.away * M).toBeLessThan(-0.2);
    // And 40 cm: too near, after a moment, and for as long as they stay.
    r = range.update(at(0.4), (t += 33));
    expect(r.near).toBe(false);
    for (let i = 0; i < 300; i++) r = range.update(at(0.4), (t += 33));
    expect(r.near).toBe(true);
    expect(range.home()).toBe(home);
    for (let i = 0; i < 30; i++) r = range.update(at(0), (t += 33));
    expect(r.near).toBe(false);
    // Standing 30 cm further back: pulled back at first; after some seconds it is where they stand, and home has gone there.
    for (let i = 0; i < 20; i++) r = range.update(at(-0.3), (t += 33));
    expect(r.back).toBe(true);
    for (let i = 0; i < 450; i++) r = range.update(at(-0.3), (t += 33));
    expect(r.back).toBe(false);
    expect(range.home()).toBeGreaterThan(home + 0.15);
    // Taken again on request.
    range.rehome();
    expect(range.update(at(-0.3), (t += 33)).ready).toBe(false);
    for (let i = 0; i < 30; i++) r = range.update(at(-0.3), (t += 33));
    expect(r.ready).toBe(true);
    expect(Math.abs(r.away)).toBeLessThan(0.02);
  });

  it("holds its reading when the shoulders are not seen, and measures without hips or ears", () => {
    const c = cam(1.0, 2.6, 1.0);
    const range = createRangeReader({ lensTan: TAN });
    const frame = (forward: number, hide: number[] = []) => {
      const f = frameOf(0, skeleton(stance(), { forward }), c);
      for (const i of hide) f.lm[i] = { ...f.lm[i], v: 0.1 };
      return f;
    };
    let t = 0;
    for (let i = 0; i < 30; i++) range.update(frame(0), (t += 33));
    let r = range.update(frame(-0.3, [11]), (t += 33));
    expect(r.held).toBe(true);
    expect(Math.abs(r.away)).toBeLessThan(0.02);
    // Hips behind a desk and gloves over the ears: the shoulders carry on.
    for (let i = 0; i < 15; i++) r = range.update(frame(-0.3, [23, 24, 7, 8]), (t += 33));
    expect(r.held).toBe(false);
    expect(r.away * M).toBeGreaterThan(0.26);
    expect(r.back).toBe(true);
    expect(bodySizes(frame(0, [23]).lm).torso).toBeNull();
    expect(bodySizes(frame(0, [7]).lm).head).toBeNull();
  });
});
