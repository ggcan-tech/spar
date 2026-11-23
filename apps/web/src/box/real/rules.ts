import type { Guard } from "../defence";
import type { Hand, PunchShape } from "../punch";

/**
 * The rules of a real exchange.
 *
 * Nothing is shown before it is thrown. The opponent's punch is one motion:
 * its body starts to move, the fist leaves (from then on the punch goes where
 * it was aimed), it lands, the hand comes home. There is no held pose and no
 * word. What the player has instead is what a boxer has: range, the gloves,
 * the head, and knowing what comes next.
 *
 * - Range belongs to the opponent's feet. From the edge only straight punches
 *   reach; hooks and uppercuts need the pocket, and the step in is the one
 *   honest warning. The player can pull back one step for one exchange.
 * - A glove keeps a punch out where it is, not when it got there. Three
 *   outcomes: on the gloves, partly blocked, clean. A hand that is punching
 *   guards nothing until it is home, so the opening is the hand that is out.
 * - A straight punch misses a head that left the line after the fist did. A
 *   hook only misses a head that is under it.
 * - The player's punch is judged against what the opponent showed when the
 *   fist reached full stretch, with a little of the past in the player's
 *   favour, because the camera is late and the player hit what they saw.
 * - Two books are kept. The card counts clean punches and decides rounds.
 *   Hurt comes only from solid power punches, drains away, and is the only
 *   thing that puts anyone down.
 *
 * Pure and deterministic: no clocks, no randomness except through the mind.
 * Every number is here or in the opponent's row, and all of them are guesses
 * tuned on scripted players, not on people.
 */
export const RULES = {
  health: 100,
  breath: 100,
  /** A clean punch to the head, in points of health. The opponent's are these times its power. */
  hit: { jab: 1.2, cross: 2.4, hook: 2.8, uppercut: 3.0 },
  /** A body punch does this share at once, and this many times that comes off the breath. */
  bodyShare: 0.75,
  bodyBreath: 1.5,
  /**
   * The share of a punch one glove keeps out, by where the glove is. Straight
   * punches and uppercuts meet both gloves and the shares add. A hook meets
   * only the glove on the side it comes round.
   */
  cover: {
    head: {
      chin: { jab: 0.3, cross: 0.22, uppercut: 0.1, hook: 0.3 },
      cover: { jab: 0.45, cross: 0.45, uppercut: 0.2, hook: 0.75 },
    },
    body: {
      low: { straight: 0.45, hook: 0.85 },
      chin: { straight: 0.15, hook: 0.35 },
      cover: { straight: 0, hook: 0.1 },
    },
    /**
     * A straight aimed at one side meets the glove on that side squarely and
     * the far one hardly: so the side where a hand is out is the side to hit.
     * Against two gloves in the same place the sum is as for the middle.
     */
    near: 1.5,
    far: 0.5,
    /** No guard keeps out more than this. */
    most: 0.95,
  },
  /** Kept out at least this much: on the gloves, no score. Less than `clean`: clean. Between: partly blocked. */
  gloves: 0.75,
  clean: 0.3,
  /** Solid: the guard kept out less than half. Only solid punches hurt. */
  solid: 0.5,
  /** Blocking costs the blocker this share of what was kept out, in breath. */
  blockCost: 0.3,
  /** With less breath than this a guard keeps out only this share of its share. */
  tiredGuard: { below: 20, keeps: 0.6 },
  /** Both hands seen to be down: head punches do this much more. */
  handsDown: 1.25,
  /** A straight punch misses a head this far from where it was aimed, and glances off one this far. */
  missAt: 0.12,
  glanceAt: 0.07,
  glance: 0.4,
  /** A hook passes over a head this far below where the player stands. */
  duckAt: 0.15,
  /** A head already moving sideways faster than this is not thrown a straight punch at the head. */
  moving: 0.25,
  /** The height of the player's head in their stance, unless the input says. */
  standing: 1.65,
  /** The head position kindest to the player in this last stretch before a punch lands is the one used. */
  kind: 0.08,
  /** Gloves in place within this long after a punch lands count as in place. */
  late: 0.04,
  /** The player's punch is judged against the kindest thing the opponent showed in this stretch before the fist arrived. */
  favour: 0.08,
  /** How much of what the opponent showed is remembered, for punches that are confirmed late. */
  memory: 0.5,
  /** A punch that lands while the target's own punch is in flight, or within `justLanded` of its landing. */
  counter: 1.4,
  justLanded: 0.12,
  /** Hit solidly within this long before landing one's own: a trade. Both land, neither is a counter. */
  trade: 0.15,
  /** Two punches that land within this of each other were thrown at once: neither is a counter. */
  atOnce: 0.06,
  /** A solid power counter takes this much of the weight off the punch it beat. */
  beaten: 0.5,
  /** A hook or an uppercut from one step too far still arrives, as an arm punch worth this. */
  longHook: 0.5,
  /** Pulled back for longer than `after`: the player takes this much more and gives this much less. */
  heels: { after: 1, takes: 1.2, gives: 0.7 },
  /** Forward again for this long, and the next pull back is a fresh one. */
  backForget: 0.6,
  /** Breath a punch costs. Each punch within `within` of the last costs `more` again, up to `most` times. */
  cost: { jab: 3, cross: 5, hook: 6, uppercut: 6.5 },
  flurry: { within: 0.6, more: 0.12, most: 2.5 },
  /** A punch that hits nothing costs this much more. */
  missCost: 0.5,
  /** Breath a second, after this long without punching; this share of it behind a cover. */
  regen: 8,
  regenAfter: 0.6,
  coverRegen: 0.25,
  /** Punches thrown with little breath do less. */
  tired: { below: 30, does: 0.5 },
  spent: { below: 10, does: 0.15 },
  /**
   * Hurt. The damage of solid power punches to the head piles up and drains
   * away. Past `base + perHealth x health` the fighter is hurt for `lasts`
   * seconds: takes more, guards worse, hits softer.
   */
  hurt: { base: 2.1, perHealth: 0.02, drain: 4, lasts: 1.6, takes: 1.5, guard: 0.6, gives: 0.6, coverIn: 0.1 },
  /** This many more solid power punches while hurt put a fighter down. */
  finish: 3,
  /** Seconds down, seconds of quiet after getting up, the share of health to get up with, and the breath. */
  count: 3.2,
  grace: 1.2,
  rise: [0.6, 0.4],
  riseBreath: 60,
  /** Knockdowns in the bout that stop it. */
  stopAt: 3,
  /** After the opponent comes through being hurt it ties up and is broken off for this long. */
  breakFor: 1.0,
  /** Seconds in a round, rounds, and the share of missing health that comes back in the corner. */
  clock: 120,
  rounds: 3,
  restHeal: 0.5,
  /** Seconds before the opponent first comes, in round one and after. */
  opening: 2,
  roundOpening: 1.5,
  /**
   * The card. A clean punch is one point, a clean power punch one and a half;
   * a punch thrown with no breath behind it is a push and scores nothing. A
   * knockdown counts as this many points in its round. Closer than `even`
   * the round is level. Ten to eight needs a knockdown, or `wide.times` as
   * many points with `wide.gap` between.
   */
  card: { clean: 1, power: 1.5, knockdown: 4, even: 1, wide: { times: 1.5, gap: 8 } },
  /** Touched, the opponent's gloves stay up this long. */
  coverHold: 0.8,
  /** The most its moves are ever planned ahead: a delay longer than this is not hidden, it is said. */
  aheadMost: 0.35,
  /** The player's feint: a hand out for at least this long and at most that long with no punch read from it. */
  shownPunch: { least: 0.06, most: 0.4 },
  /** Solid punches taken within this long are what make it cover up, and it never stays covered longer than `shellMost`. */
  shellWithin: 1.2,
  shellMost: 2.0,
  /** A feint is shown this long. A deliberate pause inside a combination. */
  feint: 0.28,
  pause: 0.3,
  /** The player's punch after this long without one is a lead: the opponent may have read it. */
  leadGap: 0.45,
  /** Having read a lead, it may be ready for whatever follows within this long. */
  readFor: 0.5,
  /** What a punch it saw coming meets. */
  caught: 0.9,
  /** The same hand cannot go again sooner than this after landing. */
  sameHand: 0.12,
  /** The player's own punches: how long the fist is in flight at most, and how long the hand takes to come home. */
  me: {
    flight: { straight: 0.25, hook: 0.3, uppercut: 0.32 },
    home: { straight: 0.2, hook: 0.26, uppercut: 0.28 },
  },
  /** How well a punch was thrown: 1 is a good one. Under `push` it scores nothing and cannot hurt. */
  quality: { least: 0.3, most: 1.2, push: 0.5 },
  /** The opponent paces itself: with less breath than these it waits, throws shorter, and brings its hand home slower. */
  paces: { waitsBelow: 35, waitFor: 0.8, shortBelow: 55, slowBelow: 40, slowHome: 1.3 },
  /** Seconds an event stays in the list. */
  eventsFor: 1.5,
};

// ── The opponent's punches ────────────────────────────────────────────────
/** The table a punch's times are read from. */
export type FoeKind = "jab" | "cross" | "hook" | "body" | "uppercut";
/**
 * Seconds for each kind of punch, measured from the first movement of the
 * body: `commit` to the fist leaving (the aim is fixed then), `impact` to
 * contact; and `home` from contact to the hand being back. Later these come
 * from the motion clips.
 */
export type PunchTimes = Record<FoeKind, { commit: number; impact: number; home: number }>;
export type Level = "head" | "body";
export type Third = "left" | "middle" | "right";
/** What it can throw. `col` is the row of the damage, cost and cover tables it uses. */
export const PUNCH = {
  j: { kind: "jab", lead: true, level: "head", shape: "straight", col: "jab", pocket: false },
  c: { kind: "cross", lead: false, level: "head", shape: "straight", col: "cross", pocket: false },
  h: { kind: "hook", lead: true, level: "head", shape: "hook", col: "hook", pocket: true },
  rh: { kind: "hook", lead: false, level: "head", shape: "hook", col: "hook", pocket: true },
  u: { kind: "uppercut", lead: false, level: "head", shape: "uppercut", col: "uppercut", pocket: true },
  bj: { kind: "jab", lead: true, level: "body", shape: "straight", col: "jab", pocket: false },
  bc: { kind: "body", lead: false, level: "body", shape: "straight", col: "cross", pocket: false },
  bh: { kind: "body", lead: true, level: "body", shape: "hook", col: "hook", pocket: true },
} as const satisfies Record<
  string,
  { kind: FoeKind; lead: boolean; level: Level; shape: PunchShape; col: Col; pocket: boolean }
