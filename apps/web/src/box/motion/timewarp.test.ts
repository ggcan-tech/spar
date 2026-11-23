import { describe, expect, it } from "vitest";
import { TEST_PACK } from "./fixture";
import { RATE_LIMITS, clipTimeAt, planFeint, planPunch, type ClipTimes, type TimeMap } from "./timewarp";

/**
 * Time-warping: contact falls on the time the rules chose, the load plays
 * at 0.6 to 1.0 of its speed and the strike at 0.9 to 1.1, and no frame is
 * ever held.
 */
const clip: ClipTimes = { first: 0.1, launch: 0.25, contact: 0.45, guard: 0.85, end: 0.95 };
const want = (start: number, load: number, strike: number, home = 0.4) => ({
  start,
  commit: start + load,
  impact: start + load + strike,
  home: start + load + strike + home,
});
/** The speed the clip plays at between each pair of knots. */
const speeds = (map: TimeMap) =>
  map.knots.slice(1).map((k, i) => (k.clip - map.knots[i].clip) / (k.at - map.knots[i].at));
/** Which part of the clip a stretch between knots is. */
const partOf = (c: ClipTimes, from: number) => (from < c.launch - 1e-9 ? "load" : from < c.contact - 1e-9 ? "strike" : from < c.guard - 1e-9 ? "home" : "tail");

