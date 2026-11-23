import { describe, expect, it } from "vitest";
import { BOXERS, LADDER } from "../real/mind";
import { STYLES, playMany, type StyleName } from "../real/players";
import { MOTION_TIMES, fitTimes } from "./realPose";
import { PUNCH_SPAN } from "./times";

/**
 * The game hands the rules each opponent's own punch times, held to what the
 * clips can show. This is the gate for that: the same lines the rules'
 * balance is held to, played with those times.
 */
const NO_SKILL: StyleName[] = ["nothing", "swings", "hides", "hides and pokes", "leans back", "only jabs"];
const fitted = (name: (typeof LADDER)[number]) => ({ ...BOXERS[name], times: fitTimes(BOXERS[name].times) });

describe("punch times the clips can show", () => {
  it("never asks a clip to play slower than it can, and leaves a quicker punch as it is", () => {
    for (const name of LADDER) {
      const own = BOXERS[name].times,
        fit = fitTimes(own);
      for (const kind of Object.keys(own) as (keyof typeof own)[]) {
        expect(fit[kind].impact, `${name} ${kind}`).toBeLessThanOrEqual(PUNCH_SPAN[kind].most + 1e-9);
        expect(fit[kind].impact).toBeLessThanOrEqual(own[kind].impact);
        if (own[kind].impact <= PUNCH_SPAN[kind].most) expect(fit[kind]).toEqual(own[kind]);
        expect(fit[kind].commit).toBeLessThanOrEqual(fit[kind].impact);
      }
    }
    // The first opponent is still slower than the last, punch for punch.
    for (const kind of ["jab", "hook", "uppercut"] as const) expect(fitTimes(BOXERS.beginner.times)[kind].impact).toBeGreaterThan(fitTimes(BOXERS.counter.times)[kind].impact);
  });
  it("keeps the ladder: no skill wins nothing, a hands-up beginner beats the first opponent, a middle player is an even match for the last", () => {
    for (const style of NO_SKILL) for (const name of LADDER) expect(playMany(fitted(name), STYLES[style], 8).wins, `${style} v ${name}`).toBeLessThan(0.1);
    const first = playMany(fitted("beginner"), STYLES.beginner, 40);
    expect(first.wins).toBeGreaterThan(0.8);
    expect(first.r1Down).toBeLessThan(0.1);
    const last = playMany(fitted("counter"), STYLES.middle, 100);
    expect(last.wins).toBeGreaterThanOrEqual(0.4);
    expect(last.wins).toBeLessThanOrEqual(0.65);
  });
  it("would not keep it with one performer's times for everybody", () => {
    // Why the clips' own times are not simply handed to the rules.
    const flat = playMany({ ...BOXERS.counter, times: MOTION_TIMES }, STYLES.middle, 40);
    expect(flat.wins).toBeLessThan(0.2);
  });
});
