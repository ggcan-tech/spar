import { describe, expect, it } from "vitest";
import { createArmRuler } from "../pov/body";
import { validPose } from "../pov/duel";
import { trackedAvatar } from "../pov/input";
import { syntheticFrame, type SyntheticMotion } from "../pov/syntheticBody";
import { createPovTracker } from "../pov/tracking";
import { RULES } from "./fight";
import { createBoxGame, type BoxInput, type BoxView, type Keys } from "./game";
import { foePose, headForFoe, DISTANCE } from "./opponentPose";
import type { Punch } from "./punch";
import { AT_REST, boxDemoMotion, stance } from "./scriptedBoxer";

const idle: Keys = { punches: [], slip: 0, duck: false, high: false, low: false, start: false };
const keyboard = (over: Partial<Keys> = {}): BoxInput => ({
  tracking: null,
  pose: null,
  valid: true,
  calibrated: true,
  poseT: 0,
  poseAge: 0,
  arms: null,
  keys: { ...idle, ...over },
});
const punch = (over: Partial<Punch> = {}): Punch => ({
  hand: "right",
  shape: "straight",
  target: "body",
  power: 1,
  t: 0,
  ...over,
});
/** Run frames at 60 a second until `until` ms; `act` says what is pressed at each. */
function play(
  game: ReturnType<typeof createBoxGame>,
  from: number,
  until: number,
  act: (now: number, view: BoxView | null) => Partial<Keys> = () => ({}),
) {
  let view: BoxView | null = null;
  const events: string[] = [];
  const words: string[] = [];
  let now = from;
  for (; now < until; now += 1000 / 60) {
    view = game.frame(now, keyboard(act(now, view)));
    for (const e of view.events) events.push(e.kind);
    const said = view.cue?.text ?? view.word?.text;
    if (said && words.at(-1) !== said) words.push(said);
  }
  return { view: view!, events, words, now };
}

/** Start by asking, and run to the bell. */
function toBell(game: ReturnType<typeof createBoxGame>, from = 0) {
  let asked = false;
  return play(game, from, from + 2600, () => {
    const start = !asked;
    asked = true;
    return { start };
  });
}

