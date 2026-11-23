import { describe, expect, it } from "vitest";
import { createArmRuler } from "../../pov/body";
import { validPose } from "../../pov/duel";
import { trackedAvatar } from "../../pov/input";
import { syntheticFrame, type SyntheticMotion } from "../../pov/syntheticBody";
import { createPovTracker } from "../../pov/tracking";
import { OUT_MS } from "../capture";
import { createPunchReader, type Punch, type PunchStart } from "../punch";
import { createContactReader, type ContactEvent } from "../read/contact";
import { CAMS, runWithSetup, throwsOf } from "../read/rig";
import { boxDemoMotion } from "../scriptedBoxer";
import { bodyOf, type Me3D } from "./body3d";
import { createRealGame, type RealInput, type RealKeys, type RealView } from "./game";
import { LADDER } from "./mind";

const idle: RealKeys = { punches: [], slip: 0, duck: false, high: false, low: false, back: false, start: false };
const keyboard = (over: Partial<RealKeys> = {}, more: Partial<RealInput> = {}): RealInput => ({
  ...more,
  tracking: null,
  pose: null,
  valid: true,
  calibrated: true,
  poseT: 0,
  poseAge: 0,
  arms: null,
  keys: { ...idle, ...over },
});
const punch = (over: Partial<Punch> = {}): Punch => ({ hand: "left", shape: "straight", target: "head", power: 1, t: 0, ...over });
/** Frames at 60 a second until `until` ms or the phase is `stop`; `act` says what is pressed. */
function play(
  game: ReturnType<typeof createRealGame>,
  from: number,
  until: number,
  act: (now: number, view: RealView | null) => Partial<RealKeys> = () => ({}),
  stop?: string,
  more: (now: number, view: RealView | null) => Partial<RealInput> = () => ({}),
) {
  let view: RealView | null = null;
  const kinds: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const said: string[] = [];
  const sounds: string[] = [];
  let finishes = 0,
    bells = 0,
    now = from;
  for (; now < until && (stop === undefined || view?.phase !== stop); now += 1000 / 60) {
    view = game.frame(now, keyboard(act(now, view), more(now, view)));
    for (const e of view.events) {
      kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      if (e.kind === "its" || e.kind === "mine") outcomes[`${e.kind}:${e.outcome}`] = (outcomes[`${e.kind}:${e.outcome}`] ?? 0) + 1;
    }
    for (const line of view.lines) said.push(line.text);
    sounds.push(...view.sounds);
    if (view.finished) finishes++;
    if (view.bell) bells++;
  }
  return { view: view!, kinds, outcomes, said, sounds, finishes, bells, now };
}
/** Hands up, a one-two every two and a half seconds. */
const beginner = () => {
  let asked = false,
    next = 0,
    second = -1;
  return (now: number, v: RealView | null): Partial<RealKeys> => {
    const start = !asked;
    asked = true;
    if (v?.phase !== "fight") return { start };
    if (second >= 0 && now >= second) {
      second = -1;
      return { punches: [punch({ hand: "right" })] };
    }
    if (now >= next) {
      next = now + 2500;
      second = now + 320;
      return { punches: [punch()] };
    }
    return {};
  };
};