>;
type Col = "jab" | "cross" | "hook" | "uppercut";
export type Code = keyof typeof PUNCH;
/** A step of a combination: a punch, a feint ("f"), a beat of waiting ("w"), or a step into the pocket before anything is thrown ("in"). */
export type Step = Code | "f" | "w" | "in";

/**
 * The numbers of an opponent that the rules themselves read: how its body
 * moves. What it decides is the mind's business (see mind.ts).
 */
export interface Body {
  times: PunchTimes;
  /** Seconds from one punch of a combination landing to the next. */
  gap: number;
  /** Seconds to step into the pocket, and to step out after a visit. */
  stepIn: number;
  stepOut: number;
  /** Seconds before it has closed on a player who pulled back. */
  follows: number;
  /** How hard it hits: a multiple of the punch table. */
  power: number;
  /** How well its gloves keep punches out in each place; 1 is the table. */
  tight: { chin: number; cover: number; low: number };
  /** Seconds a glove takes to move when it answers something. */
  guardMove: number;
  /** Seconds an elbow stays down after a body punch. */
  lowFor: number;
  /** Solid punches in quick succession that make it cover up. */
  shellAfter: number;
  /** Seconds before an answer starts, and the least time between answers. */
  answerDelay: number;
  answerEvery: number;
  /** With less breath than this its hands rest at its chest. */
  sags: number;
  /** The share of the usual breath that comes back to it. */
  wind: number;
}

// ── The mind ──────────────────────────────────────────────────────────────
/** The player's first punch after a pause. */
export interface Lead {
  hand: Hand;
  shape: PunchShape;
  level: Level;
  at: number;
}
/** Yes-or-no habits the rules ask the mind about. */
export type Habit =
  /** Drops its other hand as it throws this punch. */
  | "drop"
  /** Does not throw a straight punch at a head that is already moving. */
  | "hook"
  /** Touched, brings its gloves up. */
  | "cover"
  /** Hit in the body, drops that elbow. */
  | "elbow"
  /** Comes in at once on a hurt player. */
  | "press"
  /** Having read a lead, is ready for the punch after it. */
  | "ready"
  /** Answers a punch that did nothing. */
  | "answer"
  /** Hits back at once when hit solidly. */
  | "fire"
  /** A stiff jab as it steps in stops its feet. */
  | "stop";
/** What happened, for its habits. */
export type Report =
  /** Its head punch landed on the gloves; or got through. */
  | "head-blocked"
  | "head-through"
  /** Its straight punch was slipped; its hook was ducked. */
  | "slipped"
  | "ducked"
  /** The player landed a solid counter just as its combination ended. */
  | "answered"
  /** Its punch fell short: the player had pulled back. */
  | "short";
/**
 * The opponent's decisions. Everything random in a bout comes through here,
 * so a seeded mind and the same inputs give the same bout.
 */
export interface Mind {
  /** Seconds it waits before its next visit, counted from now. `share` shortens it. */
  wait(s: Bout, share?: number): number;
  /** The combination for its next visit. */
  visit(s: Bout): Step[];
  /** The player led: did it see it coming, and will it answer? */
  reads(lead: Lead, s: Bout): { how: "slip" | "catch"; answer: boolean } | null;
  /** What it answers with. */
  reply(s: Bout): Step[];
  will(what: Habit, s: Bout, code?: Code): boolean;
  /** Seconds it stays covered up; seconds its hand comes home low after this punch (0 for not at all). */
  span(what: "shell" | "home-low", s: Bout, code?: Code): number;
  report(what: Report): void;
}

// ── The state ─────────────────────────────────────────────────────────────
export type Side = "me" | "foe";
export type Range = "edge" | "pocket";
/** Where a glove is when it is not punching: by the chin, lifted to cover the brow or temple, elbow down by the ribs, or hanging. */
export type Place = "chin" | "cover" | "low" | "down";
export type Spot = Place | "out";
/** Touch sparring: touches are counted and nobody is hurt. Open sparring: hurt, but a standing count instead of the floor. A bout: everything. */
export type Stakes = "touch" | "open" | "bout";
export type Outcome =
  | "clean"
  | "partly"
  | "gloves"
  /** The head was off the line, or under the hook; or the opponent slipped it. */
  | "miss"
  /** Thrown from too far. */
  | "short"
  /** The player was not seen for part of it: it glances off and counts for nothing. */
  | "unseen";

/** One of the opponent's punches, from its first movement until its hand is home. */
export interface Thrown {
  id: number;
  code: Code;
  kind: FoeKind;
  hand: Hand;
  level: Level;
  shape: PunchShape;
  /** First movement, the fist leaving, contact, the hand home. For a feint: shown from `start`, pulled back at `commit`, and nothing lands. */
  start: number;
  commit: number;
  impact: number;
  home: number;
  /** Where it is going: the player's head when the fist left. Null until then, and for a body punch. */
  aim: { x: number; y: number } | null;
  feint: boolean;
  /** Which visit it belongs to, its place in that combination (from 0), and how long the combination is. */
  visit: number;
  index: number;
  of: number;
  /** What its breath put behind it: 1, or less if it was tired or beaten to the punch. */
  weight: number;
  /** The player could not be seen at some moment of it. */
  blind: boolean;
  /** Landed, missed or called off. */
  done: boolean;
  /** The kindest things seen so far: head furthest from the aim, deepest under it, most kept out (-1 before anything was looked at); whether the hands stayed down; and whether the player was caught punching at contact. */
  off: number;
  under: number;
  kept: number;
  open: boolean;
  caught: boolean;
}
export interface Glove {
  place: Place;
  since: number;
  /** A move it has already begun: where to, and when it is there. */
  next: { place: Place; at: number } | null;
  /** When it leaves this place, as far as is known now; Infinity if it is simply resting there. */
  until: number;
}
/** What the opponent showed from `from` until the next one: what a late punch is judged against. */
export interface Shown {
  from: number;
  spots: [Spot, Spot];
  feet: Range;
  hurt: boolean;
  /** A punch of its own in flight or only just landed. */
  open: boolean;
}
export interface Visit {
  id: number;
  steps: Step[];
  /** The next step to do, and when. */
  index: number;
  nextAt: number;
  startedAt: number;
  /** It has shown a feint in this visit. */
  feint: boolean;
  /** An answer to something the player did, not a visit of its own choosing. */
  answer: boolean;
  /** When its last punch lands. */
  doneAt: number;
  threw: number;
}
interface Fighter {
  health: number;
  breath: number;
  /** Hurt until this time; the pile it comes from; solid power punches taken while hurt. */
  hurtUntil: number;
  hurtPile: number;
  hurtHits: number;
  /** On the floor, or taking a standing count. */
  down: { since: number; until: number; standing: boolean } | null;
  /** Health kept through a knockdown that came while hurt. */
  kept: number;
  /** When it last threw, and how many punches in a row without a breath. */
  lastPunchAt: number;
  chain: number;
  /** When it was last hit solidly. */
  solidAt: number;
}
export interface Me extends Fighter {
  /** Each hand, [left, right]: guards nothing until this time. */
  out: [number, number];
  /** Since when each hand has been seen driving out with no punch read from it yet; -1 when it is not out, -2 once its punch has been read and it is coming back. */
  drive: [number, number];
  /** When each hand's last punch reached full stretch, and the last of either. */
  stretch: [number, number];
  lastStretch: number;
  /** Since when the player has been pulled back (-1: not), and since when forward again. */
  backSince: number;
  forwardSince: number;
  /** One step out of range right now; and pulled back so long that it costs. */
  away: boolean;
  heels: boolean;
  head: { x: number; y: number; vx: number };
  /** A glove is lifted to cover: breath comes back slowly. */
  covering: boolean;
  /** Punches whose time has not come yet. */
  coming: Blow[];
  /** When a solid power counter last beat the player to the punch. */
  beatenAt: number;
}
export type FoeMode = "set" | "visit" | "shell" | "hurt";
export interface Foe extends Fighter {
  /** Standing ready, in a combination, covered up, or hurt. */
  mode: FoeMode;
  /** Its feet: standing at `to` once `end` has passed, on the way there before. */
  feet: { from: Range; to: Range; start: number; end: number };
  /** [left, right]. */
  gloves: [Glove, Glove];
  /** Each elbow is down, or hand low, until this time; -1 when not. And the gloves are up until this. */
  lowUntil: [number, number];
  coverUntil: number;
  /** Its punches not yet home, oldest first; and the newest of them. */
  punches: Thrown[];
  punch: Thrown | null;
  visit: Visit | null;
  visits: number;
  /** When it may next come; when a pending answer starts; when it may next answer. */
  nextAt: number;
  answerAt: number | null;
  answerCool: number;
  shell: { since: number; until: number } | null;
  /** Times of the solid punches it took lately. */
  solids: number[];
  lastVisitEnd: number;
  /** The player's lead it last saw coming: how it met it, and when. */
  evade: { how: "slip" | "catch"; at: number } | null;
  /** What it showed lately, oldest first. */
  seen: Shown[];
}
/** One round's punches: [the player's, the opponent's]. */
export interface Tally {
  thrown: [number, number];
  clean: [number, number];
  partly: [number, number];
  gloves: [number, number];
  missed: [number, number];
  /** Punches that got through at least partly. */
  touches: [number, number];
  /** What the round is scored on. */
  points: [number, number];
  /** Knockdowns scored, and standing counts given. */
  downs: [number, number];
  counts: [number, number];
}
export interface Card {
  /** Each finished round, ten to whoever took it: [the player, the opponent]. */
  scores: [number, number][];
  /** A tally a round; the last is the round being boxed. */
  rounds: Tally[];
}
/** What the event says about why a punch did what it did. */
export interface Why {
  /** The target's hands that were out punching, [left, right]. */
  out: [boolean, boolean];
  /** Where the target's gloves were, [left, right]. */
  spots: [Spot, Spot];
  /** Both of the target's hands were down. */
  low: boolean;
  /** The punch could reach. */
  reach: boolean;
  /** The target was hurt; the player was on their heels. */
  hurt: boolean;
  heels: boolean;
}
export type BoutEvent = { id: number; at: number } & (
  /** Its feet begin a step. The step in is the warning. */
  | { kind: "step"; to: Range; end: number }
  /** The first movement of one of its punches, or of a feint. */
  | {
      kind: "throw";
      punch: number;
      code: Code;
      hand: Hand;
      level: Level;
      shape: PunchShape;
      feint: boolean;
      index: number;
      of: number;
      impact: number;
    }
  /** One of its punches arrived, or did not. */
  | {
      kind: "its";
      punch: number;
      code: Code;
      hand: Hand;
      level: Level;
      shape: PunchShape;
      outcome: Outcome;
      /** How it was made to miss. */
      how: "slip" | "duck" | null;
      damage: number;
      kept: number;
      glance: boolean;
      counter: boolean;
      solid: boolean;
      why: Why;
    }
  /** One of the player's punches was judged. `judged` is the time it was judged against. */
  | {
      kind: "mine";
      hand: Hand;
      shape: PunchShape;
      level: Level;
      third: Third;
      outcome: Outcome;
      /** The opponent saw it coming: slipped it or caught it. */
      read: "slip" | "catch" | null;
      damage: number;
      kept: number;
      /** A hook or uppercut from a step too far. */
      long: boolean;
      counter: boolean;
      solid: boolean;
      judged: number;
      why: Why;
    }
  | { kind: "hurt"; who: Side; until: number }
  /** Down, or a standing count. `by`: finished while hurt, or worn to nothing and then hit. */
  | { kind: "down"; who: Side; downs: number; standing: boolean; by: "finish" | "worn" }
  | { kind: "up"; who: Side }
  /** The opponent came through being hurt: it ties up and they are broken. */
  | { kind: "break" }
  /** A punch in the air was called off: the bell, or somebody went down. */
  | { kind: "called-off"; punch: number }
  /** The bell at the end of a round that is not the last. */
  | { kind: "bell"; round: number; score: [number, number] }
  | { kind: "over"; winner: Side | null; how: "stoppage" | "points" | "draw" }
);
type Said = BoutEvent extends infer E ? (E extends BoutEvent ? Omit<E, "id" | "at"> : never) : never;