describe("a round, from the bell to the result", () => {
  it("is started by the first punch, counts in, and only then lets anything land", () => {
    const game = createBoxGame({ level: "rookie", seed: 4 });
    const waiting = play(game, 0, 1000);
    expect(waiting.view.phase).toBe("ready");
    // A punch: the gloves answer it at once, and the count begins.
    let thrown = false;
    const first = play(game, waiting.now, waiting.now + 100, () => {
      const punches = thrown ? [] : [punch()];
      thrown = true;
      return { punches };
    });
    expect(first.view.phase).toBe("count");
    expect(first.view.fight.foe.hp).toBe(RULES.health);
    const counting = play(game, first.now, first.now + 2000);
    expect(counting.view.count).toBe(1);
    expect(counting.view.countKind).toBe("start");
    const started = play(game, counting.now, counting.now + 400);
    expect(started.view.phase).toBe("fight");
    expect(started.words).toContain("FIGHT");
    // A rookie's hands are low: the first punch at its head lands.
    let hit = false;
    const landed = play(game, started.now, started.now + 300, () => {
      const punches = hit ? [] : [punch({ target: "head" })];
      hit = true;
      return { punches };
    });
    expect(landed.events).toContain("landed");
    expect(landed.view.stats).toMatchObject({ thrown: 1, landed: 1 });
  });

  it("also starts on a held cover, on being asked, and by itself for a player who just stands there", () => {
    const covered = createBoxGame({ seed: 1 });
    expect(play(covered, 0, 300, () => ({ high: true })).view.phase).toBe("ready");
    const held = play(covered, 300, 700, () => ({ high: true }));
    expect(held.view.phase).toBe("count");
    expect(toBell(createBoxGame({ seed: 1 })).view.phase).toBe("fight");
    const standing = createBoxGame({ seed: 1 });
    expect(play(standing, 0, 14000).view.phase).toBe("ready");
    expect(play(standing, 14000, 16000).view.phase).toBe("count");
  });

  it("teaches the first three punches with a word, and after a dodge says to hit back", () => {
    const game = createBoxGame({ level: "rookie", seed: 4 });
    let asked = false;
    const { view, events, words } = play(game, 0, 16000, (now, v) => {
      const start = !asked;
      asked = true;
      const foe = v?.fight.foe;
      // Move when the word appears, as a beginner does, and stay there until it has passed.
      const coming = foe?.attack && foe.phase !== "recover" && v!.fight.time - foe.attack.startAt > 0.45;
      return { start, slip: coming ? 1 : 0, duck: !!coming && foe!.attack!.kind === "hook", low: foe?.attack?.kind === "body" };
    });
    expect(words).toEqual(expect.arrayContaining(["SLIP", "DUCK", "ELBOW DOWN"]));
    expect(words).toContain("HIT BACK");
    expect(events.filter((e) => e === "dodged").length).toBeGreaterThanOrEqual(2);
    expect(events).not.toContain("hit-me");
    expect(view.stats.dodged).toBeGreaterThanOrEqual(2);
  });

  it("finishes the fight, keeps the result up, and will not restart on what the player was already doing", () => {
    const game = createBoxGame({ level: "rookie", seed: 9 });
    let asked = false,
      next = 0,
      n = 0,
      endedAt = 0;
    const { view, events, words, now } = play(game, 0, 200000, (t, v) => {
      const start = !asked;
      asked = true;
      if (v?.phase === "over") {
        endedAt ||= t;
        // Covering up as the fight ends, and holding it.
        return { high: true };
      }
      if (endedAt) return {};
      if (v?.phase !== "fight" || t < next) return { start };
      next = t + 620;
      const kinds: Punch[] = [
        punch({ hand: "left" }),
        punch({ shape: "hook" }),
        punch({ hand: "left", shape: "uppercut", target: "head" }),
        punch({ target: "head" }),
      ];
      return { punches: [kinds[n++ % kinds.length]], high: v.fight.me.down };
    });
    void now;
    expect(view.phase).toBe("over");
    expect(events.filter((e) => e === "foe-down").length + events.filter((e) => e === "me-down").length).toBeGreaterThan(0);
    expect(["YOU WIN", "YOU LOSE", "DRAW"]).toContain(view.word?.text);
    void words;
    // A grade to chase.
    expect(["S", "A", "B", "C", "D"]).toContain(view.stats.grade);
    expect(view.stats.seconds).toBeGreaterThan(5);
    // Minutes of holding the cover since the end: still the result.
    expect(view.stats.thrown).toBeGreaterThan(10);
    expect(view.word?.sub).toMatch(/go again/);
    // Gloves down, then a punch: a fresh fight, and the old numbers stay up until its bell.
    const lowered = play(game, 200000, 200400);
    expect(lowered.view.phase).toBe("over");
    let thrown = false;
    const again = play(game, 200400, 200600, () => {
      const punches = thrown ? [] : [punch()];
      thrown = true;
      return { punches };
    });
    expect(again.view.phase).toBe("count");
    expect(again.view.fight.foe.hp).toBe(RULES.health);
    expect(again.view.stats.thrown).toBeGreaterThan(10);
    const bell = play(game, 200600, 203200);
    expect(bell.view.phase).toBe("fight");
    expect(bell.view.stats.thrown).toBe(0);
  });

  it("counts over a player who is down, and lets them up only by something they do afterwards", () => {
    const game = createBoxGame({ level: "contender", seed: 3 });
    toBell(game);
    // Stand there with the hands down until knocked down.
    let v = play(game, 2600, 2700).view;
    let t = 2700;
    while (!v.fight.me.down && t < 120000) v = play(game, t, (t += 200), () => ({ low: true })).view;
    expect(v.fight.me.down).toBe(true);
    expect(v.countKind).toBe("down");
    const counts = new Set<number>();
    let up = false;
    const lying = play(game, t, t + 3000, (now) => {
      // Nothing for two seconds, then a punch.
      return now > t + 2000 && !up ? ((up = true), { punches: [punch()] }) : {};
    });
    void counts;
    expect(lying.events).toContain("me-up");
    expect(lying.view.fight.me.down).toBe(false);
  });

  it("holds everything while the menu is open, and comes back with a short count and no bell", () => {
    const game = createBoxGame({ seed: 2 });
    const bell = toBell(game);
    const before = bell.view.fight.time;
    let sounds: string[] = [];
    let view = bell.view;
    for (let now = bell.now; now < bell.now + 3000; now += 1000 / 60) {
      view = game.frame(now, { ...keyboard(), hold: true });
      sounds.push(...view.sounds);
    }
    expect(view.phase).toBe("paused");
    expect(view.pausedWhy).toBe("menu");
    expect(view.fight.time - before).toBeLessThan(0.1);
    expect(sounds).toContain("pause");
    sounds = [];
    const back = play(game, bell.now + 3000, bell.now + 3200);
    expect(back.view.phase).toBe("count");
    expect(back.view.countKind).toBe("resume");
    for (let now = bell.now + 3200; now < bell.now + 5000; now += 1000 / 60) {
      view = game.frame(now, keyboard());
      sounds.push(...view.sounds);
    }
    expect(view.phase).toBe("fight");
    expect(sounds).toContain("resume");
    expect(sounds).not.toContain("bell");
  });
});