describe("a real bout, from the first tap to the card", () => {
  it("counts in, rings the bell, and then nothing is shown before it is thrown and nothing is said", () => {
    const game = createRealGame({ boxer: "jabber", seed: 3 });
    const bell = play(game, 0, 2600, beginner());
    expect(bell.view.phase).toBe("fight");
    expect(bell.sounds).toContain("bell");
    const round = play(game, bell.now, bell.now + 60000, beginner());
    // It threw, each punch as one motion with its times known from its first movement.
    expect(round.kinds.throw).toBeGreaterThan(6);
    const p = round.view.bout.foe.punches[0] ?? round.view.bout.foe.punch;
    if (p) {
      expect(p.commit).toBeGreaterThan(p.start);
      expect(p.impact).toBeGreaterThan(p.commit);
      expect(p.home).toBeGreaterThan(p.impact);
    }
    // Hands up: most of what it threw met gloves or was only partly through.
    const through = round.outcomes["its:clean"] ?? 0;
    const stopped = (round.outcomes["its:gloves"] ?? 0) + (round.outcomes["its:partly"] ?? 0);
    expect(stopped).toBeGreaterThan(through);
    // The player's one-twos were judged too.
    expect(Object.keys(round.outcomes).some((k) => k.startsWith("mine:"))).toBe(true);
    // In a round the corner says nothing but the time.
    expect(round.said.filter((line) => line !== "Thirty seconds.")).toEqual([]);
  });
  it("goes to the corner at the bell with the card and one instruction, waits for raised hands or the clock, and is decided after the last round", () => {
    const game = createRealGame({ boxer: "beginner", seed: 5, rounds: 2 });
    const first = play(game, 0, 140000, beginner(), "rest");
    expect(first.view.phase).toBe("rest");
    expect(first.bells).toBe(1);
    const c = first.view.corner!;
    expect(c).toMatchObject({ round: 1, of: 2 });
    expect(c.score[0] + c.score[1]).toBeGreaterThanOrEqual(18);
    expect(c.say.split(" ").length).toBeLessThanOrEqual(6);
    expect(first.said.at(-1)).toMatch(/round\. .*Breathe\./);
    // A tap in the first seconds of the rest does not skip it.
    const early = play(game, first.now, first.now + 3000, (now) => ({ start: now > first.now + 1500 && now < first.now + 1600 }));
    expect(early.view.phase).toBe("rest");
    // The clock brings the second round out.
    const second = play(game, early.now, early.now + 70000, () => ({}), "fight");
    expect(second.view.phase).toBe("fight");
    expect(second.view.bout.round).toBe(2);
    const done = play(game, second.now, second.now + 140000, beginner(), "over");
    expect(done.view.phase).toBe("over");
    expect(done.finishes).toBe(1);
    expect(done.view.result!.rounds.length).toBe(2);
    expect(done.view.result!.total[0] + done.view.result!.total[1]).toBeGreaterThanOrEqual(36);
  });
  it("keeps the opponent's body in one piece through a round against every opponent", () => {
    for (const boxer of LADDER) {
      const game = createRealGame({ boxer, seed: 11, rounds: 1 });
      const act = beginner();
      let worst = 0,
        prev: RealView | null = null;
      for (let now = 0; now < 40000; now += 1000 / 60) {
        const view = game.frame(now, keyboard(act(now, prev)));
        const d = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        // The spine keeps its lengths whatever it is doing.
        if (view.pose.fallen === 0) {
          expect(Math.abs(d(view.pose.hips, view.pose.chest) - 0.42)).toBeLessThan(0.02);
          expect(Math.abs(d(view.pose.chest, view.pose.head) - 0.27)).toBeLessThan(0.02);
        }
        // Its head never jumps: a punch is motion, not a pose snapped into.
        if (prev && prev.phase === "fight" && view.phase === "fight" && view.rate === 1 && prev.pose.fallen === 0 && view.pose.fallen === 0)
          worst = Math.max(worst, d(view.pose.head, prev.pose.head));
        // It stands at the player's own range: never on top of them, never out of sight.
        expect(view.distance).toBeGreaterThan(0.7);
        expect(view.distance).toBeLessThan(1.5);
        prev = view;
      }
      expect(worst, boxer).toBeLessThan(0.09);
    }
  });
  it("does not start a new bout on what the player was doing as the last one ended", () => {
    const game = createRealGame({ boxer: "swinger", seed: 2, rounds: 1 });
    // Do nothing: the swinger stops it.
    let asked = false;
    const lost = play(game, 0, 200000, () => ({ start: !asked && (asked = true) }), "over");
    expect(lost.view.phase).toBe("over");
    expect(lost.view.result).not.toBeNull();
    // Still punching as it ended: not a request.
    const still = play(game, lost.now, lost.now + 1200, () => ({ punches: [punch()] }));
    expect(still.view.phase).toBe("over");
    // The result is read, the hands go quiet, then a tap: a fresh bout.
    const quiet = play(game, still.now, still.now + 3200);
    const again = play(game, quiet.now, quiet.now + 400, (now) => ({ start: now < quiet.now + 100 }));
    expect(again.view.phase).toBe("count");
    expect(again.view.bout.time).toBe(0);
  });
});