export interface Bout {
  time: number;
  /** Fixed when the bout was made. */
  boxer: Body;
  times: PunchTimes;
  stakes: Stakes;
  /** False: range is not played. Everything always reaches and nobody steps. */
  range: boolean;
  /** The player's lead hand; its straight is the jab. The opponent stands the same way round. */
  lead: Hand;
  round: number;
  rounds: number;
  clock: number;
  roundStart: number;
  /** Between rounds: nothing moves until `nextRound`. */
  rest: boolean;
  /** Null while the bout is on. */
  over: { winner: Side | null; how: "stoppage" | "points" | "draw" } | null;
  me: Me;
  foe: Foe;
  card: Card;
  /** Knockdowns scored in the whole bout: [by the player, by the opponent]. */
  downs: [number, number];
  /**
   * Seconds its moves are planned ahead. A camera knows the player late and a
   * screen shows late, so the opponent is drawn this far ahead of the clock;
   * a punch, a step or a glove that began "now" would be seen with its first
   * moments already gone. So each begins this long after it is decided, and
   * the opponent cannot answer anything faster than that. 0 with no delay.
   */
  ahead: number;
  events: BoutEvent[];
  nextId: number;
}

/** One punch of the player's, as the reader gives it. */
export interface Blow {
  hand: Hand;
  shape: PunchShape;
  /** Where the fist went: head or body, and which third as the player sees the opponent. */
  level: Level;
  third: Third;
  /** How well it was thrown: 1 is a good punch. */
  quality: number;
  /** The rules time at which the fist reached full stretch. Usually a little before now; if it is still to come the punch is held until then. */
  at: number;
  /**
   * What the fist really met, when both bodies are known in one room (see
   * space.ts): nothing (it fell short or went past), the opponent's gloves or
   * arms, or the opponent itself, and then how much of it a glove took on the
   * way in (0 to 1). When given, this decides: the reach table, the cover
   * table and the opponent's unseen "slip" are not asked. What it saw coming
   * it must then be seen to do.
   */
  met?: { what: "air" | "guard" | "body"; kept: number };
}
export interface BoutInput {
  /** Punches read since the last step. */
  punches: readonly Blow[];
  /** The player's head in their own frame, in metres: sideways and height. */
  head: { x: number; y: number };
  guard: Guard;
  /** Pulled back: a step or a lean of more than a hand's width away from the opponent. */
  back?: boolean;
  /** Hands that are out punching right now, [left, right], as the reader sees them. */
  busy?: readonly [boolean, boolean];
  /** The height of the player's head when they stand in their stance. */
  standing?: number;
  /**
   * The player is not seen properly right now: a hand is hidden, or the
   * newest pose is old. A punch in the air at such a moment glances off and
   * counts for nothing, and the opponent starts nothing new.
   */
  blind?: boolean;
  /** How far ahead of the clock the opponent is being drawn, seconds: its new moves begin that much later. */
  ahead?: number;
  /** The player showed a punch and took it back, as whoever reads the camera saw it: a feint. (Without this, a hand seen out with no punch read from it is taken for one.) */
  shown?: boolean;
  /**
   * How much of this punch of the opponent's the player's guard keeps out
   * right now, 0 to 1, from where their gloves and forearms really are (see
   * space.ts); null when that is not known. When given it is used in place of
   * the cover table.
   */
  kept?: (punch: Thrown) => number | null;
}
export interface BoutOptions {
  boxer: Body;
  /** Punch times, if not the boxer's own: the motion clips' when there are some. */
  times?: PunchTimes;
  stakes?: Stakes;
  range?: boolean;
  lead?: Hand;
  rounds?: number;
  clock?: number;
  /** Seconds before the opponent first comes. */
  opening?: number;
}

const IX: Record<Hand, 0 | 1> = { left: 0, right: 1 };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const emptyTally = (): Tally => ({
  thrown: [0, 0],
  clean: [0, 0],
  partly: [0, 0],
  gloves: [0, 0],
  missed: [0, 0],
  touches: [0, 0],
  points: [0, 0],
  downs: [0, 0],
  counts: [0, 0],
});
const fighter = (): Fighter => ({
  health: RULES.health,
  breath: RULES.breath,
  hurtUntil: -Infinity,
  hurtPile: 0,
  hurtHits: 0,
  down: null,
  kept: 0,
  lastPunchAt: -Infinity,
  chain: 0,
  solidAt: -Infinity,
});
const glove = (place: Place, since: number): Glove => ({ place, since, next: null, until: Infinity });

export function createBout(options: BoutOptions): Bout {
  const range = options.range !== false;
  // With range off it stands in the pocket for good: everything reaches.
  const at: Range = range ? "edge" : "pocket";
  return {
    time: 0,
    boxer: options.boxer,
    times: options.times ?? options.boxer.times,
    stakes: options.stakes ?? "bout",
    range,
    lead: options.lead ?? "left",
    round: 1,
    rounds: Math.max(1, Math.floor(options.rounds ?? RULES.rounds)),
    clock: options.clock ?? RULES.clock,
    roundStart: 0,
    rest: false,
    over: null,
    me: {
      ...fighter(),
      out: [-Infinity, -Infinity],
      drive: [-1, -1],
      stretch: [-Infinity, -Infinity],
      lastStretch: -Infinity,
      backSince: -1,
      forwardSince: -1,
      away: false,
      heels: false,
      head: { x: 0, y: RULES.standing, vx: 0 },
      covering: false,
      coming: [],
      beatenAt: -Infinity,
    },
    foe: {
      ...fighter(),
      mode: "set",
      feet: { from: at, to: at, start: 0, end: 0 },
      gloves: [glove("chin", 0), glove("chin", 0)],
      lowUntil: [-1, -1],
      coverUntil: -1,
      punches: [],
      punch: null,
      visit: null,
      visits: 0,
      nextAt: options.opening ?? RULES.opening,
      answerAt: null,
      answerCool: -Infinity,
      shell: null,
      solids: [],
      lastVisitEnd: -Infinity,
      evade: null,
      seen: [],
    },
    card: { scores: [], rounds: [emptyTally()] },
    downs: [0, 0],
    ahead: 0,
    events: [],
    nextId: 1,
  };
}

// ── Small readings of the state, for the rules and for whoever draws it ────
/** Where its feet count as being at `t`: there once the step has ended. */
export function standsAt(foe: Foe, t: number): Range {
  return t >= foe.feet.end ? foe.feet.to : foe.feet.from;
}
/** Is this hand of the opponent's out punching at `t`? */
export function handOut(foe: Foe, hand: Hand, t: number): boolean {
  for (const p of foe.punches) if (!p.feint && p.hand === hand && p.start <= t && t < p.home) return true;
  return false;
}
/** Would a punch of this shape from the player reach right now? */
export function reaches(s: Bout, shape: PunchShape): boolean {
  if (!s.range) return true;
  const { feet } = s.foe;
  // A step it is in the middle of counts as its nearer end: the doubt is the player's.
  const near = s.time >= feet.end ? feet.to === "pocket" : feet.from === "pocket" || feet.to === "pocket";
  const steps = (near ? 0 : 1) + (s.me.away ? 1 : 0);
  return shape === "straight" ? steps <= 1 : steps <= 0;
}
/** What breath puts behind a punch. */
const weightOf = (breath: number) =>
  breath >= RULES.tired.below ? 1 : breath >= RULES.spent.below ? RULES.tired.does : RULES.spent.does;

