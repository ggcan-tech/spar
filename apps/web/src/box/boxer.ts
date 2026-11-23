import type { Hand } from "./punch";

/**
 * The opponent's decisions: what it throws next, how long it shows it first,
 * how long it rests, where it holds its guard. It plays to the player the way
 * the dodgeball opponent did: `form` runs from -1 (easiest) to 1 (hardest),
 * moves with how the fight is going, and at 0 every number is the level's own.
 *
 * All numbers are design guesses to be tuned by playing.
 */
export type BoxLevel = "rookie" | "digger" | "contender" | "fox" | "champion";
/** The ladder, easiest first. Each is built on one lesson. */
export const LADDER: readonly BoxLevel[] = ["rookie", "digger", "contender", "fox", "champion"];
export const LEVEL_NAME: Record<BoxLevel, [string, string]> = {
  rookie: ["Rookie", "Slow punches, one at a time"],
  digger: ["Digger", "Goes to your body: elbows down"],
  contender: ["Contender", "Quicker, with combinations and feints"],
  fox: ["Fox", "Shows punches it does not throw, and hits you while you punch"],
  champion: ["Champion", "Fast, in twos and threes"],
};
/** What the opponent throws. A jab and a cross come straight; a hook comes round; a body shot comes low. */
export type AttackKind = "jab" | "cross" | "hook" | "body";
export interface AttackPlan {
  kind: AttackKind;
  /** The opponent's own hand. */
  hand: Hand;
  /** Seconds the punch is shown before it is thrown. */
  windup: number;
  /** Shown, then not thrown. */
  feint: boolean;
  /** A second punch that follows at once if the first was not dodged. */
  follow: AttackKind | null;
  /** Seconds the opponent is open after the player makes it miss. */
  counterWindow: number;
  /** Seconds it takes to get its guard back otherwise. */
  recover: number;
  /** One of the first slow punches that teach each defence. */
  teaching: boolean;
  /**
   * Seconds after it is first shown at which a straight punch fixes its aim.
   * A beginner who moves when told to has finished moving well before a punch
   * lands, so the aim is taken early and the punch does not follow: at once
   * for a lesson and a rookie, a moment later for a contender. Measured from
   * the tell, so a slower punch is always the easier one.
   */
  aimAfter: number;
}
export type BoxerOutcome =
  | "hit-player"
  | "blocked-by-player"
  | "dodged-by-player"
  | "was-hit"
  | "was-countered"
  | "blocked-player"
  | "got-up";
const FORM_STEP: Record<BoxerOutcome, number> = {
  "hit-player": -0.12,
  "blocked-by-player": 0.02,
  "dodged-by-player": 0.1,
  "was-hit": 0.01,
  "was-countered": 0.1,
  "blocked-player": -0.02,
  // Back on its feet, it comes on harder.
  "got-up": 0.3,
};
export const LEVEL = {
  rookie: {
    idle: [1.1, 2.2],
    windup: { jab: 0.62, cross: 0.8, hook: 0.9, body: 0.8 },
    mix: { jab: 0.45, cross: 0.25, hook: 0.2, body: 0.1 },
    combo: 0,
    feint: 0,
    counterWindow: 1.2,
    recover: 0.45,
    /** How soon, and how likely, it moves its guard to where it is being hit. */
    guardDelay: 0.9,
    guardChance: 0.5,
    // A rookie's punch goes where the head was when it was first shown.
    aimAfter: 0,
    /** Hit where it is not covering, it covers there at the first punch; otherwise it needs telling twice. */
    coversAtOnce: false,
    /** What being hit in the middle of a punch of one's own costs. */
    caught: 1.25,
  },
  // Goes to the body, and comes round with hooks when the elbows drop.
  digger: {
    idle: [0.85, 1.8],
    windup: { jab: 0.52, cross: 0.66, hook: 0.74, body: 0.62 },
    mix: { jab: 0.2, cross: 0.1, hook: 0.25, body: 0.45 },
    combo: 0.15,
    feint: 0,
    counterWindow: 1.1,
    recover: 0.4,
    guardDelay: 0.7,
    guardChance: 0.65,
    aimAfter: 0.1,
    coversAtOnce: false,
    caught: 1.5,
  },
  contender: {
    idle: [0.55, 1.4],
    windup: { jab: 0.38, cross: 0.5, hook: 0.6, body: 0.52 },
    mix: { jab: 0.35, cross: 0.25, hook: 0.2, body: 0.2 },
    combo: 0.35,
    feint: 0.15,
    counterWindow: 1.0,
    recover: 0.35,
    guardDelay: 0.45,
    guardChance: 0.85,
    aimAfter: 0.2,
    coversAtOnce: true,
    caught: 1.75,
  },
  // Shows punches it does not throw, waits, and hits a player who is punching.
  fox: {
    idle: [0.5, 1.3],
    windup: { jab: 0.36, cross: 0.48, hook: 0.58, body: 0.5 },
    mix: { jab: 0.3, cross: 0.3, hook: 0.25, body: 0.15 },
    combo: 0.2,
    feint: 0.32,
    counterWindow: 1.0,
    recover: 0.33,
    guardDelay: 0.35,
    guardChance: 0.95,
    aimAfter: 0.22,
    coversAtOnce: true,
    caught: 2.5,
  },
  // Fast, in twos and threes.
  champion: {
    idle: [0.45, 1.15],
    windup: { jab: 0.33, cross: 0.43, hook: 0.52, body: 0.46 },
    mix: { jab: 0.35, cross: 0.25, hook: 0.22, body: 0.18 },
    combo: 0.5,
    feint: 0.2,
    counterWindow: 0.95,
    recover: 0.32,
    guardDelay: 0.3,
    guardChance: 0.95,
    aimAfter: 0.25,
    coversAtOnce: true,
    caught: 2,
  },
} as const;
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
/** The first three punches of a rookie fight, one for each defence, shown for a long second. */
const LESSONS: AttackKind[] = ["jab", "hook", "body"];