describe("the gym minute", () => {
  /** Play the gym minute; `act` says what is pressed for the task on screen. */
  const gymRun = (act: (task: string, now: number, v: RealView) => Partial<RealKeys>, until = 90000) => {
    const game = createRealGame({ boxer: "beginner", seed: 6, gym: true });
    const tasks: string[] = [];
    const said: string[] = [];
    let view: RealView | null = null,
      asked = false,
      done = false,
      now = 0;
    for (; now < until && view?.phase !== "fight"; now += 1000 / 60) {
      const start = !asked;
      asked = true;
      const task = view?.teach?.word ?? "";
      if (task && tasks.at(-1) !== task) tasks.push(task);
      view = game.frame(now, keyboard({ start, ...(view && view.phase === "gym" ? act(task, now, view) : {}) }));
      for (const line of view.lines) said.push(line.text);
      if (view.gymDone) done = true;
    }
    return { view: view!, tasks, said, done, now };
  };
  it("takes a first-timer through hands up, the pad, a jab on the gloves, a step back and the head, then rings the bell", () => {
    let next = 0,
      n = 0;
    const run = gymRun((task, now, v) => {
      const p = v.bout.foe.punch;
      const coming = !!p && !p.done && v.bout.time >= p.start;
      // Slow punches at the pad: one every second and a half, so this is nobody who has boxed.
      if (task === "HIT THE PAD" && now >= next) {
        next = now + 1500;
        return { punches: [punch({ hand: n++ % 2 ? "right" : "left" })] };
      }
      // One small step back as it comes in; the head off the line as it jabs.
      if (task === "STEP BACK") return { back: v.bout.foe.feet.to === "pocket" || coming };
      if (task === "MOVE YOUR HEAD") return { slip: coming ? 1 : 0 };
      return {};
    });
    expect(run.tasks).toEqual(["HANDS UP", "HIT THE PAD", "KEEP THEM UP", "STEP BACK", "MOVE YOUR HEAD"]);
    expect(run.done).toBe(true);
    expect(run.view.phase).toBe("fight");
    expect(run.view.grade).toBe("full");
    // Nothing that happened in the gym carried over, and nobody was hurt there.
    expect(run.view.bout.me.health).toBe(100);
    expect(run.view.bout.stakes).toBe("bout");
    expect(run.said[0]).toMatch(/Hands up/);
    expect(run.now).toBeLessThan(75000);
  });
  it("lets someone who has boxed through in well under a minute", () => {
    let next = 0,
      n = 0;
    const run = gymRun((task, now, v) => {
      const p = v.bout.foe.punch;
      if (task === "HIT THE PAD" && now >= next) {
        next = now + 400;
        return { punches: [punch({ hand: n++ % 2 ? "right" : "left" })] };
      }
      if (task === "STEP BACK") return { back: v.bout.foe.feet.to === "pocket" || (!!p && !p.done) };
      return {};
    });
    // Six sharp punches: no need to be tapped on the guard or drilled on the head.
    expect(run.tasks).toEqual(["HANDS UP", "HIT THE PAD", "STEP BACK"]);
    expect(run.view.phase).toBe("fight");
    expect(run.now).toBeLessThan(40000);
  });
  it("boxes in close with a player whose step back it cannot see, and can be skipped with a tap", () => {
    let next = 0,
      n = 0;
    const planted = gymRun((task, now) => {
      if (task === "HIT THE PAD" && now >= next) {
        next = now + 1500;
        return { punches: [punch({ hand: n++ % 2 ? "right" : "left" })] };
      }
      return {};
    }, 120000);
    expect(planted.view.phase).toBe("fight");
    expect(planted.view.grade).toBe("close");
    expect(planted.view.bout.range).toBe(false);
    const skipped = gymRun((_task, now) => ({ start: now > 3000 && now < 3100 }));
    expect(skipped.view.phase).toBe("fight");
    expect(skipped.now).toBeLessThan(8000);
  });
});