function share(place: Spot, level: Level, col: Col): number {
  const c = RULES.cover;
  if (level === "head") return place === "chin" ? c.head.chin[col] : place === "cover" ? c.head.cover[col] : 0;
  const k = col === "hook" ? "hook" : "straight";
  return place === "low" ? c.body.low[k] : place === "chin" ? c.body.chin[k] : place === "cover" ? c.body.cover[k] : 0;
}
/**
 * The share of a punch kept out by two gloves, [left, right], before
 * tiredness and hurt. `side` is the glove on the side a hook comes round;
 * `aimed` the glove a straight punch is aimed at, or -1 for the middle.
 * `sided` false: nobody knows which glove is which, so a hook meets the
 * better of the two.
 */
export function keptOut(
  spots: readonly [Spot, Spot],
  level: Level,
  col: Col,
  side: 0 | 1,
  aimed: -1 | 0 | 1 = -1,
  tight: Body["tight"] | null = null,
  sided = true,
): number {
  const of = (i: 0 | 1) => {
    const p = spots[i];
    return share(p, level, col) * (tight && p !== "out" && p !== "down" ? tight[p] : 1);
  };
  if (col === "hook") return sided ? of(side) : Math.max(of(0), of(1));
  const { near, far } = RULES.cover;
  return of(0) * (aimed < 0 ? 1 : aimed === 0 ? near : far) + of(1) * (aimed < 0 ? 1 : aimed === 1 ? near : far);
}
/** Where the player's gloves are, from the camera's guard and the hands that are out. */
export function spotsOf(guard: Guard, out0: boolean, out1: boolean): { spots: [Spot, Spot]; sided: boolean } {
  const out = [out0, out1];
  const spots: [Spot, Spot] = ["down", "down"];
  const s = guard.sides;
  let covers = guard.high,
    chins = Math.max(0, guard.up - guard.high),
    lows = guard.low;
  for (let i = 0; i < 2; i++) {
    if (out[i]) spots[i] = "out";
    else if (s) {
      // Which glove is where is known.
      if (s.high[i]) spots[i] = "cover";
      else if (s.up ? s.up[i] : !s.low[i] && chins-- > 0) spots[i] = "chin";
      else if (s.low[i]) spots[i] = "low";
    } else if (covers-- > 0) spots[i] = "cover";
    // Only counts: hand them to the hands that are not out, the best place first.
    else if (chins-- > 0) spots[i] = "chin";
    else if (lows-- > 0) spots[i] = "low";
  }
  return { spots, sided: !!s };
}

function say(s: Bout, e: Said): void {
  s.events = [...s.events, { id: s.nextId++, at: s.time, ...e } as BoutEvent];
}
function count(s: Bout, what: keyof Tally, who: 0 | 1, n = 1): void {
  const rounds = s.card.rounds;
  const last = rounds[rounds.length - 1];
  const pair: [number, number] = [last[what][0], last[what][1]];
  pair[who] += n;
  s.card = { ...s.card, rounds: [...rounds.slice(0, -1), { ...last, [what]: pair }] };
}
function setGlove(s: Bout, i: 0 | 1, g: Glove): void {
  s.foe.gloves = i === 0 ? [g, s.foe.gloves[1]] : [s.foe.gloves[0], g];
}
/** Send a glove somewhere: it is there after `delay`. */
function order(s: Bout, i: 0 | 1, place: Place, delay: number): void {
  const g = s.foe.gloves[i];
  if ((g.next ? g.next.place : g.place) === place) return;
  setGlove(s, i, { ...g, next: g.place === place ? null : { place, at: s.time + s.ahead + delay } });
}
/** Put a glove somewhere at once. */
function put(s: Bout, i: 0 | 1, place: Place): void {
  const g = s.foe.gloves[i];
  if (g.place !== place || g.next) setGlove(s, i, { ...g, place, since: s.time, next: null });
}
function setLow(s: Bout, i: 0 | 1, until: number): void {
  const l = s.foe.lowUntil;
  s.foe.lowUntil = i === 0 ? [until, l[1]] : [l[0], until];
}
/** Where its gloves rest: by the chin, or at its chest when it is tired. */
const restPlace = (s: Bout): Place => (s.foe.breath < s.boxer.sags ? "low" : "chin");
/** Back to its ordinary guard, except an elbow that is down. */
function toGuard(s: Bout): void {
  const place = restPlace(s);
  for (const i of [0, 1] as const) if (s.foe.lowUntil[i] < 0) order(s, i, place, s.boxer.guardMove);
}
function coverUp(s: Bout, delay: number): void {
  for (const i of [0, 1] as const) if (s.foe.lowUntil[i] < 0) order(s, i, "cover", delay);
}
function stepTo(s: Bout, to: Range, seconds: number): void {
  const { foe } = s;
  if (!s.range) return;
  const at = standsAt(foe, s.time);
  if (foe.feet.to === to) return;
  // Turning round in the middle of a step: it has not left yet. A step that takes time begins when it can first be seen.
  const start = at === to || seconds <= 0 ? s.time : s.time + s.ahead;
  foe.feet = { from: at, to, start, end: start + (at === to ? 0 : seconds) };
  if (at !== to) say(s, { kind: "step", to, end: foe.feet.end });
}
function spend(f: Fighter, at: number, cost: number): void {
  f.chain = at - f.lastPunchAt < RULES.flurry.within ? f.chain + 1 : 0;
  f.breath = Math.max(0, f.breath - cost * Math.min(RULES.flurry.most, (1 + RULES.flurry.more) ** f.chain));
  f.lastPunchAt = at;
}
function endVisit(s: Bout): void {
  s.foe.visit = null;
  if (s.foe.mode === "visit") s.foe.mode = "set";
}
/** Punches in the air are called off: the bell, or somebody is down. */
function callOff(s: Bout): void {
  const { foe, me } = s;
  for (const p of foe.punches) if (!p.done && !p.feint) say(s, { kind: "called-off", punch: p.id });
  if (foe.punches.length) foe.punches = [];
  foe.punch = null;
  if (me.coming.length) me.coming = [];
  foe.visit = null;
  foe.answerAt = null;
}
/**
 * The referee parts them. Whatever was in the air is called off, the opponent
 * steps back to the edge and starts nothing for `seconds`. Used for "Break!"
 * when the player has come too near the screen, and for the moment play
 * returns after any pause: nothing lands on someone who has only just come back.
 */
export function breakBout(before: Bout, seconds: number = 1.5): Bout {
  if (before.over || before.rest) return before;
  const s: Bout = { ...before, me: { ...before.me }, foe: { ...before.foe } };
  const { foe } = s;
  callOff(s);
  if (foe.mode === "visit" || foe.mode === "shell") foe.mode = "set";
  foe.shell = null;
  stepTo(s, "edge", s.boxer.stepOut);
  foe.nextAt = Math.max(foe.nextAt, s.time + seconds);
  foe.answerCool = Math.max(foe.answerCool, s.time + seconds);
  if (foe.mode !== "hurt" && !foe.down) toGuard(s);
  say(s, { kind: "break" });
  return s;
}

/** Advance the bout by `dt` seconds. Returns a new state; the given one is not changed. */
export function stepBout(before: Bout, dt: number, input: BoutInput, mind: Mind): Bout {
  if (!(dt > 0) || dt > 0.1) throw new Error("A bout needs a small positive step");
  if (before.over || before.rest) return before;
  const now = before.time + dt;
  const s: Bout = { ...before, time: now, me: { ...before.me }, foe: { ...before.foe } };
  if (input.ahead !== undefined) s.ahead = clamp(input.ahead, 0, RULES.aheadMost);
  const { me, foe } = s;
  if (s.events.length && now - s.events[0].at >= RULES.eventsFor)
    s.events = s.events.filter((e) => now - e.at < RULES.eventsFor);

  if (me.down && now >= me.down.until) rise(s, 0);
  if (foe.down && now >= foe.down.until) rise(s, 1);
  const anyDown = me.down !== null || foe.down !== null;

  // ── The player's body ───────────────────────────────────────────────────
  let feinted = input.shown === true;
  const vx = (input.head.x - me.head.x) / dt;
  // Smoothed over a twentieth of a second: one pose's jump is not a moving head.
  const k = Math.min(1, dt / 0.05);
  me.head = { x: input.head.x, y: input.head.y, vx: me.head.vx + (vx - me.head.vx) * k };
  me.covering = input.guard.high > 0;
  if (input.busy) {
    // A hand that has just gone out is in flight until its punch is read; after that it is only coming back.
    const d0 = input.busy[0] ? (me.drive[0] === -1 ? now : me.drive[0]) : -1;
    const d1 = input.busy[1] ? (me.drive[1] === -1 ? now : me.drive[1]) : -1;
    // A hand that went out and came back with no punch read from it showed a punch and took it back.
    for (const [was, is] of [
      [me.drive[0], d0],
      [me.drive[1], d1],
    ])
      if (was >= 0 && is === -1 && now - was >= RULES.shownPunch.least && now - was <= RULES.shownPunch.most) feinted = true;
    if (d0 !== me.drive[0] || d1 !== me.drive[1]) me.drive = [d0, d1];
  }
  if (s.range && input.back) {
    if (me.backSince < 0) me.backSince = now;
    me.forwardSince = -1;
    const closed = me.backSince + s.boxer.follows;
    me.away = now < closed;
    me.heels = now - me.backSince > RULES.heels.after;
    // It follows: it has closed the distance `follows` after the pull back.
    if (!anyDown && !me.away && foe.feet.to !== "pocket") stepTo(s, "pocket", 0);
    else if (!anyDown && now >= closed - s.boxer.stepIn && foe.feet.to !== "pocket")
      stepTo(s, "pocket", Math.max(0, closed - now));
  } else {
    me.away = false;
    me.heels = false;
    if (me.backSince >= 0) {
      if (me.forwardSince < 0) {
        me.forwardSince = now;
        // It was following; with nobody to follow it goes back to the edge.
        if (!foe.visit && foe.feet.to === "pocket" && !anyDown) stepTo(s, "edge", s.boxer.stepOut);
      }
      if (now - me.forwardSince >= RULES.backForget) me.backSince = -1;
    }
  }

  if (anyDown) {
    // A punch thrown while somebody is down is ignored, and costs nothing.
    if (me.coming.length) me.coming = [];
  } else {
    if (input.punches.length) me.coming = [...me.coming, ...input.punches];
    moveGloves(s);
    watch(s, input);
    if (feinted) flinch(s, mind);
    think(s, input, mind);
    remember(s);
    land(s, input, mind);
    if (!s.over) {
      // Breath comes back with the hands at rest, slowly behind a cover; the pile of hurt drains.
      const regen = RULES.regen * dt;
      if (!me.down) {
        if (now - me.lastPunchAt >= RULES.regenAfter)
          me.breath = Math.min(RULES.breath, me.breath + regen * (me.covering ? RULES.coverRegen : 1));
        if (me.hurtPile > 0) me.hurtPile = Math.max(0, me.hurtPile - RULES.hurt.drain * dt);
      }
      if (!foe.down) {
        if (now - foe.lastPunchAt >= RULES.regenAfter)
          foe.breath = Math.min(RULES.breath, foe.breath + regen * s.boxer.wind);
        if (foe.hurtPile > 0) foe.hurtPile = Math.max(0, foe.hurtPile - RULES.hurt.drain * dt);
      }
    }
  }
  tidy(s);
  if (!s.over && now - s.roundStart >= s.clock) bell(s);
  return s;
}

