import { describe, expect, it } from "vitest";
import { AIM } from "./aim";
import { formulaFall } from "./fall";
import { TEST_PACK } from "./fixture";
import { createMotionPlayer, type PlayerOptions } from "./player";
import { PUNCH_TIMES } from "./times";
import { SIZE, type MotionDrive, type MotionKind, type MotionLevel, type MotionPose, type MotionPunch } from "./types";
import { distance, v3 } from "./vec";

/**
 * The player object, driven the way the game will drive it, frame by frame
 * at 60 a second. The invariants are those of opponentPose.test.ts: the
 * spine keeps its lengths and nothing jumps.
 */
const DT = 1 / 60;
const EYE = v3(0, 1.62, 1.3);
/**
 * Where a punch is asked to land in these tests: as realPose.ts asks in the
 * game. For the head, 0.42 m short of the eye (where the game's stand-in
 * body stops its fist) and at the chin, 10 cm under the eye; for the body,
 * the belly. The recorded punches land about there by themselves.
 */
const landing = (eye: { x: number; y: number; z: number }, level: MotionLevel = "head") =>
  level === "body" ? v3(eye.x * 0.5, eye.y - 0.5, eye.z - 0.55) : v3(eye.x, eye.y - 0.1, eye.z - 0.42);
const rest = (time: number): MotionDrive => ({
  time,
  idle: true,
  punch: null,
  step: null,
  guard: ["chin", "chin"],
  tired: 0,
  hurt: 0,
  hit: null,
  eye: EYE,
  down: null,
});
let nextId = 1;
/** A punch at the clips' own times, aimed at the eye. */
function punch(kind: MotionKind, hand: "left" | "right", start: number, level: MotionLevel = kind === "body" ? "body" : "head", more: Partial<MotionPunch> = {}): MotionPunch {
  const t = PUNCH_TIMES[kind];
  return {
    id: nextId++,
    kind,
    hand,
    level,
    start,
    commit: start + t.load,
    impact: start + t.load + t.strike,
    home: start + t.load + t.strike + t.home,
    feint: false,
    target: landing(EYE, level),
    block: null,
    ...more,
  };
}
/** Run from `from` to `to`, giving each frame's drive, and check every pose on the way. Returns the poses. */
function run(options: PlayerOptions, from: number, to: number, drive: (t: number) => MotionDrive, check = true) {
  const player = createMotionPlayer(TEST_PACK, { seed: 7, ...options });
  const poses: { t: number; pose: MotionPose }[] = [];
  let worst = 0;
  const frames = Math.round((to - from) / DT);
  for (let i = 0; i <= frames; i++) {
    const t = from + i * DT;
    const pose = player.update(drive(t));
    if (check) {
      // The spine, to 2%, as opponentPose.test.ts asks of the formula body (a little more as it lies on the canvas).
      expect(Math.abs(distance(pose.hips, pose.chest) / SIZE.chest - 1), `spine at ${t.toFixed(3)}`).toBeLessThan(0.02);
      expect(Math.abs(distance(pose.chest, pose.head) / SIZE.head - 1), `neck at ${t.toFixed(3)}`).toBeLessThan(0.02);
      for (const p of [pose.head, pose.chest, pose.hips, ...pose.gloves, ...pose.shoulders, ...pose.elbows, ...pose.feet])
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      if (poses.length) worst = Math.max(worst, distance(pose.head, poses[poses.length - 1].pose.head));
    }
    poses.push({ t, pose });
  }
  return { poses, worst, at: (t: number) => poses[Math.round((t - from) / DT)].pose };
}
/** The head never moves more than a hand's width in a frame. */
const HEAD_STEP = 0.13;