describe("the lessons before a first fight", () => {
  it("takes the player through each move with nothing at stake, then rings the bell", () => {
    const game = createBoxGame({ level: "rookie", seed: 5, intro: true });
    const tasks: string[] = [];
    let asked = false,
      next = 0,
      finished = false,
      fresh: number | null = null;
    const { view, words } = play(game, 0, 90000, (now, v) => {
      const start = !asked;
      asked = true;
      if (v?.phase === "fight" && fresh === null) fresh = v.fight.me.hp;
      if (!v || v.phase !== "lesson") return { start };
      if (v.lessonDone) finished = true;
      const task = v.cue?.text ?? "";
      if (task && tasks.at(-1) !== task) tasks.push(task);
      const foe = v.fight.foe;
      const coming = !!foe.attack && foe.phase !== "recover" && v.fight.time - foe.attack.startAt > 0.5;
      if ((task === "PUNCH" || task === "GO LOW" || task === "GO HIGH") && now >= next) {
        next = now + 450;
        // Where its gloves are not, once that is the task.
        return { punches: [punch({ target: task === "GO LOW" ? "body" : "head" })] };
      }
      // Make it miss, then hit it while it is open.
      if (task === "HIT BACK" && foe.phase === "recover" && now >= next) {
        next = now + 450;
        return { punches: [punch({ target: "head" })] };
      }
      return {
        slip: (task === "SLIP" || task === "HIT BACK") && coming ? 1 : 0,
        duck: task === "DUCK" && coming,
        low: task === "ELBOW DOWN" && coming,
      };
    });
    void finished;
    expect(tasks.slice(0, 5)).toEqual(["PUNCH", "SLIP", "DUCK", "ELBOW DOWN", "HIT BACK"]);
    // The last: its gloves move to where it was hit, so the target changes each time.
    expect(tasks.slice(5)).toEqual(["GO LOW", "GO HIGH", "GO LOW", "GO HIGH"]);
    expect(words).toContain("GOOD");
    expect(words).toContain("NOW FIGHT");
    // Nothing that happened in the lessons carried over to the fight.
    expect(fresh).toBe(RULES.health);
    expect(view.fight.practice).toBeUndefined();
  });
  it("can be skipped, and moves on by itself from a task the player cannot do", () => {
    const skipped = createBoxGame({ seed: 5, intro: true });
    // One press starts the lessons; a second, two seconds in, skips them.
    const pressed = new Set<number>();
    const press = (now: number, at: number) => now >= at && !pressed.has(at) && !!pressed.add(at);
    const out = play(skipped, 0, 6000, (now) => ({ start: press(now, 100) || press(now, 2000) }));
    expect(["count", "fight"]).toContain(out.view.phase);
    expect(out.view.fight.practice).toBeUndefined();
    const stuck = createBoxGame({ seed: 5, intro: true });
    let asked = false;
    const waited = play(stuck, 0, 6 * 27000 + 6000, () => {
      const start = !asked;
      asked = true;
      return { start };
    });
    expect(waited.view.phase).toBe("fight");
  });
});

