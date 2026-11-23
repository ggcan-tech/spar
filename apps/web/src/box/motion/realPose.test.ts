import { describe, expect, it } from "vitest";
import type { Guard } from "../defence";
import { SPINE, headForFoe, type FoePose } from "../opponentPose";
import { BOXERS, createMind, type BoxerName } from "../real/mind";
import { createBout, stepBout, type Bout, type PunchTimes } from "../real/rules";
import { distanceOf, standInPose, type StandInOptions } from "../real/standIn";
import { AIM } from "./aim";
import { TEST_PACK } from "./fixture";
import { LANDING, MOTION_TIMES, createMotionPose, driveOf, eyeOf, motionTimes } from "./realPose";
import { PUNCH_TIMES } from "./times";

/**
 * The recorded motion as the game's pose maker: real bouts from the rules,
 * an opponent's mind throwing what it throws, the pose asked for every frame
 * the way the game asks.
 */
const STEP = 1 / 120;
const AHEAD = 0.1;
const UP: Guard = { high: 0, low: 0, up: 2, heights: [null, null], sides: { high: [false, false], low: [false, false], up: [true, true] }, known: true };
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const head = (t: number) => ({ x: 0.04 * Math.sin(t * 1.1), y: 1.6 + 0.02 * Math.sin(t * 0.7), z: 0 });
const options = (t: number): StandInOptions => ({ target: headForFoe(head(t)), blocking: false, struck: null });
/** A bout run for `seconds`, with what the pose maker gave at each drawn frame and the bout as it stood. */
function play(name: BoxerName, seconds: number, seed: number, make = createMotionPose(TEST_PACK), lead: "left" | "right" = "left") {
  const mind = createMind(BOXERS[name], seed);
  let s: Bout = createBout({ boxer: BOXERS[name], times: MOTION_TIMES, opening: 0.3, lead });
  const frames: { t: number; pose: FoePose; bout: Bout }[] = [];
  let i = 0;
  while (s.time < seconds && !s.over && !s.rest) {
    s = stepBout(s, STEP, { punches: [], head: { x: head(s.time).x, y: head(s.time).y }, guard: UP, ahead: AHEAD }, mind);
    // A pose sixty times a second, drawn `ahead` of the rules' clock.
    if (++i % 2 === 0) {
      const t = s.time + AHEAD;
      frames.push({ t, pose: make(s, t, options(t)), bout: s });
    }
  }
  return frames;
}

