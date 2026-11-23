import type { ArmLengths } from "../../pov/body";
import type { PlayerPose } from "../../pov/duel";
import type { Vec3 } from "../../pov/physics";
import type { Line } from "../coach";
import { BLOCK, NO_GUARD, readGuard, type Guard } from "../defence";
import type { FlowSound } from "../game";
import type { FoePose } from "../opponentPose";
import { headForFoe } from "../opponentPose";
import { createPunchReader, type ArmSource, type Hand, type Punch, type PunchShape, type PunchStart } from "../punch";
import type { ContactEvent } from "../read/contact";
import { STILL, reactionOf, type Reaction } from "../reaction";
import { BOXERS, createMind, scriptedMind, type BoxerName } from "./mind";
import {
  RULES,
  breakBout,
  createBout,
  nextRound,
  stepBout,
  type Blow,
  type Bout,
  type BoutEvent,
  type BoutInput,
  type Level,
  type Mind,
  type PunchTimes,
  type Stakes,
  type Step,
  type Tally,
  type Third,
  type Thrown,
  type Why,
} from "./rules";
import { guardOfBody, type Me3D } from "./body3d";
import { createKeysBody } from "./keysBody";
import { coverOf, foeShape, roomToFoeDir, sweep, type Touch } from "./space";
import { distanceOf, standInPose, type StandInOptions } from "./standIn";

/**
 * One session of real boxing, from the camera's poses to what is drawn and
 * heard. Nothing here tells the player what to do while punches fly: no cue,
 * no word. The opponent moves at real speed and the rules (./rules) decide
 * by where things were. What this loop adds is the frame around a bout: the
 * first punch starts it, a count, rounds with a corner between, a pause when
 * the player is lost, and the result.
 */
export const FIXED = 1 / 120;
/** The most the opponent is drawn ahead to make up for the delay of the camera and the screen, seconds. */
export const MAX_LEAD = RULES.aheadMost;
/** A head that moved less than this in the last `ms`, behind an unchanged guard, will be where it is when the punch arrives. */
const STEADY = { moved: 0.04, ms: 100 };
export interface RealKeys {
  punches: Punch[];
  slip: -1 | 0 | 1;
  duck: boolean;
  /** Gloves lifted to cover; elbows down at the ribs; a step or lean back. */
  high: boolean;
  low: boolean;
  back: boolean;
  start: boolean;
}
export interface RealInput {
  tracking: ArmSource | null;
  pose: PlayerPose | null;
  valid: boolean;
  calibrated: boolean;
  poseT: number;
  poseAge: number;
  arms: ArmLengths | null;
  keys: RealKeys | null;
  reason?: string | null;
  start?: boolean;
  hold?: boolean;
  /** Punches read where the poses arrive, since the last frame. */
  read?: { punches: Punch[]; starts: PunchStart[]; busy: [boolean, boolean] };
  /** The player has pulled back: a step or a lean away, as the range reader sees it. */
  back?: boolean;
  /**
   * How large the player looks against how large they looked at their spot:
   * 1 at home, 1.2 a small step toward the screen. Not given when it is not
   * measured (the keyboard, or a camera that cannot tell).
   */
  near?: number | null;
  /**
   * This device's whole delay as the game measured it, ms: camera, model and
   * screen. The opponent is drawn that far ahead. Not given: the age of the
   * newest pose is used, which leaves the screen's share out.
   */
  leadMs?: number | null;
  /**
   * The player's punches as the contact reader gives them (read/contact.ts),
   * since the last frame, on the poses' own clock. When given they are used
   * in place of `read.punches`: each carries where it goes, how well it was
   * thrown, and the moment its fist is at full stretch, which may be a little
   * ahead of now or behind it. A touch (a hand put out, not thrown) is no punch.
   */
  contacts?: readonly ContactEvent[];
  /** The guard read from the gloves' real places, when there is an aim set-up: used in place of the picture's heights. */
  guard?: Guard | null;
  /** From a pose's own time to the rules being able to use it, ms: the model and one pose more. Not given: taken from the lead. */
  behindMs?: number | null;
  /**
   * The player's body in the room, one to one, from the newest pose (see
   * body3d.ts). Given, it is the player: the view is its eyes, the gloves
   * are where its gloves are, and a punch is its glove meeting the opponent
   * (space.ts). The punch reader is then not asked anything. The keyboard
   * needs none: it is given a body of its own (keysBody.ts).
   */
  body?: Me3D | null;
}
export type RealPhase = "setup" | "ready" | "count" | "gym" | "fight" | "rest" | "paused" | "over";
/**
 * The gym minute: a partner, real speed, nothing at stake. It teaches by
 * position and rhythm what the rounds will ask for, and it is also how the
 * game finds out, without a form, whether this camera can follow this person.
 * Words and a voice are allowed here: training is where teaching lives.
 */
const GYM: { word: string; sub: string; say: string; visits: Step[][] | null; wait: number; need: number; maxMs: number }[] = [
  { word: "HANDS UP", sub: "Fists by your chin", say: "Hands up. Fists by your chin.", visits: null, wait: 60, need: 1, maxMs: 12000 },
  { word: "HIT THE PAD", sub: "Front hand, back hand", say: "Hit the pad. Snap it back. Don't lock your elbow.", visits: null, wait: 60, need: 6, maxMs: 25000 },
  { word: "KEEP THEM UP", sub: "Its jab lands on your gloves", say: "Keep them up. It jabs your gloves.", visits: [["j"]], wait: 1.3, need: 3, maxMs: 14000 },
  { word: "STEP BACK", sub: "Look behind you first. One small step as it comes in", say: "Look behind you. When it steps in, one small step back.", visits: [["in", "h"]], wait: 1.6, need: 1, maxMs: 14000 },
  { word: "MOVE YOUR HEAD", sub: "Off the line as it jabs. Either side", say: "Now your head. Off the line as it jabs.", visits: [["j"]], wait: 1.4, need: 2, maxMs: 14000 },
];
/** What the gym minute found: everything is read; range is not (the game is boxed in close); or punches are not read at all. */
export type Grade = "full" | "close" | "not-yet";
export interface Teach {
  word: string;
  sub: string;
  beat: number;
  of: number;
  done: number;
  need: number;
}
/** What the corner says between rounds. */
export interface Corner {
  round: number;
  of: number;
  /** This round's score and the card so far: [the player, the opponent]. */
  score: [number, number];
  total: [number, number];
  /** The round's punches. */
  tally: Tally;
  /** One instruction, six words at most, picked from what cost the most. */
  say: string;
  /** Why the punch being shown again got through: the one cause the camera can back. Null when nothing clean landed. */
  cause: string | null;
  /** The share of the round the player's hands were up (or out punching), 0 to 1; null when the hands were not seen enough to say. */
  up: number | null;
  /** Seconds of rest left; and whether raised hands will bring the next round. */
  left: number;
  ready: boolean;
}
export interface Result {
  winner: "me" | "foe" | null;
  /** "ended": the player stopped the session; the rounds boxed are kept and nobody lost. */
  how: "stoppage" | "points" | "draw" | "ended";
  total: [number, number];
  rounds: Tally[];
  /** Each finished round's score, ten to whoever took it; and the share of each round the hands were up (null: not seen enough to say). */
  scores: [number, number][];
  up: (number | null)[];
  /** The player's punches each round by kind, [thrown, clean]: jabs, everything harder, and how many of either went to the body. */
  mix: Mix[];
  seconds: number;
}
export interface Mix {
  jabs: [number, number];
  power: [number, number];
  body: [number, number];
}
/** A punch of the player's as it begins: enough to send the glove on its way. */
export interface Sent {
  hand: Hand;
  shape: PunchShape;
  level: Level;
  third: Third;
}
export interface RealView {
  phase: RealPhase;
  bout: Bout;
  boxer: BoxerName;
  /** The opponent's body in its own frame, how far away it stands, and what a hit adds. */
  pose: FoePose;
  distance: number;
  react: Reaction;
  /** 0 to 1: its guard rocking under a punch it took on the gloves. */
  rock: number;
  head: Vec3;
  hands: [Vec3 | null, Vec3 | null];
  guard: Guard;
  /** The player's punches begun on this frame. */
  sent: Sent[];
  /** What the rules said happened on this frame. */
  events: BoutEvent[];
  /**
   * Its punches arriving, as they are to be seen and heard on this frame. The
   * opponent is drawn ahead of the rules by the device's delay, so the rules
   * settle a punch that long after its picture arrived. When the player stands
   * steady the outcome is certain beforehand and is shown with the picture;
   * otherwise it is shown when it is settled.
   */
  shown: BoutEvent[];
  count: number | null;
  countKind: "start" | "resume" | "down" | "foe" | null;
  sounds: FlowSound[];
  lines: Line[];
  /** Seconds left in the round. */
  clock: number;
  rate: number;
  corner: Corner | null;
  result: Result | null;
  /** 0 to 1: how far a held start signal has got. */
  hold: number;
  pausedWhy: "gone" | "other-person" | "menu" | null;
  /** A bout ended on this frame: the moment to save it. A round ended: save that much. */
  finished: boolean;
  bell: boolean;
  /** The player's own state, for what their vision shows: 0 fresh to 1 spent. */
  worn: number;
  hurt: boolean;
  breath: number;
  /** The gym minute's task, while it runs. */
  teach: Teach | null;
  /** The gym minute ended on this frame. */
  gymDone: boolean;
  /** What it found about this camera and this person; null until it has run. */
  grade: Grade | null;
  /**
   * The player's spot. "ropes": a step too near the screen. "break": the
   * referee has parted them, and nothing lands until the player is back.
   * "back": the count waits for the player to go back to their spot.
   */
  spot: "home" | "ropes" | "break" | "back";
  /** How far past their spot the player is, 0 at home to 1 at the break line. */
  crowd: number;
  /**
   * The corner is showing the punch that got through again, from the side and
   * slowed: `pose` and `distance` are then that moment's, and this is where
   * the player's head and hands were.
   */
  replay: { head: Vec3; hands: [Vec3 | null, Vec3 | null]; hit: boolean } | null;
  /** The first punches led with the other hand than the stance chosen. */
  stanceDoubt: boolean;
  /** The player's own body, to be drawn as it is: null when the gloves are only known as two points (the first build's way). */
  me: Me3D | null;
  /** Where the player's glove met something on this frame, in the room: for what is seen and heard at the place it happened. */
  touches: { hand: Hand; what: Touch["what"]; at: Vec3; speed: number }[];
}
/**
 * A punch by real contact. The glove must be moving this fast to count as
 * thrown at all (units a second), and is at full value from `good`; a stroke
 * that began this fast and met nothing is a miss; a hand may land again once
 * it has come back to this share of its arm's length.
 */
