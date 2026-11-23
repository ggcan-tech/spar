import { describe, expect, it } from "vitest";
import type { SyntheticMotion } from "../../pov/syntheticBody";
import { stance } from "../scriptedBoxer";
import type { ContactEvent } from "./contact";
import { QUALITY, createQuality } from "./quality";
import { CAMS, runContact, throwsOf, type Noise, type Thrown } from "./rig";

const NOISE: Omit<Noise, "seed"> = { sigma: 0.005, depth: 0.03 };
type Timed = ContactEvent & { s: number };
const ends = (events: Timed[], from = -Infinity, to = Infinity) =>
  events.filter((e): e is Extract<Timed, { kind: "end" }> => e.kind === "end" && e.s >= from && e.s < to);
const hands = ["left", "right"] as const;
/** Snapped punches: out in 150–210 ms, straight back. */
const snaps = (from: number, count: number, hooks = false): Thrown[] =>
  Array.from({ length: count }, (_, i) => ({
    at: from + i,
    hand: hands[i % 2],
    shape: hooks && i % 3 === 2 ? ("hook" as const) : ("straight" as const),
    style: { extend: 0.15 + 0.03 * (i % 3), hold: 0.04 },
  }));
/** Pushes: the same reach, but the arm takes half a second to get there and stays a while. */
const pushes = (from: number, count: number): Thrown[] =>
  Array.from({ length: count }, (_, i) => ({
    at: from + i * 1.6,
    hand: hands[i % 2],
    shape: "straight" as const,
    style: { extend: 0.5 + 0.05 * (i % 3), hold: 0.1, back: 0.5 },
  }));