describe("a round played through the camera", () => {
  /** The scripted boxer through the tracker into the game, as the screen does it. */
  function camera(motion: (seconds: number) => SyntheticMotion, seconds: number, lost?: [number, number]) {
    const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative" });
    const ruler = createArmRuler();
    const game = createBoxGame({ level: "rookie", seed: 6 });
    const phases: string[] = [];
    const words: string[] = [];
    let view: BoxView | null = null;
    let poseT = -Infinity;
    for (let now = 1000; now < 1000 + seconds * 1000; now += 1000 / 60) {
      const s = (now - 1000) / 1000;
      // A pose thirty times a second, arriving 60 ms after its own time.
      if (Math.floor(now / 33.3) !== Math.floor((now - 1000 / 60) / 33.3)) {
        const t = now - 60;
        const frame = syntheticFrame(t, motion(s));
        if (lost && s >= lost[0] && s < lost[1]) frame.lm = frame.lm.map((p) => ({ ...p, v: 0.05 }));
        tracker.update(frame, now);
        poseT = t;
      }
      const tracking = tracker.sample(now);
      if (tracking.valid && tracking.joints && tracking.jointWeights) ruler.measure(tracking.joints, tracking.jointWeights, poseT);
      const pose = trackedAvatar(tracking, 1.8, { arms: ruler.lengths() ?? undefined });
      const valid = tracking.valid && validPose(pose);
      view = game.frame(now, {
        tracking,
        pose: valid ? pose : null,
        valid,
        calibrated: tracking.calibrated,
        poseT,
        poseAge: tracker.poseAge(now),
        arms: ruler.lengths(),
        keys: null,
      });
      if (phases.at(-1) !== view.phase) phases.push(view.phase);
      const said = view.cue?.text ?? view.word?.text;
      if (said && words.at(-1) !== said) words.push(said);
    }
    return { view: view!, phases, words };
  }
  it("sets up, starts when the player covers up, and reads their punches", () => {
    const { view, phases, words } = camera(boxDemoMotion, 22);
    expect(phases.slice(0, 4)).toEqual(["setup", "ready", "count", "fight"]);
    expect(words).toContain("FIGHT");
    // One loop of the routine has eleven punches; the next has begun.
    expect(view.stats.thrown).toBeGreaterThanOrEqual(11);
    expect(view.stats.thrown).toBeLessThanOrEqual(14);
    expect(view.stats.landed).toBeGreaterThanOrEqual(3);
    expect(view.lead).toBeGreaterThan(0.03);
    expect(view.lead).toBeLessThanOrEqual(0.12);
  });
  it("does not start for a player who only stands in the guard, and pauses when they are lost", () => {
    const waiting = camera((s) => (s < 2.2 ? AT_REST : stance()), 8);
    expect(waiting.phases).toEqual(["setup", "ready"]);
    const lost = camera(boxDemoMotion, 14, [9, 10.5]);
    expect(lost.phases).toEqual(["setup", "ready", "count", "fight", "paused", "count", "fight"]);
  });
  it("waits out a pose or two lost mid-exchange without stopping the fight", () => {
    const blip = camera(boxDemoMotion, 14, [9, 9.3]);
    expect(blip.phases).toEqual(["setup", "ready", "count", "fight"]);
  });
  it("starts on the first punch for a player who never covers up", () => {
    // Guard up without the opening cover, then the routine's punches.
    const { phases, view } = camera((s) => (s < 2.2 ? AT_REST : s < 4 ? stance() : boxDemoMotion(s)), 12);
    expect(phases).toEqual(["setup", "ready", "count", "fight"]);
    expect(view.stats.thrown).toBeGreaterThan(2);
  });
});

describe("the opponent's body", () => {
  const head = headForFoe({ x: 0, y: 1.65, z: 0 });
  it("shows each kind of punch differently before it throws it, and reaches the player with it", () => {
    const game = createBoxGame({ level: "contender", seed: 2 });
    const seen = new Map<string, { glove: number; x: number; y: number }>();
    let reached = 0;
    let asked = false;
    play(game, 0, 60000, (now, v) => {
      const start = !asked;
      asked = true;
      const foe = v?.fight.foe;
      if (foe?.attack && !foe.attack.feint) {
        const pose = foePose(foe, v!.fight.time, v!.fight.time, head);
        if (foe.phase === "windup" && pose.loading && pose.loading.amount > 0.95) {
          const g = pose.gloves[pose.loading.glove];
          seen.set(foe.attack.kind, { glove: pose.loading.glove, x: Math.abs(g.x - pose.chest.x), y: g.y - pose.chest.y });
        }
        if (foe.phase === "strike" && foe.attack.impactAt - v!.fight.time < 0.01) {
          const g = pose.gloves[foe.attack.hand === "left" ? 0 : 1];
          if (g.z > DISTANCE - 0.4) reached++;
        }
      }
      return { start, high: true };
    });
    expect([...seen.keys()].sort()).toEqual(["body", "cross", "hook", "jab"]);
    // A hook is drawn out wide; a body shot is drawn low.
    expect(seen.get("hook")!.x).toBeGreaterThan(seen.get("cross")!.x + 0.1);
    expect(seen.get("body")!.y).toBeLessThan(seen.get("jab")!.y - 0.25);
    expect(reached).toBeGreaterThan(3);
  });
});