/**
 * The player showed a punch and took it back. An opponent that answers a touch
 * with its gloves answers this the same way: its hands come up, and its body
 * is open under them for as long as they stay there.
 */
function flinch(s: Bout, mind: Mind): void {
  const { foe, boxer } = s;
  const now = s.time;
  if (foe.mode !== "set" || foe.visit || foe.down || now < foe.hurtUntil || foe.coverUntil > 0) return;
  if (!mind.will("cover", s)) return;
  coverUp(s, boxer.guardMove);
  foe.coverUntil = now + boxer.guardMove + RULES.coverHold;
}

/** Back on their feet, or the count is over: some health back, and both start again from the edge. */
function rise(s: Bout, who: 0 | 1): void {
  const { me, foe } = s;
  const now = s.time;
  const f: Fighter = who === 0 ? me : foe;
  if (!f.down) return;
  // How many times they have been put down, or counted, by the other.
  const times = f.down.standing ? s.card.rounds.reduce((n, r) => n + r.counts[1 - who], 0) : s.downs[1 - who];
  f.down = null;
  f.health = Math.max(f.kept, RULES.health * RULES.rise[Math.min(Math.max(times, 1), RULES.rise.length) - 1]);
  if (who === 0) f.breath = Math.max(f.breath, RULES.riseBreath);
  say(s, { kind: "up", who: who === 0 ? "me" : "foe" });
  // It leaves a moment of quiet.
  foe.mode = "set";
  foe.shell = null;
  if (s.range) foe.feet = { from: "edge", to: "edge", start: now, end: now };
  foe.nextAt = now + RULES.grace;
  foe.solids = [];
  foe.gloves = [glove("chin", now), glove("chin", now)];
  foe.lowUntil = [-1, -1];
  foe.coverUntil = -1;
}

/** Gloves that were on their way arrive. */
function moveGloves(s: Bout): void {
  for (const i of [0, 1] as const) {
    const g = s.foe.gloves[i];
    if (g.next && s.time >= g.next.at) setGlove(s, i, { ...g, place: g.next.place, since: g.next.at, next: null });
  }
}

/**
 * Its punches in the air: the aim is fixed when the fist leaves, and from
 * just before contact the kindest head and the best cover are kept.
 */
function watch(s: Bout, input: BoutInput): void {
  const { foe, me } = s;
  if (!foe.punches.length) return;
  const now = s.time;
  let changed: Thrown[] | null = null;
  for (let n = 0; n < foe.punches.length; n++) {
    const p = foe.punches[n];
    if (p.done || p.feint) continue;
    let q = null as Thrown | null;
    const edit = (): Thrown => (q ??= { ...p });
    if (input.blind && !p.blind) edit().blind = true;
    if (p.aim === null && p.level === "head" && now >= p.commit) edit().aim = { x: input.head.x, y: input.head.y };
    const aim = q ? q.aim : p.aim;
    if (now >= p.impact - RULES.kind && p.level === "head") {
      if (p.shape === "hook") {
        const under = (input.standing ?? RULES.standing) - input.head.y;
        if (under > p.under) edit().under = under;
      } else if (aim) {
        // Getting under an uppercut does not help: only sideways counts.
        const dx = input.head.x - aim.x,
          dy = p.shape === "uppercut" ? 0 : input.head.y - aim.y;
        const off = Math.hypot(dx, dy);
        if (off > p.off) edit().off = off;
      }
    }
    if (now >= p.impact) {
      const o0 = isOut(me, input, 0, now),
        o1 = isOut(me, input, 1, now);
      const { spots, sided } = spotsOf(input.guard, o0, o1);
      const d = PUNCH[p.code];
      // Its left hand arrives on the player's right. Where the gloves really are decides, when that is known.
      const real = input.kept ? input.kept(p) : null;
      let kept = real ?? keptOut(spots, p.level, d.col, p.hand === "left" ? 1 : 0, -1, null, sided);
      if (me.breath < RULES.tiredGuard.below) kept *= RULES.tiredGuard.keeps;
      if (now < me.hurtUntil) kept *= RULES.hurt.guard;
      kept = Math.min(RULES.cover.most, kept);
      if (kept > p.kept) edit().kept = kept;
      // Hands down only if both were seen to be down: a hidden hand is not a low one.
      const open =
        spots[0] === "down" && spots[1] === "down" && input.guard.known !== false && (p.kept < 0 || p.open);
      if (open !== (q ?? p).open) edit().open = open;
      // Caught punching is a fact about the moment of contact, not about the moment after.
      const caught = p.kept < 0 ? punching(me, now) : p.caught;
      if (caught !== (q ?? p).caught) edit().caught = caught;
    }
    if (q) {
      changed ??= foe.punches.slice();
      changed[n] = q;
    }
  }
  if (changed) foe.punches = changed;
}
/** A hand of the player's that guards nothing right now. */
function isOut(me: Me, input: BoutInput, i: 0 | 1, now: number): boolean {
  return now < me.out[i] || (input.busy ? input.busy[i] : false);
}
/** The player is caught punching: a fist on its way out, or only just at full stretch. */
function punching(me: Me, now: number): boolean {
  for (const i of [0, 1] as const) {
    if (now >= me.stretch[i] && now - me.stretch[i] <= RULES.justLanded) return true;
    // A hand seen driving out with no punch read from it yet is in flight, for as long as a punch can be.
    if (me.drive[i] >= 0 && now - me.drive[i] <= RULES.me.flight.uppercut) return true;
  }
  return false;
}

/** Remember what it shows now, if that has changed. */
function remember(s: Bout): void {
  const { foe } = s;
  const now = s.time;
  let o0 = false,
    o1 = false,
    open = false;
  for (const p of foe.punches) {
    if (p.feint || p.start > now) continue;
    if (now < p.home) p.hand === "left" ? (o0 = true) : (o1 = true);
    if (now <= p.impact + RULES.justLanded) open = true;
  }
  const a: Spot = o0 ? "out" : foe.gloves[0].place,
    b: Spot = o1 ? "out" : foe.gloves[1].place;
  const f = foe.feet;
  // In the middle of a step it counts as the nearer end: the doubt is the player's.
  const feet: Range = !s.range || (now >= f.end ? f.to === "pocket" : f.from === "pocket" || f.to === "pocket") ? "pocket" : "edge";
  const hurt = now < foe.hurtUntil;
  const seen = foe.seen;
  const last = seen[seen.length - 1];
  const same = last && last.spots[0] === a && last.spots[1] === b && last.feet === feet && last.hurt === hurt && last.open === open;
  // Forget what was replaced longer ago than anything can be judged against.
  let drop = 0;
  while (drop + 1 < seen.length && seen[drop + 1].from <= now - RULES.memory) drop++;
  if (same && !drop) return;
  const kept = drop ? seen.slice(drop) : seen;
  foe.seen = same ? kept : [...kept, { from: now, spots: [a, b], feet, hurt, open }];
}

/** Keep the things a drawing reads in step with the rest. */
function tidy(s: Bout): void {
  const { foe } = s;
  const now = s.time;
  if (foe.punches.length) {
    // A punch is forgotten once its hand is home and it has been judged.
    let gone = false;
    for (const p of foe.punches) if (now >= p.home && (p.done || p.feint)) gone = true;
    if (gone) foe.punches = foe.punches.filter((p) => !(now >= p.home && (p.done || p.feint)));
  }
  const newest = foe.punches.length ? foe.punches[foe.punches.length - 1] : null;
  if (foe.punch !== newest) foe.punch = newest;
  for (const i of [0, 1] as const) {
    const g = foe.gloves[i];
    const move = s.boxer.guardMove;
    const until = g.next
      ? g.next.at
      : foe.lowUntil[i] > 0 && g.place === "low"
        ? foe.lowUntil[i] + move
        : g.place === "cover" && foe.shell
          ? Math.min(foe.shell.until, foe.shell.since + RULES.shellMost) + move
          : g.place === "cover" && foe.coverUntil > 0
            ? foe.coverUntil + move
            : g.place === "cover" && now < foe.hurtUntil
              ? foe.hurtUntil + move
              : Infinity;
    if (until !== g.until) setGlove(s, i, { ...g, until });
  }
}

