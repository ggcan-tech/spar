import type { ArmLengths } from "../pov/body";
import type { PlayerPose } from "../pov/duel";
import type { Vec3 } from "../pov/physics";
import { createBoxerMind, type AttackKind, type BoxLevel } from "./boxer";
import { SPOKEN, type Line } from "./coach";
import { BLOCK, NO_GUARD, readGuard, type Guard } from "./defence";
import {
  RULES,
  createFight,
  nextRound,
  stepFight,
  type FightEvent,
  type FightState,
} from "./fight";
import {
  createPunchReader,
  type ArmSource,
  type Punch,
  type PunchStart,
} from "./punch";

/**
 * One session of boxing from the camera's poses to what is drawn and heard:
 * reads punches and blocks, runs the rules at a fixed step, holds the world
 * for an instant on a hit, pauses when the player is lost, teaches the three
 * defences before a first fight, and starts and restarts without a touch.
 *
 * The first punch starts it. Anyone standing in front of a boxer punches, so
 * that needs no explaining, and it shows the punch reader works for this
 * person before anything can hit them. Covering up, a hand above the head, a
 * tap or a key also start it, and so does standing in view for a while.
 */
export const FIXED = 1 / 120;
/** The most a drawn punch is moved ahead to make up for the camera's delay, seconds. */
export const MAX_LEAD = 0.12;
export interface Keys {
  /** Punches pressed since the last frame. */
  punches: Punch[];
  slip: -1 | 0 | 1;
  duck: boolean;
  high: boolean;
  low: boolean;
  /** Start or restart was asked for. */
  start: boolean;
}
export interface BoxInput {
  /** The tracker's result for the newest pose and the pose made from it; null without a camera. */
  tracking: ArmSource | null;
  pose: PlayerPose | null;
  /** The body is tracked. */
  valid: boolean;
  /** Setup is complete. */
  calibrated: boolean;
  /** Time of the newest pose on the even clock, ms. */
  poseT: number;
  /** How old the pose is as it is drawn, ms. */
  poseAge: number;
  arms: ArmLengths | null;
  keys: Keys | null;
  /** Why the tracker is not following the player, when it is not. */
  reason?: string | null;
  /** A tap or a key asked to start, in camera mode. */
  start?: boolean;
  /** The menu is open: nothing may happen behind it. */
  hold?: boolean;
  /**
   * Punches already read from every pose since the last frame, by a reader
   * run where the poses arrive. Without it the game reads the newest pose itself.
   */
  read?: { punches: Punch[]; starts: PunchStart[]; busy: [boolean, boolean] };
}
export type BoxPhase =
  "setup" | "ready" | "count" | "lesson" | "fight" | "rest" | "drill" | "paused" | "over";
/**
 * A bout against the opponent, a minute of nothing but defence, a minute of
 * combinations called by number, or a whole session: all of them in a row with
 * a warm-up before and a cool-down after, one button and nothing to choose.
 */
export type BoxMode = "bout" | "defence" | "pads" | "session";
type StageKind = "warmup" | "pads" | "defence" | "round" | "burst" | "cooldown";
/** What is shown in the corner between rounds. */
export interface RestInfo {
  round: number;
  of: number;
  /** Seconds of rest left. */
  left: number;
  /** This round's score and the card so far: [the player, the opponent]. */
  score: [number, number];
  total: [number, number];
  praise: string;
  fix: string;
  /** A punch will start the next round now. */
  ready: boolean;
  /** Between the parts of a session: what was just done, and what comes next. */
  title?: string;
  next?: string;
}
export interface Word {
  text: string;
  sub?: string;
  tone: "good" | "bad" | "warn" | "plain";
  /** When it was said, ms. */
  at: number;
}
/** Sounds that belong to the round's flow rather than to a punch. */
export type FlowSound =
  | "setup-done"
  | "count"
  | "bell"
  | "pause"
  | "resume"
  | "tick"
  | "knock"
  | "ropes"
  | "lesson-step"
  | "lesson-done";
export interface BoxView {
  phase: BoxPhase;
  fight: FightState;
  /** The number to show large: the count in, the count back, or the referee's count over the player. */
  count: number | null;
  countKind: "start" | "resume" | "down" | "foe" | null;
  /** The player's head and hands in their own frame (hands null when unseen). */
  head: Vec3;
  hands: [Vec3 | null, Vec3 | null];
  guard: Guard;
  /** Seconds the opponent's punches are drawn ahead. */
  lead: number;
  /** What happened this frame. */
  events: FightEvent[];
  /** Punches the player began this frame, in any phase: the gloves always answer. */
  punches: PunchStart[];
  /** Punches confirmed this frame: what was judged, or would have been. */
  confirmed: Punch[];
  sounds: FlowSound[];
  /** What to do about the punch being shown, or the lesson's task. */
  cue: Word | null;
  /** The last thing worth saying in large letters. */
  word: Word | null;
  /** 1 normally; under 1 in the slow moment after a knockdown. */
  rate: number;
  stats: Stats;
  /** 0 to 1: how far a held start gesture has got. */
  hold: number;
  /** Take the centre again where the player now stands (once, as a count ends). */
  recenter: boolean;
  /** The lesson's place: which task of how many, and how many times done of how many needed. */
  lesson: { step: number; of: number; done: number; need: number } | null;
  /** The lessons were finished or skipped on this frame. */
  lessonDone: boolean;
  /** Why play is held, when it is. */
  pausedWhy: "gone" | "other-person" | "menu" | null;
  /** The player's stamina, 0 to 1. */
  breath: number;
  mode: BoxMode;
  /** Seconds left in the round, or in the drill. */
  clock: number;
  /** In the corner between rounds. */
  rest: RestInfo | null;
  /** What the coach says aloud this frame. */
  lines: Line[];
  /** A bout or a drill ended on this frame: the moment to save it. */
  finished: boolean;
  /** In a session: which part this is, of how many. */
  stage: { name: string; index: number; of: number } | null;
}
export interface Stats {
  mode: BoxMode;
  thrown: number;
  landed: number;
  counters: number;
  dodged: number;
  blocked: number;
  taken: number;
  bestCombo: number;
  /** Seconds the fight lasted. */
  seconds: number;
  /** S, A, B or C once the fight is over. */
  grade: string;
  /** One thing to do differently, from what got through. */
  advice: string;
  /** Rounds fought, and the card when it went to one: [the player, the opponent]. */
  rounds: number;
  card: [number, number] | null;
  /** With a camera: of the punches thrown, how often the hand came back to the guard and the other hand stayed up. */
  back: number;
  backOf: number;
  otherUp: number;
  otherUpOf: number;
  /** A defence drill: the longest run of clean defences, how many were clean, of how many punches. */
  streak: number;
  clean: number;
  faced: number;
  /** Pads: combinations finished, punches on the call, and combinations called. */
  combos: number;
  onCall: number;
  called: number;
  /** A whole session: each part's own score. */
  session: { pads: number; defence: number; round: "" | "win" | "loss" | "draw"; grade: string; burst: number } | null;
}
const HEAD: Vec3 = { x: 0, y: 1.65, z: 0 };
const CUE: Record<AttackKind, [string, string]> = {
  jab: ["SLIP", "Head to one side"],
  cross: ["SLIP", "Head to one side"],
  hook: ["DUCK", "Bend your knees"],
  // An elbow, not both gloves: the other hand stays up.
  body: ["ELBOW DOWN", "Elbow to your ribs"],
};
const NAME: Record<AttackKind, string> = {
  jab: "JAB",
  cross: "CROSS",
  hook: "HOOK",
  body: "BODY SHOT",
};
/** The lessons before a first fight: one task at a time, nothing at stake. */
const LESSONS: {
  word: string;
  sub: string;
  attack: AttackKind | null;
  need: number;
  /** What counts: a punch landed, a clean defence, a punch landed after making it miss, or a punch where its gloves are not. */
  task: "hit" | "defend" | "counter" | "gap";
}[] = [
  { word: "PUNCH", sub: "Hit it four times", attack: null, need: 4, task: "hit" },
  { word: "SLIP", sub: "Head to one side as it comes", attack: "jab", need: 2, task: "defend" },
  { word: "DUCK", sub: "Bend your knees, under the hook", attack: "hook", need: 2, task: "defend" },
  { word: "ELBOW DOWN", sub: "Elbow to your ribs, other hand up", attack: "body", need: 2, task: "defend" },
  // What the game is about: make it miss, then hit it.
  { word: "HIT BACK", sub: "Slip, then punch", attack: "jab", need: 2, task: "counter" },
  { word: "HIGH AND LOW", sub: "Hit where its gloves are not", attack: null, need: 4, task: "gap" },
];
/** Pads: combinations by number, in the order a class teaches them. 1 lead straight, 2 rear straight, 3 lead hook, 4 rear hook. */
export const COMBOS: readonly (readonly number[])[] = [
  [1, 1],
  [1, 2],
  [1, 1, 2],
  [1, 2, 3],
  [1, 2, 3, 2],
  [2, 3, 2],
];
/**
 * A session, in order. A beginner's class in miniature: loosen up, the pads,
 * defence, one round of the real thing, empty the tank, breathe.
 */