describe("a punch or a push", () => {
  it("rates speed against this player's own best, and calls under half of it a touch", () => {
    const q = createQuality();
    // Before anything is known of the player: a snapped beginner's punch is the bar.
    expect(q.best("left")).toBe(QUALITY.startBest);
    for (const speed of [4, 4.2, 3.8, 4.1, 4]) q.learn("left", speed);
    expect(q.best("left")).toBeCloseTo(4.1, 5);
    // The other hand borrows it until it has thrown a few of its own.
    expect(q.best("right")).toBeCloseTo(4.1, 5);
    const good = q.rate({ hand: "left", shape: "straight", speed: 4.1 });
    expect(good).toMatchObject({ touch: false, reach: 1, home: 1 });
    expect(good.value).toBeCloseTo(1, 5);
    // Faster than their best: a little more, never past the rules' bound.
    expect(q.rate({ hand: "left", shape: "straight", speed: 8 }).value).toBe(QUALITY.most);
    // Three fifths of their best: a weak punch. Under half: a touch, and under the rules' line for a push.
    expect(q.rate({ hand: "left", shape: "straight", speed: 2.5 })).toMatchObject({ touch: false });
    const push = q.rate({ hand: "left", shape: "straight", speed: 1.9 });
    expect(push.touch).toBe(true);
    expect(push.value).toBeLessThan(QUALITY.push);
    expect(push.value).toBeGreaterThanOrEqual(QUALITY.least);
  });

  it("does not let a player who only pushes set the bar", () => {
    const q = createQuality();
    for (let i = 0; i < 10; i++) q.learn("left", 1.1);
    expect(q.best("left")).toBe(QUALITY.leastBest);
    expect(q.rate({ hand: "left", shape: "straight", speed: 1.1 }).touch).toBe(true);
    // Nonsense is not learned.
    q.learn("right", NaN);
    q.learn("right", -1);
    q.reset();
    expect(q.best("left")).toBe(QUALITY.startBest);
  });

  it("gives full credit at 90% of the arm and never more for locking the elbow out", () => {
    const q = createQuality();
    const at = (reach: number) => q.rate({ hand: "left", shape: "straight", speed: QUALITY.startBest, reach });
    expect(at(0.9).reach).toBe(1);
    expect(at(1.0).reach).toBe(1);
    expect(at(1.0).value).toBe(at(0.9).value);
    // Half-way out keeps half; between, in proportion.
    expect(at(0.45).reach).toBeCloseTo(QUALITY.shortKeeps, 6);
    expect(at(0.675).reach).toBeCloseTo(0.75, 6);
    expect(at(0.3).reach).toBe(QUALITY.shortKeeps);
    // A hook is thrown with a bent arm: reach is not asked of it.
    expect(q.rate({ hand: "left", shape: "hook", speed: QUALITY.startBest, reach: 0.5 }).reach).toBe(1);
    // Not known yet: no penalty.
    expect(q.rate({ hand: "left", shape: "straight", speed: QUALITY.startBest, reach: null }).reach).toBe(1);
  });

  it("wants the hand home within 300–400 ms", () => {
    const q = createQuality();
    const back = (backMs: number) => q.rate({ hand: "right", shape: "straight", speed: QUALITY.startBest, backMs });
    expect(back(250).home).toBe(1);
    expect(back(400).home).toBe(1);
    expect(back(600).home).toBeCloseTo(0.85, 6);
    expect(back(800).home).toBe(QUALITY.lateKeeps);
    expect(back(2000).home).toBe(QUALITY.lateKeeps);
    expect(back(800).value).toBeCloseTo(QUALITY.lateKeeps, 6);
  });

  it("tells pushes from snapped punches nine times in ten, on the scripted person through the whole reading", () => {
    const rows: string[] = [];
    let right = 0,
      all = 0;
    for (const fps of [30, 60]) {
      // A few snaps to show the player's own speed, then pushes, then snaps again with hooks among them.
      const list = [...snaps(0.3, 6), ...pushes(6.5, 10), ...snaps(23, 10, true)];
      const run = runContact(throwsOf(list), 33.5, { fps, cam: CAMS[1][1], noise: { seed: 5, ...NOISE } });
      const snapped = [...ends(run.events, 0, 6.4), ...ends(run.events, 22.9)],
        pushed = ends(run.events, 6.4, 22.9);
      const snapsRight = snapped.filter((e) => !e.touch).length,
        pushesRight = pushed.filter((e) => e.touch).length;
      rows.push(
        `${fps} poses a second: ${snapsRight} of ${snapped.length} snapped punches rated as punches (${snapped.map((e) => e.quality.toFixed(2)).join(" ")}); ${pushesRight} of ${pushed.length} pushes rated as touches (${pushed.map((e) => e.quality.toFixed(2)).join(" ")}); own best ${run.contact.learned().best.left.toFixed(1)} / ${run.contact.learned().best.right.toFixed(1)} units a second`,
      );
      // Every punch thrown was read.
      expect(snapped.length).toBeGreaterThanOrEqual(15);
      expect(pushed.length).toBeGreaterThanOrEqual(9);
      right += snapsRight + pushesRight;
      all += snapped.length + pushed.length;
      // A snapped punch is never taken for a push more than once in sixteen.
      expect(snapsRight / snapped.length).toBeGreaterThanOrEqual(0.93);
      expect(pushesRight / pushed.length).toBeGreaterThanOrEqual(0.7);
      // At the start a touch is not called on thin evidence: no snapped punch begins as one.
      const firstReadings = run.events.filter((e): e is Extract<Timed, { kind: "start" }> => e.kind === "start" && (e.s < 6.4 || e.s >= 22.9));
      expect(firstReadings.filter((e) => e.touch).length).toBeLessThanOrEqual(1);
    }
    console.log(`quality, scripted snaps (150–210 ms) and pushes (500–600 ms), desk laptop, 0.5 cm of noise: ${right} of ${all} told apart\n` + rows.join("\n"));
    // The coach's test: separated nine times in ten.
    expect(right / all).toBeGreaterThanOrEqual(0.9);
  });

  it("rates a player who only ever pushes as pushing", () => {
    const run = runContact(throwsOf(pushes(0.3, 10)), 17, { cam: CAMS[1][1], noise: { seed: 5, ...NOISE } });
    const pushed = ends(run.events);
    const touches = pushed.filter((e) => e.touch).length;
    console.log(`quality, only pushes from the first: ${touches} of ${pushed.length} rated as touches (${pushed.map((e) => e.quality.toFixed(2)).join(" ")})`);
    expect(pushed.length).toBeGreaterThanOrEqual(8);
    expect(touches / pushed.length).toBeGreaterThanOrEqual(0.7);
  });

  it("calls a flick that went less than far a touch, and most of what restless hands make the reader read", () => {
    // Flicks: out to 45% of a punch and back in a fifth of a second, after four real punches.
    const flicks: Thrown[] = [
      ...snaps(0.3, 4).map((p) => ({ ...p, hand: "left" as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ at: 4.5 + i * 0.9 + i * 0.011, hand: "left" as const, shape: "straight" as const, style: { extend: 0.09, hold: 0, back: 0.1, reach: 0.45 } })),
    ];
    const rows: string[] = [];
    for (const fps of [30, 60]) {
      const run = runContact(throwsOf(flicks), 14, { fps, cam: CAMS[1][1], noise: { seed: 5, ...NOISE } });
      const read = ends(run.events, 4.4);
      const feints = run.events.filter((e) => e.kind === "cancel" && e.feint && e.s >= 4.4).length;
      rows.push(`${fps} poses a second, ten flicks: ${read.length} read as punches, of which ${read.filter((e) => e.short).length} marked short and ${read.filter((e) => e.touch).length} touches; ${feints} called feints; the rest not seen`);
      // Whatever the reader made of a flick, it is not a scoring punch.
      expect(read.filter((e) => !e.touch).length).toBeLessThanOrEqual(1);
      for (const e of read.filter((x) => x.short)) expect(e.quality).toBeLessThan(QUALITY.push);
    }
    // Hands that wander 3–4 cm in the guard for half a minute: the reader confirms some as punches.
    const wander = (s: number): SyntheticMotion | null => {
      if (s < 4.5) return null;
      const m = stance();
      const w = (k: number) => 0.025 * Math.sin(s * 5.3 + k) + 0.015 * Math.sin(s * 11 + 2 * k);
      return {
        ...m,
        leftHand: { x: m.leftHand!.x + w(0), y: m.leftHand!.y + w(1), z: m.leftHand!.z + w(2) },
        rightHand: { x: m.rightHand!.x + w(3), y: m.rightHand!.y + w(4), z: m.rightHand!.z + w(5) },
      };
    };
    const real = throwsOf(snaps(0.3, 4));
    for (const fps of [30, 60]) {
      const run = runContact((s) => wander(s) ?? real(s), 34.5, { fps, cam: CAMS[1][1], noise: { seed: 5, ...NOISE } });
      const read = ends(run.events, 4.5);
      const harmless = read.filter((e) => e.touch).length;
      rows.push(
        `${fps} poses a second, restless hands for 30 s: the reader confirmed ${read.length} punches; ${harmless} rated as touches, ${read.length - harmless} as weak punches (${read.filter((e) => !e.touch).map((e) => e.quality.toFixed(2)).join(" ")})`,
      );
      // Most are stopped here. The rest are the reader's to stop: see the report.
      expect(harmless / Math.max(1, read.length)).toBeGreaterThanOrEqual(0.65);
      for (const e of read.filter((x) => !x.touch)) expect(e.quality).toBeLessThan(0.9);
    }
    console.log("quality, flicks and restless hands, desk laptop, 0.5 cm of noise\n" + rows.join("\n"));
  });
});