describe("the frame around a round: the spot, the referee, the corner's replay, stopping", () => {
  /** Tap, and box nothing: whatever it throws arrives. */
  const tap = () => {
    let asked = false;
    return (): Partial<RealKeys> => ({ start: !asked && (asked = true) });
  };
  it("parts them when the player comes too near the screen: nothing lands until they are back, and then it gives them a moment", () => {
    const game = createRealGame({ boxer: "swinger", seed: 4, rounds: 1 });
    const bell = play(game, 0, 60000, tap(), "fight");
    // A step toward the screen: the ropes, and no break yet.
    const ropes = play(game, bell.now, bell.now + 400, () => ({}), undefined, () => ({ near: 1.22 }));
    expect(ropes.view.spot).toBe("ropes");
    expect(ropes.sounds).toContain("ropes");
    // Past the line: the referee.
    const parted = play(game, ropes.now, ropes.now + 3000, () => ({ punches: [punch()] }), undefined, () => ({ near: 1.4 }));
    expect(parted.view.spot).toBe("break");
    expect(parted.said).toContain("Break!");
    expect(parted.kinds.break).toBe(1);
    // Three seconds on the wrong side of the line: nothing of its landed, nothing of the player's counted, the clock stood still.
    const stood = parted.view.bout.time;
    const still = play(game, parted.now, parted.now + 3000, () => ({ punches: [punch()] }), undefined, () => ({ near: 1.4 }));
    expect(still.kinds.its ?? 0).toBe(0);
    expect(still.kinds.mine ?? 0).toBe(0);
    expect(still.view.bout.time).toBe(stood);
    expect(still.view.bout.foe.feet.to).toBe("edge");
    // Back on the spot: play goes on, and it starts nothing for a second.
    const back = play(game, still.now, still.now + 1000, () => ({}), undefined, () => ({ near: 1.02 }));
    expect(back.view.spot).toBe("home");
    expect(back.view.bout.time).toBeGreaterThan(stood);
    expect(back.kinds.throw ?? 0).toBe(0);
    const on = play(game, back.now, back.now + 12000, () => ({}), undefined, () => ({ near: 1 }));
    expect(on.kinds.throw).toBeGreaterThan(0);
  });
  it("does not count in a player who is standing too near, and tells the corner about a player who keeps coming in", () => {
    const game = createRealGame({ boxer: "beginner", seed: 8, rounds: 2, clock: 30 });
    const act = tap();
    const waiting = play(game, 0, 6000, act, undefined, () => ({ near: 1.25 }));
    expect(waiting.view.phase).toBe("count");
    expect(waiting.view.spot).toBe("back");
    const bell = play(game, waiting.now, waiting.now + 4000, act, "fight");
    expect(bell.view.phase).toBe("fight");
    expect(bell.view.bout.clock).toBe(30);
    // In and out three times.
    let at = bell.now;
    for (let i = 0; i < 3; i++) {
      at = play(game, at, at + 1200, () => ({}), undefined, () => ({ near: 1.4 })).now;
      at = play(game, at, at + 1500, () => ({}), undefined, () => ({ near: 1 })).now;
    }
    const corner = play(game, at, at + 60000, () => ({}), "rest");
    expect(corner.view.corner!.say).toBe("Punch, then step out.");
  });
  it("takes back a punch that was in the air when play stopped, and gives a second and a half on return", () => {
    const game = createRealGame({ boxer: "swinger", seed: 4, rounds: 1 });
    const bell = play(game, 0, 60000, tap(), "fight");
    // Until one of its punches is on its way.
    let view = bell.view,
      now = bell.now;
    while (!view.bout.foe.punches.some((p) => !p.done && !p.feint && view.bout.time >= p.start) && now < bell.now + 30000) {
      view = game.frame(now, keyboard());
      now += 1000 / 60;
    }
    expect(view.bout.foe.punches.some((p) => !p.done)).toBe(true);
    // The menu opens: play is held.
    const held = play(game, now, now + 2000, () => ({}), undefined, () => ({ hold: true }));
    expect(held.view.phase).toBe("paused");
    const resumed = play(game, held.now, held.now + 8000, () => ({}), "fight");
    expect(resumed.kinds["called-off"]).toBeGreaterThan(0);
    const after = play(game, resumed.now, resumed.now + 1300);
    expect(after.kinds.its ?? 0).toBe(0);
    expect(after.kinds.throw ?? 0).toBe(0);
  });
  it("shows the punch that got through again in the corner, from before its first movement to after it lands, three times, with one cause", () => {
    const game = createRealGame({ boxer: "swinger", seed: 4, rounds: 2, clock: 25, stakes: "touch" });
    // Elbows down the whole round: its head punches come through.
    let asked = false;
    const first = play(game, 0, 60000, () => ({ start: !asked && (asked = true), low: true }), "rest");
    expect(first.view.phase).toBe("rest");
    expect(first.outcomes["its:clean"]).toBeGreaterThan(0);
    expect(first.view.corner!.cause).toMatch(/\.$/);
    // The card first.
    const card = play(game, first.now, first.now + 6500);
    expect(card.view.replay).toBeNull();
    // Then the punch, slowed: its glove travels all the way to where the player's head was.
    let reach = Infinity,
      frames = 0,
      hits = 0,
      now = card.now,
      view = card.view;
    for (; now < card.now + 40000 && (frames === 0 || view.replay); now += 1000 / 60) {
      view = game.frame(now, keyboard());
      if (!view.replay) continue;
      frames++;
      if (view.replay.hit) hits++;
      // How near the player's spot its glove got: the distance it stood at then, less how far out its glove was.
      reach = Math.min(reach, view.distance - Math.max(...view.pose.gloves.map((g) => g.z)));
    }
    expect(frames).toBeGreaterThan(300);
    expect(hits).toBeGreaterThan(30);
    // To within a hand of the player's face (the eyes are 8 cm in front of the spot).
    expect(reach).toBeLessThan(0.35);
    // And the card again, until the next round.
    expect(view.replay).toBeNull();
    expect(view.phase).toBe("rest");
    const second = play(game, now, now + 60000, () => ({}), "fight");
    expect(second.said).toContain("Seconds out.");
    expect(second.view.bout.round).toBe(2);
  });
  it("can be stopped in the corner: the rounds boxed are kept and nobody lost", () => {
    const game = createRealGame({ boxer: "beginner", seed: 5, rounds: 3, clock: 25 });
    const first = play(game, 0, 60000, beginner(), "rest");
    game.stop();
    const done = play(game, first.now, first.now + 200);
    expect(done.view.phase).toBe("over");
    expect(done.finishes).toBe(1);
    expect(done.view.result).toMatchObject({ how: "ended", winner: null });
    expect(done.view.result!.rounds).toHaveLength(1);
    // A fresh bout afterwards, with the length asked for.
    game.setFormat(2, 90);
    const quiet = play(game, done.now, done.now + 3200);
    const again = play(game, quiet.now, quiet.now + 5000, (now) => ({ start: now < quiet.now + 100 }), "fight");
    expect(again.view.phase).toBe("fight");
    expect(again.view.bout).toMatchObject({ rounds: 2, clock: 90, time: expect.any(Number) });
    expect(again.view.result).toBeNull();
  });
});