describe("the recorded motion as the game's pose maker", () => {
  it("gives the rules the clips' own punch times", () => {
    const times: PunchTimes = MOTION_TIMES;
    for (const kind of ["jab", "cross", "hook", "uppercut", "body"] as const) {
      expect(times[kind].commit).toBeCloseTo(PUNCH_TIMES[kind].load, 3);
      expect(times[kind].impact).toBeCloseTo(PUNCH_TIMES[kind].load + PUNCH_TIMES[kind].strike, 3);
      expect(times[kind].home).toBe(PUNCH_TIMES[kind].home);
      expect(motionTimes(1.5)[kind].impact).toBeGreaterThan(times[kind].impact);
    }
  });

  it("plays whole rounds against three opponents with the spine true and nothing jumping", () => {
    for (const name of ["beginner", "jabber", "pressure"] as const) {
      const frames = play(name, 25, 3);
      expect(frames.length).toBeGreaterThan(1000);
      let worst = 0;
      let punches = 0;
      const seen = new Set<number>();
      frames.forEach(({ pose, bout, t }, i) => {
        expect(Math.abs(dist(pose.hips, pose.chest) / SPINE.chest - 1)).toBeLessThan(pose.fallen > 0 ? 0.04 : 0.02);
        expect(Math.abs(dist(pose.chest, pose.head) / SPINE.head - 1)).toBeLessThan(0.02);
        for (const p of [pose.head, pose.chest, pose.hips, ...pose.gloves, ...pose.shoulders, ...pose.poles]) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
        if (i) worst = Math.max(worst, dist(pose.head, frames[i - 1].pose.head));
        for (const p of bout.foe.punches) if (!seen.has(p.id)) (seen.add(p.id), punches++);
        // The glove never comes nearer the player's eye than 0.26 m, wherever the opponent stands.
        const eye = eyeOf(bout, t, options(t));
        if (pose.fallen === 0) for (const g of pose.gloves) expect(dist(g, eye)).toBeGreaterThanOrEqual(AIM.near - 1e-6);
      });
      // It threw, and the head never moved more than a hand's width in a frame.
      expect(punches, name).toBeGreaterThan(3);
      expect(worst, name).toBeLessThan(0.13);
    }
  });

  it("puts each head punch's glove where it is asked at the impact, when the rules have fixed the aim by then", () => {
    const frames = play("jabber", 45, 9);
    let checked = 0;
    const done = new Set<number>();
    for (let i = 1; i < frames.length; i++) {
      const { bout, t } = frames[i];
      for (const p of bout.foe.punches) {
        // The frame in which the impact falls, for straight head punches from the edge of range (they reach from there).
        if (done.has(p.id) || p.feint || p.level !== "head" || p.shape !== "straight" || !(frames[i - 1].t < p.impact && t >= p.impact) || !p.aim) continue;
        if (distanceOf(bout, t) < 1.25) continue;
        done.add(p.id);
        const drive = driveOf(bout, t, options(t));
        if (!drive.punch || drive.punch.id !== p.id) continue;
        const h = p.hand === "left" ? 0 : 1;
        const gap = Math.min(dist(frames[i].pose.gloves[h], drive.punch.target), dist(frames[i - 1].pose.gloves[h], drive.punch.target));
        // Within the fist's travel in a frame, and the reach the recorded cross has.
        expect(gap, `punch ${p.id} ${p.kind}`).toBeLessThan(0.1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("stands the same way round as the player: southpaw for a player who leads with the right", () => {
    const orthodox = play("jabber", 12, 4, createMotionPose(TEST_PACK), "left");
    const southpaw = play("jabber", 12, 4, createMotionPose(TEST_PACK), "right");
    // Mirrored: its feet are in `feet` when the motion made the pose.
    const feet = (p: FoePose) => (p as FoePose & { feet: [{ z: number }, { z: number }] }).feet;
    const lead = (frames: typeof orthodox) => frames.reduce((n, f) => n + feet(f.pose)[0].z - feet(f.pose)[1].z, 0) / frames.length;
    expect(lead(orthodox)).toBeGreaterThan(0.15);
    expect(lead(southpaw)).toBeLessThan(-0.15);
  });

  it("reads the bout as the stand-in does: punch, step, gloves, tiredness, the fall from its own beginning", () => {
    const frames = play("pressure", 30, 6);
    const withPunch = frames.find((f) => f.bout.foe.punches.some((p) => f.t >= p.start && f.t < p.impact && !p.feint && p.level === "head"));
    expect(withPunch).toBeDefined();
    const { bout, t } = withPunch!;
    const drive = driveOf(bout, t, options(t));
    const p = bout.foe.punches.filter((q) => t >= q.start - 1 / 30 && t < q.home).pop()!;
    expect(drive.punch?.id).toBe(p.id);
    expect(drive.punch?.impact).toBe(p.impact);
    expect(drive.idle).toBe(false);
    expect(drive.hit).toBeNull();
    // The eye is where it really is: nearer when it has stepped in.
    expect(drive.eye.z).toBeCloseTo(distanceOf(bout, t), 9);
    if (p.level === "head") expect(drive.punch!.target.z).toBeCloseTo(drive.eye.z - LANDING.short, 9);
    // A knockdown is read `ahead` seconds earlier than a planned move would be.
    const downed: Bout = { ...bout, ahead: 0.1, foe: { ...bout.foe, down: { since: 20, until: 23.2, standing: false } } };
    expect(driveOf(downed, 20.5, options(20.5)).down).toMatchObject({ since: 20.1, until: 23.3, out: false });
    const count: Bout = { ...bout, foe: { ...bout.foe, down: { since: 20, until: 23.2, standing: true } } };
    expect(driveOf(count, 20.5, options(20.5)).down).toBeNull();
    expect(driveOf(count, 20.5, options(20.5)).hurt).toBe(1);
  });

  it("falls and gets up by the formula fall, with no jump either way", () => {
    const frames = play("jabber", 8, 2);
    const make = createMotionPose(TEST_PACK);
    const base = frames[frames.length - 1].bout;
    const at = base.time;
    let worst = 0;
    let before: FoePose | null = null;
    let lowest = Infinity;
    for (let t = at - 2; t < at + 6; t += 1 / 60) {
      const down = t >= at + 0.5 && t < at + 0.5 + 3.2 ? { since: at + 0.5 - base.ahead, until: at + 3.7 - base.ahead, standing: false } : null;
      const s: Bout = { ...base, foe: { ...base.foe, punches: [], punch: null, down } };
      const pose = make(s, t, { ...options(t), struck: { at: at + 0.5, hand: "right", shape: "hook", target: "head", power: 1, damage: 12 } });
      if (before) worst = Math.max(worst, dist(pose.head, before.head));
      lowest = Math.min(lowest, pose.head.y);
      before = pose;
    }
    expect(worst).toBeLessThan(0.13);
    expect(lowest).toBeLessThan(0.3);
    expect(before!.fallen).toBe(0);
    expect(before!.head.y).toBeGreaterThan(1.4);
  });
});

describe("a moment shown again", () => {
  // A bout stopped at the moment a head punch has just landed.
  const frames = play("jabber", 40, 9);
  const landed = frames.find((f) => f.bout.foe.punches.some((p) => p.level === "head" && !p.feint && p.aim && f.t - AHEAD >= p.impact && f.t - AHEAD < p.impact + 0.05));
  const snapshot = landed!.bout;
  const punch = snapshot.foe.punches.find((p) => p.level === "head" && !p.feint && p.aim)!;
  const again = (t: number): StandInOptions => ({ target: headForFoe(head(punch.impact)), blocking: false, struck: null, again: true });
  const from = punch.start - 0.3,
    to = punch.impact + 0.15;

  it("gives the same pose for the same moment, in any order, as often as asked", () => {
    expect(landed).toBeDefined();
    const make = createMotionPose(TEST_PACK);
    const times = Array.from({ length: 40 }, (_, i) => from + ((to - from) * i) / 39);
    const forward = times.map((t) => make(snapshot, t, again(t)));
    const backward = times.slice().reverse().map((t) => make(snapshot, t, again(t))).reverse();
    // And by another maker that has never seen the bout.
    const fresh = createMotionPose(TEST_PACK);
    const other = times.map((t) => fresh(snapshot, t, again(t)));
    forward.forEach((pose, i) => {
      expect(pose).toEqual(backward[i]);
      expect(pose).toEqual(other[i]);
    });
  });

  it("does not touch the bout as it runs, and is not touched by it", () => {
    const plain = play("jabber", 14, 9);
    // The same bout again, with the corner's replay asked for between every two frames.
    const live = createMotionPose(TEST_PACK);
    let k = 0;
    const mixed = play("jabber", 14, 9, (s, t, o) => {
      live(snapshot, from + ((to - from) * (k++ % 50)) / 49, again(0));
      return live(s, t, o);
    });
    expect(mixed.length).toBe(plain.length);
    mixed.forEach((f, i) => {
      expect(dist(f.pose.head, plain[i].pose.head)).toBe(0);
      expect(dist(f.pose.gloves[0], plain[i].pose.gloves[0])).toBe(0);
    });
    // And the replay is the same whether or not a bout ran in between.
    const alone = createMotionPose(TEST_PACK)(snapshot, punch.impact, again(0));
    expect(live(snapshot, punch.impact, again(0))).toEqual(alone);
  });

  it("is a punch from before its first movement to after it lands, with nothing jumping and the spine true", () => {
    const make = createMotionPose(TEST_PACK);
    let before: FoePose | null = null;
    let worst = 0;
    // At a quarter of real speed, as the corner shows it.
    for (let t = from; t <= to; t += 1 / 240) {
      const pose = make(snapshot, t, again(t));
      expect(Math.abs(dist(pose.hips, pose.chest) / SPINE.chest - 1)).toBeLessThan(0.02);
      if (before) worst = Math.max(worst, dist(pose.head, before.head));
      before = pose;
    }
    // A quarter of a hand's width at a quarter of the speed.
    expect(worst).toBeLessThan(0.13 / 4);
  });

  it("carries the fist all the way to the head, as the stand-in's does, because it is seen from the side", () => {
    const make = createMotionPose(TEST_PACK);
    const h = punch.hand === "left" ? 0 : 1;
    const eye = eyeOf(snapshot, punch.impact, again(0));
    const aimed = { x: -punch.aim!.x, y: punch.aim!.y, z: eye.z };
    const pose = make(snapshot, punch.impact, again(0));
    const first = createMotionPose(TEST_PACK)(snapshot, punch.impact, { ...again(0), again: false });
    // Through the lens it stops 0.42 m short; shown again it is within a hand of the head.
    expect(dist(first.gloves[h], aimed)).toBeGreaterThan(0.3);
    expect(dist(pose.gloves[h], aimed)).toBeLessThan(0.2);
    // The stand-in's goes to the same place.
    const standIn = standInPose(snapshot, punch.impact, again(0));
    expect(dist(pose.gloves[h], standIn.gloves[h])).toBeLessThan(0.2);
  });
});