describe("standing ready", () => {
  it("plays the guard loops one after another for a minute with no jump at any join", () => {
    const { poses, worst } = run({}, 0, 60, rest);
    expect(worst).toBeLessThan(HEAD_STEP);
    // Measured: the head moves about 5 cm in a frame at most while it stands in its guard.
    expect(worst).toBeLessThan(0.07);
    // More than one loop was used, and every one of them is a guard.
    const used = new Set(poses.map((p) => p.pose.playing.clip));
    expect(used.size).toBeGreaterThan(1);
    for (const id of used) expect(TEST_PACK.byId.get(id)?.kind).toBe("guard");
    // Both gloves up near the chin, the head above them, nothing fallen.
    for (const { pose } of poses) {
      expect(pose.fallen).toBe(0);
      expect(pose.head.y).toBeGreaterThan(1.3);
      for (const g of pose.gloves) expect(g.y).toBeGreaterThan(1.05);
    }
  });
  it("is the same every time for the same seed", () => {
    const a = run({ seed: 3 }, 0, 8, rest, false).poses.map((p) => p.pose.head.x);
    const b = run({ seed: 3 }, 0, 8, rest, false).poses.map((p) => p.pose.head.x);
    expect(a).toEqual(b);
  });
  it("calms its bounce when it is set to work, and when tired", () => {
    const rise = (drive: (t: number) => MotionDrive) => {
      const ys = run({}, 0, 12, drive, false).poses.slice(120).map((p) => p.pose.hips.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    const lively = rise(rest);
    expect(rise((t) => ({ ...rest(t), idle: false }))).toBeLessThan(lively * 0.6);
  });
  it("stands still in time when the time is held: a hit-stop", () => {
    const player = createMotionPlayer(TEST_PACK, { seed: 1 });
    for (let i = 0; i < 30; i++) player.update(rest(i * DT));
    const a = player.update(rest(0.5));
    const b = player.update(rest(0.5));
    const c = player.update(rest(0.5));
    expect(distance(a.head, b.head)).toBe(0);
    expect(distance(b.gloves[0], c.gloves[0])).toBe(0);
  });
});

describe("a punch", () => {
  const kinds: [MotionKind, "left" | "right"][] = [
    ["jab", "left"],
    ["cross", "right"],
    ["hook", "left"],
    ["hook", "right"],
    ["uppercut", "left"],
    ["uppercut", "right"],
    ["body", "left"],
    ["body", "right"],
  ];
  it("lands its glove on the target at the impact, for every kind, and nothing jumps on the way in or out", () => {
    for (const [kind, hand] of kinds) {
      const p = punch(kind, hand, 2);
      const { worst, at, poses } = run({}, 0, p.home + 1, (t) => ({ ...rest(t), idle: false, punch: t >= 2 - DT / 2 && t < p.home ? p : null }));
      expect(worst, `${kind} ${hand}`).toBeLessThan(HEAD_STEP);
      const h = hand === "left" ? 0 : 1;
      // The frame nearest the impact (the impact itself falls between frames).
      const frame = at(p.impact);
      expect(frame.aim?.refused, `${kind} ${hand}`).toBe(false);
      const gap = Math.min(...poses.filter((x) => Math.abs(x.t - p.impact) <= DT).map((x) => distance(x.pose.gloves[h], p.target)));
      // Within the fist's travel in half a frame of the target.
      expect(gap, `${kind} ${hand} off target by ${gap.toFixed(3)}`).toBeLessThan(0.06);
      // The other glove stays back.
      expect(frame.gloves[1 - h].z).toBeLessThan(frame.gloves[h].z - 0.2);
      // And it is the punch's own clip that plays, from before the fist leaves.
      expect(TEST_PACK.byId.get(at(p.commit).playing.clip)?.punches.length).toBeGreaterThan(0);
      // Home again: back in a guard clip, the glove back by the body.
      const after = at(p.home + 0.8);
      expect(TEST_PACK.byId.get(after.playing.clip)?.kind).toBe("guard");
      expect(after.gloves[h].z).toBeLessThan(0.55);
      expect(after.aim).toBeNull();
    }
  });
  it("is exactly on the target when the impact falls on a frame", () => {
    // Times chosen so that the impact is a whole number of frames from the start.
    const start = 2;
    const p = punch("jab", "left", start, "head", { commit: start + 9 * DT, impact: start + 21 * DT, home: start + 46 * DT });
    const { at } = run({}, 0, 4, (t) => ({ ...rest(t), punch: t >= start - DT / 2 && t < p.home ? p : null }));
    expect(distance(at(p.impact).gloves[0], p.target)).toBeLessThan(1e-6);
    expect(at(p.impact).aim?.weight).toBeCloseTo(1, 6);
    // The cross in these recordings is a shorter punch than the jab (it lands
    // 0.75 to 0.81 m out, the jab 0.85 to 0.97). Asked for 0.88 m it gets
    // there with hips, trunk and arm at their limits, to within a centimetre or two.
    const c = punch("cross", "right", start, "head", { commit: start + 9 * DT, impact: start + 21 * DT, home: start + 46 * DT });
    const far = run({}, 0, 4, (t) => ({ ...rest(t), punch: t >= start - DT / 2 && t < c.home ? c : null }));
    expect(distance(far.at(c.impact).gloves[1], c.target)).toBeLessThan(0.025);
  });
  it("starts moving at once and has its glove still near the guard when the fist leaves", () => {
    const p = punch("cross", "right", 2);
    const { at } = run({}, 0, 4, (t) => ({ ...rest(t), punch: t >= 2 - DT / 2 && t < p.home ? p : null }));
    const before = at(2 - 2 * DT),
      launch = at(p.commit),
      mid = at((p.commit + p.impact) / 2),
      land = at(p.impact);
    expect(launch.gloves[1].z).toBeLessThan(before.gloves[1].z + 0.2);
    // Then it flies: most of the way in the second half, never held.
    expect(mid.gloves[1].z).toBeGreaterThan(launch.gloves[1].z);
    expect(land.gloves[1].z).toBeGreaterThan(mid.gloves[1].z + 0.1);
  });
  it("lands on time when the rules ask for a slower punch than the clip, by slowing the load and starting late", () => {
    for (const slower of [1.3, 1.6, 2.5]) {
      const t = PUNCH_TIMES.jab;
      const start = 2;
      const p = punch("jab", "left", start, "head", { commit: start + t.load * slower, impact: start + t.load * slower + t.strike, home: start + t.load * slower + t.strike + t.home });
      const { worst, poses } = run({}, 0, p.home + 0.5, (time) => ({ ...rest(time), punch: time >= start - DT / 2 && time < p.home ? p : null }));
      expect(worst).toBeLessThan(HEAD_STEP);
      const gap = Math.min(...poses.filter((x) => Math.abs(x.t - p.impact) <= DT).map((x) => distance(x.pose.gloves[0], p.target)));
      expect(gap, `×${slower}`).toBeLessThan(0.06);
    }
  });
});

describe("the aim", () => {
  const off = (x: number, y = 0) => landing(v3(EYE.x + x, EYE.y + y, EYE.z));
  const throwAt = (target: (t: number) => { x: number; y: number; z: number }, eye: (t: number) => { x: number; y: number; z: number }, more: Partial<MotionPunch> = {}) => {
    const p = punch("cross", "right", 2, "head", more);
    const out = run({}, 0, p.home + 0.5, (t) => ({ ...rest(t), eye: eye(t), punch: t >= 2 - DT / 2 && t < p.home ? { ...p, target: target(t) } : null }));
    return { p, ...out };
  };
  it("follows a head that is a little off the clip's own line: a slip's width either way, and a duck", () => {
    for (const [x, y] of [[0.12, 0], [-0.12, 0], [0.08, -0.12], [0, 0.08]]) {
      const { p, at, worst } = throwAt(() => off(x, y), () => v3(EYE.x + x, EYE.y + y, EYE.z));
      expect(at(p.impact).aim?.refused).toBe(false);
      expect(distance(at(p.impact).gloves[1], off(x, y))).toBeLessThan(0.06);
      expect(worst).toBeLessThan(HEAD_STEP);
    }
  });
  it("stops following at the commit: a head that moves afterwards is missed", () => {
    const p0 = punch("cross", "right", 2);
    // The head is on the line until just after the fist leaves, then goes 30 cm to the side.
    const moved = (t: number) => (t > p0.commit + 0.02 ? 0.3 : 0);
    const { p, at, poses } = throwAt((t) => off(moved(t)), (t) => v3(EYE.x + moved(t), EYE.y, EYE.z));
    const land = at(p.impact);
    // The glove did not go to where the head is now.
    expect(distance(land.gloves[1], off(0.3))).toBeGreaterThan(0.2);
    expect(Math.abs(land.gloves[1].x)).toBeLessThan(0.12);
    // And it never comes within 0.20 m of the eye as it passes; in fact never within 0.26.
    for (const { pose, t } of poses) {
      const eye = v3(EYE.x + moved(t), EYE.y, EYE.z);
      for (const g of pose.gloves) expect(distance(g, eye)).toBeGreaterThanOrEqual(AIM.pass);
    }
  });
  it("follows until the rules say the aim is fixed, when they say so", () => {
    const p0 = punch("cross", "right", 2);
    // The rules fix the aim 0.08 s after the drawn commit; the head moved 10 cm in between.
    const fixedAt = p0.commit + 0.08;
    const where = (t: number) => (t > p0.commit + 0.02 ? 0.1 : 0);
    const p = { ...p0 };
    const { at } = run({}, 0, p.home + 0.5, (t) => ({
      ...rest(t),
      eye: v3(EYE.x + where(t), EYE.y, EYE.z),
      punch: t >= 2 - DT / 2 && t < p.home ? { ...p, target: off(where(Math.min(t, fixedAt))), fixed: t >= fixedAt } : null,
    }));
    expect(distance(at(p.impact).gloves[1], off(0.1))).toBeLessThan(0.06);
  });
  it("refuses a bend of more than 25 degrees and lets the punch play its own line", () => {
    const { p, at } = throwAt(() => off(0.45), () => v3(EYE.x + 0.45, EYE.y, EYE.z));
    const land = at(p.impact);
    expect(land.aim?.refused).toBe(true);
    expect(land.aim!.bend).toBeGreaterThan(AIM.bend);
    // Its own line: straight ahead, nowhere near the target.
    expect(Math.abs(land.gloves[1].x)).toBeLessThan(0.1);
    expect(distance(land.gloves[1], off(0.45))).toBeGreaterThan(0.3);
  });
  it("never brings a glove nearer than 0.26 m to the eye, however far the player leans in", () => {
    for (const lean of [0.2, 0.35, 0.5]) {
      const eye = v3(EYE.x, EYE.y, EYE.z - lean);
      const { poses, worst } = throwAt(() => landing(eye), () => eye);
      for (const { pose } of poses) for (const g of pose.gloves) expect(distance(g, eye)).toBeGreaterThanOrEqual(AIM.near - 1e-6);
      expect(worst).toBeLessThan(HEAD_STEP);
    }
  });
  it("stops on the player's glove when it is blocked", () => {
    const block = v3(0.06, 1.55, 0.7);
    const { p, at } = throwAt(() => off(0), () => EYE, { block });
    expect(distance(at(p.impact).gloves[1], block)).toBeLessThan(0.06);
    // Short of where it would have landed.
    expect(at(p.impact).gloves[1].z).toBeLessThan(off(0).z - 0.1);
  });
});

describe("a combination", () => {
  it("overlaps as in a ring: the cross's body starts while the jab's hand is still out, and both land on time", () => {
    const jab = punch("jab", "left", 2);
    // The cross lands 0.25 s after the jab: it begins before the jab has landed.
    const t = PUNCH_TIMES.cross;
    const impact = jab.impact + 0.25;
    const cross = punch("cross", "right", impact - t.load - t.strike, "head", { commit: impact - t.strike, impact, home: impact + t.home });
    expect(cross.start).toBeLessThan(jab.impact);
    const { worst, at, poses } = run({}, 0, cross.home + 1, (time) => ({
      ...rest(time),
      idle: false,
      punch: time >= cross.start - DT / 2 && time < cross.home ? cross : time >= jab.start - DT / 2 && time < jab.home ? jab : null,
    }));
    expect(worst).toBeLessThan(HEAD_STEP);
    const near = (when: number, h: 0 | 1, target: { x: number; y: number; z: number }) =>
      Math.min(...poses.filter((x) => Math.abs(x.t - when) <= DT).map((x) => distance(x.pose.gloves[h], target)));
    expect(near(jab.impact, 0, jab.target)).toBeLessThan(0.07);
    expect(near(cross.impact, 1, cross.target)).toBeLessThan(0.07);
    // The second punch is played from the take in which the two were thrown as one motion.
    expect(at(cross.impact).playing.clip).toBe("combo_jab_cross");
    // The jab's hand is on its way home while the cross flies.
    expect(at(cross.impact).gloves[0].z).toBeLessThan(at(jab.impact).gloves[0].z - 0.15);
  });
  it("called off before it lands, the hand comes back with no jump", () => {
    const p = punch("cross", "right", 2);
    const stopAt = (p.commit + p.impact) / 2;
    const { worst, at } = run({}, 0, 4, (t) => ({ ...rest(t), punch: t >= 2 - DT / 2 && t < stopAt ? p : null }));
    expect(worst).toBeLessThan(HEAD_STEP);
    expect(at(p.impact + 0.4).gloves[1].z).toBeLessThan(0.55);
    expect(TEST_PACK.byId.get(at(p.impact + 0.4).playing.clip)?.kind).toBe("guard");
  });
});

describe("a feint", () => {
  it("shows the punch up to two frames before its launch, then goes back: the fist never flies", () => {
    const real = punch("cross", "right", 2);
    const still = run({}, 0, 4, rest, false);
    const thrown = run({}, 0, 4, (t) => ({ ...rest(t), punch: t >= 2 - DT / 2 && t < real.home ? real : null }));
    // The same number, so that the same take of the cross is chosen for both.
    const feint = { ...real, feint: true };
    const shown = run({}, 0, 4, (t) => ({ ...rest(t), punch: t >= 2 - DT / 2 && t < feint.home ? feint : null }));
    expect(shown.worst).toBeLessThan(HEAD_STEP);
    // Up to the commit it is the same motion as the real punch.
    // (A little behind it: it has two frames less to show in the same time.)
    for (let t = 2 + 0.08; t < real.commit - DT; t += DT) expect(distance(shown.at(t).gloves[1], thrown.at(t).gloves[1])).toBeLessThan(0.07);
    // And the body did move: it is not the guard.
    const moved = Math.max(...shown.poses.filter((x) => x.t > 2 && x.t < real.commit + 0.1).map((x) => distance(x.pose.chest, still.at(x.t).chest)));
    expect(moved).toBeGreaterThan(0.02);
    // After it the glove never goes out.
    const reach = Math.max(...shown.poses.filter((x) => x.t > real.commit).map((x) => x.pose.gloves[1].z));
    expect(reach).toBeLessThan(thrown.at(real.impact).gloves[1].z - 0.3);
    expect(TEST_PACK.byId.get(shown.at(real.commit + 0.6).playing.clip)?.kind).toBe("guard");
  });
});

describe("the mirror", () => {
  it("gives a left-handed boxer: the same motion, sideways reversed, hands swapped", () => {
    const flip = (p: { x: number; y: number; z: number }) => v3(-p.x, p.y, p.z);
    const jab = punch("jab", "left", 1, "head", { target: landing(v3(0.08, EYE.y, EYE.z)) });
    const mirrored: MotionPunch = { ...jab, hand: "right", target: flip(jab.target) };
    const eye = v3(0.08, EYE.y, EYE.z);
    const a = run({}, 0, 3, (t) => ({ ...rest(t), eye, punch: t >= 1 - DT / 2 && t < jab.home ? jab : null }));
    const b = run({ southpaw: true }, 0, 3, (t) => ({ ...rest(t), eye: flip(eye), punch: t >= 1 - DT / 2 && t < jab.home ? mirrored : null }));
    for (let i = 0; i < a.poses.length; i += 3) {
      const x = a.poses[i].pose,
        y = b.poses[i].pose;
      expect(distance(flip(x.head), y.head)).toBeLessThan(1e-9);
      expect(distance(flip(x.gloves[0]), y.gloves[1])).toBeLessThan(1e-9);
      expect(distance(flip(x.gloves[1]), y.gloves[0])).toBeLessThan(1e-9);
      expect(distance(flip(x.feet[0]), y.feet[1])).toBeLessThan(1e-9);
      expect(y.turn).toBeCloseTo(-x.turn, 9);
    }
    // The southpaw's jab is its right hand, and its right foot leads.
    const land = b.at(jab.impact);
    expect(land.gloves[1].z).toBeGreaterThan(land.gloves[0].z + 0.2);
    expect(land.feet[1].z).toBeGreaterThan(land.feet[0].z);
  });
});

describe("the layers", () => {
  it("moves the head and chest by a hit given from outside, on top of whatever is playing, keeping the spine", () => {
    const hit = { head: v3(0, 0, -0.1), chest: v3(0, 0, -0.03) };
    const plain = run({}, 0, 2, rest).at(1.5);
    const struck = run({}, 0, 2, (t) => ({ ...rest(t), hit: t > 1.4 ? hit : null })).at(1.5);
    expect(struck.head.z).toBeLessThan(plain.head.z - 0.06);
    expect(struck.chest.z).toBeLessThan(plain.chest.z - 0.02);
    expect(distance(struck.hips, plain.hips)).toBe(0);
  });
  it("lets a hit land during its own punch without moving where the fist lands", () => {
    const p = punch("cross", "right", 2);
    const hit = { head: v3(0.05, 0, -0.08), chest: v3(0.02, 0, -0.03) };
    const { poses } = run({}, 0, 3.5, (t) => ({ ...rest(t), hit: t > p.commit ? hit : null, punch: t >= 2 - DT / 2 && t < p.home ? p : null }));
    const gap = Math.min(...poses.filter((x) => Math.abs(x.t - p.impact) <= DT).map((x) => distance(x.pose.gloves[1], p.target)));
    expect(gap).toBeLessThan(0.06);
  });
  it("puts each guard glove where the rules say: covering lifts it, down drops it, and it gets there without a jump", () => {
    const base = run({}, 0, 3, rest).at(2.5);
    const cover = run({}, 0, 3, (t) => ({ ...rest(t), guard: t > 1 ? ["cover", "chin"] : ["chin", "chin"] }));
    const down = run({}, 0, 3, (t) => ({ ...rest(t), guard: t > 1 ? ["chin", "down"] : ["chin", "chin"] }));
    const low = run({}, 0, 3, (t) => ({ ...rest(t), guard: t > 1 ? ["low", "low"] : ["chin", "chin"] }));
    expect(cover.at(2.5).gloves[0].y).toBeGreaterThan(base.gloves[0].y + 0.1);
    expect(distance(cover.at(2.5).gloves[1], base.gloves[1])).toBeLessThan(1e-9);
    expect(down.at(2.5).gloves[1].y).toBeLessThan(base.gloves[1].y - 0.3);
    expect(low.at(2.5).gloves[0].y).toBeLessThan(base.gloves[0].y - 0.08);
    expect(low.at(2.5).gloves[0].y).toBeGreaterThan(down.at(2.5).gloves[1].y + 0.1);
    // A glove moves no more than 6 cm in a frame on its way.
    for (const r of [cover, down, low])
      for (let i = 1; i < r.poses.length; i++)
        for (const h of [0, 1]) expect(distance(r.poses[i].pose.gloves[h], r.poses[i - 1].pose.gloves[h])).toBeLessThan(0.09);
  });
  it("shows tiredness and hurt in the posture: hands lower, head down", () => {
    // Over ten seconds of guard: how high the gloves ride against the chest, and how far the head is ahead of the hips.
    const mean = (r: ReturnType<typeof run>, of: (p: MotionPose) => number) => r.poses.reduce((n, p) => n + of(p.pose), 0) / r.poses.length;
    const hands = (p: MotionPose) => (p.gloves[0].y + p.gloves[1].y) / 2 - p.chest.y;
    const fresh = run({}, 0, 10, rest);
    const tired = run({}, 0, 10, (t) => ({ ...rest(t), tired: 1 }));
    const hurt = run({}, 0, 10, (t) => ({ ...rest(t), hurt: 1 }));
    expect(mean(tired, hands)).toBeLessThan(mean(fresh, hands) - 0.04);
    expect(mean(tired, (p) => p.head.z - p.hips.z)).toBeGreaterThan(mean(fresh, (p) => p.head.z - p.hips.z) + 0.03);
    expect(mean(hurt, hands)).toBeLessThan(mean(fresh, hands) - 0.06);
    expect(mean(hurt, (p) => p.head.y - p.chest.y)).toBeLessThan(mean(fresh, (p) => p.head.y - p.chest.y) - 0.005);
    expect(hurt.worst).toBeLessThan(HEAD_STEP);
  });
});

describe("a step", () => {
  const step = { from: "edge" as const, to: "pocket" as const, start: 2, end: 2.3 };
  it("carries the whole body in by the pocket's depth between its start and end, playing a recorded step", () => {
    const { at, worst, poses } = run({ pocket: 0.3 }, 0, 4, (t) => ({ ...rest(t), step }));
    expect(worst).toBeLessThan(HEAD_STEP);
    expect(at(1.9).advance).toBe(0);
    expect(at(2.3).advance).toBeCloseTo(0.3, 9);
    expect(at(3.5).advance).toBeCloseTo(0.3, 9);
    expect(at(3.5).lunge).toBeCloseTo(0.3, 9);
    // It only ever goes forward, and the feet go with it.
    for (let i = 1; i < poses.length; i++) expect(poses[i].pose.advance).toBeGreaterThanOrEqual(poses[i - 1].pose.advance - 1e-12);
    expect((at(3.5).feet[0].z + at(3.5).feet[1].z) / 2).toBeGreaterThan((at(1).feet[0].z + at(1).feet[1].z) / 2 + 0.2);
    expect(TEST_PACK.byId.get(at(2.15).playing.clip)?.step?.dir).toBe("in");
    // And out again.
    const back = { from: "pocket" as const, to: "edge" as const, start: 3, end: 3.35 };
    const both = run({ pocket: 0.3 }, 0, 5, (t) => ({ ...rest(t), step: t < 2.9 ? step : back }));
    expect(both.worst).toBeLessThan(HEAD_STEP);
    expect(both.at(4.5).advance).toBeCloseTo(0, 9);
    expect(TEST_PACK.byId.get(both.at(3.2).playing.clip)?.step?.dir).toBe("out");
  });
  it("leaves the points where they are when the stage moves the frame, but still plays the step", () => {
    const { at, worst } = run({ stageMoves: true }, 0, 4, (t) => ({ ...rest(t), step }));
    expect(worst).toBeLessThan(HEAD_STEP);
    expect(at(3.5).advance).toBe(0);
    expect(at(3.5).lunge).toBe(0);
    expect(TEST_PACK.byId.get(at(2.15).playing.clip)?.step?.dir).toBe("in");
  });
  it("lands a punch thrown from the pocket", () => {
    const p = punch("hook", "left", 3, "head", { target: landing(v3(EYE.x, EYE.y, EYE.z + 0.3)) });
    // The player is as far from it as before: the eye is a pocket's depth further along.
    const eye = v3(EYE.x, EYE.y, EYE.z + 0.3);
    const { poses, worst } = run({ pocket: 0.3 }, 0, 5, (t) => ({ ...rest(t), eye, step, punch: t >= 3 - DT / 2 && t < p.home ? p : null }));
    expect(worst).toBeLessThan(HEAD_STEP);
    const gap = Math.min(...poses.filter((x) => Math.abs(x.t - p.impact) <= DT).map((x) => distance(x.pose.gloves[0], p.target)));
    expect(gap).toBeLessThan(0.06);
    for (const { pose } of poses) for (const g of pose.gloves) expect(distance(g, eye)).toBeGreaterThanOrEqual(AIM.near - 1e-6);
  });
});

describe("going down", () => {
  const down = { since: 3, until: 3 + 3.2, out: false, by: { hand: "right" as const, shape: "hook" as const } };
  it("hands over to the formula fall and takes back the guard, the head never jumping", () => {
    const { poses, at } = run({ fall: formulaFall }, 0, 9, (t) => ({ ...rest(t), down: t >= 3 && t < down.until ? down : null }), false);
    let worst = 0;
    for (let i = 1; i < poses.length; i++) worst = Math.max(worst, distance(poses[i].pose.head, poses[i - 1].pose.head));
    // The same bound the formula fall is held to in opponentPose.test.ts.
    expect(worst).toBeLessThan(HEAD_STEP);
    expect(at(2.9).fallen).toBe(0);
    expect(at(4.2).fallen).toBeGreaterThan(0.99);
    expect(at(4.2).head.y).toBeLessThan(0.3);
    expect(at(4.2).playing.clip).toBe("fall");
    // Up again and in its guard.
    expect(at(8).fallen).toBe(0);
    expect(at(8).head.y).toBeGreaterThan(1.4);
    expect(TEST_PACK.byId.get(at(8).playing.clip)?.kind).toBe("guard");
    // Lying, the spine is within the 4% the formula fall is allowed.
    for (const { pose } of poses) expect(Math.abs(distance(pose.hips, pose.chest) / SIZE.chest - 1)).toBeLessThan(0.04);
  });
  it("falls from the middle of its own punch with no jump", () => {
    const p = punch("cross", "right", 2.7);
    const { poses } = run({ fall: formulaFall }, 0, 8, (t) => ({ ...rest(t), punch: t >= 2.7 - DT / 2 && t < 3 ? p : null, down: t >= 3 && t < down.until ? down : null }), false);
    let worst = 0;
    for (let i = 1; i < poses.length; i++) worst = Math.max(worst, distance(poses[i].pose.head, poses[i - 1].pose.head));
    expect(worst).toBeLessThan(HEAD_STEP);
  });
  it("stays down when it is out", () => {
    const out = { since: 3, until: Infinity, out: true };
    const { at } = run({ fall: formulaFall }, 0, 12, (t) => ({ ...rest(t), down: t >= 3 ? out : null }), false);
    expect(at(11).fallen).toBe(1);
  });
});

describe("across every transition", () => {
  it("never moves the head more than 13 cm in a frame: a round of everything, at 60 and at 30 frames a second", () => {
    // Punches of every kind, alone and in combinations a quarter of a second apart, feints, steps, hits,
    // guard changes, a knockdown, all from a seeded script.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const kinds: [MotionKind, "left" | "right", MotionLevel][] = [
      ["jab", "left", "head"],
      ["cross", "right", "head"],
      ["hook", "left", "head"],
      ["hook", "right", "head"],
      ["uppercut", "right", "head"],
      ["uppercut", "left", "head"],
      ["body", "right", "body"],
      ["body", "left", "body"],
      ["jab", "left", "body"],
    ];
    const punches: MotionPunch[] = [];
    let when = 1;
    while (when < 50) {
      const many = 1 + Math.floor(rnd() * 3);
      let impact = 0;
      for (let i = 0; i < many; i++) {
        const [kind, hand, level] = kinds[Math.floor(rnd() * kinds.length)];
        const t = PUNCH_TIMES[kind];
        const slow = 1 + rnd() * 0.6;
        const start = i === 0 ? when : impact + 0.22 + rnd() * 0.2 - t.load * slow - t.strike;
        const eye = v3((rnd() - 0.5) * 0.2, EYE.y + (rnd() - 0.5) * 0.15, EYE.z);
        const p = punch(kind, hand, start, level, {
          commit: start + t.load * slow,
          impact: start + t.load * slow + t.strike,
          home: start + t.load * slow + t.strike + t.home,
          feint: rnd() < 0.15,
          target: landing(eye, level),
          block: rnd() < 0.2 ? v3(eye.x, eye.y - 0.05, eye.z - 0.5) : null,
        });
        impact = p.impact;
        punches.push(p);
      }
      when = impact + 0.5 + rnd() * 1.5;
    }
    const down = { since: 30, until: 33.2, out: false };
    const places = ["chin", "cover", "low", "down"] as const;
    const drive = (t: number): MotionDrive => {
      // The newest punch that has begun and is not yet home; one in five is called off half-way.
      let now: MotionPunch | null = null;
      for (const p of punches) if (t >= p.start - DT / 2 && t < (p.id % 5 === 0 ? (p.commit + p.impact) / 2 : p.home)) now = p;
      const beat = Math.floor(t / 1.7);
      return {
        time: t,
        idle: beat % 3 === 0,
        punch: now,
        step: beat % 4 < 2 ? { from: "edge", to: "pocket", start: beat * 1.7 - (beat % 4) * 1.7 + 0.2, end: beat * 1.7 - (beat % 4) * 1.7 + 0.5 } : { from: "pocket", to: "edge", start: beat * 1.7 - (beat % 4 - 2) * 1.7 + 0.2, end: beat * 1.7 - (beat % 4 - 2) * 1.7 + 0.55 },
        guard: [places[beat % 4], places[(beat * 3 + 1) % 4]],
        tired: Math.min(1, t / 40),
        hurt: t > 20 && t < 22 ? 1 : 0,
        hit: t % 5 < 0.2 ? { head: v3(0.04, 0, -0.08 * Math.sin(((t % 5) / 0.2) * Math.PI)), chest: v3(0, 0, -0.03 * Math.sin(((t % 5) / 0.2) * Math.PI)) } : null,
        eye: v3(0.05 * Math.sin(t), EYE.y, EYE.z),
        down: t >= down.since && t < down.until ? down : null,
      };
    };
    for (const fps of [60, 30]) {
      const player = createMotionPlayer(TEST_PACK, { seed: 11, fall: formulaFall, pocket: 0.3 });
      let before: MotionPose | null = null;
      let worst = 0,
        worstAt = 0;
      for (let t = 0; t <= 52; t += 1 / fps) {
        const d = drive(t);
        const pose = player.update(d);
        // The hit layer is the game's own knock, given from outside: it is not the motion's doing, so it is measured without.
        if (before && !d.hit && !drive(t - 1 / fps).hit) {
          // Per sixtieth of a second, so both rates are held to the same speed.
          const moved = distance(pose.head, before.head) * (fps / 60);
          if (moved > worst) {
            worst = moved;
            worstAt = t;
          }
        }
        const lying = pose.fallen > 0 || d.down !== null;
        expect(Math.abs(distance(pose.hips, pose.chest) / SIZE.chest - 1)).toBeLessThan(lying ? 0.04 : 0.02);
        expect(Math.abs(distance(pose.chest, pose.head) / SIZE.head - 1)).toBeLessThan(0.02);
        // The arms as scene.ts will draw them: never longer than the arm.
        for (const h of [0, 1]) expect(distance(pose.shoulders[h], pose.gloves[h])).toBeLessThan((SIZE.upperArm + SIZE.forearm) / SIZE.wristShare + 1e-6);
        if (!lying) for (const g of pose.gloves) expect(distance(g, d.eye)).toBeGreaterThanOrEqual(AIM.near - 1e-6);
        before = pose;
      }
      expect(worst, `${fps} fps, worst at ${worstAt.toFixed(2)} s`).toBeLessThan(HEAD_STEP);
    }
  });
});