// ── The opponent's turn ───────────────────────────────────────────────────
function think(s: Bout, input: BoutInput, mind: Mind): void {
  const { foe, boxer } = s;
  const now = s.time;
  if (now < foe.hurtUntil) {
    if (foe.mode !== "hurt") {
      // Hurt: whatever it was doing stops, and its arms come up.
      foe.mode = "hurt";
      foe.visit = null;
      foe.answerAt = null;
      foe.shell = null;
      for (const i of [0, 1] as const) order(s, i, "cover", RULES.hurt.coverIn);
    }
    return;
  }
  if (foe.mode === "hurt") {
    // Came through it: it ties up, and they are broken.
    foe.mode = "set";
    stepTo(s, "edge", boxer.stepOut);
    foe.nextAt = now + RULES.breakFor;
    foe.solids = [];
    toGuard(s);
    say(s, { kind: "break" });
  }
  for (const i of [0, 1] as const)
    if (foe.lowUntil[i] > 0 && now >= foe.lowUntil[i]) {
      setLow(s, i, -1);
      order(s, i, foe.mode === "shell" ? "cover" : restPlace(s), boxer.guardMove);
    }
  if (foe.coverUntil > 0 && now >= foe.coverUntil && foe.mode !== "shell") {
    foe.coverUntil = -1;
    toGuard(s);
  }
  if (foe.mode === "shell" && foe.shell) {
    if (now >= foe.shell.until || now - foe.shell.since >= RULES.shellMost) {
      foe.mode = "set";
      foe.shell = null;
      toGuard(s);
      // Out of its shell it either answers or backs off.
      if (!input.blind && mind.will("answer", s)) begin(s, mind.reply(s), true, true);
      else {
        stepTo(s, "edge", boxer.stepOut);
        foe.nextAt = now + mind.wait(s, 0.4);
      }
    }
    return;
  }
  if (foe.solids.length) {
    if (now - foe.solids[0] >= RULES.shellWithin) foe.solids = foe.solids.filter((t) => now - t < RULES.shellWithin);
    if (foe.solids.length >= boxer.shellAfter) {
      // Hit too often too quickly: it covers up.
      foe.mode = "shell";
      foe.visit = null;
      foe.answerAt = null;
      foe.shell = { since: now, until: now + mind.span("shell", s) };
      coverUp(s, boxer.guardMove);
      foe.solids = [];
      return;
    }
  }
  // Standing ready, its hands rest where its breath lets them.
  if (foe.mode === "set" && foe.coverUntil < 0) {
    const rest = restPlace(s);
    for (const i of [0, 1] as const) {
      const g = foe.gloves[i];
      if (foe.lowUntil[i] < 0 && !g.next && g.place !== rest && (g.place === "chin" || g.place === "low"))
        order(s, i, rest, boxer.guardMove);
    }
  }
  const v = foe.visit;
  if (v) {
    if (v.index >= v.steps.length) {
      if (now >= v.doneAt) {
        foe.visit = null;
        foe.mode = "set";
        foe.lastVisitEnd = now;
        foe.nextAt = now + mind.wait(s);
        // It does not walk away from a player it has just walked down.
        if (!input.back) stepTo(s, "edge", boxer.stepOut);
      }
      return;
    }
    // Nothing new starts while the player cannot be seen.
    if (now >= v.nextAt && !input.blind) doStep(s, v, mind);
    return;
  }
  if (foe.answerAt !== null && now >= foe.answerAt && !input.blind) {
    foe.answerAt = null;
    begin(s, mind.reply(s), true, false);
    return;
  }
  if (now >= foe.nextAt && !input.blind) {
    if (foe.breath < RULES.paces.waitsBelow) {
      // Out of breath: it moves and waits.
      foe.nextAt = now + RULES.paces.waitFor;
      return;
    }
    let steps = mind.visit(s);
    if (foe.breath < RULES.paces.shortBelow) steps = steps.filter((k) => k !== "f" && k !== "w" && k !== "in").slice(0, 2);
    begin(s, steps, false, false);
  }
}

/** Begin a combination: step in first if any of it needs the pocket. */
function begin(s: Bout, wanted: Step[], answer: boolean, straightIfFar: boolean): void {
  const { foe, boxer } = s;
  const now = s.time;
  let steps = wanted;
  const needs = (list: Step[]) => list.some((k) => k === "in" || (k !== "f" && k !== "w" && PUNCH[k].pocket));
  const far = s.range && standsAt(foe, now) !== "pocket";
  // Out of its shell it does not step in to answer: it throws what reaches.
  if (straightIfFar && far && needs(steps)) steps = ["c"];
  if (!steps.length) return;
  let nextAt = now;
  if (needs(steps) && s.range) {
    if (far) {
      stepTo(s, "pocket", boxer.stepIn);
      // Decided early enough that the first punch starts as the step ends.
      nextAt = Math.max(now, foe.feet.end - s.ahead);
    } else if (foe.feet.to !== "pocket") stepTo(s, "pocket", 0);
  }
  foe.visit = {
    id: ++foe.visits,
    steps,
    index: 0,
    nextAt,
    startedAt: now,
    feint: false,
    answer,
    doneAt: Infinity,
    threw: 0,
  };
  foe.mode = "visit";
}

/** The next step of its combination: a punch leaves, a feint is shown, or it waits a beat. */
function doStep(s: Bout, v: Visit, mind: Mind): void {
  const { foe, me, boxer, times } = s;
  const now = s.time;
  const step = v.steps[v.index];
  const index = v.index;
  const next: Visit = { ...v, index: index + 1 };
  foe.visit = next;
  /** When what is decided now first moves. */
  const begins = now + s.ahead;
  const lead = s.lead;
  const rear: Hand = lead === "left" ? "right" : "left";
  if (step === "in") {
    // The step in was taken before the combination began: go straight on.
    next.nextAt = now;
    return;
  }
  if (step === "w") {
    next.nextAt = now + RULES.pause;
    return;
  }
  if (step === "f") {
    // A feint: the jab is shown and pulled back. Nothing lands and the hand still guards.
    const t = times.jab;
    const p: Thrown = {
      id: s.nextId++,
      code: "j",
      kind: "jab",
      hand: lead,
      level: "head",
      shape: "straight",
      start: begins,
      commit: begins + Math.min(t.commit, RULES.feint),
      impact: begins + Math.min(t.commit, RULES.feint),
      home: begins + RULES.feint,
      aim: null,
      feint: true,
      visit: v.id,
      index,
      of: v.steps.length,
      weight: 0,
      blind: false,
      done: true,
      off: -1,
      under: -1,
      kept: -1,
      open: false,
      caught: false,
    };
    foe.punches = [...foe.punches, p];
    next.feint = true;
    next.nextAt = now + RULES.feint;
    say(s, { kind: "throw", punch: p.id, code: "j", hand: lead, level: "head", shape: "straight", feint: true, index, of: v.steps.length, impact: p.impact });
    return;
  }
  let code: Code = step;
  // It does not throw a straight punch at a head that is already moving: a
  // hook covers the sideways move, and from the edge the body does not move.
  if (PUNCH[code].level === "head" && PUNCH[code].shape === "straight" && Math.abs(me.head.vx) > RULES.moving && mind.will("hook", s, code)) {
    const close = !s.range || standsAt(foe, now) === "pocket";
    code = PUNCH[code].lead ? (close ? "h" : "bj") : close ? "rh" : "bc";
  }
  const d = PUNCH[code];
  const hand = d.lead ? lead : rear;
  const t = times[d.kind];
  const slow = foe.breath < RULES.paces.slowBelow ? RULES.paces.slowHome : 1;
  const weight = weightOf(foe.breath);
  spend(foe, now, RULES.cost[d.col]);
  const p: Thrown = {
    id: s.nextId++,
    code,
    kind: d.kind,
    hand,
    level: d.level,
    shape: d.shape,
    start: begins,
    commit: begins + t.commit,
    impact: begins + t.impact,
    home: begins + t.impact + t.home * slow,
    aim: null,
    feint: false,
    visit: v.id,
    index,
    of: v.steps.length,
    weight,
    blind: false,
    done: false,
    off: -1,
    under: -1,
    kept: -1,
    open: false,
    caught: false,
  };
  foe.punches = [...foe.punches, p];
  next.threw++;
  next.doneAt = p.impact;
  count(s, "thrown", 1);
  say(s, { kind: "throw", punch: p.id, code, hand, level: d.level, shape: d.shape, feint: false, index, of: v.steps.length, impact: p.impact });
  // Habits of the hands: the other one drops as it punches; this one comes home low.
  const i = IX[hand],
    o = (1 - i) as 0 | 1;
  if (mind.will("drop", s, code)) {
    if (s.ahead > 0) order(s, o, "low", 0);
    else put(s, o, "low");
    setLow(s, o, Math.max(foe.lowUntil[o], p.home));
  }
  const low = mind.span("home-low", s, code);
  if (low > 0) {
    if (s.ahead > 0) order(s, i, "low", p.impact - now - s.ahead);
    else put(s, i, "low");
    setLow(s, i, Math.max(foe.lowUntil[i], p.home + low));
  }
  // The next one lands a beat after this one.
  const nk = v.steps[index + 1];
  if (nk !== undefined && nk !== "f" && nk !== "w" && nk !== "in") {
    const nd = PUNCH[nk];
    // The next one is decided `ahead` before it moves, like this one was.
    next.nextAt = Math.max(now + 0.06, p.impact + boxer.gap - times[nd.kind].impact - s.ahead, nd.lead === d.lead ? p.impact + RULES.sameHand - s.ahead : 0);
  } else next.nextAt = p.impact;
}

// ── Landing ───────────────────────────────────────────────────────────────
/** Everything that lands this step, in the order it landed. */
function land(s: Bout, input: BoutInput, mind: Mind): void {
  const now = s.time;
  for (;;) {
    if (s.over || s.me.down || s.foe.down) return;
    let punch: Thrown | null = null;
    for (const p of s.foe.punches)
      if (!p.done && !p.feint && now >= p.impact && (!punch || p.impact < punch.impact) && settled(s, p)) punch = p;
    let blow: Blow | null = null;
    for (const b of s.me.coming) if (b.at <= now && (!blow || b.at < blow.at)) blow = b;
    if (!punch && !blow) return;
    if (blow && (!punch || blow.at < punch.impact)) {
      const taken = blow;
      s.me.coming = s.me.coming.filter((b) => b !== taken);
      strike(s, taken, mind);
    } else if (punch) take(s, punch, input, mind);
  }
}
/** Can its punch be judged yet? At once if waiting could not help the player; otherwise a moment after contact. */
function settled(s: Bout, p: Thrown): boolean {
  if (s.time >= p.impact + RULES.late) return true;
  if (p.blind || p.kept >= RULES.gloves) return true;
  if (p.level === "head" && (p.shape === "hook" ? p.under >= RULES.duckAt : p.off >= RULES.missAt)) return true;
  return !itReaches(s, p);
}
function itReaches(s: Bout, p: Thrown): boolean {
  if (!s.range) return true;
  const steps = (standsAt(s.foe, s.time) === "pocket" ? 0 : 1) + (s.me.away ? 1 : 0);
  return p.shape === "straight" ? steps <= 1 : steps <= 0;
}

