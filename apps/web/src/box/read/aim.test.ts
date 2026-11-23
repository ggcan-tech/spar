import { describe, expect, it } from "vitest";
import type { SyntheticMotion } from "../../pov/syntheticBody";
import { GUARD, stance } from "../scriptedBoxer";
import {
  AIM,
  bodyPoint,
  calibrateAim,
  defaultMarks,
  learnMarks,
  recentred,
  solveArm,
  tooSteep,
  zoneOf,
  type AimSetup,
  type AimSource,
} from "./aim";
import { CAMS, M, SETUP_S, ease, f0, f1, mean, runWithSetup, skeleton, spread, type Cam, type Noise } from "./rig";

/**
 * The perception study's aim table (finding 4), kept as a test: the fist at
 * full stretch at nine targets, three heights by three sides, seen by four
 * cameras with 1.5 cm of noise, through the real tracker. Measured on a
 * scripted person; a real elbow is often hidden by the fist.
 */
const HEIGHTS: [string, number][] = [
  ["head", 0.18],
  ["chest", -0.06],
  ["belly", -0.3],
];
/** Metres from the left shoulder toward the body's middle: the middle one is the body's middle. */
const SIDES: [string, number][] = [
  ["own side", 0.06],
  ["middle", 0.185],
  ["across", 0.31],
];
const THIRDS = ["left", "middle", "right"] as const;
const LEVELS = ["head", "chest", "belly"] as const;
const guardLeft = { x: GUARD.in, y: GUARD.up, z: GUARD.fwd },
  guardRight = { x: -GUARD.in, y: GUARD.up, z: GUARD.fwd };
const TARGETS: { hi: number; si: number; reach: number }[] = [];
for (const reach of [1, 0.85]) for (let hi = 0; hi < 3; hi++) for (let si = 0; si < 3; si++) TARGETS.push({ hi, si, reach });
const EACH = 0.9;
/** The left fist goes from the guard to one target after another and holds there for a moment. */
function toTargets(s: number, more: (m: SyntheticMotion) => SyntheticMotion = (m) => m): SyntheticMotion {
  const n = Math.max(0, Math.floor(s / EACH));
  const q = s - n * EACH;
  const it = TARGETS[n % TARGETS.length];
  const length = 0.54 * it.reach;
  const across = SIDES[it.si][1],
    up = HEIGHTS[it.hi][1];
  const end = { x: across, y: up, z: Math.sqrt(Math.max(0.01, length * length - across * across - up * up)) };
  const out = q < 0.3 ? 0 : q < 0.5 ? ease((q - 0.3) / 0.2) : q < 0.62 ? 1 : 1 - ease((q - 0.62) / 0.22);
  return more({
    leftHand: { x: guardLeft.x + (end.x - guardLeft.x) * out, y: guardLeft.y + (end.y - guardLeft.y) * out, z: guardLeft.z + (end.z - guardLeft.z) * out },
    rightHand: guardRight,
    // The punching shoulder comes forward, as in the study.
    twist: -0.28 * it.reach * out,
  });
}
const atFullStretch = (s: number) => {
  const q = s - Math.floor(s / EACH) * EACH;
  return s >= 0 && q >= 0.55 && q <= 0.6;
};
const nearest = (v: number, marks: number[]) => marks.reduce((best, m, i) => (Math.abs(v - m) < Math.abs(v - marks[best]) ? i : best), 0);
const CAMERAS: [string, Cam][] = [CAMS[0], CAMS[1], CAMS[2], CAMS[5]];
const NOISE: Omit<Noise, "seed"> = { sigma: 0.015, depth: 0.06 };

interface Tally {
  across: number[];
  up: number[];
  heightRight: number;
  sideRight: number;
  n: number;
}
const tally = (): Tally => ({ across: [], up: [], heightRight: 0, sideRight: 0, n: 0 });
const say = (t: Tally) =>
  `across ${f1(mean(t.across))} ± ${f1(spread(t.across))}, up ${f1(mean(t.up))} ± ${f1(spread(t.up))} cm, height right ${f0((100 * t.heightRight) / t.n)}%, side right ${f0((100 * t.sideRight) / t.n)}%`;