describe("a device with a delay: the opponent is drawn ahead, and plans that far ahead", () => {
  const tap = () => {
    let asked = false;
    return (): Partial<RealKeys> => ({ start: !asked && (asked = true) });
  };
  it("begins each punch a delay after deciding it, so its first movement is seen; and shows a punch landing when its picture arrives", () => {
    const game = createRealGame({ boxer: "jabber", seed: 3, rounds: 1, stakes: "touch" });
    const act = tap();
    const delay = () => ({ leadMs: 150 });
    let view: RealView | null = null;
    const decided = new Map<number, number>();
    const shownAt = new Map<number, [number, string]>();
    const settledAt = new Map<number, [number, string]>();
    let late = 0;
    for (let now = 0; now < 60000 && view?.phase !== "over"; now += 1000 / 60) {
      view = game.frame(now, keyboard(act(), delay()));
      for (const e of view.events) {
        if (e.kind === "throw") decided.set(e.punch, e.at);
        if (e.kind === "its") settledAt.set(e.punch, [now, e.outcome]);
      }
      for (const e of view.shown) if (e.kind === "its") shownAt.set(e.punch, [now, e.outcome]);
      // Nothing is ever drawn part-way through a punch that has only just been decided.
      for (const p of view.bout.foe.punches) {
        const at = decided.get(p.id);
        if (at !== undefined) expect(p.start - at).toBeCloseTo(0.15, 1);
        if (!p.done && view.bout.time + 0.15 < p.start) late++;
      }
    }
    expect(decided.size).toBeGreaterThan(8);
    expect(settledAt.size).toBeGreaterThan(8);
    // Standing still with the hands up: every arrival was shown, once, with the picture, as what it turned out to be.
    let early = 0;
    for (const [punch, [at, outcome]] of settledAt) {
      const shown = shownAt.get(punch);
      expect(shown, `punch ${punch}`).toBeDefined();
      expect(shown![1]).toBe(outcome);
      if (at - shown![0] > 100) early++;
    }
    expect(early).toBeGreaterThan(settledAt.size * 0.8);
    expect(late).toBeGreaterThanOrEqual(0);
  });
  it("does not say beforehand how a punch ends for a player who is moving: that is shown when it is settled", () => {
    const game = createRealGame({ boxer: "jabber", seed: 3, rounds: 1, stakes: "touch" });
    let asked = false,
      view: RealView | null = null,
      settled = 0,
      early = 0;
    const shownAt = new Map<number, number>();
    for (let now = 0; now < 60000 && view?.phase !== "over"; now += 1000 / 60) {
      // Side to side without rest.
      const slip = Math.floor(now / 160) % 2 ? 1 : -1;
      view = game.frame(now, keyboard({ start: !asked && (asked = true), slip: view?.phase === "fight" ? (slip as 1 | -1) : 0 }, { leadMs: 150 }));
      for (const e of view.shown) if (e.kind === "its") shownAt.set(e.punch, now);
      for (const e of view.events)
        if (e.kind === "its") {
          settled++;
          if (now - (shownAt.get(e.punch) ?? now) > 100) early++;
        }
    }
    expect(settled).toBeGreaterThan(8);
    expect(early).toBeLessThan(settled * 0.2);
  });
});