export const CONTACT = { least: 0.8, stroke: 2.0, good: 3.2, rearm: 0.66, missFrom: 0.22, /** Faster than any fist: the camera lost and found the hand. */ most: 13 };
/**
 * Where the opponent stands, head to head, set by how far this player's own
 * punches go: the middle of the last few, shoulder to the middle of the glove
 * at the far point of the stroke. (Nobody punching at air straightens the arm
 * all the way: on a real recording the fists went 0.48–0.53 m out on an arm
 * that could reach 0.59. Until a few punches have been seen, four fifths of
 * the arm is taken.) In the pocket its face is met a little before that far
 * point; at the edge it is a step further; with range off it stays in the
 * pocket. So everyone boxes at their own range.
 */
export const STANDS_AT = { pocket: 0.19, edge: 0.55, still: 0.19, /** How far its head stands in front of its feet, until that has been seen: the formula body's. */ lean: 0.05, /** A stroke counts toward the player's reach from this far out. */ from: 0.3, /** The nearest the middle of its head ever is to the player's eyes. */ clinch: 0.5 };
/** Its glove comes to the chin: this far under the eyes. */
const ARRIVES = 0.11;
/** The player's spot: ropes at this much nearer than home, the break past that, and back inside this to go on. */
export const SPOT = { ropes: 1.2, break: 1.3, back: 1.12, holdMs: 150, leastMs: 700 };
/** The replay in the corner: from this long before the punch's first movement to this long after it lands, at this share of real speed. */
const REPLAY = { before: 0.3, after: 0.15, speed: 0.25, pauseS: 1.2, fromMs: 7000, times: 3 };
const HEAD: Vec3 = { x: 0, y: 1.65, z: 0 };
const BEAT_MS = 750,
  GRACE_MS = 400,
  SETTLE_MS = 600,
  HOLD_MS = 900,
  AUTO_START_MS = 15000,
  RESULT_MS = 2500,
  /** The corner: a minute, which raised hands may end after twenty seconds. */
  REST_MS = 60000,
  REST_MIN_MS = 20000,
  /** The corner shouts in a round at most this often. */
  SHOUT_MS = 8000;
const smooth = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
export type PoseMaker = (s: Bout, t: number, o: StandInOptions) => FoePose;