describe("a bout of rounds", () => {
  /** Stand there with the hands up until the phase is `phase`, or `until`. */
  const until = (game: ReturnType<typeof createBoxGame>, from: number, to: number, phase: string, act: (now: number, v: BoxView | null) => Partial<Keys> = () => ({})) => {
    let view: BoxView | null = null;
    const said: string[] = [];
    const sounds: string[] = [];
    let now = from;
    for (; now < to && view?.phase !== phase; now += 1000 / 60) {
      view = game.frame(now, keyboard(act(now, view)));
      for (const line of view.lines) said.push(line.text);
      sounds.push(...view.sounds);
    }
    return { view: view!, now, said, sounds };
  };
  it("goes to the corner at the bell, says one thing done well and one to fix, and comes out for the next", () => {
    const game = createBoxGame({ level: "rookie", seed: 3, openers: false });
    const bell = toBell(game);
    expect(bell.view.phase).toBe("fight");
    expect(bell.view.word).toMatchObject({ text: "FIGHT", sub: "Round 1 of 3" });
    // Cover up for the whole round: nothing lands clean, and the round goes to the clock.
    const corner = until(game, bell.now, bell.now + 130000, "rest", () => ({ high: true }));
    expect(corner.view.phase).toBe("rest");
    expect(corner.view.rest).toMatchObject({ round: 1, of: 3 });
    expect(corner.view.rest!.score[0] + corner.view.rest!.score[1]).toBeGreaterThanOrEqual(18);
    expect(corner.view.rest!.praise).not.toBe("");
    expect(corner.said.some((line) => /Breathe in/.test(line))).toBe(true);
    expect(corner.said).toContain("Thirty seconds.");
    expect(corner.sounds).toContain("knock");
    // Still covering as the bell went: that is not a request for the next round.
    const sat = until(game, corner.now, corner.now + 3000, "count", () => ({ high: true }));
    expect(sat.view.phase).toBe("rest");
    expect(sat.view.rest!.ready).toBe(false);
    // After a breath, a punch brings the next round out; health has come part of the way back.
    const hurt = sat.view.fight.me.hp;
    let thrown = false;
    const out = until(game, sat.now + 4000, sat.now + 12000, "fight", (now) => {
      const punches = !thrown && now > sat.now + 4500 ? [punch()] : [];
      if (punches.length) thrown = true;
      return { punches };
    });
    expect(out.view.phase).toBe("fight");
    expect(out.view.fight.round).toBe(2);
    expect(out.view.word?.text).toBe("ROUND 2");
    expect(out.view.fight.me.hp).toBeGreaterThanOrEqual(hurt);
    expect(out.view.clock).toBeGreaterThan(RULES.clock - 2);
  });
  it("starts the next round by itself when the rest runs out, and is decided on the card after the last", () => {
    const game = createBoxGame({ level: "rookie", seed: 3, openers: false, rounds: 2 });
    const bell = toBell(game);
    const corner = until(game, bell.now, bell.now + 130000, "rest", () => ({ high: true }));
    const second = until(game, corner.now, corner.now + 50000, "fight");
    expect(second.view.fight.round).toBe(2);
    const done = until(game, second.now, second.now + 130000, "over", () => ({ high: true }));
    expect(done.view.phase).toBe("over");
    expect(done.view.stats.rounds).toBe(2);
    expect(done.view.stats.card).not.toBeNull();
    expect(done.view.word?.sub).toMatch(/\d+–\d+/);
  });
  it("moves to a queued opponent only at the next bell", () => {
    const game = createBoxGame({ level: "rookie", seed: 3 });
    const bell = toBell(game);
    game.queueLevel("digger");
    expect(play(game, bell.now, bell.now + 500).view.fight.level).toBe("rookie");
  });
});