/** One of the opponent's punches arrives at the player. */
function take(s: Bout, p: Thrown, input: BoutInput, mind: Mind): void {
  const { me, foe, boxer } = s;
  const now = s.time;
  foe.punches = foe.punches.map((q) => (q === p ? { ...p, done: true } : q));
  const d = PUNCH[p.code];
  const o0 = isOut(me, input, 0, now),
    o1 = isOut(me, input, 1, now);
  const spots = spotsOf(input.guard, o0, o1).spots;
  const reach = itReaches(s, p);
  const hurt = now < me.hurtUntil;
  const why: Why = { out: [o0, o1], spots, low: p.open, reach, hurt, heels: me.heels };
  const tell = (outcome: Outcome, how: "slip" | "duck" | null, damage = 0, kept = 0, glance = false, counter = false, solid = false) =>
    say(s, { kind: "its", punch: p.id, code: p.code, hand: p.hand, level: p.level, shape: p.shape, outcome, how, damage, kept, glance, counter, solid, why });
  if (!reach) {
    count(s, "missed", 1);
    mind.report("short");
    tell("short", null);
    return;
  }
  let glance = false;
  if (p.level === "head") {
    if (p.shape === "hook") {
      if (p.under >= RULES.duckAt) {
        count(s, "missed", 1);
        mind.report("ducked");
        tell("miss", "duck");
        return;
      }
    } else if (p.off >= RULES.missAt) {
      count(s, "missed", 1);
      mind.report("slipped");
      tell("miss", "slip");
      return;
    } else glance = p.off >= RULES.glanceAt;
  }
  if (p.blind) {
    // Not seen for part of it: nobody can say where the gloves were. It counts for nothing either way.
    tell("unseen", null);
    return;
  }
  const kept = Math.max(0, p.kept);
  const base = RULES.hit[d.col] * (p.level === "body" ? RULES.bodyShare : 1) * boxer.power * p.weight;
  // Caught punching, unless it was itself hit solidly a moment ago: then it is a trade.
  const atOnce = Math.abs(me.stretch[0] - p.impact) <= RULES.atOnce || Math.abs(me.stretch[1] - p.impact) <= RULES.atOnce;
  const counter = p.caught && !atOnce && now - foe.solidAt > RULES.trade;
  const damage =
    base *
    (1 - kept) *
    (glance ? RULES.glance : 1) *
    (p.level === "head" && p.open ? RULES.handsDown : 1) *
    (counter ? RULES.counter : 1) *
    (hurt ? RULES.hurt.takes : 1) *
    (me.heels ? RULES.heels.takes : 1);
  // A punch with no breath behind it is an arm punch: it cannot hurt or floor anybody.
  const r = apply(s, mind, 1, p.level, d.col !== "jab" && p.weight >= RULES.tired.does, base, damage, kept, counter, p.weight);
  if (p.level === "head") mind.report(kept >= RULES.gloves ? "head-blocked" : "head-through");
  tell(r.outcome, null, s.stakes === "touch" ? 0 : damage, kept, glance, counter, r.solid);
  if (r.down) floor(s, 1, r.down);
}

/** One of the player's punches arrives at the opponent. */
function strike(s: Bout, blow: Blow, mind: Mind): void {
  const { me, foe, boxer } = s;
  const now = s.time;
  const at = clamp(blow.at, now - RULES.memory, now);
  const i = IX[blow.hand];
  const col: Col = blow.shape === "hook" ? "hook" : blow.shape === "uppercut" ? "uppercut" : blow.hand === s.lead ? "jab" : "cross";
  const power = col !== "jab";
  const lead = at - me.lastStretch > RULES.leadGap;
  let weight = weightOf(me.breath);
  // Beaten to the punch by a solid power counter while this one was on its way.
  if (at > me.beatenAt && at - me.beatenAt <= RULES.me.flight[blow.shape]) weight *= RULES.beaten;
  spend(me, at, RULES.cost[col]);
  me.lastStretch = at;
  me.stretch = i === 0 ? [at, me.stretch[1]] : [me.stretch[0], at];
  const home = at + RULES.me.home[blow.shape];
  me.out = i === 0 ? [Math.max(me.out[0], home), me.out[1]] : [me.out[0], Math.max(me.out[1], home)];
  if (me.drive[i] >= 0) me.drive = i === 0 ? [-2, me.drive[1]] : [me.drive[0], -2];
  count(s, "thrown", 0);

  // A set opponent may have seen a lead coming, and be ready for what follows it.
  let read: "slip" | "catch" | null = null;
  if (blow.met) {
    // Real contact: what the fist met is what happened. It may still answer a lead it saw.
    if (lead && foe.mode === "set" && !foe.visit && now >= foe.hurtUntil) {
      const r = mind.reads({ hand: blow.hand, shape: blow.shape, level: blow.level, at }, s);
      if (r?.answer && now >= foe.answerCool) {
        foe.answerAt = at + boxer.answerDelay * 0.4;
        foe.answerCool = now + boxer.answerEvery;
      }
    }
  } else if (lead && foe.mode === "set" && !foe.visit && now >= foe.hurtUntil) {
    const r = mind.reads({ hand: blow.hand, shape: blow.shape, level: blow.level, at }, s);
    if (r) {
      read = r.how;
      foe.evade = { how: r.how, at };
      if (r.answer && now >= foe.answerCool) {
        foe.answerAt = at + boxer.answerDelay * 0.4;
        foe.answerCool = now + boxer.answerEvery;
      }
    }
  } else if (!lead && foe.evade && at - foe.evade.at < RULES.readFor && mind.will("ready", s)) read = "catch";

  // The glove on the side it lands, and the glove it is aimed at: the opponent's right is on the player's left.
  const side: 0 | 1 = blow.third === "left" ? 1 : blow.third === "right" ? 0 : blow.hand === "left" ? 1 : 0;
  const aimed: -1 | 0 | 1 = blow.third === "middle" ? -1 : blow.third === "left" ? 1 : 0;
  const hookish = blow.shape !== "straight";
  const quality = clamp(blow.quality, RULES.quality.least, RULES.quality.most);
  const base = RULES.hit[col] * (blow.level === "body" ? RULES.bodyShare : 1) * weight * quality;
  // Hit solidly a moment ago, or landing in the same moment as its punch: a trade, not a counter.
  let trade = now - me.solidAt <= RULES.trade;
  for (const p of foe.punches) if (!p.feint && Math.abs(p.impact - at) <= RULES.atOnce) trade = true;
  const tired = foe.breath < RULES.tiredGuard.below ? RULES.tiredGuard.keeps : 1;
  // Judged against the kindest thing it showed in the last moment before the fist arrived.
  let best: { shown: Shown; damage: number; kept: number; long: boolean; counter: boolean; reach: boolean } | null = null;
  const seen = foe.seen;
  for (let n = 0; n < seen.length; n++) {
    const shown = seen[n];
    const until = n + 1 < seen.length ? seen[n + 1].from : Infinity;
    if (shown.from > at || until <= at - RULES.favour) continue;
    const steps = !s.range ? 0 : (shown.feet === "pocket" ? 0 : 1) + (me.away ? 1 : 0);
    // A hook from one step too far still arrives, as an arm punch; from two steps nothing does.
    const reach = blow.met ? blow.met.what !== "air" : steps <= 1;
    const long = blow.met ? false : hookish && steps === 1;
    let kept = blow.met
      ? blow.met.what === "guard"
        ? 1
        : blow.met.kept
      : read === "catch"
        ? RULES.caught
        : keptOut(shown.spots, blow.level, col, side, aimed, boxer.tight) * tired * (shown.hurt ? RULES.hurt.guard : 1);
    kept = Math.min(RULES.cover.most, kept);
    const counter = shown.open && !trade;
    const damage = !reach
      ? -1
      : base * (1 - kept) * (long ? RULES.longHook : 1) * (counter ? RULES.counter : 1) * (shown.hurt ? RULES.hurt.takes : 1);
    if (!best || damage >= best.damage) best = { shown, damage, kept, long, counter, reach };
  }
  const shown: Shown = best?.shown ?? { from: now, spots: [foe.gloves[0].place, foe.gloves[1].place], feet: "pocket", hurt: false, open: false };
  const why: Why = {
    out: [shown.spots[0] === "out", shown.spots[1] === "out"],
    spots: shown.spots,
    low: false,
    reach: best ? best.reach && !best.long : true,
    hurt: shown.hurt,
    heels: me.heels,
  };
  const tell = (outcome: Outcome, damage = 0, kept = 0, long = false, counter = false, solid = false) =>
    say(s, { kind: "mine", hand: blow.hand, shape: blow.shape, level: blow.level, third: blow.third, outcome, read, damage, kept, long, counter, solid, judged: at, why });
  const missed = () => {
    count(s, "missed", 0);
    me.breath = Math.max(0, me.breath - RULES.cost[col] * RULES.missCost);
  };
  // A punch that did nothing may be answered.
  const answerIt = () => {
    if ((foe.mode === "set" || foe.mode === "shell") && !foe.visit && foe.answerAt === null && now >= foe.answerCool && now >= foe.hurtUntil && mind.will("answer", s)) {
      foe.answerAt = now + boxer.answerDelay;
      foe.answerCool = now + boxer.answerEvery;
      if (foe.shell) foe.shell = { ...foe.shell, until: Math.min(foe.shell.until, foe.answerAt) };
    }
  };
  if (best && !best.reach) {
    missed();
    answerIt();
    tell("short");
    return;
  }
  if (read === "slip") {
    // It slips the punch: a miss, and it has its answer ready.
    missed();
    tell("miss");
    return;
  }
  const kept = best ? best.kept : 0;
  const counter = best ? best.counter : false;
  const long = best ? best.long : false;
  const wasHurt = now < foe.hurtUntil;
  const damage =
    Math.max(0, best ? best.damage : base) * (me.heels ? RULES.heels.gives : 1) * (now < me.hurtUntil ? RULES.hurt.gives : 1);
  // A push scores nothing and hurts nobody, however clean.
  const push = blow.quality < RULES.quality.push;
  const r = apply(s, mind, 0, blow.level, power && !push && weight >= RULES.tired.does, base, damage, kept, counter, push ? 0 : weight);
  tell(r.outcome, s.stakes === "touch" ? 0 : damage, kept, long, counter, r.solid);
  // Touched, it brings its gloves up: the next punch to the head meets them, and its body is open.
  if (foe.mode !== "shell" && !wasHurt && !r.down && mind.will("cover", s)) {
    coverUp(s, boxer.guardMove);
    foe.coverUntil = now + boxer.guardMove + RULES.coverHold;
  }
  if (r.solid && !r.down) {
    foe.solids = [...foe.solids, now];
    if (now - foe.lastVisitEnd < 0.7 && counter) mind.report("answered");
    // Hit in the body, the elbow comes down on that side, and the head opens.
    if (blow.level === "body" && mind.will("elbow", s)) {
      for (const g of blow.shape === "hook" ? [side] : ([0, 1] as const)) {
        order(s, g, "low", boxer.guardMove);
        setLow(s, g, now + boxer.guardMove + boxer.lowFor);
      }
    }
    // A stiff jab as it steps in stops its feet.
    if (col === "jab" && foe.visit && foe.visit.index === 0 && now < foe.feet.end && foe.feet.to === "pocket" && mind.will("stop", s)) {
      endVisit(s);
      stepTo(s, "edge", 0);
      foe.nextAt = now + mind.wait(s, 0.6);
    }
    if (foe.mode === "set" && !foe.visit) {
      foe.nextAt = Math.max(foe.nextAt, now + 0.15);
      if (foe.answerAt === null && !wasHurt && mind.will("fire", s)) foe.answerAt = now + boxer.answerDelay;
    }
  } else if (!r.down) answerIt();
  if (r.down) floor(s, 0, r.down);
}