describe("through the camera", () => {
  /** The scripted boxer through the tracker into the game, as the screen does it; `change` may alter what the game is given. */
  function camera(
    game: ReturnType<typeof createRealGame>,
    motion: (seconds: number) => SyntheticMotion,
    seconds: number,
    change: (s: number, input: RealInput) => RealInput = (_s, input) => input,
    withContact = false,
  ) {
    const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative" });
    const ruler = createArmRuler();
    // As capture.ts does it: the punch reader and the contact reader on every pose, where poses arrive.
    const reader = createPunchReader(),
      contact = createContactReader();
    let punches: Punch[] = [],
      starts: PunchStart[] = [],
      contacts: ContactEvent[] = [],
      busy: [boolean, boolean] = [false, false];
    const judgedLate: number[] = [];
    let touches = 0,
      readerPunches = 0,
      gloves = 0;
    const flyingUntil: [number, number] = [-Infinity, -Infinity];
    const outcomes: Record<string, number> = {};
    const phases: string[] = [];
    const said: string[] = [];
    const kinds: Record<string, number> = {};
    const ahead: number[] = [];
    let view: RealView | null = null,
      poseT = -Infinity,
      finishes = 0;
    for (let now = 1000; now < 1000 + seconds * 1000; now += 1000 / 60) {
      const s = (now - 1000) / 1000;
      // A pose thirty times a second, arriving 60 ms after its own time.
      if (Math.floor(now / 33.3) !== Math.floor((now - 1000 / 60) / 33.3)) {
        const t = now - 60;
        const result = tracker.update(syntheticFrame(t, motion(s)), now);
        poseT = t;
        if (withContact && result.valid && result.joints && result.jointWeights) {
          ruler.measure(result.joints, result.jointWeights, t);
          const read = reader.update(result, t, ruler.lengths());
          punches.push(...read.punches);
          starts.push(...read.starts);
          busy = reader.busy(t);
          const events = contact.update({ t, tracking: result, arms: ruler.lengths(), starts: read.starts, punches: read.punches, busy, jitter: reader.jitter() });
          touches += events.filter((e) => e.kind === "confirm" && e.touch).length;
          readerPunches += read.punches.length;
          contacts.push(...events);
          // A hand counts as out punching from a punch confirmed as thrown until its arm has ended.
          for (const e of events) {
            const i = e.hand === "left" ? 0 : 1;
            if (e.kind === "confirm") flyingUntil[i] = t + OUT_MS(e);
            else if (e.kind === "end" || e.kind === "home" || e.kind === "cancel") flyingUntil[i] = Math.min(flyingUntil[i], t + 60);
          }
          busy = [t < flyingUntil[0], t < flyingUntil[1]];
        }
      }
      const tracking = tracker.sample(now);
      if (tracking.valid && tracking.joints && tracking.jointWeights) ruler.measure(tracking.joints, tracking.jointWeights, poseT);
      const pose = trackedAvatar(tracking, 1.8, { arms: ruler.lengths() ?? undefined });
      const valid = tracking.valid && validPose(pose);
      view = game.frame(
        now,
        change(s, {
          tracking,
          pose: valid ? pose : null,
          valid,
          calibrated: tracking.calibrated,
          poseT,
          poseAge: tracker.poseAge(now),
          arms: ruler.lengths(),
          keys: null,
          ...(withContact ? { read: { punches, starts, busy }, contacts } : {}),
        }),
      );
      punches = [];
      starts = [];
      contacts = [];
      if (phases.at(-1) !== view.phase) phases.push(view.phase);
      for (const line of view.lines) said.push(line.text);
      if (view.finished) finishes++;
      gloves += view.sent.length;
      for (const e of view.events) {
        kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
        if (e.kind === "its" || e.kind === "mine") outcomes[`${e.kind}:${e.outcome}`] = (outcomes[`${e.kind}:${e.outcome}`] ?? 0) + 1;
        if (e.kind === "throw") {
          const p = view.bout.foe.punches.find((q) => q.id === e.punch);
          if (p) ahead.push(p.start - e.at);
        }
        // How long after the moment it was judged against a punch of the player's was settled.
        if (e.kind === "mine") judgedLate.push(e.at - e.judged);
      }
    }
    return { view: view!, phases, said, kinds, ahead, finishes, judgedLate, touches, readerPunches, gloves, outcomes };
  }
  it("sets up, starts on the first punch, reads the player's punches, and plans the opponent's moves ahead by the camera's delay", () => {
    const run = camera(createRealGame({ boxer: "jabber", seed: 6, rounds: 1 }), boxDemoMotion, 30);
    expect(run.phases.slice(0, 4)).toEqual(["setup", "ready", "count", "fight"]);
    expect(run.kinds.mine).toBeGreaterThan(8);
    expect(run.kinds.throw).toBeGreaterThan(3);
    // Poses arrive 60 ms old and a pose apart: its punches begin that much after they are decided.
    for (const a of run.ahead) {
      expect(a).toBeGreaterThan(0.04);
      expect(a).toBeLessThan(0.15);
    }
  });
  it("uses the device's measured delay when it has one, and parts them when the player comes too near", () => {
    const run = camera(createRealGame({ boxer: "jabber", seed: 6, rounds: 1 }), boxDemoMotion, 20, (s, input) => ({
      ...input,
      leadMs: 180,
      near: s > 12 && s < 14 ? 1.4 : 1,
    }));
    expect(Math.max(...run.ahead)).toBeGreaterThan(0.16);
    expect(run.said).toContain("Break!");
    expect(run.view.spot).toBe("home");
  });
  it("never hands a bout to somebody else: the first boxer's rounds are kept, and the newcomer gets the gym minute", () => {
    const game = createRealGame({ boxer: "jabber", seed: 6, rounds: 1 });
    const run = camera(game, boxDemoMotion, 26, (s, input) =>
      // Another body walks in at twelve seconds; set-up runs again on it; then it stands there.
      s >= 12 && s < 13.5
        ? { ...input, valid: false, pose: null, reason: "different-person" }
        : s >= 13.5 && s < 15
          ? { ...input, valid: false, pose: null, calibrated: false }
          : input,
    );
    expect(run.phases.slice(0, 6)).toEqual(["setup", "ready", "count", "fight", "paused", "over"]);
    expect(run.view.result?.how ?? "ended").toBe("ended");
    // The newcomer's first punch starts the gym minute, not a round.
    expect(run.phases).toContain("gym");
    expect(run.phases.slice(6)).not.toContain("fight");
  });
  it("with the contact reader: the same punches, each judged against the moment its fist was at full stretch", () => {
    const plain = camera(createRealGame({ boxer: "jabber", seed: 6, rounds: 1 }), boxDemoMotion, 30);
    const timed = camera(createRealGame({ boxer: "jabber", seed: 6, rounds: 1 }), boxDemoMotion, 30, undefined, true);
    expect(timed.phases.slice(0, 4)).toEqual(["setup", "ready", "count", "fight"]);
    // The scripted boxer snaps its punches: none is a touch, and as many are judged as without the contact reader, give or take.
    expect(timed.touches).toBeLessThanOrEqual(2);
    expect(timed.kinds.mine).toBeGreaterThan(plain.kinds.mine * 0.8);
    expect(timed.kinds.mine).toBeLessThan(plain.kinds.mine * 1.2 + 2);
    // The moment judged is near the moment it is settled: never a quarter of a second back, never in the future.
    for (const late of timed.judgedLate) {
      expect(late).toBeGreaterThan(-0.02);
      expect(late).toBeLessThan(0.26);
    }
  });
  it("restless hands (a known weakness): what the game makes of punches the reader invents from fists that drift about", () => {
    // Set-up with the arms down, the hands up, one punch to ring the bell; then half a minute of a restless guard, never a punch.
    const drift = (amp: number) => (s: number): SyntheticMotion => {
      if (s < 6) return boxDemoMotion(s);
      const m = boxDemoMotion(3);
      const w = (k: number) => amp * (0.625 * Math.sin(s * 5.3 + k) + 0.375 * Math.sin(s * 11 + 2 * k));
      return { ...m, leftHand: { x: m.leftHand!.x + w(0), y: m.leftHand!.y + w(1), z: m.leftHand!.z + w(2) }, rightHand: { x: m.rightHand!.x + w(3), y: m.rightHand!.y + w(4), z: m.rightHand!.z + w(5) } };
    };
    const play = (amp: number) => camera(createRealGame({ boxer: "jabber", seed: 6, rounds: 1, stakes: "touch" }), drift(amp), 40, undefined, true);
    const scored = (r: ReturnType<typeof play>) => r.view.bout.card.rounds.reduce((n, t) => n + t.clean[0] + t.partly[0], 0);
    const still = play(0);
    const lines: string[] = [];
    for (const [amp, mostScored, mostThrough] of [
      [0.04, 9, 3],
      [0.06, 32, 7],
    ] as const) {
      const restless = play(amp);
      expect(restless.phases.slice(0, 4)).toEqual(["setup", "ready", "count", "fight"]);
      lines.push(
        `fists drifting ±${amp * 100} cm for 34 s: the punch reader read ${restless.readerPunches - still.readerPunches} punches nobody threw; ${restless.touches} went to the rules as pushes (no score); ${scored(restless) - scored(still)} scored; its clean punches ${restless.outcomes["its:clean"] ?? 0} against ${still.outcomes["its:clean"] ?? 0} with still hands`,
      );
      // Known and not solved: the reader is fooled by fists that drift this far. These lines hold what the game then makes of it.
      expect(scored(restless) - scored(still)).toBeLessThanOrEqual(mostScored);
      expect((restless.outcomes["its:clean"] ?? 0) - (still.outcomes["its:clean"] ?? 0)).toBeLessThanOrEqual(mostThrough);
    }
    console.log(lines.join("\n"));
  });
});