export const SESSION: readonly { kind: StageKind; name: string; seconds: number }[] = [
  { kind: "warmup", name: "WARM-UP", seconds: 45 },
  { kind: "pads", name: "PADS", seconds: 60 },
  { kind: "defence", name: "DEFENCE", seconds: 60 },
  { kind: "round", name: "ROUND", seconds: 120 },
  { kind: "burst", name: "FINISHER", seconds: 30 },
  { kind: "cooldown", name: "COOL-DOWN", seconds: 30 },
];
/** What the coach leads, by the second it starts: a word, what it means, and what is said. */
const LED: Record<"warmup" | "cooldown", readonly [number, string, string, string][]> = {
  warmup: [
    [0, "MARCH", "On the spot, arms loose", "March on the spot. Arms loose."],
    [10, "SHOULDERS", "Roll them back, big circles", "Roll your shoulders back. Big circles."],
    [20, "SLOW PUNCHES", "Left, right, half speed", "Slow punches. Left, right. Half speed, don't lock your elbows."],
    [33, "KNEES", "Bend them five times, slowly", "Bend your knees. Five times, slowly."],
  ],
  cooldown: [
    [0, "BREATHE", "In through the nose, out through the mouth", "Slow breathing. In through your nose, out through your mouth."],
    [13, "SHAKE OUT", "Arms and shoulders loose", "Shake out your arms and shoulders."],
    [23, "WELL DONE", "That is a session", ""],
  ],
};
const NUMBER = ["", "One", "Two", "Three", "Four"];
const PAD_NAME = ["", "jab", "cross", "hook", "hook"];
const BEAT_MS = 750,
  /** A lost player is waited for this long before play is held. */
  GRACE_MS = 400,
  COVER_MS = 450,
  RAISE_MS = 800,
  /** In view this long, a punch may start it; in view this long, it starts by itself. */
  SETTLE_MS = 600,
  AUTO_START_MS = 15000,
  /** The result stays this long, and a start gesture must then be made afresh. */
  RESULT_MS = 2500,
  /** A lesson's task is left behind after this long, whatever happened. */
  LESSON_MAX_MS = 25000,
  /** The rest between rounds, and how soon a punch may end it. */
  REST_MS = 40000,
  REST_MIN_MS = 6000,
  /** Between the parts of a session: a breath, and what is next. */
  STAGE_REST_MS = 9000,
  STAGE_REST_MIN_MS = 3000,
  /** A hand is given this long to come back to the guard after a punch. */
  BACK_MS = 900;
/** Seconds a drill lasts. */
export const DRILL_S = 60;
const smooth = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};