/**
 * A punch has arrived: the card, the breath, the health, the hurt.
 * `by` 0 is the player hitting the opponent, 1 the other way.
 */
function apply(
  s: Bout,
  mind: Mind,
  by: 0 | 1,
  level: Level,
  power: boolean,
  base: number,
  damage: number,
  kept: number,
  counter: boolean,
  weight: number,
): { outcome: "clean" | "partly" | "gloves"; solid: boolean; down: "finish" | "worn" | null } {
  const { foe, me, boxer } = s;
  const now = s.time;
  const def: Fighter = by === 0 ? foe : me;
  const outcome = kept >= RULES.gloves ? "gloves" : kept >= RULES.clean ? "partly" : "clean";
  const solid = kept < RULES.solid;
  const touch = s.stakes === "touch";
  count(s, outcome, by);
  if (outcome !== "gloves") {
    count(s, "touches", by);
    // Touch sparring counts touches. Otherwise only clean punches with something behind them.
    const points = touch ? 1 : outcome === "clean" && weight >= RULES.tired.does ? (power ? RULES.card.power : RULES.card.clean) * Math.min(1, weight) : 0;
    if (points > 0) count(s, "points", by, points);
  }
  // Blocking is work, and a body punch takes the wind.
  def.breath = Math.max(0, def.breath - base * kept * RULES.blockCost - (level === "body" ? damage * RULES.bodyBreath : 0));
  let down: "finish" | "worn" | null = null;
  if (!touch) {
    const worn = def.health <= 0;
    def.health = Math.max(0, def.health - damage);
    const hurt = now < def.hurtUntil;
    if (solid && power) {
      if (level === "head") def.hurtPile += damage;
      // Hurt and hit solidly again and again: down. Worn to nothing and hit solidly: down.
      if (hurt && ++def.hurtHits >= RULES.finish) down = "finish";
      else if (worn || def.health <= 0) down = "worn";
    }
    if (!down && !hurt && def.hurtPile >= RULES.hurt.base + RULES.hurt.perHealth * def.health) {
      def.hurtUntil = now + RULES.hurt.lasts;
      def.hurtHits = 0;
      def.hurtPile = 0;
      say(s, { kind: "hurt", who: by === 0 ? "foe" : "me", until: def.hurtUntil });
      // It may come in at once on a hurt player: whatever it was throwing is cut short for what finishes.
      if (by === 1 && mind.will("press", s)) {
        endVisit(s);
        foe.answerAt = null;
        foe.nextAt = Math.min(foe.nextAt, now);
      }
    }
  }
  // A solid power punch that beats a punch to the target takes the weight off it.
  if (solid && counter && power) {
    if (by === 0) {
      let any = false;
      for (const p of foe.punches) if (!p.done && !p.feint && p.impact > now) any = true;
      if (any) foe.punches = foe.punches.map((p) => (!p.done && !p.feint && p.impact > now ? { ...p, weight: p.weight * RULES.beaten } : p));
      if (foe.visit && now >= foe.hurtUntil && !down) {
        endVisit(s);
        foe.nextAt = now + mind.wait(s, 0.6);
        stepTo(s, "edge", boxer.stepOut);
      }
    } else me.beatenAt = now;
  }
  if (solid) def.solidAt = now;
  return { outcome, solid, down };
}

/** Somebody goes down; in open sparring they take a standing count instead. */
function floor(s: Bout, by: 0 | 1, how: "finish" | "worn"): void {
  const { me, foe } = s;
  const now = s.time;
  const def: Fighter = by === 0 ? foe : me;
  const standing = s.stakes !== "bout";
  def.kept = how === "finish" ? def.health : 0;
  def.down = { since: now, until: now + RULES.count, standing };
  def.hurtUntil = -Infinity;
  def.hurtPile = 0;
  def.hurtHits = 0;
  callOff(s);
  foe.mode = "set";
  foe.shell = null;
  if (standing) {
    count(s, "counts", by);
    say(s, { kind: "down", who: by === 0 ? "foe" : "me", downs: s.card.rounds.reduce((n, r) => n + r.counts[by], 0), standing, by: how });
    return;
  }
  count(s, "downs", by);
  s.downs = by === 0 ? [s.downs[0] + 1, s.downs[1]] : [s.downs[0], s.downs[1] + 1];
  say(s, { kind: "down", who: by === 0 ? "foe" : "me", downs: s.downs[by], standing, by: how });
  if (s.downs[by] >= RULES.stopAt) {
    s.over = { winner: by === 0 ? "me" : "foe", how: "stoppage" };
    say(s, { kind: "over", winner: s.over.winner, how: "stoppage" });
  }
}

/** The bell: the round is scored, and either the bout is over or both go to their corners. */
function bell(s: Bout): void {
  const { me, foe } = s;
  const now = s.time;
  const r = s.card.rounds[s.card.rounds.length - 1];
  const c = RULES.card;
  const mine = r.points[0] + c.knockdown * r.downs[0],
    its = r.points[1] + c.knockdown * r.downs[1];
  // Ten to nine; ten to eight for a knockdown, or for a round nobody could call close.
  const wide = (a: number, b: number, downs: boolean) => (downs || (a >= b * c.wide.times && a - b >= c.wide.gap) ? 8 : 9);
  const score: [number, number] =
    Math.abs(mine - its) < c.even
      ? [10, 10]
      : mine > its
        ? [10, wide(mine, its, r.downs[0] > r.downs[1])]
        : [wide(its, mine, r.downs[1] > r.downs[0]), 10];
  s.card = { ...s.card, scores: [...s.card.scores, score] };
  // Punches in the air are called off. Anybody down is saved by the bell.
  callOff(s);
  if (s.round >= s.rounds) {
    const total = s.card.scores.reduce((a, x) => [a[0] + x[0], a[1] + x[1]], [0, 0]);
    // Level cards go to whoever scored more over the whole bout; a draw only if that is level too.
    const all = s.card.rounds.reduce((a, x) => [a[0] + x.points[0] + c.knockdown * x.downs[0], a[1] + x.points[1] + c.knockdown * x.downs[1]], [0, 0]);
    const winner: Side | null =
      total[0] !== total[1] ? (total[0] > total[1] ? "me" : "foe") : Math.abs(all[0] - all[1]) >= c.even ? (all[0] > all[1] ? "me" : "foe") : null;
    s.over = { winner, how: winner ? "points" : "draw" };
    say(s, { kind: "over", winner, how: s.over.how });
    return;
  }
  for (const who of [0, 1] as const) {
    const f: Fighter = who === 0 ? me : foe;
    if (!f.down) continue;
    f.health = Math.max(f.kept, RULES.health * RULES.rise[Math.min(Math.max(s.downs[1 - who], 1), RULES.rise.length) - 1]);
    f.down = null;
  }
  foe.mode = "set";
  foe.shell = null;
  s.rest = true;
  say(s, { kind: "bell", round: s.round, score });
}

/** Out of the corner for the next round: breath back, half of the missing health, and it starts from the edge. */
export function nextRound(before: Bout): Bout {
  if (!before.rest || before.over) return before;
  const now = before.time;
  const heal = (hp: number) => hp + (RULES.health - hp) * RULES.restHeal;
  const at: Range = before.range ? "edge" : "pocket";
  const fresh = { hurtUntil: -Infinity, hurtPile: 0, hurtHits: 0, down: null, chain: 0 };
  return {
    ...before,
    rest: false,
    round: before.round + 1,
    roundStart: now,
    card: { ...before.card, rounds: [...before.card.rounds, emptyTally()] },
    me: {
      ...before.me,
      ...fresh,
      health: heal(before.me.health),
      breath: RULES.breath,
      out: [-Infinity, -Infinity],
      drive: [-1, -1],
      coming: [],
      backSince: -1,
      forwardSince: -1,
      away: false,
      heels: false,
    },
    foe: {
      ...before.foe,
      ...fresh,
      health: heal(before.foe.health),
      // A boxer with little wind is still blowing when the bell goes again.
      breath: before.foe.breath + (RULES.breath - before.foe.breath) * Math.min(1, before.boxer.wind),
      mode: "set",
      feet: { from: at, to: at, start: now, end: now },
      gloves: [glove("chin", now), glove("chin", now)],
      lowUntil: [-1, -1],
      coverUntil: -1,
      punches: [],
      punch: null,
      visit: null,
      nextAt: now + RULES.roundOpening,
      answerAt: null,
      shell: null,
      solids: [],
      evade: null,
      seen: [],
    },
  };
}