export function createBoxerMind(seed = (Math.random() * 2 ** 32) >>> 0) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  let form = 0;
  let thrown = 0;
  let openers = true;
  return {
    /** A rookie's first three punches are slow ones that teach each defence; off once the lessons have been passed. */
    setOpeners(on: boolean) {
      openers = on;
    },
    /**
     * The next punch. `tired` is 0 to 1: how much body punishment it has
     * taken. `go` sends it to the body or the head: a player who keeps
     * covering one is hit in the other.
     */
    next(level: BoxLevel, tired = 0, go: "head" | "body" | null = null): AttackPlan {
      const l = LEVEL[level];
      const count = thrown++;
      const lesson = level === "rookie" && openers ? LESSONS[count] : undefined;
      let pick = random(),
        kind: AttackKind = "jab";
      for (const [name, share] of Object.entries(l.mix) as [
        AttackKind,
        number,
      ][]) {
        kind = name;
        if ((pick -= share) < 0) break;
      }
      if (lesson) kind = lesson;
      else if (go === "body") kind = "body";
      else if (go === "head" && kind === "body") kind = random() < 0.5 ? "cross" : "hook";
      // A jab is the lead hand, a cross the rear; hooks and body shots come from either.
      const hand: Hand =
        kind === "jab"
          ? "left"
          : kind === "cross"
            ? "right"
            : random() < 0.5
              ? "left"
              : "right";
      const slow = (1 - 0.2 * form) * (1 + 0.3 * clamp(tired, 0, 1));
      const feint =
        !lesson && count >= 4 && random() < clamp(l.feint + 0.1 * form, 0, 0.4);
      const combo =
        !lesson &&
        !feint &&
        kind === "jab" &&
        random() < clamp(l.combo + 0.15 * form, 0, 0.7);
      return {
        kind,
        hand,
        windup: lesson ? 1.1 : l.windup[kind] * slow,
        feint,
        follow: combo ? (random() < 0.7 ? "cross" : "hook") : null,
        // Never shorter than a player needs to see the opening and answer it.
        counterWindow: Math.max(0.9, l.counterWindow * (1 - 0.1 * form)),
        recover: l.recover,
        teaching: !!lesson,
        aimAfter: lesson ? 0 : Math.min(l.aimAfter, 0.5 * l.windup[kind] * slow),
      };
    },
    /** The plan for a punch that follows another at once. */
    follow(level: BoxLevel, kind: AttackKind, first: AttackPlan): AttackPlan {
      return {
        ...first,
        kind,
        hand: kind === "cross" ? "right" : "left",
        // Never quicker than a player can see it and move.
        windup: Math.max(0.4, LEVEL[level].windup[kind] * 0.55),
        feint: false,
        follow: null,
        teaching: false,
      };
    },
    /** Seconds it waits behind its guard before the next punch. */
    idle(level: BoxLevel): number {
      const [lo, hi] = LEVEL[level].idle;
      return (lo + random() * (hi - lo)) * (1 - 0.25 * form);
    },
    /** Hit where it was not covering: does it move its guard there, and how soon? */
    coverAfter(level: BoxLevel): number | null {
      const l = LEVEL[level];
      return random() < clamp(l.guardChance + 0.1 * form, 0, 1)
        ? l.guardDelay * (1 - 0.2 * form)
        : null;
    },
    report(what: BoxerOutcome) {
      form = clamp(form + FORM_STEP[what], -1, 1);
    },
    form: () => form,
    reset() {
      form = 0;
      thrown = 0;
    },
  };
}
export type BoxerMind = ReturnType<typeof createBoxerMind>;