export function createBoxGame(
  options: {
    level?: BoxLevel;
    seed?: number;
    intro?: boolean;
    /** The player's lead hand: "right" for someone who stands right foot forward. */
    lead?: "left" | "right";
    /** Rounds in a bout. Default 3. */
    rounds?: number;
    /** A rookie opens with three slow punches that teach each defence. Off for a player who has done the lessons. */
    openers?: boolean;
    mode?: BoxMode;
    /** Low impact: no ducking. Hooks are blocked with the glove on that side. */
    gentle?: boolean;
  } = {},
) {
  let level: BoxLevel = options.level ?? "rookie";
  /** An opponent to move to at the next bell. */
  let queued: BoxLevel | null = null;
  let leadHand: "left" | "right" = options.lead ?? "left";
  const rounds = options.rounds ?? 3;
  let mode: BoxMode = options.mode ?? "bout";
  let gentle = options.gentle === true;
  const mind = createBoxerMind(options.seed);
  mind.setOpeners(options.openers ?? true);
  // The drills' own dice, apart from the opponent's.
  let dice = ((options.seed ?? Math.floor(Math.random() * 2 ** 31)) ^ 0x9e3779b9) >>> 0 || 1;
  const roll = () => {
    dice = (Math.imul(dice, 1664525) + 1013904223) >>> 0;
    return dice / 2 ** 32;
  };
  const reader = createPunchReader();
  let fight = createFight(level, 2, undefined, leadHand, rounds);
  let phase: BoxPhase = "setup";
  let last = -Infinity;
  let accumulator = 0;
  let holdUntil = -Infinity,
    holdFrom = -Infinity;
  let slowUntil = -Infinity;
  let lastPoseT = -Infinity;
  let pending: Punch[] = [];
  let word: (Word & { tier: number }) | null = null;
  let cue: Word | null = null;
  let lead = 0;
  // Smoothed head for the keyboard, so a key press is a movement and not a jump.
  let keyHead = { ...HEAD };
  let stats: Stats = blank();
  /** The finished fight's numbers, shown until the next bell. */
  let shownStats: Stats | null = null;
  /** How many times in a row each kind of punch has got through, and how many in all. */
  const hitBy: Record<AttackKind, number> = { jab: 0, cross: 0, hook: 0, body: 0 };
  const hitTotal: Record<AttackKind, number> = { jab: 0, cross: 0, hook: 0, body: 0 };
  const seen = new Set<number>();
  // Getting to the bell.
  let presentSince = -1,
    absentSince = -1,
    coveredSince = -1,
    raisedSince = -1,
    readySince = -1,
    overAt = -Infinity,
    /** After a result, the start signal must be seen to stop before it counts again. */
    rearmed = true,
    quietSince = -1;
  let counting: { from: number; kind: "start" | "resume" | "round"; beats: number; recentred: boolean } | null = null;
  let resumeTo: "fight" | "lesson" | "drill" = "fight";
  /** What a count in leads to. */
  let countTo: "fight" | "drill" = "fight";
  // The corner between rounds.
  let rest: { at: number; rearmed: boolean; quiet: number; stage?: boolean; info: Omit<RestInfo, "left" | "ready"> } | null = null;
  // A session: which part it has reached, and what each part scored.
  let session: { index: number; score: NonNullable<Stats["session"]>; round: Stats | null } | null = null;
  /** What is being played, or was last: the mode chosen may change before the next bell. */
  let active: BoxMode = mode;
  /** How long the present drill runs, seconds. */
  let drillSeconds = DRILL_S;
  /** Sounds made outside the frame's own flow. */
  let flow: FlowSound[] = [];
  // The numbers as they stood when the round began, for what is said in the corner.
  let mark: Stats = blank();
  let markHits: Record<AttackKind, number> = { jab: 0, cross: 0, hook: 0, body: 0 };
  let said30 = false;
  // The slow moment of a knockdown: from a fifth of the speed back to all of it.
  let slowFrom = -Infinity;
  // A punching hand is watched until it is back in the guard.
  const backSince: [number, number] = [-1, -1];
  let heldHigh: [boolean, boolean] = [false, false];
  // A drill.
  let drill:
    | { kind: "defence"; streak: number; best: number; clean: number; faced: number; windup: number }
    | {
        kind: "pads";
        rung: number;
        wins: number;
        call: readonly number[] | null;
        index: number;
        failed: boolean;
        calledAt: number;
        nextAt: number;
        combos: number;
        onCall: number;
        called: number;
      }
    // Led by the coach, nothing judged: a warm-up or a cool-down, and which step of it has been said.
    | { kind: "warmup"; step: number }
    | { kind: "cooldown"; step: number }
    // Thirty seconds of everything: the punches thrown are the score.
    | { kind: "burst"; thrown: number }
    | null = null;
  let lines: Line[] = [];
  let finished = false;
  let lastCount: number | null = null;
  let pausedWhy: BoxView["pausedWhy"] = null;
  // Where this player's guard and head sit, measured as they stand ready.
  let guardLevel: number = BLOCK.guardLevel;
  let guardSamples: number[] = [];
  // Getting up: asked for once, after going down, and remembered until it happens.
  let riseArmed = false,
    riseAsked = false;
  // Breath.
  let winded = false;
  let lastClockTick = Infinity;
  // Lessons.
  let teach = options.intro === true;
  let lesson: { step: number; done: number; fails: number; since: number; nextAt: number; nudged?: boolean } | null = null;

  function blank(): Stats {
    return {
      mode: "bout",
      thrown: 0,
      landed: 0,
      counters: 0,
      dodged: 0,
      blocked: 0,
      taken: 0,
      bestCombo: 0,
      seconds: 0,
      grade: "",
      advice: "",
      rounds: 0,
      card: null,
      back: 0,
      backOf: 0,
      otherUp: 0,
      otherUpOf: 0,
      streak: 0,
      clean: 0,
      faced: 0,
      combos: 0,
      onCall: 0,
      called: 0,
      session: null,
    };
  }
  /** One thing done well and one to put right, from the numbers since `from`. Only what the camera can back. */
  function notes(from: Stats, hitsFrom: Record<AttackKind, number>): { praise: string; fix: string } {
    const d = (k: "thrown" | "landed" | "counters" | "dodged" | "blocked" | "taken" | "back" | "backOf" | "otherUp" | "otherUpOf") =>
      stats[k] - from[k];
    const hits = (k: AttackKind) => hitTotal[k] - hitsFrom[k];
    const straight = hits("jab") + hits("cross");
    const praise =
      d("counters") >= 2
        ? `${d("counters")} counters landed`
        : d("dodged") >= 2
          ? `You made it miss ${d("dodged")} times`
          : d("thrown") >= 8 && d("landed") / d("thrown") >= 0.5
            ? `${Math.round((100 * d("landed")) / d("thrown"))}% of your punches landed`
            : d("blocked") >= 2
              ? `${d("blocked")} punches blocked`
              : "You stayed in it";
    const fix =
      hits("hook") >= 2 && hits("hook") >= straight && hits("hook") >= hits("body")
        ? `Hooks landed ${hits("hook")} times: bend your knees when the arm swings wide`
        : hits("body") >= 2 && hits("body") >= straight
          ? `Body shots landed ${hits("body")} times: elbow to your ribs when it dips`
          : straight >= 2
            ? `Straight punches landed ${straight} times: move your head when the glove lights`
            : d("otherUpOf") >= 5 && d("otherUp") / d("otherUpOf") < 0.6
              ? `Your other hand dropped on ${d("otherUpOf") - d("otherUp")} of ${d("otherUpOf")} punches: keep it at your chin`
              : d("backOf") >= 5 && d("back") / d("backOf") < 0.6
                ? `Your hand came back to your chin on ${d("back")} of ${d("backOf")} punches: bring it home`
                : d("counters") === 0 && d("dodged") > 0
                  ? "Hit back the moment it misses: that punch counts double"
                  : d("thrown") < 8
                    ? "Throw more: one-two every time it rests"
                    : "";
    return { praise, fix };
  }
  /** The numbers as they stand, kept to measure the next round from. */
  function markRound() {
    mark = { ...stats };
    markHits = { ...hitTotal };
    said30 = false;
    lastClockTick = Infinity;
  }
  /** The next punch of a defence drill: any of the four, from either side, at the drill's present speed. */
  function drillPunch(windup: number): NonNullable<FightState["practice"]> {
    const pick = roll();
    const attack: AttackKind = pick < 0.35 ? "jab" : pick < 0.6 ? "cross" : pick < 0.85 ? "hook" : "body";
    return {
      attack,
      windup,
      rest: 0.45,
      open: 0.45,
      ...(attack === "hook" || attack === "body" ? { hand: roll() < 0.5 ? ("left" as const) : ("right" as const) } : {}),
    };
  }
  function restart(practice?: FightState["practice"]) {
    fight = createFight(level, practice ? 0.9 : 2, practice, leadHand, rounds);
    if (gentle) fight.gentle = true;
    if (!practice) mind.reset();
    stats = blank();
    rest = null;
    drill = null;
    backSince[0] = backSince[1] = -1;
    slowFrom = -Infinity;
    seen.clear();
    pending = [];
    cue = null;
    accumulator = 0;
    holdUntil = slowUntil = -Infinity;
    winded = false;
    lastClockTick = Infinity;
    for (const k of Object.keys(hitBy) as AttackKind[]) hitBy[k] = hitTotal[k] = 0;
    markRound();
  }
  /**
   * Large words have a rank: a result outranks a note, and the same word is not
   * said again within a moment, so the stage does not flicker.
   */
  const say = (now: number, text: string, tone: Word["tone"], tier = 1, sub?: string) => {
    if (word && word.text === text && now - word.at < 600) return;
    if (word && tier < word.tier && now - word.at < 500) return;
    word = { text, tone, at: now, tier, ...(sub ? { sub } : {}) };
    // The coach says the short form of it; the coach's own pacing drops what comes too soon.
    if (SPOKEN[text]) lines.push({ ...SPOKEN[text] });
  };
  function react(now: number, events: FightEvent[], sounds: FlowSound[]) {
    for (const e of events) {
      switch (e.kind) {
        case "telegraph": {
          const stuck = hitBy[e.attack] >= 2;
          // The opponent's left arrives on the player's right: say which elbow.
          const mine = e.hand === "left" ? "Right" : "Left";
          const sub =
            e.attack === "body"
              ? `${mine} elbow to your ribs`
              : e.attack === "hook" && gentle
                ? `${mine} glove to your temple`
                : CUE[e.attack][1];
          cue =
            (phase === "fight" && (e.teaching || stuck)) || (phase === "drill" && stuck)
              ? { text: e.attack === "hook" && gentle ? "GLOVE UP" : CUE[e.attack][0], sub, tone: "warn", at: now }
              : null;
          // The one call that may be made over a punch on its way: its defence, on time.
          if (cue || phase === "lesson") {
            const answer = e.attack === "body" ? "elbow" : e.attack === "hook" ? (gentle ? "glove-up" : "duck") : "slip";
            lines.push({ text: `${answer === "glove-up" ? "Glove up" : answer.charAt(0).toUpperCase() + answer.slice(1)}.`, call: [answer], must: true });
          }
          break;
        }
        case "feint":
          cue = null;
          break;
        case "parried":
          stats.blocked++;
          hitBy[e.attack] = 0;
          cue = null;
          say(now, "PARRY!", "good", 2, "Hit back");
          holdUntil = now + 70;
          break;
        case "landed":
          stats.landed++;
          stats.bestCombo = Math.max(stats.bestCombo, e.combo);
          // The combination's count is drawn as its own thing, not as a word.
          if (e.counter) {
            stats.counters++;
            say(now, "COUNTER!", "good", 2);
          }
          // The world holds for an instant at contact, longer the heavier the punch.
          holdFrom = now + 50;
          holdUntil = Math.max(
            holdUntil,
            holdFrom + 30 + 150 * Math.min(1, e.damage / 16),
          );
          break;
        case "blocked":
          // My punch met its guard: say where to go instead. On the pads that is the point.
          if (phase !== "drill" && phase !== "lesson") say(now, e.target === "head" ? "GO LOW" : "GO HIGH", "warn");
          break;
        case "guard-broken":
          say(now, "GUARD BROKEN", "good", 2);
          holdUntil = now + 100;
          break;
        case "stopped":
          say(now, "STOPPED", "good", 2, "You beat them to it");
          break;
        case "gassed":
          // The finisher is for emptying the tank: nobody is told to stop.
          if (drill?.kind !== "burst") say(now, "BREATHE", "warn", 1, "Stop punching for a moment");
          break;
        case "dodged":
          stats.dodged++;
          hitBy[e.attack] = 0;
          cue = null;
          // A drill keeps its beat: no word to hit back, no slow moment.
          if (phase === "drill") break;
          // The next thing to do, not a label for what was done.
          say(now, "HIT BACK", "good", 2, e.late ? "Perfect timing" : e.how === "duck" ? "Ducked" : "Slipped");
          // A quarter second of slow motion: the punch going past is the reward.
          slowUntil = Math.max(slowUntil, now + (e.late ? 320 : 250));
          break;
        case "blocked-me":
          stats.blocked++;
          hitBy[e.attack] = 0;
          cue = null;
          say(now, "BLOCK!", "good");
          break;
        case "hit-me":
          stats.taken++;
          hitBy[e.attack]++;
          hitTotal[e.attack]++;
          cue = null;
          // Heavier punches hold the world longer.
          holdUntil = now + 50 + 8 * Math.min(14, e.damage);
          if (e.caught) say(now, "CAUGHT!", "bad", 2, "Hit while punching");
          else if (e.early) say(now, "TOO EARLY", "warn", 2, "Wait for it");
          else if (e.open) say(now, "HANDS UP", "bad", 1, "Fists by your chin");
          else if (hitBy[e.attack] === 1 || hitBy[e.attack] % 3 === 0)
            say(now, `${NAME[e.attack]}: ${CUE[e.attack][0]}`, "bad", 1);
          break;
        case "foe-down":
          say(
            now,
            "KNOCKDOWN!",
            "good",
            3,
            e.downs >= RULES.knockdowns ? undefined : `${e.downs} of ${RULES.knockdowns}`,
          );
          // Slow for the whole fall, coming back to speed as it lands.
          slowFrom = now;
          break;
        case "foe-up":
          break;
        case "me-down":
          riseArmed = riseAsked = false;
          slowUntil = now + 700;
          lines.push({ text: "Take a breath. Hands up when you're ready.", must: true });
          break;
        case "round-over": {
          // To the corner: the round's score, one thing done well, one to put right.
          const total = fight.card.reduce<[number, number]>((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
          const { praise, fix } = notes(mark, markHits);
          rest = { at: now, rearmed: false, quiet: -1, info: { round: e.round, of: fight.rounds, score: e.score, total, praise, fix } };
          phase = "rest";
          cue = null;
          sounds.push("bell");
          lines.push({ text: `${praise}. ${fix ? `${fix.split(":").pop()!.trim()}. ` : ""}Breathe in through your nose.`, must: true });
          break;
        }
        case "me-up":
          say(now, "ON YOUR FEET", "plain", 2);
          sounds.push("resume");
          break;
        case "over":
          break;
      }
    }
  }
  function beginCount(now: number, kind: "start" | "resume" | "round") {
    phase = "count";
    counting = { from: now, kind, beats: kind === "resume" ? 2 : 3, recentred: false };
    coveredSince = raisedSince = -1;
    lastCount = null;
    guardSamples = [];
  }
  function beginLesson(now: number, step: number) {
    if (step >= LESSONS.length) {
      endLessons(now);
      return;
    }
    const task = LESSONS[step];
    restart({ attack: task.attack, windup: 1.1 });
    lesson = { step, done: 0, fails: 0, since: now, nextAt: -1 };
    // Its gloves up to begin with, so the first punch has to go under them.
    if (task.task === "gap") fight = { ...fight, foe: { ...fight.foe, guard: "high" } };
    phase = "lesson";
    lines.push({ text: `${task.word.charAt(0)}${task.word.slice(1).toLowerCase()}. ${task.sub}.`, must: true });
  }
  /** A drill: defence, the pads, or one of a session's led or all-out parts. Nobody can be hurt in any of them. */
  function beginDrill(now: number, kind: Exclude<StageKind, "round">, seconds = DRILL_S) {
    if (kind === "defence") {
      restart(drillPunch(0.9));
      drill = { kind: "defence", streak: 0, best: 0, clean: 0, faced: 0, windup: 0.9 };
    } else {
      // It stands there: the pads, something to hit, or just company.
      restart({ attack: null, windup: 1.1 });
      if (kind === "pads") {
        // Its gloves are the pads.
        fight = { ...fight, foe: { ...fight.foe, guard: "high" } };
        drill = { kind: "pads", rung: 0, wins: 0, call: null, index: 0, failed: false, calledAt: now, nextAt: -1, combos: 0, onCall: 0, called: 0 };
      } else if (kind === "burst") drill = { kind: "burst", thrown: 0 };
      else drill = { kind, step: -1 };
    }
    drillSeconds = seconds;
    stats.mode = active;
    countTo = "drill";
    beginCount(now, "start");
  }
  /** The next part of a session. */
  function beginStage(now: number) {
    if (!session) return;
    const stage = SESSION[session.index];
    if (stage.kind === "round") {
      // One round of the real thing, against the opponent chosen.
      restart();
      fight = { ...fight, rounds: 1 };
      stats.mode = active;
      countTo = "fight";
      beginCount(now, "start");
    } else beginDrill(now, stage.kind, stage.seconds);
  }
  /**
   * A part is over. In a session that is not finished: a breath, what was
   * done, and what is next. Otherwise the result.
   */
  function endStage(now: number, title: string, summary: string, spoken: string) {
    cue = null;
    if (session && session.index < SESSION.length - 1) {
      const done = SESSION[session.index],
        next = SESSION[session.index + 1];
      rest = {
        at: now,
        rearmed: false,
        quiet: -1,
        stage: true,
        info: {
          round: session.index + 1,
          of: SESSION.length,
          score: [0, 0],
          total: [0, 0],
          praise: summary,
          fix: "",
          // The round says how it went; the others that they are done.
          title: done.kind === "round" ? title : `${done.name} DONE`,
          next: next.name,
        },
      };
      phase = "rest";
      flow.push("bell");
      lines.push({ text: `${spoken} Next: ${next.name.toLowerCase().replace("-", " ")}.`, must: true });
      return;
    }
    if (session) {
      // The whole session: the round's numbers are the ones kept, with each part's score beside them.
      const score = session.score;
      stats = { ...(session.round ?? stats), mode: "session", session: score, seconds: SESSION.reduce((a, p) => a + p.seconds, 0) };
      say(now, "SESSION DONE", "good", 4, "Six parts, start to finish");
      lines.push({ text: "That's the session. Well done.", must: true });
      session = null;
    } else {
      say(now, title, "good", 4, summary);
      lines.push({ text: spoken, must: true });
    }
    phase = "over";
    overAt = now;
    rearmed = false;
    quietSince = -1;
    finished = true;
    flow.push("bell");
  }
  function endDrill(now: number) {
    if (!drill) return;
    stats.seconds = drillSeconds;
    if (drill.kind === "defence") {
      stats.streak = drill.best;
      stats.clean = drill.clean;
      stats.faced = drill.faced;
      if (session) session.score.defence = drill.best;
      endStage(now, "TIME", `Longest run ${drill.best} · ${drill.clean} of ${drill.faced} clean`, `Time. Your longest run was ${drill.best}.`);
    } else if (drill.kind === "pads") {
      stats.combos = drill.combos;
      stats.onCall = drill.onCall;
      stats.called = drill.called;
      if (session) session.score.pads = drill.combos;
      endStage(now, "TIME", `${drill.combos} combinations · ${drill.onCall} punches on the call`, `Time. ${drill.combos} combinations.`);
    } else if (drill.kind === "burst") {
      if (session) session.score.burst = drill.thrown;
      endStage(now, "TIME", `${drill.thrown} punches in ${drillSeconds} seconds`, `Time. ${drill.thrown} punches.`);
    } else endStage(now, drill.kind === "warmup" ? "WARM" : "DONE", drill.kind === "warmup" ? "Loose and ready" : "Breathing easy", drill.kind === "warmup" ? "Good." : "Good.");
  }
  let finishedLessons = false;
  function endLessons(now: number) {
    lesson = null;
    teach = false;
    finishedLessons = true;
    restart();
    say(now, "NOW FIGHT", "good", 3);
    beginCount(now, "start");
  }

  return {
    setLevel(next: BoxLevel) {
      if (next === level) return;
      level = next;
      // Never under a fight in progress: the new opponent comes with the next bell.
      if (phase === "ready" || phase === "setup" || phase === "over") restart();
    },
    level: () => level,
    /** Which hand leads; takes effect with the next bell. */
    setLead(next: "left" | "right") {
      leadHand = next;
      if (phase === "ready" || phase === "setup" || phase === "over") restart();
    },
    /** Show the moves again before the next fight. */
    teach() {
      teach = true;
    },
    /** Fight this opponent from the next bell; what is on the canvas now is left as it lies. */
    queueLevel(next: BoxLevel) {
      queued = next;
    },
    /** Low impact, from the next bell. */
    setGentle(on: boolean) {
      gentle = on;
    },
    /** A bout, a defence drill or pads: from the next bell. */
    setMode(next: BoxMode) {
      mode = next;
    },
    mode: () => mode,
    frame(now: number, input: BoxInput): BoxView {
      const elapsed = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      const camera = input.keys === null;
      const sounds: FlowSound[] = (flow = []);
      lines = [];
      finished = false;
      // ── What the player is doing ─────────────────────────────────────────
      let head = { ...HEAD };
      let hands: [Vec3 | null, Vec3 | null] = [null, null];
      let guard: Guard = NO_GUARD;
      // Confirmed punches are judged; the start of one is enough to send the glove.
      const thrown: Punch[] = [];
      const begun: PunchStart[] = [];
      let tracked = true;
      if (camera) {
        tracked = input.valid && input.pose !== null;
        if (tracked && input.pose && input.tracking) {
          head = { ...input.pose.head };
          const src = input.tracking;
          hands = [
            src.leftHandTracked === false ? null : { ...input.pose.leftHand },
            src.rightHandTracked === false ? null : { ...input.pose.rightHand },
          ];
          // Read where the poses arrive when the screen does that; otherwise here, from the newest.
          let read: { punches: Punch[]; starts: PunchStart[] } | null = input.read ?? null;
          if (!read && input.poseT > lastPoseT) {
            lastPoseT = input.poseT;
            read = reader.update(src, input.poseT, input.arms);
          }
          if (read) {
            // A crouch takes a punch to the body, as it does in a ring. The
            // head's height was set to the player's own stance as the count ended.
            const low = HEAD.y - head.y >= RULES.duck;
            for (const p of read.punches)
              thrown.push(low && p.shape !== "uppercut" ? { ...p, target: "body" } : p);
            for (const p of read.starts)
              begun.push(low && p.shape !== "uppercut" ? { ...p, target: "body" } : p);
          }
          guard = readGuard(src, input.read?.busy ?? reader.busy(input.poseT), guardLevel, heldHigh);
          heldHigh = guard.sides ? [guard.sides.high[0], guard.sides.high[1]] : [false, false];
        }
        lead +=
          (Math.min(MAX_LEAD, Math.max(0, input.poseAge) / 1000) - lead) *
          Math.min(1, elapsed * 8);
      } else if (input.keys) {
        const k = input.keys;
        const want = { x: k.slip * 0.28, y: HEAD.y - (k.duck ? 0.32 : 0) };
        const ease = Math.min(1, elapsed * 16);
        keyHead = {
          x: keyHead.x + (want.x - keyHead.x) * ease,
          y: keyHead.y + (want.y - keyHead.y) * ease,
          z: 0,
        };
        head = { ...keyHead };
        guard = {
          high: k.high ? 2 : 0,
          low: k.low ? 2 : 0,
          up: k.low ? 0 : 2,
          heights: [null, null],
          sides: { high: [k.high, k.high], low: [k.low, k.low], up: [!k.low, !k.low] },
        };
        // Gloves where a guard, a cover or a low block would put them.
        const gy = k.high ? 0.03 : k.low ? -0.42 : -0.2;
        hands = [
          { x: head.x - 0.13, y: head.y + gy, z: 0.24 },
          { x: head.x + 0.13, y: head.y + gy, z: 0.24 },
        ];
        thrown.push(...k.punches);
        begun.push(...k.punches);
        lead = 0;
      }
      const asked = input.keys?.start === true || input.start === true;
      // ── Is the player there ──────────────────────────────────────────────
      const held = input.hold === true;
      const here = tracked && !held;
      if (here) {
        if (presentSince < 0) presentSince = now;
        absentSince = -1;
      } else {
        presentSince = -1;
        if (absentSince < 0) absentSince = now;
      }
      // A pose or two lost in the middle of an exchange is waited out.
      const gone = !here && (held || now - absentSince > GRACE_MS);
      const ready = camera ? input.calibrated : true;
      // ── Getting to the bell ──────────────────────────────────────────────
      if (phase === "setup" && ready && here) {
        phase = "ready";
        readySince = now;
        if (camera) sounds.push("setup-done");
      }
      if (camera && !input.calibrated) {
        // Setup done again before a fight goes back to setup. During one, play
        // is held and picked up where it was: a fight is never thrown away.
        if (phase === "ready") phase = "setup";
        else if (phase === "fight" || phase === "lesson" || phase === "drill" || (phase === "count" && counting?.kind === "resume")) {
          if (phase !== "count") resumeTo = phase;
          phase = "paused";
          pausedWhy = "gone";
          sounds.push("pause");
        } else if (phase === "count") {
          // Between rounds the corner waits; before a first bell it is setup again.
          phase = counting?.kind === "round" ? "rest" : "setup";
          counting = null;
        }
      }
      const covering = guard.high >= 2;
      const raised =
        camera &&
        hands.some((h) => h !== null && h.y > head.y + 0.16) &&
        !covering;
      const signal = covering || raised || thrown.length > 0 || asked;
      let hold = 0;
      if (phase === "ready" || phase === "over") {
        if (covering) {
          if (coveredSince < 0) coveredSince = now;
        } else coveredSince = -1;
        if (raised) {
          if (raisedSince < 0) raisedSince = now;
        } else raisedSince = -1;
        const over = phase === "over";
        // A result is shown for a while, and whatever the player was doing as
        // the fight ended (covering up, fists in the air) is not a request.
        if (over && now - overAt >= RESULT_MS && !rearmed) {
          if (!signal) {
            if (quietSince < 0) quietSince = now;
            if (now - quietSince >= 300) rearmed = true;
          } else quietSince = -1;
        }
        const armed = !over || rearmed;
        const coverFor = over ? 900 : COVER_MS;
        hold = armed
          ? Math.max(
              coveredSince >= 0 ? (now - coveredSince) / coverFor : 0,
              raisedSince >= 0 ? (now - raisedSince) / RAISE_MS : 0,
            )
          : 0;
        hold = Math.max(0, Math.min(1, hold));
        const settled = presentSince >= 0 && now - presentSince >= SETTLE_MS;
        const go =
          here &&
          ready &&
          armed &&
          ((asked && (over ? now - overAt >= 600 : true)) ||
            (settled && thrown.length > 0) ||
            hold >= 1 ||
            (!over && readySince >= 0 && presentSince >= 0 && now - presentSince >= AUTO_START_MS));
        if (go) {
          if (over) shownStats = { ...stats };
          if (queued) {
            level = queued;
            queued = null;
          }
          active = mode;
          session = null;
          if (mode === "session") {
            session = { index: 0, score: { pads: 0, defence: 0, round: "", grade: "", burst: 0 }, round: null };
            beginStage(now);
          } else if (mode !== "bout") beginDrill(now, mode);
          else if (teach) beginLesson(now, 0);
          else {
            if (over || fight.time > 0 || fight.practice) restart();
            countTo = "fight";
            beginCount(now, "start");
          }
        }
      } else if (phase === "rest" && rest) {
        // In the corner. Whatever the player was doing at the bell is not a
        // request; after a breath a punch brings the next round, and so does the clock.
        const sat = now - rest.at;
        if (!rest.rearmed) {
          if (!signal) {
            if (rest.quiet < 0) rest.quiet = now;
            if (now - rest.quiet >= 300) rest.rearmed = true;
          } else rest.quiet = -1;
        }
        const may =
          sat >= (rest.stage ? STAGE_REST_MIN_MS : REST_MIN_MS) && rest.rearmed && (thrown.length > 0 || asked);
        if (here && ready && (may || sat >= (rest.stage ? STAGE_REST_MS : REST_MS))) {
          if (rest.stage && session) {
            // On to the next part of the session.
            session.index++;
            beginStage(now);
          } else beginCount(now, "round");
        }
      } else if (phase === "paused") {
        if (here && ready) beginCount(now, "resume");
      } else if ((phase === "fight" || phase === "lesson" || phase === "drill") && gone) {
        resumeTo = phase;
        phase = "paused";
        pausedWhy = held ? "menu" : input.reason === "different-person" ? "other-person" : "gone";
        sounds.push("pause");
      }
      let count: number | null = null;
      let countKind: BoxView["countKind"] = null;
      let recenter = false;
      if (phase === "count" && counting) {
        if (gone || !ready) {
          // Left before the bell: back to waiting, to the corner, or to the hold it came from.
          // In the middle of a session the part waits for them rather than the session starting over.
          const within = session !== null && counting.kind === "start";
          if (within) resumeTo = countTo;
          phase = counting.kind === "resume" || within ? "paused" : counting.kind === "round" ? "rest" : "ready";
          if (phase === "paused") pausedWhy = held ? "menu" : "gone";
          counting = null;
        } else {
          const passed = now - counting.from;
          const total = counting.beats * BEAT_MS;
          // Standing ready, in their stance: where they are now is the middle,
          // and where their fists are is their guard.
          if (!counting.recentred && passed >= total - 300) {
            counting.recentred = true;
            recenter = true;
          }
          if (camera && passed >= total - 600 && guard.up >= 2 && guard.high < 2)
            for (const h of guard.heights) if (h !== null) guardSamples.push(h);
          if (passed >= total) {
            const kind = counting.kind;
            counting = null;
            if (guardSamples.length >= 6) {
              const sorted = [...guardSamples].sort((a, b) => a - b);
              guardLevel = Math.max(0, Math.min(0.3, sorted[sorted.length >> 1]));
            }
            if (kind === "resume") {
              phase = resumeTo;
              sounds.push("resume");
              // Nothing lands in the first moment back, and a punch that was
              // on its way when play stopped is taken back: it cannot land on
              // someone who has only just stepped in again.
              const f = fight.foe;
              if (f.phase === "windup" || f.phase === "strike")
                fight = { ...fight, foe: { ...f, phase: "guard", attack: null, since: fight.time, until: fight.time + 1.5 } };
              else if (f.phase === "guard") fight = { ...fight, foe: { ...f, until: Math.max(f.until, fight.time + 0.8) } };
            } else if (kind === "round") {
              fight = nextRound(fight);
              rest = null;
              phase = "fight";
              markRound();
              say(now, `ROUND ${fight.round}`, "plain", 3, fight.round === fight.rounds ? "Last round" : undefined);
              sounds.push("bell");
            } else {
              phase = countTo;
              shownStats = null;
              if (countTo === "fight") say(now, "FIGHT", "plain", 3, fight.rounds > 1 ? `Round 1 of ${fight.rounds}` : undefined);
              else if (drill?.kind === "pads") {
                say(now, "PADS", "plain", 3, "Throw the numbers it calls");
                drill.nextAt = now + 1100;
              } else if (drill?.kind === "burst") say(now, "EVERYTHING", "plain", 3, "As many punches as you can");
              else if (drill?.kind === "defence") say(now, "DON'T GET HIT", "plain", 3, "Slip, duck, elbow down");
              sounds.push("bell");
            }
            pending = [];
            accumulator = 0;
          } else {
            count = counting.beats - Math.floor(passed / BEAT_MS);
            countKind = counting.kind === "round" ? "start" : counting.kind;
          }
        }
      }
      // ── The fight, or a lesson ───────────────────────────────────────────
      const events: FightEvent[] = [];
      const rate =
        now - slowFrom < 1100 ? 0.2 + 0.8 * smooth((now - slowFrom) / 1100) : now < slowUntil ? 0.3 : 1;
      let lessonDone = false;
      if ((phase === "fight" || phase === "lesson" || phase === "drill") && here) {
        // With a camera: does the other hand stay up, and does the punching hand come home?
        if (camera && phase === "fight") {
          const ups = guard.sides?.up ?? [false, false];
          for (const p of thrown) {
            const hand = p.hand === "left" ? 0 : 1;
            stats.otherUpOf++;
            if (ups[1 - hand]) stats.otherUp++;
            backSince[hand] = now;
          }
          for (let h = 0; h < 2; h++) {
            if (backSince[h] < 0 || now - backSince[h] < 120) continue;
            if (ups[h]) {
              stats.back++;
              stats.backOf++;
              backSince[h] = -1;
            } else if (now - backSince[h] > BACK_MS) {
              stats.backOf++;
              backSince[h] = -1;
            }
          }
        }
        if (fight.foe.phase !== "down" && fight.foe.phase !== "out" && !fight.me.down)
          stats.thrown += thrown.length;
        pending.push(...thrown);
        // Getting up is something the player does after going down.
        const asking = covering || thrown.length > 0 || asked;
        if (fight.me.down && !asking) riseArmed = true;
        if (fight.me.down && riseArmed && asking) riseAsked = true;
        const rise = fight.me.down && riseAsked;
        if (now >= holdUntil || now < holdFrom) accumulator += elapsed * rate;
        const steps = Math.min(12, Math.floor(accumulator / FIXED));
        for (let i = 0; i < steps; i++) {
          fight = stepFight(
            fight,
            FIXED,
            {
              punches: pending,
              head: { x: head.x, y: head.y },
              guard,
              rise,
              // A hidden hand, or a pose more than 150 ms old: the doubt is the player's.
              blind: camera && (guard.known === false || input.poseAge > 150),
            },
            mind,
          );
          pending = [];
          accumulator -= FIXED;
          for (const e of fight.events)
            if (!seen.has(e.id)) {
              seen.add(e.id);
              events.push(e);
            }
          if (fight.over) break;
        }
        if (seen.size > 600) seen.clear();
        react(now, events, sounds);
        // TypeScript cannot see that what happened may have changed the phase.
        const stage = phase as BoxPhase;
        if (stage === "lesson" && lesson) {
          const task = LESSONS[lesson.step];
          for (const e of events) {
            if (task.task === "hit") {
              if (e.kind === "landed") lesson.done++;
            } else if (task.task === "gap") {
              // Hit where the gloves are not, and they move there: the other target next.
              if (e.kind === "landed") {
                lesson.done++;
                fight = { ...fight, foe: { ...fight.foe, guard: e.target === "head" ? "high" : "low" } };
              }
            } else if (e.kind === "hit-me") {
              // A defence has to be done twice running; hitting back just has to be done.
              if (task.task === "defend") lesson.done = 0;
              // Three misses: show it for longer.
              if (++lesson.fails === 3 && task.attack)
                fight = { ...fight, practice: { attack: task.attack, windup: 1.5 } };
            } else if (task.task === "counter") {
              if (e.kind === "landed" && e.counter) lesson.done++;
            } else if (
              (e.kind === "dodged" && task.attack !== "body") ||
              (e.kind === "blocked-me" && e.how === "low" && task.attack === "body") ||
              // Low impact: the hook is stopped with the glove on its side.
              (gentle && e.kind === "blocked-me" && e.placed && task.attack === "hook")
            )
              lesson.done++;
          }
          // Hands moving and nothing read: the punches are too slow or too short for the camera.
          if (task.task === "hit" && lesson.done === 0 && !lesson.nudged && now - lesson.since > 7000) {
            lesson.nudged = true;
            say(now, "FASTER", "warn", 2, "Snap it out and back");
            lines.push({ text: "Faster. Snap it out and back.", call: ["faster"], must: true });
          }
          if (lesson.nextAt < 0 && (lesson.done >= task.need || now - lesson.since > LESSON_MAX_MS)) {
            lesson.nextAt = now + 800;
            if (lesson.done >= task.need) say(now, "GOOD", "good", 3);
            sounds.push("lesson-step");
          }
          // Asking again, once a lesson is under way, skips the lessons.
          const skip = asked && now - lesson.since > 500;
          if (skip || (lesson.nextAt >= 0 && now >= lesson.nextAt)) {
            const next = skip ? LESSONS.length : lesson.step + 1;
            if (next >= LESSONS.length) {
              lessonDone = true;
              sounds.push("lesson-done");
            }
            beginLesson(now, next);
          }
        } else if (stage === "drill" && drill) {
          if (drill.kind === "defence") {
            let resolved = false;
            for (const e of events) {
              // A jab caught on a guard that is simply up is neither: the drill is about moving.
              if (e.kind === "dodged" || e.kind === "parried" || (e.kind === "blocked-me" && e.how !== "catch")) {
                drill.clean++;
                drill.faced++;
                drill.best = Math.max(drill.best, ++drill.streak);
                // Each clean one makes the next a little quicker.
                drill.windup = Math.max(0.42, drill.windup * 0.96);
                resolved = true;
                if (drill.streak >= 3) say(now, `×${drill.streak}`, "good");
              } else if (e.kind === "hit-me") {
                drill.faced++;
                drill.streak = 0;
                drill.windup = Math.min(0.9, drill.windup * 1.08);
                resolved = true;
              } else if (e.kind === "blocked-me") {
                drill.faced++;
                resolved = true;
              }
            }
            if (resolved) fight = { ...fight, practice: drillPunch(drill.windup) };
          } else if (drill.kind === "warmup" || drill.kind === "cooldown") {
            // Led by the coach: the next thing to do, as its second comes.
            const steps = LED[drill.kind];
            let due = -1;
            for (let i = 0; i < steps.length; i++) if (fight.time >= steps[i][0]) due = i;
            if (due > drill.step) {
              drill.step = due;
              if (steps[due][3]) lines.push({ text: steps[due][3], must: true });
              sounds.push("lesson-step");
            }
          } else if (drill.kind === "burst") drill.thrown += thrown.length;
          else {
            const pads = drill;
            // Judged by hand and order: one camera cannot be sure of a cross against a hook.
            for (const p of thrown) {
              if (!pads.call || pads.failed || pads.index >= pads.call.length || pads.nextAt >= 0) break;
              const lead = pads.call[pads.index] % 2 === 1;
              if ((p.hand === leadHand) === lead) {
                pads.index++;
                pads.onCall++;
                if (pads.index === pads.call.length) {
                  pads.combos++;
                  say(now, "GOOD", "good", 2);
                  sounds.push("lesson-step");
                  pads.nextAt = now + 800;
                  // Two of a kind done: the next one up.
                  if (++pads.wins >= 2 && pads.rung < COMBOS.length - 1) {
                    pads.rung++;
                    pads.wins = 0;
                  }
                }
              } else {
                pads.failed = true;
                say(now, "OTHER HAND", "warn", 2, pads.call[pads.index] % 2 === 1 ? "1 is your front hand" : "2 is your back hand");
                pads.nextAt = now + 1000;
              }
            }
            // Not thrown in time: the next call comes anyway.
            if (pads.call && pads.nextAt < 0 && now - pads.calledAt > 2600 + 600 * pads.call.length) pads.nextAt = now;
            if (pads.nextAt >= 0 && now >= pads.nextAt) {
              // Mostly the newest combination, sometimes an earlier one.
              const rung = roll() < 0.7 ? pads.rung : Math.floor(roll() * (pads.rung + 1));
              pads.call = COMBOS[rung];
              pads.index = 0;
              pads.failed = false;
              pads.calledAt = now;
              pads.nextAt = -1;
              pads.called++;
              sounds.push("count");
              lines.push({
                text: `${pads.call.map((n, i) => (i ? NUMBER[n].toLowerCase() : NUMBER[n])).join(", ")}.`,
                call: pads.call.map((n) => NUMBER[n].toLowerCase()),
                must: true,
              });
            }
          }
          if (fight.time >= drillSeconds) endDrill(now);
          else {
            const left = drillSeconds - fight.time;
            if (left <= 10 && Math.ceil(left) < lastClockTick) {
              if (lastClockTick === Infinity) sounds.push("knock");
              lastClockTick = Math.ceil(left);
              sounds.push("tick");
            }
          }
        } else if (stage === "fight") {
          // Learn where this player's guard sits while they stand in it.
          if (camera && guard.up >= 2 && guard.high === 0) {
            const hs = guard.heights.filter((h): h is number => h !== null);
            const mean = hs.reduce((a, h) => a + h, 0) / Math.max(1, hs.length);
            if (hs.length === 2 && Math.abs(mean - guardLevel) <= 0.08)
              guardLevel += (mean - guardLevel) * Math.min(1, elapsed / 4);
          }
          const breath = fight.me.stamina / RULES.stamina;
          if (!winded && breath < 0.3) {
            winded = true;
            say(now, "BREATHE", "warn", 1, "Stop punching for a moment");
          } else if (winded && breath > 0.6) {
            winded = false;
            say(now, "GO", "good");
          }
          const left = RULES.clock - (fight.time - fight.roundStart);
          if (!said30 && left <= 30 && left > 25) {
            said30 = true;
            lines.push({ text: "Thirty seconds.", call: ["thirty"] });
          }
          if (left <= 10 && left > 0 && Math.ceil(left) < lastClockTick) {
            if (lastClockTick === Infinity) {
              say(now, "10 SECONDS", "plain");
              // The double knock of a gym's ten-second warning.
              sounds.push("knock");
            }
            lastClockTick = Math.ceil(left);
            sounds.push("tick");
          }
          if (fight.over) {
            phase = "over";
            overAt = now;
            rearmed = false;
            quietSince = -1;
            finished = true;
            const won = fight.over.winner === 0,
              draw = fight.over.winner === null;
            // A grade to chase, and one thing to do differently.
            stats.seconds = fight.time;
            stats.rounds = fight.round;
            stats.card =
              fight.over.how === "ko" || fight.rounds === 1
                ? null
                : fight.card.reduce<[number, number]>((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
            stats.grade = !won
              ? draw
                ? "C"
                : "D"
              : fight.over.how !== "ko"
                ? "B"
                : stats.taken <= 2 && stats.counters >= 2
                  ? "S"
                  : "A";
            stats.advice = notes(blank(), { jab: 0, cross: 0, hook: 0, body: 0 }).fix;
            say(
              now,
              won ? "YOU WIN" : draw ? "DRAW" : "YOU LOSE",
              won ? "good" : draw ? "plain" : "bad",
              4,
              fight.over.how === "ko"
                ? "Knockout"
                : stats.card
                  ? `${draw ? "Level" : "On points"}, ${stats.card[0]}–${stats.card[1]}`
                  : draw
                    ? "Nothing between you"
                    : "On points",
            );
            lines.push({
              text: `${won ? "You win" : draw ? "A draw" : "It takes this one"}. ${stats.advice ? `${stats.advice.split(":").pop()!.trim()}.` : won ? "Good work." : "Again."}`,
              must: true,
            });
            if (fight.over.how !== "ko") slowUntil = now + 900;
            // Inside a session the round is one part of six: its result is kept and the session goes on.
            if (session) {
              session.score.round = won ? "win" : draw ? "draw" : "loss";
              session.score.grade = stats.grade;
              session.round = { ...stats };
              finished = false;
              // One line from the coach, not the fight's result and then the session's.
              lines.pop();
              endStage(
                now,
                won ? "ROUND WON" : draw ? "ROUND DRAWN" : "ROUND LOST",
                `Grade ${stats.grade}${stats.advice ? ` · ${stats.advice.split(":").pop()!.trim()}` : ""}`,
                won ? "Round won." : draw ? "A level round." : "It took that round.",
              );
            }
          }
        }
      }
      // The referee's count over a player who is down.
      if (phase === "fight" && fight.me.down) {
        count = Math.min(Math.ceil(RULES.downMax), 1 + Math.floor(fight.time - fight.me.downAt));
        countKind = "down";
      }
      // And over the opponent, out loud.
      if (phase === "fight" && fight.foe.phase === "down" && count === null) {
        count = 1 + Math.floor(fight.time - fight.foe.since);
        countKind = "foe";
      }
      if (count !== null && count !== lastCount)
        sounds.push(countKind === "down" || countKind === "foe" ? "tick" : "count");
      lastCount = count;
      if (word && now - word.at > (phase === "over" ? Infinity : 1100)) word = null;
      // After the result has been read, say how to go again.
      const overWord: Word | null =
        phase === "over" && now - overAt >= RESULT_MS && word
          ? { ...word, sub: camera ? "Punch to go again" : "Press Enter to go again" }
          : word;
      // A cue stays until the punch it is about has landed or been taken back.
      if (cue && (fight.foe.attack === null || fight.foe.phase === "recover")) cue = null;
      const task = phase === "lesson" && lesson ? LESSONS[lesson.step] : null;
      const lessonCue: Word | null =
        task && lesson && lesson.nextAt < 0
          ? task.task === "gap"
            ? // Which way to go now, as its gloves move.
              { text: fight.foe.guard === "high" ? "GO LOW" : "GO HIGH", sub: task.sub, tone: "warn", at: lesson.since }
            : gentle && task.attack === "hook"
              ? { text: "GLOVE UP", sub: "Glove to your temple on the side it comes from", tone: "warn", at: lesson.since }
              : { text: task.word, sub: task.sub, tone: "warn", at: lesson.since }
          : null;
      // The pads: the numbers called, until they are thrown.
      const pads = phase === "drill" && drill?.kind === "pads" ? drill : null;
      const padsCue: Word | null =
        pads?.call && pads.nextAt < 0
          ? {
              text: pads.call.join(" · "),
              sub: pads.call.map((n) => PAD_NAME[n]).join(", "),
              tone: "warn",
              at: pads.calledAt,
            }
          : null;
      // A led part: the word of the step it is on. The finisher: the count, climbing.
      const led = phase === "drill" && drill && (drill.kind === "warmup" || drill.kind === "cooldown") ? drill : null;
      const ledStep = led && led.step >= 0 ? LED[led.kind][led.step] : null;
      const burst = phase === "drill" && drill?.kind === "burst" ? drill : null;
      const stageCue: Word | null = ledStep
        ? { text: ledStep[1], sub: ledStep[2], tone: "plain", at: ledStep[0] }
        : burst
          ? { text: String(burst.thrown), sub: "Punches. Keep going", tone: "good", at: 0 }
          : null;
      const restInfo: RestInfo | null =
        phase === "rest" && rest
          ? {
              ...rest.info,
              left: Math.max(0, Math.ceil(((rest.stage ? STAGE_REST_MS : REST_MS) - (now - rest.at)) / 1000)),
              ready: now - rest.at >= (rest.stage ? STAGE_REST_MIN_MS : REST_MIN_MS) && rest.rearmed,
            }
          : phase === "count" && counting?.kind === "round" && rest
            ? { ...rest.info, left: 0, ready: false }
            : null;
      if (finishedLessons) {
        lessonDone = true;
        finishedLessons = false;
      }
      return {
        phase,
        fight,
        count,
        countKind,
        head,
        hands,
        guard,
        lead: phase === "fight" || phase === "lesson" || phase === "drill" ? lead : 0,
        events,
        punches: begun,
        confirmed: thrown,
        sounds,
        cue: phase === "fight" ? cue : phase === "drill" ? (padsCue ?? stageCue ?? cue) : lessonCue,
        word: overWord,
        rate,
        stats: shownStats ?? stats,
        hold,
        recenter,
        lesson:
          task && lesson
            ? { step: lesson.step, of: LESSONS.length, done: Math.min(lesson.done, task.need), need: task.need }
            : padsCue && pads?.call
              ? { step: 0, of: 1, done: pads.index, need: pads.call.length }
              : null,
        lessonDone,
        pausedWhy: phase === "paused" ? pausedWhy : null,
        breath: fight.me.stamina / RULES.stamina,
        // What is on the stage now; before a first bell, what has been chosen.
        mode: phase === "setup" || phase === "ready" ? mode : active,
        clock: Math.max(
          0,
          phase === "drill" || (drill && phase !== "over") ? drillSeconds - fight.time : RULES.clock - (fight.time - fight.roundStart),
        ),
        stage: session ? { name: SESSION[session.index].name, index: session.index + 1, of: SESSION.length } : null,
        rest: restInfo,
        lines,
        finished,
      };
    },
  };
}
export type BoxGame = ReturnType<typeof createBoxGame>;