describe("the plan for a punch", () => {
  it("plays the clip as recorded when asked for the clip's own times", () => {
    const map = planPunch(clip, want(10, 0.15, 0.2, 0.4));
    for (const rate of Object.values(map.rates)) expect(rate).toBeCloseTo(1, 9);
    expect(map.begins).toBeCloseTo(10, 9);
    expect(clipTimeAt(map, 10)).toBeCloseTo(clip.first, 9);
    expect(clipTimeAt(map, 10.15)).toBeCloseTo(clip.launch, 9);
    expect(clipTimeAt(map, 10.35)).toBeCloseTo(clip.contact, 9);
    expect(clipTimeAt(map, 10.75)).toBeCloseTo(clip.guard, 9);
    expect(clipTimeAt(map, 99)).toBeCloseTo(clip.end, 9);
  });

  it("puts contact on the impact whatever is asked, and keeps every part inside its limits", () => {
    for (const load of [0.02, 0.1, 0.15, 0.2, 0.25, 0.4, 0.9])
      for (const strike of [0.1, 0.18, 0.2, 0.22, 0.3])
        for (const home of [0.1, 0.4, 1.2]) {
          const w = want(3, load, strike, home);
          const map = planPunch(clip, w);
          expect(clipTimeAt(map, w.impact)).toBeCloseTo(clip.contact, 9);
          expect(map.lands).toBeCloseTo(w.impact, 9);
          expect(map.rates.load).toBeGreaterThanOrEqual(RATE_LIMITS.load[0]);
          expect(map.rates.load).toBeLessThanOrEqual(RATE_LIMITS.load[1]);
          expect(map.rates.strike).toBeGreaterThanOrEqual(RATE_LIMITS.strike[0]);
          expect(map.rates.strike).toBeLessThanOrEqual(RATE_LIMITS.strike[1]);
          // The same, read off the knots themselves.
          speeds(map).forEach((speed, i) => {
            const part = partOf(clip, map.knots[i].clip);
            const [low, high] = part === "load" ? RATE_LIMITS.load : part === "strike" ? RATE_LIMITS.strike : part === "home" ? RATE_LIMITS.home : [1, 1];
            expect(speed, `${part} for load ${load} strike ${strike}`).toBeGreaterThanOrEqual(low - 1e-9);
            expect(speed, `${part} for load ${load} strike ${strike}`).toBeLessThanOrEqual(high + 1e-9);
          });
        }
  });

  it("never holds a frame: the clip's time always moves forward while it plays", () => {
    for (const load of [0.02, 0.15, 0.9]) {
      const w = want(3, load, 0.2);
      const map = planPunch(clip, w);
      let last = -Infinity;
      for (let t = map.begins; t <= map.ends; t += 1 / 240) {
        const c = clipTimeAt(map, t);
        if (last > -Infinity) expect(c).toBeGreaterThan(last);
        last = c;
      }
    }
  });

  it("starts late, with the guard going on, when asked for a longer load than the slowest allowed", () => {
    // The load is 0.15 s; at 0.6 of its speed it lasts 0.25 s. Asked for 0.9 s.
    const w = want(3, 0.9, 0.2);
    const map = planPunch(clip, w);
    expect(map.rates.load).toBeCloseTo(0.6, 9);
    expect(map.begins).toBeCloseTo(w.commit - 0.25, 9);
    expect(map.begins).toBeGreaterThan(w.start);
  });

  it("skips the beginning of the load when asked for a shorter one than the clip has", () => {
    const w = want(3, 0.05, 0.2);
    const map = planPunch(clip, w);
    expect(map.begins).toBeCloseTo(3, 9);
    expect(map.rates.load).toBe(1);
    // It comes in 0.05 s before the launch.
    expect(clipTimeAt(map, 3)).toBeCloseTo(clip.launch - 0.05, 9);
    expect(clipTimeAt(map, w.commit)).toBeCloseTo(clip.launch, 9);
  });

  it("comes in part-way through the strike when there is no time even for that", () => {
    const w = { start: 3, commit: 3, impact: 3.1, home: 3.5 };
    const map = planPunch(clip, w);
    expect(map.rates.strike).toBeCloseTo(1.1, 9);
    expect(clipTimeAt(map, 3)).toBeCloseTo(clip.contact - 0.1 * 1.1, 9);
    expect(clipTimeAt(map, 3.1)).toBeCloseTo(clip.contact, 9);
  });

  it("brings the hand home when the rules say, within what a hand can do", () => {
    expect(planPunch(clip, want(3, 0.15, 0.2, 0.4)).homes).toBeCloseTo(3.75, 9);
    // Asked for twice as fast: only 1.3 times is given.
    expect(planPunch(clip, want(3, 0.15, 0.2, 0.2)).homes).toBeCloseTo(3.35 + 0.4 / 1.3, 9);
    expect(planPunch(clip, want(3, 0.15, 0.2, 2)).homes).toBeCloseTo(3.35 + 0.4 / 0.7, 9);
  });

  it("planned again part-way, runs on from where the clip is", () => {
    const w = want(3, 0.15, 0.2);
    const map = planPunch(clip, w);
    const now = 3.1;
    const at = clipTimeAt(map, now);
    // The rules move the impact 30 ms later, before the fist has left.
    const later = planPunch(clip, { ...w, commit: w.commit + 0.03, impact: w.impact + 0.03 }, RATE_LIMITS, { at: now, clip: at });
    expect(clipTimeAt(later, now)).toBeCloseTo(at, 9);
    expect(clipTimeAt(later, w.impact + 0.03)).toBeCloseTo(clip.contact, 9);
    // In flight, the fist may only be hurried or slowed within the strike's limits: a large move is not followed.
    const flying = { at: 3.25, clip: clipTimeAt(map, 3.25) };
    const far = planPunch(clip, { ...w, impact: w.impact + 0.3 }, RATE_LIMITS, flying);
    expect(far.rates.strike).toBeCloseTo(0.9, 9);
    expect(far.lands).toBeLessThan(w.impact + 0.05);
  });

  it("holds for every punch in the pack played at the times the rules are given", () => {
    for (const c of TEST_PACK.clips.filter((x) => x.punches.length === 1)) {
      const e = c.punches[0].events;
      const times: ClipTimes = { first: e.first / c.fps, launch: e.launch / c.fps, contact: e.contact / c.fps, guard: e.guard / c.fps, end: (c.frames - 1) / c.fps };
      // A slow beginner's version: half as long again.
      const own = want(0, (times.launch - times.first) * 1.5, times.contact - times.launch);
      const map = planPunch(times, own);
      expect(clipTimeAt(map, own.impact), c.id).toBeCloseTo(times.contact, 9);
      expect(map.rates.load, c.id).toBeCloseTo(1 / 1.5, 6);
      expect(map.rates.strike, c.id).toBeCloseTo(1, 6);
    }
  });
});

describe("the plan for a feint", () => {
  const frame = 1 / 60;
  it("shows the punch up to two frames before its launch, and no further", () => {
    const map = planFeint(clip, 3, 3.15, frame);
    expect(clipTimeAt(map, 3.15)).toBeCloseTo(clip.launch - 2 * frame, 9);
    expect(clipTimeAt(map, 9)).toBeCloseTo(clip.launch - 2 * frame, 9);
    expect(map.ends).toBe(3.15);
    for (let t = 3; t <= 4; t += 0.01) expect(clipTimeAt(map, t)).toBeLessThan(clip.launch);
  });
  it("keeps the load inside its limits", () => {
    for (const span of [0.03, 0.1, 0.15, 0.3, 1]) {
      const map = planFeint(clip, 3, 3 + span, frame);
      expect(map.rates.load).toBeGreaterThanOrEqual(0.6);
      expect(map.rates.load).toBeLessThanOrEqual(1);
      for (const speed of speeds(map)) {
        expect(speed).toBeGreaterThanOrEqual(0.6 - 1e-9);
        expect(speed).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});