describe("drills", () => {
  it("runs a minute of defence, counts the longest clean run, and gets quicker as it goes", () => {
    const game = createBoxGame({ seed: 8, mode: "defence" });
    let asked = false;
    const windups: number[] = [];
    const { view, events } = play(game, 0, 70000, (now, v) => {
      const start = !asked;
      asked = true;
      const foe = v?.fight.foe;
      const a = foe?.attack;
      if (a && foe.phase === "windup" && windups.at(-1) !== a.windup) windups.push(a.windup);
      const coming = !!a && foe!.phase !== "recover" && v!.fight.time - a.startAt > 0.3;
      return { start, slip: coming && (a!.kind === "jab" || a!.kind === "cross") ? 1 : 0, duck: coming && a!.kind === "hook", low: coming && a!.kind === "body" };
    });
    expect(view.phase).toBe("over");
    expect(view.finished || view.stats.mode === "defence").toBe(true);
    expect(view.stats).toMatchObject({ mode: "defence" });
    expect(view.stats.streak).toBeGreaterThan(8);
    expect(view.stats.clean).toBe(view.stats.faced);
    expect(view.word).toMatchObject({ text: "TIME" });
    // All four kinds came, nobody was hurt, and the last was shown for less time than the first.
    expect(events).not.toContain("hit-me");
    expect(view.fight.me.hp).toBe(RULES.health);
    expect(windups.at(-1)!).toBeLessThan(windups[0] * 0.7);
  });
  it("calls combinations by number on the pads and counts the ones thrown with the right hands", () => {
    const game = createBoxGame({ seed: 8, mode: "pads" });
    let asked = false,
      next = 0,
      call = "",
      index = 0;
    const calls = new Set<string>();
    const spoken: string[] = [];
    let view: BoxView | null = null;
    for (let now = 0; now < 70000; now += 1000 / 60) {
      const start = !asked;
      asked = true;
      let punches: Punch[] = [];
      const text = view?.phase === "drill" ? (view.cue?.text ?? "") : "";
      if (text !== call) {
        call = text;
        index = 0;
        if (text) calls.add(text);
        next = now + 350;
      }
      const numbers = call ? call.split(" · ").map(Number) : [];
      if (index < numbers.length && now >= next) {
        // Odd numbers are the front hand, even the back.
        punches = [punch({ hand: numbers[index] % 2 ? "left" : "right", target: "head" })];
        index++;
        next = now + 280;
      }
      view = game.frame(now, keyboard({ start, punches }));
      for (const line of view.lines) spoken.push(line.text);
    }
    expect(view!.phase).toBe("over");
    expect(view!.stats.mode).toBe("pads");
    expect(view!.stats.combos).toBeGreaterThan(12);
    expect(view!.stats.onCall).toBeGreaterThan(view!.stats.combos * 2 - 1);
    // It moved up from the first combinations to longer ones, and said them aloud.
    expect(calls.has("1 · 1")).toBe(true);
    expect([...calls].some((c) => c.split(" · ").length >= 4)).toBe(true);
    expect(spoken).toContain("One, two.");
  });
  it("says OTHER HAND when the wrong one is thrown, and calls the next", () => {
    const game = createBoxGame({ seed: 8, mode: "pads" });
    let asked = false,
      thrown = false;
    const { words } = play(game, 0, 9000, (now, v) => {
      const start = !asked;
      asked = true;
      const called = v?.phase === "drill" && !!v.cue?.text && !thrown;
      if (called) thrown = true;
      // Every first call is a lead punch: throw the back hand at it.
      return { start, punches: called ? [punch({ hand: "right", target: "head" })] : [] };
    });
    expect(words).toContain("OTHER HAND");
  });
});