describe("the real body through the camera: a punch is a glove that gets there", () => {
  /** The scripted person does the set-up (the reach included) and then `punches`, with their body handed to the game pose by pose. */
  function box(distance: "reach" | "far", seconds = 9) {
    const game = createRealGame({ boxer: "beginner", seed: 3, rounds: 1, clock: 3600, stakes: "touch", range: distance === "far", still: true });
    const list = Array.from({ length: 6 }, (_x, i) => ({ at: 2.5 + i * 1.0, hand: i % 2 ? ("right" as const) : ("left" as const), shape: "straight" as const, style: { extend: 0.2 } }));
    const motion = throwsOf(list);
    const outcomes: Record<string, number> = {};
    const phases: string[] = [];
    let previous: Me3D | null = null,
      touches = 0,
      furthest = 0,
      started = false;
    runWithSetup(motion, seconds, { cam: CAMS[1][1], noise: { seed: 4, sigma: 0.005, depth: 0.03 } }, (p) => {
      const body = bodyOf(p.result, { t: p.t, away: p.range.ready ? p.range.away : 0, setup: p.setup, range: p.range.units, arms: p.arms, previous });
      previous = body;
      // Two frames a pose, as a screen at sixty would draw them.
      for (const now of [p.t, p.t + 16]) {
        const view = game.frame(now, {
          tracking: p.result,
          pose: null,
          valid: body !== null,
          calibrated: true,
          poseT: p.t,
          poseAge: now - p.t + 60,
          arms: p.arms,
          keys: null,
          body,
          // A tap rings the bell once the reach has been shown.
          start: !started && p.setup !== null && p.s > 0.5,
        });
        if (view.phase === "count") started = true;
        if (phases.at(-1) !== view.phase) phases.push(view.phase);
        touches += view.touches.length;
        if (view.me) furthest = Math.max(furthest, view.me.gloves[0].z, view.me.gloves[1].z);
        for (const e of view.events) if (e.kind === "mine") outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
      }
    });
    return { outcomes, phases, touches, furthest };
  }
  it("lands, or meets a glove, when the opponent stands in reach; and meets nothing but air when it stands a step too far", () => {
    const near = box("reach");
    expect(near.phases).toContain("fight");
    // Six punches were thrown: each got somewhere, and none was invented from the guard between them.
    const landed = (near.outcomes.clean ?? 0) + (near.outcomes.partly ?? 0) + (near.outcomes.gloves ?? 0);
    expect(landed).toBeGreaterThanOrEqual(3);
    expect(landed + (near.outcomes.short ?? 0)).toBeLessThanOrEqual(6);
    // (The gloves also touched it before the bell, reaching out for the set-up: that is contact too, and counts for nothing.)
    expect(near.touches).toBeGreaterThanOrEqual(landed);
    // The glove really went out: more than half a metre in front of the spot.
    expect(near.furthest).toBeGreaterThan(0.55);
    const far = box("far");
    expect((far.outcomes.clean ?? 0) + (far.outcomes.partly ?? 0) + (far.outcomes.gloves ?? 0)).toBe(0);
    // Thrown and fallen short: counted as thrown, not as landed.
    expect(far.outcomes.short ?? 0).toBeGreaterThanOrEqual(3);
  });
});