describe("where the punch goes", () => {
  it("is within about ±4 cm and right for nine targets from four camera heights at 1.5 cm of noise (the study's table)", () => {
    const rows: string[] = [];
    for (const [camName, c] of CAMERAS) {
      const solved = tally(),
        picture = tally(),
        wristOnly = tally(),
        rangeOut = tally();
      let tilt = 0,
        steep = false,
        elbows = 0;
      for (const seed of [1, 2, 3]) {
        const held: AimSource[] = [];
        let wrong: AimSetup | null = null;
        const run = runWithSetup(toTargets, EACH * TARGETS.length, { cam: c, noise: { seed, ...NOISE } }, (p) => {
          // A second set-up made with the range 10% out, as a wrong lens angle would make it.
          const sinceSetup = p.s + SETUP_S;
          if (sinceSetup >= 0.45 && sinceSetup <= 1.05) held.push(p.result);
          if (sinceSetup > 1.1 && !wrong) wrong = calibrateAim(held, p.range.units * 1.1, p.arms);
          if (!p.setup || !wrong || !atFullStretch(p.s)) return;
          const it = TARGETS[Math.floor(p.s / EACH) % TARGETS.length];
          const sk = skeleton(toTargets(p.s));
          const truth = { x: sk.get(15)!.x - sk.get(11)!.x, up: sk.get(15)!.y - sk.get(11)!.y };
          const arm = p.setup.reach[0] * M;
          const note = (t: Tally, across: number, up: number, point: { x: number; y: number } | null) => {
            t.across.push((across - truth.x) * 100);
            t.up.push((up - truth.up) * 100);
            t.n++;
            if (point) {
              // The zones, set to the study's nine targets: rows 24 cm apart from the head's, columns 12.5 cm about the body's middle.
              const zone = zoneOf(point, "left", { head: HEIGHTS[0][1] / arm, middle: [0, 0] });
              if (zone.height === LEVELS[it.hi]) t.heightRight++;
              if (zone.third === THIRDS[it.si]) t.sideRight++;
            } else {
              if (nearest(up, HEIGHTS.map((h) => h[1])) === it.hi) t.heightRight++;
              if (nearest(across, SIDES.map((h) => h[1])) === it.si) t.sideRight++;
            }
          };
          const a = solveArm(p.result, "left", p.setup, p.range.units)!;
          note(solved, a.across * arm, a.up * arm, a.point);
          if (a.elbow) elbows++;
          // The picture alone: the wrist against the shoulder as the tracker has them.
          const j = p.result.joints!;
          note(picture, (j[7].x - j[3].x) * M, (j[7].y - j[3].y) * M, null);
          const w = solveArm(p.result, "left", p.setup, p.range.units, { wristOnly: true })!;
          note(wristOnly, w.across * arm, w.up * arm, w.point);
          const far = solveArm(p.result, "left", wrong, p.range.units * 1.1)!;
          note(rangeOut, far.across * wrong.reach[0] * M, far.up * wrong.reach[0] * M, null);
        });
        tilt = run.setup!.tiltDeg;
        steep = tooSteep(run.setup!);
      }
      const sight = (Math.atan2(1.41 - c.height, c.distance) * 180) / Math.PI;
      rows.push(
        `${camName} (line of sight to the shoulders ${f1(sight)}°, found ${f1(tilt)}°)\n    solved: ${say(solved)}\n    the picture alone: ${say(picture)}\n    wrist alone on a sphere of arm's length: ${say(wristOnly)}\n    solved with the range 10% out: ${say(rangeOut)}`,
      );
      // The study: ±1.8–3.4 cm up and down, ±1.5 across, 100% right.
      expect(Math.abs(mean(solved.up))).toBeLessThan(1.5);
      expect(spread(solved.up)).toBeLessThan(4);
      expect(Math.abs(mean(solved.across))).toBeLessThan(1);
      expect(spread(solved.across)).toBeLessThan(2.2);
      expect(solved.heightRight / solved.n).toBeGreaterThanOrEqual(0.98);
      expect(solved.sideRight / solved.n).toBeGreaterThanOrEqual(0.97);
      expect(elbows / solved.n).toBeGreaterThan(0.9);
      // The tilt is found to a few degrees, and none of these four is too steep to play from.
      expect(Math.abs(tilt - sight)).toBeLessThan(3.5);
      expect(steep).toBe(false);
      // With the range (or the lens angle) 10% out: the study's "bias under 4 cm, spread under 5".
      expect(Math.abs(mean(rangeOut.up))).toBeLessThan(4);
      expect(spread(rangeOut.up)).toBeLessThan(5);
      // The wrist alone, when the elbow cannot be trusted: rougher, still mostly the right height.
      expect(wristOnly.heightRight / wristOnly.n).toBeGreaterThanOrEqual(0.9);
      expect(Math.abs(mean(wristOnly.up))).toBeLessThan(6.5);
      // And the picture alone is what the study said: far out from below or above, about right from chest height.
      if (camName.startsWith("low table")) expect(mean(picture.up)).toBeGreaterThan(12);
      if (camName.startsWith("desk laptop")) expect(mean(picture.up)).toBeGreaterThan(8);
      if (camName.startsWith("shelf")) expect(mean(picture.up)).toBeLessThan(-6);
    }
    console.log("aim at full stretch, scripted person through the tracker, 1.5 cm of noise (errors in cm)\n" + rows.join("\n"));
  });

  it("falls back to the wrist alone when the elbow is hidden, and says so", () => {
    const rows: string[] = [];
    for (const [camName, c] of [CAMS[1], CAMS[2]] as [string, Cam][]) {
      const t = tally();
      let withElbow = 0;
      runWithSetup(
        toTargets,
        EACH * 9,
        {
          cam: c,
          noise: { seed: 4, ...NOISE },
          // The fist in front of the elbow: the model stops being sure of it.
          fault: (frame, s) => (s > SETUP_S ? { ...frame, lm: frame.lm.map((p, i) => (i === 13 ? { ...p, v: 0.2 } : p)) } : frame),
        },
        (p) => {
          if (!p.setup || !atFullStretch(p.s)) return;
          const it = TARGETS[Math.floor(p.s / EACH) % TARGETS.length];
          const a = solveArm(p.result, "left", p.setup, p.range.units)!;
          if (a.elbow) withElbow++;
          const arm = p.setup.reach[0] * M;
          const sk = skeleton(toTargets(p.s));
          t.up.push((a.up * arm - (sk.get(15)!.y - sk.get(11)!.y)) * 100);
          t.across.push((a.across * arm - (sk.get(15)!.x - sk.get(11)!.x)) * 100);
          t.n++;
          const zone = zoneOf(a.point, "left", { head: HEIGHTS[0][1] / arm, middle: [0, 0] });
          if (zone.height === LEVELS[it.hi]) t.heightRight++;
          if (zone.third === THIRDS[it.si]) t.sideRight++;
        },
      );
      rows.push(`${camName}, elbow hidden: ${say(t)}`);
      expect(t.n).toBeGreaterThan(8);
      expect(withElbow).toBe(0);
      expect(t.heightRight / t.n).toBeGreaterThanOrEqual(0.85);
      expect(Math.abs(mean(t.up))).toBeLessThan(6);
    }
    console.log("aim with the elbow hidden (full reach)\n" + rows.join("\n"));
  });

  it("asks again when the arms were not out, not straight or not still", () => {
    const c = CAMS[1][1];
    const guard: AimSource[] = [],
      moving: AimSource[] = [];
    let range = 0,
      arms = null as Parameters<typeof calibrateAim>[2];
    const run = runWithSetup(() => stance(), 0.6, { cam: c }, (p) => {
      const since = p.s + SETUP_S;
      range = p.range.units;
      arms = p.arms;
      // The arms on their way out are not a set-up; nor is the guard.
      if (since >= 0.05 && since <= 0.28) moving.push(p.result);
      if (p.s > 0.1) guard.push(p.result);
    });
    expect(run.setup).not.toBeNull();
    expect(calibrateAim(guard, range, arms)).toBeNull();
    expect(calibrateAim(moving, range, arms)).toBeNull();
    expect(calibrateAim(guard.slice(0, 2), range, arms)).toBeNull();
    expect(calibrateAim([], range, arms)).toBeNull();
    // Arms hanging at the sides are straight and still too, and are not a set-up: found when the game took its set-up from a player just standing there.
    const hanging: AimSource[] = [];
    const down = { leftHand: { x: -0.05, y: -0.5, z: 0.08 }, rightHand: { x: 0.05, y: -0.5, z: 0.08 } };
    runWithSetup(() => down, 0.6, { cam: c }, (p) => {
      if (p.s > 0.1) hanging.push(p.result);
    });
    expect(hanging.length).toBeGreaterThan(6);
    expect(calibrateAim(hanging, range, arms)).toBeNull();
    // A set-up says how still the arms were held.
    expect(run.setup!.spreadCm).toBeLessThan(1);
    expect(run.setup!.reach[0]).toBeGreaterThan(0.5);
  });

  it("moves the point with the body: a punch from a slip lands to the side, one from a crouch lands lower", () => {
    const c = CAMS[2][1];
    const straight = (s: number): SyntheticMotion => {
      const out = s < 0.4 ? 0 : s < 0.6 ? ease((s - 0.4) / 0.2) : 1;
      return {
        leftHand: { x: guardLeft.x + (0.13 - guardLeft.x) * out, y: guardLeft.y + (0.08 - guardLeft.y) * out, z: guardLeft.z + (0.5 - guardLeft.z) * out },
        rightHand: guardRight,
      };
    };
    const end = (body: Parameters<typeof stance>[0]) => {
      const got = { x: 0, y: 0 };
      runWithSetup(
        (s) => {
          const b = stance(body);
          return { ...b, ...straight(s) };
        },
        0.9,
        { cam: c },
        (p) => {
          if (p.setup && p.s > 0.7) {
            const at = solveArm(p.result, "left", p.setup, p.range.units)!.point;
            const arm = p.setup.reach[0] * M * 100;
            got.x = at.x * arm;
            got.y = at.y * arm;
          }
        },
      );
      return got;
    };
    const still = end({}),
      slipped = end({ lean: -0.15 }),
      ducked = end({ crouch: 0.2 });
    // The script's slip carries the hips 6 cm and the shoulders 15 cm more to the player's left: 21 cm in all.
    expect(slipped.x - still.x).toBeLessThan(-16);
    expect(slipped.x - still.x).toBeGreaterThan(-26);
    expect(Math.abs(slipped.y - still.y)).toBeLessThan(4);
    expect(ducked.y - still.y).toBeLessThan(-15);
  });

  it("names six zones, and lets the marks follow this player's own punches", () => {
    const marks = defaultMarks();
    // A left straight at the head ends a little to its own side of the middle, above the shoulder line.
    expect(zoneOf({ x: -AIM.ownSide, y: AIM.headUp }, "left", marks)).toEqual({ level: "head", third: "middle", height: "head" });
    expect(zoneOf({ x: AIM.ownSide, y: AIM.headUp }, "right", marks)).toEqual({ level: "head", third: "middle", height: "head" });
    // 24 cm lower is the chest, 48 the belly: both "body" to the rules.
    expect(zoneOf({ x: -AIM.ownSide, y: AIM.headUp - AIM.rows }, "left", marks).height).toBe("chest");
    expect(zoneOf({ x: -AIM.ownSide, y: AIM.headUp - AIM.rows }, "left", marks).level).toBe("body");
    expect(zoneOf({ x: -AIM.ownSide, y: AIM.headUp - 2 * AIM.rows }, "left", marks).height).toBe("belly");
    // 12.5 cm to either side is another third, as the player sees the opponent.
    expect(zoneOf({ x: -AIM.ownSide - AIM.columns, y: AIM.headUp }, "left", marks).third).toBe("left");
    expect(zoneOf({ x: -AIM.ownSide + AIM.columns, y: AIM.headUp }, "left", marks).third).toBe("right");
    // A player who punches low and wide: three head punches a hand in set-up move the marks there.
    const learned = learnMarks([
      { hand: "left", point: { x: -0.3, y: 0.02 } },
      { hand: "left", point: { x: -0.28, y: 0.0 } },
      { hand: "left", point: { x: -0.32, y: 0.04 } },
      { hand: "right", point: { x: 0.2, y: 0.03 } },
    ]);
    expect(learned.middle[0]).toBeCloseTo(-0.3, 5);
    // The right hand threw only one: its mark stays.
    expect(learned.middle[1]).toBe(marks.middle[1]);
    expect(learned.head).toBeCloseTo(0.03, 5);
    expect(zoneOf({ x: -0.3, y: 0.02 }, "left", learned)).toEqual({ level: "head", third: "middle", height: "head" });
    expect(zoneOf({ x: -0.3, y: 0.02 }, "left", marks).level).toBe("head");
    expect(zoneOf({ x: -0.3, y: 0.02 }, "left", marks).third).toBe("left");
  });

  it("places the head and keeps its places when the tracker takes a new centre", () => {
    const c = CAMS[1][1];
    const seen: { setup: AimSetup; last: AimSource; range: number }[] = [];
    runWithSetup(() => stance({ lean: 0.1 }), 0.5, { cam: c }, (p) => {
      if (p.setup) seen.push({ setup: p.setup, last: p.result, range: p.range.units });
    });
    const { setup, last, range } = seen[seen.length - 1];
    const nose = bodyPoint(last, last.joints![0], setup, range, 0.17)!;
    // The scripted nose is 17 cm above the shoulder line: 0.31 of a 0.55 m arm.
    expect((nose.point.y - nose.shoulders.y) * setup.reach[0] * M * 100).toBeGreaterThan(14);
    expect((nose.point.y - nose.shoulders.y) * setup.reach[0] * M * 100).toBeLessThan(20);
    // The body leant 14 cm to the player's right after set-up: the shoulders say so.
    expect(nose.shoulders.x * setup.reach[0] * M * 100).toBeGreaterThan(9);
    // The tracker takes a new centre where the body now is: the same fist reads the same place.
    expect(Math.abs(last.root.x)).toBeGreaterThan(0.02);
    const before = solveArm(last, "left", setup, range)!;
    const moved: AimSource = { ...last, root: { x: 0, y: 0, z: 0 } };
    const after = solveArm(moved, "left", recentred(setup, last.root), range)!;
    expect(after.point.x).toBeCloseTo(before.point.x, 6);
    expect(after.point.y).toBeCloseTo(before.point.y, 6);
  });
});