describe("a whole session from one button", () => {
  it("runs warm-up, pads, defence, a round, a finisher and a cool-down, with a breath between, and keeps each part's score", () => {
    const game = createBoxGame({ seed: 12, mode: "session", openers: false });
    const stages: string[] = [];
    const cards: string[] = [];
    const spoken: string[] = [];
    let asked = false,
      next = 0,
      call = "",
      index = 0,
      finishes = 0,
      view: BoxView | null = null;
    let now = 0;
    for (; now < 480000 && !(view?.phase === "over"); now += 1000 / 60) {
      const start = !asked;
      asked = true;
      const keys: Partial<Keys> = { start };
      const stage = view?.stage?.name ?? "";
      if (stage && stages.at(-1) !== stage) stages.push(stage);
      if (view?.rest?.title && cards.at(-1) !== view.rest.title) cards.push(view.rest.title);
      const foe = view?.fight.foe;
      const a = foe?.attack;
      const coming = !!a && foe!.phase !== "recover" && view!.fight.time - a.startAt > 0.3;
      if (view?.phase === "drill" && stage === "PADS") {
        const text = view.cue?.text ?? "";
        if (text !== call) {
          call = text;
          index = 0;
          next = now + 350;
        }
        const numbers = /^[1-4]/.test(call) ? call.split(" · ").map(Number) : [];
        if (index < numbers.length && now >= next) {
          keys.punches = [punch({ hand: numbers[index] % 2 ? "left" : "right", target: "head" })];
          index++;
          next = now + 280;
        }
      } else if (view?.phase === "drill" && stage === "DEFENCE") {
        keys.slip = coming && (a!.kind === "jab" || a!.kind === "cross") ? 1 : 0;
        keys.duck = coming && a!.kind === "hook";
        keys.low = coming && a!.kind === "body";
      } else if (view?.phase === "fight") {
        // Make it miss, then hit it while it is open.
        keys.slip = coming && (a!.kind === "jab" || a!.kind === "cross") ? 1 : 0;
        keys.duck = coming && a!.kind === "hook";
        keys.low = coming && a!.kind === "body";
        if (foe!.phase === "recover" && now >= next) {
          keys.punches = [punch({ target: "head", shape: "hook" })];
          next = now + 320;
        }
        keys.high = view.fight.me.down;
      } else if (view?.phase === "drill" && stage === "FINISHER" && now >= next) {
        keys.punches = [punch({ hand: index++ % 2 ? "left" : "right", target: "head" })];
        next = now + 250;
      }
      view = game.frame(now, keyboard(keys));
      for (const line of view.lines) spoken.push(line.text);
      if (view.finished) finishes++;
    }
    expect(view!.phase).toBe("over");
    expect(stages).toEqual(["WARM-UP", "PADS", "DEFENCE", "ROUND", "FINISHER", "COOL-DOWN"]);
    // A card after each part but the last, and one finish for the whole thing.
    expect(cards.length).toBe(5);
    expect(cards[3]).toMatch(/^ROUND (WON|LOST|DRAWN)$/);
    expect(finishes).toBe(1);
    expect(view!.word).toMatchObject({ text: "SESSION DONE" });
    const s = view!.stats;
    expect(s.mode).toBe("session");
    expect(s.session!.pads).toBeGreaterThan(8);
    expect(s.session!.defence).toBeGreaterThan(8);
    expect(s.session!.round).toBe("win");
    expect(s.session!.burst).toBeGreaterThan(80);
    // The round's own numbers are the ones kept.
    expect(s.landed).toBeGreaterThan(5);
    // The coach led the warm-up and the cool-down, and said what was next.
    expect(spoken.some((line) => /March on the spot/.test(line))).toBe(true);
    expect(spoken.some((line) => /Next: pads/.test(line))).toBe(true);
    expect(spoken.some((line) => /Slow breathing/.test(line))).toBe(true);
    // About six and a half minutes.
    expect(now).toBeGreaterThan(300000);
    expect(now).toBeLessThan(440000);
  });
  it("names a recorded call for what must be on time, and for the pads' numbers", () => {
    const lesson = createBoxGame({ seed: 5, intro: true });
    const calls: string[] = [];
    let asked = false,
      next = 0;
    play(lesson, 0, 30000, (now, v) => {
      const start = !asked;
      asked = true;
      for (const line of v?.lines ?? []) if (line.call) calls.push(line.call.join("+"));
      if (v?.cue?.text === "PUNCH" && now >= next) {
        next = now + 450;
        return { punches: [punch({ target: "head" })] };
      }
      return { start };
    });
    // The slip lesson's jab is called as it is shown; being hit by it is not what is being checked.
    expect(calls).toContain("slip");
    const pads = createBoxGame({ seed: 8, mode: "pads" });
    const numbers: string[] = [];
    let begun = false;
    play(pads, 0, 9000, (_now, v) => {
      const start = !begun;
      begun = true;
      for (const line of v?.lines ?? []) if (line.call) numbers.push(line.call.join("+"));
      return { start };
    });
    expect(numbers).toContain("one+one");
  });
});