export function createRealGame(
  options: {
    boxer?: BoxerName;
    seed?: number;
    stakes?: Stakes;
    range?: boolean;
    rounds?: number;
    lead?: Hand;
    /** Each opponent's punch times as the motion that draws it can show them, from its own. Not given: its own. */
    times?: (own: PunchTimes) => PunchTimes;
    /** What draws the opponent's body. The stand-in formula body unless recorded motion is given. */
    pose?: PoseMaker;
    /** Begin with the gym minute: a first visit. */
    gym?: boolean;
    /** Seconds a round lasts. */
    clock?: number;
    /** The opponent only stands there: a room to try one's own body and reach in, with nothing coming back. */
    still?: boolean;
  } = {},
) {
  let boxer: BoxerName = options.boxer ?? "beginner";
  let queued: BoxerName | null = null;
  let stakes: Stakes = options.stakes ?? "bout";
  let range = options.range !== false;
  let leadHand: Hand = options.lead ?? "left";
  let rounds = options.rounds ?? 3;
  let clock = options.clock ?? RULES.clock;
  let seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const makePose: PoseMaker = options.pose ?? standInPose;
  const reader = createPunchReader();
  const newMind = (): Mind => (options.still ? scriptedMind([["w"]], { wait: 3600 }) : createMind(BOXERS[boxer], seed));
  let mind: Mind = newMind();
  const fresh = () =>
    createBout({ boxer: BOXERS[boxer], stakes, range, lead: leadHand, rounds, clock, ...(options.times ? { times: options.times(BOXERS[boxer].times) } : {}) });
  let bout = fresh();
  let phase: RealPhase = "setup";
  let last = -Infinity,
    accumulator = 0,
    lastPoseT = -Infinity,
    lead = 0;
  let pending: Blow[] = [];
  let feintDue = false;
  // The real body: the keyboard's own, the pose before, which hands may land, strokes in the air, and what the opponent looked like lately.
  const keys = createKeysBody();
  let lastBody: Me3D | null = null;
  const armed: [boolean, boolean] = [true, true];
  const strokes: ({ from: Vec3; peak: number; hit: boolean } | null)[] = [null, null];
  const lastTouch: ({ dir: Vec3; off: Vec3; at: number } | null)[] = [null, null];
  let seenLog: { at: number; drawT: number; pose: FoePose; distance: number }[] = [];
  /** The player's own standing height, taken as each bell goes. */
  let stood = HEAD.y;
  /** The player's reach, shoulder to the middle of the glove; and how far the opponent's head stands in front of its feet, averaged over a second. */
  let myReach = 0.8 * (0.57 + 0.09),
    itsLean = STANDS_AT.lean,
    /** How far in front of the spot the player's eyes are. */
    myHeadZ = 0.08;
  /** How far out the player's last strokes went, each at its far point. */
  const farPoints: number[] = [];
  const strokeFar: [number, number] = [0, 0];
  /** How far away it stands, feet from the player's spot: the bout's two ranges put where this player's arm makes them. */
  const standsAt = (s: Bout, t: number): number => {
    const d = distanceOf(s, t);
    const head = !s.range ? myReach + STANDS_AT.still : myReach + STANDS_AT.pocket + ((d - 0.95) / (1.3 - 0.95)) * (STANDS_AT.edge - STANDS_AT.pocket);
    // `head` is where the middle of its head is to be. Never nearer the player's own head than a clinch: stepped into, it gives ground.
    const least = myHeadZ + STANDS_AT.clinch;
    // A body that carries its head in front of its feet stands that much further back.
    return Math.max(head, least) + itsLean;
  };
  const seen = new Set<number>();
  let keyHead = { ...HEAD };
  // Getting to the bell.
  let presentSince = -1,
    absentSince = -1,
    heldSince = -1,
    readySince = -1,
    overAt = -Infinity,
    rearmed = true,
    quietSince = -1;
  let counting: { from: number; kind: "start" | "resume" | "round"; beats: number; recentred: boolean } | null = null;
  let resumeTo: "fight" | "gym" = "fight";
  let lastCount: number | null = null;
  let pausedWhy: RealView["pausedWhy"] = null;
  let guardLevel: number = BLOCK.guardLevel;
  let guardSamples: number[] = [];
  let heldHigh: [boolean, boolean] = [false, false];
  // The corner.
  let rest: { at: number; rearmed: boolean; upSince: number; info: Omit<Corner, "left" | "ready"> } | null = null;
  /** The cleanest punch that got through this round, with the bout as it stood and where the player was: what the corner shows again. */
  type Kept = { damage: number; bout: Bout; punch: Thrown; head: Vec3; hands: [Vec3 | null, Vec3 | null]; cause: string };
  let worst = null as Kept | null,
    shown = null as Kept | null;
  // The player's spot, and the referee.
  let parted: { since: number } | null = null,
    breaks = 0,
    ropesAt = -Infinity,
    nearSince = -1;
  // Each round: for how long the hands were seen, and for how long of that they were up.
  let watched: [number, number][] = [[0, 0]];
  const upShare = (round: number): number | null => {
    const w = watched[round - 1];
    return w && w[0] >= 5 ? w[1] / w[0] : null;
  };
  const noMix = (): Mix => ({ jabs: [0, 0], power: [0, 0], body: [0, 0] });
  let mixes: Mix[] = [noMix()];
  // Ended by the player; a different person in the picture; which hand led the first punches.
  let stopAsked = false,
    ended: Result | null = null,
    stranger = false,
    doubt = false,
    leads: [number, number] = [0, 0],
    lastThrownAt = -Infinity;
  /** What cost the player this round: clean punches taken with the hands low, with a hand out, or standing in range. */
  let cost = { low: 0, out: 0, stood: 0, taken: 0 };
  // Drawing: the last punch that landed on it, its guard rocking, the slow moment of a knockdown,
  // and the opponent held for an instant at contact while the player goes on moving.
  let struck: StandInOptions["struck"] = null;
  let rockAt = -Infinity,
    slowFrom = -Infinity,
    /** Until when the opponent's body is held still, how far behind the bout's clock it is drawn, and the clock at the last frame. */
    heldUntil = -Infinity,
    lag = 0,
    lastBoutT = 0;
  let lastTick = Infinity,
    said30 = false;
  // Its punches whose arrival has been shown ahead of being settled: what was shown ("hit", "stopped", "missed"), or null if it could not be told.
  const told = new Map<number, string | null>();
  const inert = scriptedMind([["w"]], { wait: 99 });
  let steadyLog: { at: number; x: number; y: number; guard: string }[] = [];
  const kindOf = (outcome: string) => (outcome === "clean" || outcome === "partly" ? "hit" : outcome === "gloves" || outcome === "unseen" ? "stopped" : "missed");
  // The corner's voice in a round: what a real corner shouts, about how the
  // player is standing, never about the punch that is on its way.
  let shoutAt = -Infinity,
    lowSince = -1,
    quietFrom = -1,
    stoodSince = -1,
    quietCorner = false;
  // The gym minute.
  let teach = options.gym === true;
  let gym: { beat: number; since: number; done: number; upSince: number; hands: [number, number]; firstAt: number; fast: boolean; nextAt: number } | null = null;
  let grade: Grade | null = null;
  let gymEnded = false;

  function restart() {
    if (queued) {
      boxer = queued;
      queued = null;
    }
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    mind = newMind();
    bout = fresh();
    pending = [];
    seen.clear();
    accumulator = 0;
    rest = null;
    struck = null;
    rockAt = slowFrom = heldUntil = -Infinity;
    lag = 0;
    lastBoutT = 0;
    cost = { low: 0, out: 0, stood: 0, taken: 0 };
    lastTick = Infinity;
    said30 = false;
    worst = shown = null;
    parted = null;
    breaks = 0;
    nearSince = -1;
    ended = null;
    stopAsked = false;
    told.clear();
    watched = [[0, 0]];
    mixes = [noMix()];
  }
  /** One beat of the gym minute: a partner who does exactly one thing, at real speed, and cannot hurt. */
  function beginBeat(now: number, beat: number, lines: Line[]) {
    if (beat >= GYM.length) {
      endGym(now);
      return;
    }
    const b = GYM[beat];
    mind = scriptedMind(b.visits ?? [["w"]], { wait: b.wait });
    // A partner, not an opponent: it is slow to follow a step back, so the step is felt to work.
    bout = createBout({
      boxer: { ...BOXERS.beginner, follows: 2.5 },
      ...(options.times ? { times: options.times(BOXERS.beginner.times) } : {}),
      stakes: "touch",
      // For hands up and the pad the partner stands where a punch from the spot reaches; after that, at range.
      range: beat <= 1 ? false : range,
      lead: leadHand,
      rounds: 1,
      clock: 3600,
      opening: 1.2,
    });
    pending = [];
    seen.clear();
    accumulator = 0;
    struck = null;
    lag = 0;
    lastBoutT = 0;
    gym = { beat, since: now, done: 0, upSince: -1, hands: gym?.hands ?? [0, 0], firstAt: -1, fast: gym?.fast ?? false, nextAt: -1 };
    phase = "gym";
    lines.push({ text: b.say, must: true });
  }
  function endGym(now: number) {
    gym = null;
    teach = false;
    gymEnded = true;
    grade ??= range ? "full" : "close";
    restart();
    beginCount(now, "start");
  }
  function beginCount(now: number, kind: "start" | "resume" | "round") {
    phase = "count";
    counting = { from: now, kind, beats: kind === "resume" ? 2 : 3, recentred: false };
    heldSince = -1;
    lastCount = null;
    guardSamples = [];
  }
  /** One instruction for the corner, from what cost the most this round. Only what the camera can back. */
  function instruction(tally: Tally): string {
    if (breaks >= 3) return "Punch, then step out.";
    if (cost.taken >= 3 && cost.low >= cost.taken * 0.4) return "Hands up.";
    if (cost.taken >= 3 && cost.out >= cost.taken * 0.4) return "Bring your hand home.";
    if (cost.taken >= 3 && cost.stood >= cost.taken * 0.5) return "Punch, then move.";
    if (tally.thrown[0] < 15) return "Let your hands go.";
    if (tally.clean[0] + tally.partly[0] < tally.gloves[0]) return "Change level: body, then head.";
    return "Same again.";
  }
  /** Why a punch got through, in words the camera can stand behind. */
  function causeOf(why: Why, level: Level, shape: PunchShape, caught: boolean): string {
    if (why.low) return "Both hands were down.";
    if (why.out[0] !== why.out[1]) return `Your ${why.out[0] ? "left" : "right"} hand was out.`;
    if (why.out[0] || caught) return "You were punching.";
    if (level === "body") return "Your elbows were up: the body was open.";
    if (shape === "hook") return "It came round your glove.";
    if (shape === "uppercut") return "It came up between your gloves.";
    return "It came through your gloves.";
  }
  const totalOf = (s: Bout): [number, number] =>
    s.card.scores.reduce<[number, number]>((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);

  return {
    boxer: () => boxer,
    /** Fight this opponent from the next bell; what is on the canvas now is left as it lies. */
    queueBoxer(next: BoxerName) {
      if (phase === "setup" || phase === "ready") {
        boxer = next;
        queued = null;
        restart();
      } else queued = next;
    },
    setStakes(next: Stakes) {
      stakes = next;
      if (phase === "setup" || phase === "ready") restart();
    },
    setRange(on: boolean) {
      range = on;
      if (phase === "setup" || phase === "ready") restart();
    },
    setLead(next: Hand) {
      leadHand = next;
      if (phase === "setup" || phase === "ready") restart();
    },
    /** The gym minute again before the next bout. */
    teach() {
      teach = true;
    },
    /** A corner that says nothing during a round. */
    setQuietCorner(on: boolean) {
      quietCorner = on;
    },
    /** How many rounds and how long each is, from the next bout. */
    setFormat(nextRounds: number, seconds: number) {
      rounds = Math.max(1, Math.floor(nextRounds));
      clock = Math.max(20, seconds);
      if (phase === "setup" || phase === "ready") restart();
    },
    /** Stop here: the rounds boxed are kept, and nobody lost. */
    stop() {
      stopAsked = true;
    },
    frame(now: number, input: RealInput): RealView {
      const elapsed = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      const camera = input.keys === null;
      const sounds: FlowSound[] = [];
      const lines: Line[] = [];
      const gymOver = gymEnded;
      gymEnded = false;
      let finished = false,
        bell = false;
      // ── What the player is doing ─────────────────────────────────────────
      let head = { ...HEAD };
      let hands: [Vec3 | null, Vec3 | null] = [null, null];
      let guard: Guard = NO_GUARD;
      let busy: [boolean, boolean] = [false, false];
      const thrown: Punch[] = [];
      const begun: PunchStart[] = [];
      /** For each of `thrown`: which third it goes to, and how long ago its fist was at full stretch (negative: still to come). Null: as the shape says, and now. */
      const aimed: ({ third: Third; ago: number } | null)[] = [];
      const begunTo: (Third | null)[] = [];
      let tracked = true;
      if (camera) {
        tracked = input.valid && (input.pose !== null || (input.body ?? null) !== null);
        if (tracked && input.pose && input.tracking) {
          head = { ...input.pose.head };
          const src = input.tracking;
          hands = [
            src.leftHandTracked === false ? null : { ...input.pose.leftHand },
            src.rightHandTracked === false ? null : { ...input.pose.rightHand },
          ];
          let read: { punches: Punch[]; starts: PunchStart[] } | null = input.read ?? null;
          if (!read && input.poseT > lastPoseT) {
            lastPoseT = input.poseT;
            read = reader.update(src, input.poseT, input.arms);
          }
          // A crouch takes a punch to the body, as it does in a ring.
          const low = HEAD.y - head.y >= 0.2;
          if (input.contacts) {
            for (const e of input.contacts) {
              // A hand that went out alone and came back with no punch: a feint, for the rules' next step.
              if (e.kind === "cancel" && e.feint) feintDue = true;
              // A start is only the first sign: restless hands give many. The glove goes, and the punch counts,
              // when it is confirmed. A hand put out slowly goes to the rules as what it is: a push, which scores nothing.
              if (e.kind !== "confirm") continue;
              // With real distances the aim already knows a punch from a crouch goes low; without them the crouch says so.
              const target = e.point === null && low && e.shape !== "uppercut" ? "body" : e.level;
              begun.push({ hand: e.hand, shape: e.shape, target, t: e.t });
              begunTo.push(e.third);
              thrown.push({ hand: e.hand, shape: e.shape, target, power: e.quality, t: e.t });
              aimed.push({ third: e.third, ago: (Math.max(0, input.poseAge) + input.poseT - e.at) / 1000 });
            }
          } else if (read) {
            for (const p of read.punches) thrown.push(low && p.shape !== "uppercut" ? { ...p, target: "body" } : p);
            for (const p of read.starts) begun.push(low && p.shape !== "uppercut" ? { ...p, target: "body" } : p);
          }
          busy = input.read?.busy ?? reader.busy(input.poseT);
          guard = input.guard ?? readGuard(src, busy, guardLevel, heldHigh);
          heldHigh = guard.sides ? [guard.sides.high[0], guard.sides.high[1]] : [false, false];
        }
        const delay = typeof input.leadMs === "number" && input.leadMs > 0 ? input.leadMs : Math.max(0, input.poseAge);
        lead += (Math.min(MAX_LEAD, delay / 1000) - lead) * Math.min(1, elapsed * 8);
      } else if (input.keys) {
        const k = input.keys;
        const want = { x: k.slip * 0.28, y: HEAD.y - (k.duck ? 0.32 : 0) };
        const ease = Math.min(1, elapsed * 16);
        keyHead = { x: keyHead.x + (want.x - keyHead.x) * ease, y: keyHead.y + (want.y - keyHead.y) * ease, z: 0 };
        head = { ...keyHead };
        guard = {
          high: k.high ? 2 : 0,
          low: k.low ? 2 : 0,
          up: k.low ? 0 : 2,
          heights: [null, null],
          sides: { high: [k.high, k.high], low: [k.low, k.low], up: [!k.low, !k.low] },
          known: true,
        };
        const gy = k.high ? 0.03 : k.low ? -0.42 : -0.2;
        hands = [
          { x: head.x - 0.13, y: head.y + gy, z: 0.24 },
          { x: head.x + 0.13, y: head.y + gy, z: 0.24 },
        ];
        // A keyboard has no delay to hide; one can be asked for, to try what a camera's does.
        lead = typeof input.leadMs === "number" && input.leadMs > 0 ? Math.min(MAX_LEAD, input.leadMs / 1000) : 0;
      }
      // ── The body, one to one ─────────────────────────────────────────────
      // What the opponent looked like when the newest pose was taken: what the player was looking at then.
      const seenAgo = camera ? lead * 1000 : 0;
      let lately = seenLog.length ? seenLog[seenLog.length - 1] : null;
      for (const e of seenLog) if (e.at <= now - seenAgo) lately = e;
      else break;
      const theirs = lately ? foeShape(lately.pose, lately.distance) : null;
      if (input.keys && theirs) {
        // A key throws an arm at where the opponent is drawn: a straight down the middle, a hook round to its own side.
        for (const p of input.keys.punches) {
          const side = p.shape === "straight" ? 0 : p.hand === "left" ? -1 : 1;
          const c = p.target === "body" ? { x: (theirs.trunk.a.x + theirs.trunk.b.x) / 2, y: theirs.trunk.a.y * 0.4 + theirs.trunk.b.y * 0.6, z: (theirs.trunk.a.z + theirs.trunk.b.z) / 2 } : theirs.head.c;
          keys.punch(p.hand, p.shape, { x: c.x + side * (p.target === "body" ? 0.1 : 0.07), y: c.y - (p.shape === "uppercut" && p.target === "head" ? 0.05 : 0), z: c.z }, now);
        }
      }
      const body: Me3D | null = input.keys ? keys.update(now, input.keys) : tracked ? (input.body ?? null) : null;
      const blows: Blow[] = [];
      const touches: RealView["touches"] = [];
      let out: [boolean, boolean] = [false, false];
      if (body) {
        head = { ...body.head };
        myHeadZ += (body.head.z - myHeadZ) * Math.min(1, elapsed * 6);
        {
          // The player's reach: the middle of how far their last punches went, never more than the arm, never less than three fifths of it.
          const whole = body.bones.upperArm + body.bones.foreArm + 0.09;
          const sorted = [...farPoints].sort((x, y) => x - y);
          const typical = sorted.length >= 3 ? sorted[sorted.length >> 1] : 0.8 * whole;
          myReach += (Math.max(0.6 * whole, Math.min(whole, typical)) - myReach) * Math.min(1, elapsed * 1.5);
        }
        hands = [body.seen[0] ? body.gloves[0] : null, body.seen[1] ? body.gloves[1] : null];
        const g = guardOfBody(body);
        guard = g.guard;
        out = g.out;
        busy = g.out;
        // Nothing is asked of the punch reader: a punch is a glove meeting something.
        thrown.length = begun.length = aimed.length = begunTo.length = 0;
        const dtS = lastBody ? (body.t - lastBody.t) / 1000 : 0;
        if (lastBody && dtS > 0 && dtS < 0.25) {
          const reach = body.bones.upperArm + body.bones.foreArm;
          const at = lately ? lately.drawT : bout.time;
          for (const i of [0, 1] as const) {
            const hand: Hand = i ? "right" : "left";
            const a = lastBody.gloves[i],
              b = body.gloves[i];
            const vel = { x: (b.x - a.x) / dtS, y: (b.y - a.y) / dtS, z: (b.z - a.z) / dtS };
            const speed = Math.hypot(vel.x, vel.y, vel.z);
            // Faster than a fist can go: the hand was lost and found. Nothing is made of that pose.
            if (speed > CONTACT.most) {
              strokes[i] = null;
              continue;
            }
            const arm = { x: b.x - body.shoulders[i].x, y: b.y - body.shoulders[i].y, z: b.z - body.shoulders[i].z };
            const stretch = Math.hypot(body.wrists[i].x - body.shoulders[i].x, body.wrists[i].y - body.shoulders[i].y, body.wrists[i].z - body.shoulders[i].z) / reach;
            const outward = vel.x * arm.x + vel.y * arm.y + vel.z * arm.z > 0;
            if (!armed[i] && stretch < CONTACT.rearm) armed[i] = true;
            let st = strokes[i];
            if (!st && speed >= CONTACT.stroke && outward && body.seen[i]) {
              st = strokes[i] = { from: a, peak: speed, hit: false };
              strokeFar[i] = 0;
            }
            if (st) {
              st.peak = Math.max(st.peak, speed);
              strokeFar[i] = Math.max(strokeFar[i], b.z - body.shoulders[i].z);
            }
            const d = speed > 1e-6 ? { x: vel.x / speed, y: vel.y / speed, z: vel.z / speed } : { x: 0, y: 0, z: 1 };
            // Across is a hook, upward an uppercut, the rest straight: named from the way the fist was going, for what it costs and counts.
            const shapeOf: PunchShape = Math.abs(d.x) > 0.7 ? "hook" : d.y > 0.6 ? "uppercut" : "straight";
            const fast = Math.max(speed, st?.peak ?? 0);
            const quality = Math.max(0.3, Math.min(1.2, fast / CONTACT.good));
            const touch = theirs && armed[i] && body.seen[i] && lastBody.seen[i] && speed >= CONTACT.least ? sweep(a, b, theirs) : null;
            if (touch) {
              armed[i] = false;
              if (st) st.hit = true;
              const onIt = touch.what === "head" || touch.what === "body";
              const level: Level = touch.what === "head" ? "head" : touch.what === "body" ? "body" : theirs && touch.at.y >= theirs.head.c.y - 0.2 ? "head" : "body";
              // Which side of it, as the player sees it: the room's x.
              const third: Third = touch.off.x < -0.035 ? "left" : touch.off.x > 0.035 ? "right" : "middle";
              blows.push({ hand, shape: shapeOf, level, third, quality, at, met: onIt ? { what: "body", kept: 0.6 * touch.grazed } : { what: "guard", kept: 1 } });
              thrown.push({ hand, shape: shapeOf, target: level, power: quality, t: body.t });
              lastTouch[i] = { dir: roomToFoeDir(d), off: roomToFoeDir(touch.off), at: now };
              touches.push({ hand, what: touch.what, at: touch.at, speed: fast });
            }
            // The stroke is over: it turned back or died. If it met nothing, it was thrown at the air.
            if (st && (!outward || speed < CONTACT.least)) {
              const went = Math.hypot(b.x - st.from.x, b.y - st.from.y, b.z - st.from.z);
              // How far out this one went: what the player's range is taken from.
              if (strokeFar[i] >= STANDS_AT.from) {
                farPoints.push(strokeFar[i]);
                if (farPoints.length > 9) farPoints.shift();
              }
              if (!st.hit && went >= CONTACT.missFrom) {
                const level: Level = theirs && b.y < theirs.head.c.y - 0.25 ? "body" : "head";
                blows.push({ hand, shape: shapeOf, level, third: "middle", quality: Math.max(0.3, Math.min(1.2, st.peak / CONTACT.good)), at, met: { what: "air", kept: 0 } });
                thrown.push({ hand, shape: shapeOf, target: level, power: quality, t: body.t });
              }
              strokes[i] = null;
            }
          }
        }
        if (body !== lastBody) lastBody = body;
      } else lastBody = null;
      const asked = input.keys?.start === true || input.start === true;
      const back = (input.keys ? input.keys.back : input.back === true) || (body !== null && body.hips.z <= -0.15);
      // How near the screen the player has come, against their spot.
      const near = typeof input.near === "number" && input.near > 0 ? input.near : 1;
      let spot: RealView["spot"] = "home";
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
      const gone = !here && (held || now - absentSince > GRACE_MS);
      const ready = camera ? input.calibrated : true;
      if (phase === "setup" && ready && here) {
        phase = "ready";
        readySince = now;
        if (camera) sounds.push("setup-done");
      }
      if (camera && !input.calibrated) {
        // Set-up is running again on whoever came into the picture: this is not the boxer who was here.
        if (phase === "paused" && pausedWhy === "other-person") stranger = true;
        if (phase === "ready") phase = "setup";
        else if (phase === "fight" || (phase === "count" && counting?.kind === "resume")) {
          phase = "paused";
          pausedWhy = "gone";
          sounds.push("pause");
        } else if (phase === "count") {
          phase = counting?.kind === "round" ? "rest" : "setup";
          counting = null;
        }
      }
      // Stopped by the player: what was boxed is kept, and the card is shown.
      if (stopAsked) {
        stopAsked = false;
        if (phase === "fight" || phase === "rest" || phase === "paused" || (phase === "count" && counting?.kind !== "start")) {
          const boxed = bout.card.rounds.filter((t) => t.thrown[0] + t.thrown[1] > 0);
          ended = { winner: null, how: "ended", total: totalOf(bout), rounds: boxed, scores: bout.card.scores, up: boxed.map((_t, i) => upShare(i + 1)), mix: mixes, seconds: bout.time };
          phase = "over";
          counting = null;
          rest = null;
          parted = null;
          overAt = now;
          rearmed = false;
          quietSince = -1;
          finished = boxed.length > 0;
          sounds.push("bell");
        }
      }
      // Hands up and held: the boxer's own way of saying "ready".
      const handsUp = guard.up >= 2;
      const signal = thrown.length > 0 || asked;
      let hold = 0;
      if (phase === "ready" || phase === "over") {
        const over = phase === "over";
        if (over && now - overAt >= RESULT_MS && !rearmed) {
          if (!signal) {
            if (quietSince < 0) quietSince = now;
            if (now - quietSince >= 300) rearmed = true;
          } else quietSince = -1;
        }
        const armed = !over || rearmed;
        // Before a first bell the player stands with their hands up anyway, so only a punch or a tap starts it there.
        if (over && armed && handsUp && camera) {
          if (heldSince < 0) heldSince = now;
        } else heldSince = -1;
        hold = heldSince >= 0 ? Math.min(1, (now - heldSince) / HOLD_MS) : 0;
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
          if (teach) beginBeat(now, 0, lines);
          else {
            if (over || bout.time > 0) restart();
            beginCount(now, "start");
          }
        }
      } else if (phase === "rest" && rest) {
        const sat = now - rest.at;
        if (!rest.rearmed) {
          if (!signal) {
            if (quietSince < 0) quietSince = now;
            if (now - quietSince >= 300) rest.rearmed = true;
          } else quietSince = -1;
        }
        // The player is tired: raised hands bring the next round, not a punch.
        if (sat >= REST_MIN_MS && handsUp && camera) {
          if (rest.upSince < 0) rest.upSince = now;
        } else rest.upSince = -1;
        const may = sat >= REST_MIN_MS && ((rest.upSince >= 0 && now - rest.upSince >= 1000) || (rest.rearmed && asked));
        if (here && ready && (may || sat >= REST_MS)) {
          beginCount(now, "round");
          lines.push({ text: "Seconds out.", call: ["seconds-out"], must: true });
        }
      } else if (phase === "paused") {
        if (here && ready) {
          if (stranger) {
            // Somebody else: the first boxer's rounds are kept, and the newcomer gets their own gym minute.
            stranger = false;
            stopAsked = true;
            teach = true;
            grade = null;
          } else beginCount(now, "resume");
        }
      } else if ((phase === "fight" || phase === "gym") && gone) {
        resumeTo = phase;
        phase = "paused";
        pausedWhy = held ? "menu" : input.reason === "different-person" ? "other-person" : "gone";
        sounds.push("pause");
      }
      let count: number | null = null;
      let countKind: RealView["countKind"] = null;
      if (phase === "count" && counting) {
        if (gone || !ready) {
          phase = counting.kind === "resume" ? "paused" : counting.kind === "round" ? "rest" : "ready";
          if (phase === "paused") pausedWhy = held ? "menu" : "gone";
          counting = null;
        } else {
          // Too near the screen: the count waits for the player to go back to their spot.
          if (near >= SPOT.ropes) {
            counting.from = now;
            spot = "back";
          }
          const passed = now - counting.from;
          const total = counting.beats * BEAT_MS;
          if (camera && passed >= total - 600 && guard.up >= 2 && guard.high < 2)
            for (const h of guard.heights) if (h !== null) guardSamples.push(h);
          if (passed >= total) {
            const kind = counting.kind;
            counting = null;
            if (guardSamples.length >= 6) {
              const sorted = [...guardSamples].sort((a, b) => a - b);
              guardLevel = Math.max(0, Math.min(0.3, sorted[sorted.length >> 1]));
            }
            if (body) stood = Math.max(1.2, body.head.y);
            if (kind === "round") {
              bout = nextRound(bout);
              rest = null;
              cost = { low: 0, out: 0, stood: 0, taken: 0 };
              lastTick = Infinity;
              said30 = false;
              worst = shown = null;
              breaks = 0;
              watched.push([0, 0]);
              mixes.push(noMix());
            } else if (kind === "resume") {
              sounds.push("resume");
              // Whatever was in the air when play stopped is taken back, and it gives a second and a half.
              bout = breakBout(bout, 1.5);
            }
            if (kind !== "resume") sounds.push("bell");
            phase = kind === "resume" ? resumeTo : "fight";
            pending = [];
            accumulator = 0;
          } else {
            count = counting.beats - Math.floor(passed / BEAT_MS);
            countKind = counting.kind === "round" ? "start" : counting.kind;
          }
        }
      }
      // ── The bout ─────────────────────────────────────────────────────────
      const events: BoutEvent[] = [];
      const arrivals: BoutEvent[] = [];
      // Slow only for a knockdown: a fifth of the speed, back to all of it within a second.
      const rate = now - slowFrom < 1000 ? 0.25 + 0.75 * smooth((now - slowFrom - 600) / 400) : 1;
      /** Where a punch goes when the camera cannot say: a straight down the middle, a hook round to its own side. */
      const sideOf = (p: { hand: Hand; shape: PunchShape }): Third => (p.shape === "straight" ? "middle" : p.hand === "left" ? "left" : "right");
      // With a real body nothing is sent: the glove is where the hand is.
      const sent: Sent[] = body ? [] : begun.map((p, i) => ({ hand: p.hand, shape: p.shape, level: p.target, third: begunTo[i] ?? sideOf(p) }));
      // From a pose's own time to the rules: what a moment on the poses' clock is turned into the rules' time with.
      const behind = typeof input.behindMs === "number" && input.behindMs >= 0 ? input.behindMs / 1000 : Math.min(lead, 0.12);
      const collect = () => {
        for (const e of bout.events)
          if (!seen.has(e.id)) {
            seen.add(e.id);
            events.push(e);
          }
      };
      // The player's spot: the ropes a step too near the screen, then the referee.
      if ((phase === "fight" || phase === "gym") && here) {
        if (!parted) {
          if (near >= SPOT.ropes) {
            spot = "ropes";
            if (now - ropesAt > 2500) {
              ropesAt = now;
              sounds.push("ropes");
            }
          }
          nearSince = near >= SPOT.break ? (nearSince < 0 ? now : nearSince) : -1;
          if (nearSince >= 0 && now - nearSince >= SPOT.holdMs && !bout.me.down && !bout.foe.down) {
            parted = { since: now };
            nearSince = -1;
            breaks++;
            bout = breakBout(bout, 1.5);
            collect();
            lines.push({ text: "Break!", call: ["break"], must: true });
          }
        } else if (near < SPOT.back && now - parted.since >= SPOT.leastMs) parted = null;
        if (parted) spot = "break";
      }
      if ((phase === "fight" || phase === "gym") && here && !parted) {
        // A punch read now reached full stretch about now, unless the contact reader gave the moment itself:
        // then it is the rules' time at which the player, at full stretch, saw what was on the screen.
        // Real contact has already made its punches, with what each met.
        if (body) pending.push(...blows);
        else thrown.forEach((p, i) => {
          const more = aimed[i] ?? null;
          pending.push({
            hand: p.hand,
            shape: p.shape,
            level: p.target,
            third: more ? more.third : sideOf(p),
            quality: camera ? p.power : 1,
            at: more ? Math.max(bout.time - 0.25, Math.min(bout.time + 0.3, bout.time - more.ago + behind)) : bout.time,
          });
        });
        const blind = camera && (guard.known === false || input.poseAge > 150);
        if (phase === "fight" && !blind && !bout.me.down && !bout.foe.down) {
          const w = watched[watched.length - 1];
          w[0] += elapsed;
          if (guard.up >= 2 || busy[0] || busy[1]) w[1] += elapsed;
        }
        accumulator += elapsed * rate;
        const steps = Math.min(12, Math.floor(accumulator / FIXED));
        // What the rules are told of the player, for this frame's steps and for the look ahead below.
        const told0: Omit<BoutInput, "punches"> = {
          head: { x: head.x, y: head.y },
          guard,
          back,
          busy,
          standing: body ? stood : HEAD.y,
          blind,
          ahead: lead,
          // Where the gloves and forearms really are decides what they keep out.
          ...(body
            ? {
                kept: (p: Thrown) => {
                  // Its glove comes to the chin, a little to its own side: its left hand arrives on the player's right.
                  const side = p.hand === "left" ? 1 : -1;
                  const to =
                    p.level === "body"
                      ? { x: body.hips.x + (body.head.x - body.hips.x) * 0.4 + side * 0.03, y: body.hips.y + 0.28 }
                      : { x: (p.aim ? p.aim.x : body.head.x) + side * 0.03, y: (p.aim ? p.aim.y : body.head.y) - ARRIVES };
                  // A hook comes round from its side; an uppercut comes up from below.
                  const from = p.shape === "hook" ? { x: to.x + side * 0.32, y: to.y } : p.shape === "uppercut" ? { x: to.x, y: to.y - 0.3 } : null;
                  return coverOf(body, to, from, out);
                },
              }
            : {}),
        };
        for (let i = 0; i < steps; i++) {
          bout = stepBout(bout, FIXED, { ...told0, punches: pending, shown: feintDue }, mind);
          feintDue = false;
          pending = [];
          accumulator -= FIXED;
          collect();
          if (bout.over || bout.rest) break;
        }
        if (seen.size > 800) seen.clear();
        // ── Its punches, shown as they arrive in the picture ─────────────────
        // Is the player standing as they stood a tenth of a second ago?
        const signature = `${guard.high}${guard.low}${guard.up}${busy[0] ? 1 : 0}${busy[1] ? 1 : 0}${back ? 1 : 0}`;
        steadyLog.push({ at: now, x: head.x, y: head.y, guard: signature });
        while (steadyLog.length > 2 && now - steadyLog[1].at >= STEADY.ms) steadyLog.shift();
        const old = steadyLog[0];
        const steady =
          !blind && now - old.at >= STEADY.ms * 0.6 && Math.hypot(head.x - old.x, head.y - old.y) < STEADY.moved && steadyLog.every((l) => l.guard === signature);
        if (lead > 0.03)
          for (const p of bout.foe.punches) {
            if (p.done || p.feint || told.has(p.id) || bout.time + lead < p.impact) continue;
            told.set(p.id, null);
            if (!steady || bout.over || bout.rest) continue;
            // The same rules, run on to the moment it lands with the player held as they stand.
            let ghost = bout,
              found: BoutEvent | null = null;
            for (let i = 0; i < 60 && !found && !ghost.over && !ghost.rest; i++) {
              ghost = stepBout(ghost, FIXED, { ...told0, punches: [], blind: false }, inert);
              found = ghost.events.find((e) => e.kind === "its" && e.punch === p.id) ?? null;
            }
            if (found && found.kind === "its") {
              told.set(p.id, kindOf(found.outcome));
              arrivals.push({ ...found, id: -found.id });
            }
          }
        for (const e of events)
          if (e.kind === "its") {
            // Already shown as what it turned out to be: nothing more. Otherwise it is shown now.
            const was = told.get(e.punch);
            told.delete(e.punch);
            if (was == null || (kindOf(e.outcome) === "hit" && was !== "hit")) arrivals.push(e);
          } else if (e.kind === "called-off") told.delete(e.punch);
        if (told.size > 40) told.clear();
        for (const e of events) {
          if (e.kind === "mine") {
            if (phase === "fight") {
              // The card's own count: a jab is the front hand's straight; everything else is a power punch.
              const m = mixes[mixes.length - 1];
              const clean = e.outcome === "clean" ? 1 : 0;
              const kind = e.shape === "straight" && e.hand === bout.lead ? m.jabs : m.power;
              kind[0]++;
              kind[1] += clean;
              if (e.level === "body") {
                m.body[0]++;
                m.body[1] += clean;
              }
            }
            if (e.outcome === "clean" || e.outcome === "partly") {
              // What the opponent's body does with it, and an instant in which only it stands still.
              // With real contact it goes the way it was hit: the fist's own line, and the side of it that was caught.
              const how = lastTouch[e.hand === "left" ? 0 : 1];
              struck = {
                at: bout.time,
                hand: e.hand,
                shape: e.shape,
                target: e.level,
                power: 1,
                damage: Math.min(16, e.damage * 3.4),
                ...(how && now - how.at < 400 ? { dir: how.dir, off: how.off } : {}),
              };
              const stop = e.outcome === "clean" ? (e.counter || e.solid ? 50 : 33) : 0;
              if (stop) heldUntil = Math.max(heldUntil, now + stop);
            } else if (e.outcome === "gloves") rockAt = bout.time;
          } else if (e.kind === "its") {
            if (e.outcome === "clean" || e.outcome === "partly") {
              cost.taken++;
              if (e.why.low) cost.low++;
              if (e.why.out[0] || e.why.out[1]) cost.out++;
              if (e.why.reach && !e.why.low && !(e.why.out[0] || e.why.out[1])) cost.stood++;
              // The cleanest one of the round is what the corner shows again.
              const punch = bout.foe.punches.find((q) => q.id === e.punch);
              const weight = e.damage * (e.outcome === "clean" ? 1 : 0.5);
              if (punch && phase === "fight" && (!worst || weight > worst.damage))
                worst = {
                  damage: weight,
                  bout,
                  punch,
                  head: { ...head },
                  hands: [hands[0] ? { ...hands[0] } : null, hands[1] ? { ...hands[1] } : null],
                  cause: causeOf(e.why, e.level, e.shape, e.counter),
                };
            }
          } else if (e.kind === "down") {
            if (!e.standing) slowFrom = now;
          } else if (e.kind === "bell") {
            const tally = bout.card.rounds[e.round - 1] ?? bout.card.rounds[bout.card.rounds.length - 1];
            const say = instruction(tally);
            shown = worst;
            rest = {
              at: now,
              rearmed: false,
              upSince: -1,
              info: { round: e.round, of: bout.rounds, score: e.score, total: totalOf(bout), tally, say, cause: shown?.cause ?? null, up: upShare(e.round) },
            };
            phase = "rest";
            quietSince = -1;
            bell = true;
            sounds.push("bell");
            // The corner speaks once: the score, and one thing.
            lines.push({ text: `${e.score[0] > e.score[1] ? "Your round" : e.score[0] < e.score[1] ? "His round" : "Even round"}. ${say} Breathe.`, must: true });
          } else if (e.kind === "over") {
            phase = "over";
            overAt = now;
            rearmed = false;
            quietSince = -1;
            finished = true;
            sounds.push("bell");
            lines.push({ text: e.winner === "me" ? "That's yours. Well boxed." : e.winner === "foe" ? "Not this time. Again." : "A draw.", must: true });
          }
        }
        if ((phase as RealPhase) === "gym" && gym) {
          const b = GYM[gym.beat];
          const g = gym;
          if (g.beat === 0) {
            // Hands up, and held: a second and a half.
            if (handsUp) {
              if (g.upSince < 0) g.upSince = now;
              if (now - g.upSince >= 1500) g.done = 1;
            } else g.upSince = -1;
          } else if (g.beat === 1) {
            for (const p of thrown) {
              if (g.firstAt < 0) g.firstAt = now;
              // Which hand starts each burst of the first six: a boxer leads with the front hand.
              if (g.done < 6 && now - lastThrownAt > 600) leads[p.hand === "left" ? 0 : 1]++;
              lastThrownAt = now;
              g.done++;
              g.hands[p.hand === "left" ? 0 : 1]++;
              const rear = leadHand === "left" ? 1 : 0;
              if (g.done === 6 && !doubt && leads[rear] >= 2 && leads[1 - rear] === 0) {
                doubt = true;
                lines.push({ text: `You lead with your ${rear ? "right" : "left"} hand. If that is how you stand, change it in the menu.` });
              }
            }
            // Six punches with both hands inside four and a half seconds of the first: this one has boxed. Straight to the live part.
            if (g.done >= b.need && g.done - thrown.length < b.need && now - g.firstAt < 4500 && g.hands[0] >= 2 && g.hands[1] >= 2) g.fast = true;
            // Hands moving and next to nothing read after twenty seconds: this camera cannot follow them here.
            if (camera && g.done < 3 && now - g.since > 20000) {
              grade = "not-yet";
              gym = null;
              phase = "ready";
              readySince = now;
              lines.push({ text: "The camera can't follow your punches here. More light in front of you, and the camera at chest height.", must: true });
            }
          } else
            for (const e of events) {
              if (e.kind !== "its") continue;
              if (g.beat === 2 && (e.outcome === "gloves" || e.outcome === "partly")) g.done++;
              else if (g.beat === 2 && e.outcome === "clean") lines.push({ text: "Hands up.", call: ["hands-up"], must: true });
              else if (g.beat === 3 && e.outcome === "short") g.done++;
              else if (g.beat === 4 && e.outcome === "miss") g.done++;
            }
          if (gym) {
            const late = now - g.since > b.maxMs;
            if (g.nextAt < 0 && (g.done >= b.need || late)) {
              g.nextAt = now + 700;
              // The step back could not be seen in time: this player boxes in close, and range is not asked of them.
              if (g.beat === 3 && g.done < b.need) {
                range = false;
                grade = "close";
              }
              sounds.push("lesson-step");
            }
            // A tap, once a beat is under way, skips the gym minute.
            const skip = asked && now - g.since > 500;
            if (skip || (g.nextAt >= 0 && now >= g.nextAt)) {
              // Someone who has boxed skips being tapped on the guard and the head drill.
              let next = g.beat + 1;
              if (g.fast && (next === 2 || next === 4)) next++;
              if (skip) next = GYM.length;
              if (next >= GYM.length) sounds.push("lesson-done");
              beginBeat(now, next, lines);
            }
          }
        }
        if ((phase as RealPhase) === "fight" && !quietCorner && !bout.me.down && !bout.foe.down) {
          // Hands low for two seconds; nothing thrown for six; flat-footed in range for five; out of breath.
          lowSince = guard.up < 2 && guard.known !== false && !busy[0] && !busy[1] ? (lowSince < 0 ? now : lowSince) : -1;
          if (thrown.length || quietFrom < 0) quietFrom = now;
          const near = bout.foe.feet.to === "pocket" && Math.abs(bout.me.head.vx) < 0.15 && !back;
          stoodSince = near ? (stoodSince < 0 ? now : stoodSince) : -1;
          // Never while a punch of its is in the air: that would be an answer, and answers are the player's to find.
          const air = bout.foe.punches.some((p) => !p.done && bout.time + lead >= p.start && bout.time < p.impact);
          if (!air && now - shoutAt >= SHOUT_MS) {
            const shout: Line | null =
              lowSince >= 0 && now - lowSince >= 2000
                ? { text: "Hands up.", call: ["hands-up"] }
                : bout.me.breath < 25
                  ? { text: "Breathe.", call: ["breathe"] }
                  : stoodSince >= 0 && now - stoodSince >= 5000
                    ? { text: "Move.", call: ["move"] }
                    : now - quietFrom >= 6000
                      ? { text: "Jab.", call: ["jab"] }
                      : null;
            if (shout) {
              shoutAt = now;
              lines.push(shout);
              if (shout.text === "Jab.") quietFrom = now;
            }
          }
        }
        if ((phase as RealPhase) === "fight") {
          const left = bout.clock - (bout.time - bout.roundStart);
          if (!said30 && left <= 30 && left > 25) {
            said30 = true;
            lines.push({ text: "Thirty seconds.", call: ["thirty"] });
          }
          if (left <= 10 && left > 0 && Math.ceil(left) < lastTick) {
            if (lastTick === Infinity) sounds.push("knock");
            lastTick = Math.ceil(left);
          }
        }
      }
      // The referee's count over whoever is down.
      if (phase === "fight") {
        const down = bout.me.down ?? bout.foe.down;
        if (down) {
          count = 1 + Math.floor(bout.time - down.since);
          countKind = bout.me.down ? "down" : "foe";
        }
      }
      if (count !== null && count !== lastCount) sounds.push(countKind === "down" || countKind === "foe" ? "tick" : "count");
      lastCount = count;
      // ── What is drawn ────────────────────────────────────────────────────
      // The opponent alone is held for an instant at a clean hit, then catches
      // up over a twentieth of a second: it never jumps, and the player's own
      // gloves and view never stop.
      const advanced = Math.max(0, bout.time - lastBoutT);
      lastBoutT = bout.time;
      if (now < heldUntil) lag += advanced;
      else lag *= Math.exp(-elapsed / 0.05);
      const drawT = bout.time - lag + (phase === "fight" || phase === "gym" ? lead : 0);
      const blocking =
        bout.foe.punch !== null && !bout.foe.punch.done && (bout.foe.punch.level === "body" ? guard.low > 0 : guard.high > 0 || guard.up >= 2);
      // In the corner: the punch that got through, again, at a quarter of its speed, with a pause on its last picture.
      let replay: RealView["replay"] = null;
      let pose: FoePose,
        distance: number;
      const sat = rest ? now - rest.at : 0;
      const from = shown ? shown.punch.start - REPLAY.before : 0,
        span = shown ? shown.punch.impact + REPLAY.after - from : 0,
        cycle = span / REPLAY.speed + REPLAY.pauseS;
      // The card first; then the punch three times over; then the card again.
      if (phase === "rest" && rest && shown && sat >= REPLAY.fromMs && sat < REPLAY.fromMs + REPLAY.times * cycle * 1000 && rest.upSince < 0) {
        const into = ((sat - REPLAY.fromMs) / 1000) % cycle;
        const t = from + Math.min(span, into * REPLAY.speed);
        distance = standsAt(shown.bout, t);
        pose = makePose(shown.bout, t, { target: { x: -shown.head.x, y: shown.head.y, z: distance - shown.head.z }, blocking: false, struck: null, again: true, distance });
        replay = { head: shown.head, hands: shown.hands, hit: t >= shown.punch.impact };
      } else {
        distance = standsAt(bout, drawT);
        // The player's eye in its frame, where it really is.
        pose = makePose(bout, drawT, { target: { x: -head.x, y: head.y, z: distance - (body ? head.z : head.z * 0.5) }, blocking, struck, distance });
        if (pose.fallen === 0) itsLean += (pose.head.z - itsLean) * Math.min(1, elapsed / 1.0);
        // Kept for a third of a second: a pose from the camera is judged against what was on the screen when it was taken.
        seenLog.push({ at: now, drawT, pose, distance });
        while (seenLog.length > 2 && now - seenLog[0].at > 350) seenLog.shift();
      }
      const react = struck ? reactionOf(struck, bout.time) : STILL;
      const rockT = bout.time - rockAt;
      const rock = rockT > 0 && rockT < 0.3 ? (rockT / 0.05) * Math.exp(1 - rockT / 0.05) : 0;
      const corner: Corner | null =
        (phase === "rest" || (phase === "count" && counting?.kind === "round")) && rest
          ? {
              ...rest.info,
              left: Math.max(0, Math.ceil((REST_MS - (now - rest.at)) / 1000)),
              ready: now - rest.at >= REST_MIN_MS,
            }
          : null;
      const result: Result | null =
        phase !== "over"
          ? null
          : bout.over
            ? {
                winner: bout.over.winner,
                how: bout.over.how,
                total: totalOf(bout),
                rounds: bout.card.rounds,
                scores: bout.card.scores,
                up: bout.card.rounds.map((_t, i) => upShare(i + 1)),
                mix: mixes,
                seconds: bout.time,
              }
            : ended;
      return {
        phase,
        bout,
        boxer,
        pose,
        distance,
        react: replay ? STILL : react,
        rock,
        head,
        hands,
        guard,
        sent,
        events,
        shown: arrivals,
        count,
        countKind,
        sounds,
        lines,
        clock: Math.max(0, bout.clock - (bout.time - bout.roundStart)),
        rate,
        corner,
        result,
        hold,
        pausedWhy: phase === "paused" ? pausedWhy : null,
        finished,
        bell,
        worn: 1 - bout.me.health / 100,
        hurt: bout.time < bout.me.hurtUntil,
        breath: bout.me.breath / 100,
        teach:
          phase === "gym" && gym && gym.nextAt < 0
            ? { word: GYM[gym.beat].word, sub: GYM[gym.beat].sub, beat: gym.beat, of: GYM.length, done: Math.min(gym.done, GYM[gym.beat].need), need: GYM[gym.beat].need }
            : null,
        gymDone: gymOver,
        grade,
        spot,
        crowd: Math.max(0, Math.min(1, (near - 1) / (SPOT.break - 1))),
        replay,
        stanceDoubt: doubt,
        me: body,
        touches,
      };
    },
  };
}
export type RealGame = ReturnType<typeof createRealGame>;
