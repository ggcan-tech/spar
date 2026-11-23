import {
  COURT,
  COURT_DISTANCE,
  FIXED_STEP,
  TRAINING_PACE,
  solveFlight,
  type DuelState,
  type ThrowInput,
  type TrainingPace,
} from "./duel";

/**
 * How the training opponent decides each throw. It used to release exactly
 * 0.6 s after getting the ball, at the player's head, with no error and no
 * lead: any steady sway was never hit, standing still was always hit, and the
 * rhythm could be dodged by habit. Each throw now has its own plan.
 *
 * Numbers here are design guesses to be tuned by playing, not measurements.
 */
export interface BotPlan {
  /** Seconds from getting the ball to releasing it. Never under the 0.6 s the rules allow. */
  windup: number;
  target: "head" | "torso";
  /** Share of the player's movement during the flight that the aim anticipates, 0–1. */
  lead: number;
  /** Aim error on the player's side, game units. */
  error: { x: number; y: number };
  /** Seconds the ball takes to arrive. */
  flight: number;
  /** Seconds a pump fake adds before the real release; 0 for none. */
  fake: number;
}

const LEVEL = {
  practice: {
    windup: [0.9, 1.5],
    sigma: 0.2,
    lead: 0,
    headShare: 0.3,
    fake: 0,
  },
  duel: {
    windup: [0.6, 1.1],
    sigma: 0.08,
    lead: 0.6,
    headShare: 0.5,
    fake: 0.2,
  },
} as const;
/**
 * What the opponent learns from each ball. It plays to the player: someone who
 * keeps dodging and landing throws gets tighter aim, more lead, faster balls,
 * quicker dodges and more fakes; someone who keeps getting hit gets the
 * opposite. `form` runs from -1 (easiest) to 1 (hardest) and starts at 0, where
 * every number is the level's own.
 */
export type BotOutcome =
  "hit-player" | "missed-player" | "was-hit" | "was-missed";
const FORM_STEP: Record<BotOutcome, number> = {
  "hit-player": -0.25,
  "missed-player": 0.15,
  "was-hit": 0.15,
  "was-missed": -0.05,
};
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
/** The arm is fully drawn back this long before release (see botPose in duel.ts). */
const COCKED = 0.18;
/** How long a pump fake delays the real throw. */
export const FAKE_S = 0.6;
/** How far into the forward whip a fake goes before it stops, as botPose time-to-release. */
const FAKE_DEPTH = 0.045;
/**
 * The time-to-release the opponent's body acts out. Normally the real one.
 * With a pump fake the arm is drawn back early, starts forward, stops, and
 * returns to the cocked position, from which the real throw is made: the
 * player who dodges at the first forward motion has moved too soon.
 */
export function windupClock(untilRelease: number, fake: number): number {
  const u = untilRelease;
  if (!(fake > 0) || !(u >= 0)) return u;
  if (u > fake) return COCKED + (u - fake);
  const jab = 0.1,
    back = 0.2;
  if (u > fake - jab)
    return COCKED - (COCKED - FAKE_DEPTH) * ((fake - u) / jab);
  if (u > fake - jab - back)
    return FAKE_DEPTH + (COCKED - FAKE_DEPTH) * ((fake - jab - u) / back);
  return Math.min(u, COCKED);
}
/**
 * The opponent's dodge. It used to stand in the ball's path whatever was
 * thrown. Now it sometimes steps aside: it needs a moment to react and moves at
 * a person's speed, so a hard throw still lands and a slow lob is easy to avoid.
 */
export interface BotDodge {
  direction: 1 | -1;
  /** Game time at which the step begins: the release plus a reaction time. */
  startAt: number;
  /** Game time at which the ball resolved and the opponent starts back. */
  endAt: number;
}
const DODGE = {
  practice: { chance: 0.25, reaction: 0.38 },
  duel: { chance: 0.6, reaction: 0.28 },
} as const;
/** A body starts from rest: the step accelerates, game units per second squared. */
const DODGE_ACCEL = 4;
const DODGE_REACH = 0.5;
const DODGE_RETURN = 0.8;
/** A ball crossing this close to the opponent's middle would hit. */
const WOULD_HIT = 0.45;

/** How far the opponent has stepped aside at `time`, in its own sideways direction. */
export function dodgeShift(dodge: BotDodge | null, time: number): number {
  if (!dodge || !(time > dodge.startAt)) return 0;
  const moving = Math.min(time, dodge.endAt) - dodge.startAt;
  // 18 cm in the first 0.3 s, the full half metre after 0.5 s: a hard throw
  // arrives before the step has cleared it, a lob does not.
  const out = Math.min(DODGE_REACH, 0.5 * DODGE_ACCEL * moving * moving);
  const back = time > dodge.endAt ? (time - dodge.endAt) * DODGE_RETURN : 0;
  return dodge.direction * Math.max(0, out - back);
}

/** A first ball that teaches the dodge: slow, at the body, on target. */
const TEACHING: Omit<BotPlan, "windup"> = {
  target: "torso",
  lead: 0,
  error: { x: 0, y: 0 },
  flight: 1.3,
  fake: 0,
};

export function createBotMind(seed = (Math.random() * 2 ** 32) >>> 0) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const gauss = () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += random();
    return (sum - 3) * Math.SQRT2;
  };
  let thrown = 0;
  let form = 0;
  return {
    /** The plan for the bot's next throw. Call once each time it gets the ball. */
    next(pace: TrainingPace): BotPlan {
      const level = LEVEL[pace];
      const windup =
        level.windup[0] + random() * (level.windup[1] - level.windup[0]);
      const count = thrown++;
      if (count === 0 && pace === "practice") return { windup, ...TEACHING };
      const sigma = level.sigma * (1 - 0.4 * form);
      const target = random() < level.headShare ? "head" : "torso";
      const error = { x: gauss() * sigma, y: gauss() * sigma * 0.6 };
      // Never in the first two balls: a fake means nothing before the player
      // has seen a real throw.
      const fake =
        count >= 2 && random() < clamp(level.fake + 0.15 * form, 0, 0.5)
          ? FAKE_S
          : 0;
      return {
        windup,
        target,
        lead: clamp(level.lead + 0.3 * form, 0, 1),
        error,
        flight: TRAINING_PACE[pace].flight * (1 - 0.1 * form),
        fake,
      };
    },
    /** Tell the opponent how a ball ended, so it can play to the player. */
    report(what: BotOutcome) {
      form = clamp(form + FORM_STEP[what], -1, 1);
    },
    /** -1 (easiest) to 1 (hardest); 0 is the level as designed. */
    form: () => form,
    /**
     * Whether to step out of the way of a ball just thrown. `crossing` is where
     * the ball will pass the opponent's side and `at` where the opponent
     * stands, both in the opponent's own sideways coordinate.
     */
    dodge(
      pace: TrainingPace,
      crossing: number,
      at: number,
      time: number,
    ): BotDodge | null {
      // Already going wide: nothing to avoid.
      if (Math.abs(crossing - at) > WOULD_HIT) return null;
      if (random() >= clamp(DODGE[pace].chance + 0.2 * form, 0.05, 0.85))
        return null;
      let direction: 1 | -1 =
        crossing === at ? (random() < 0.5 ? 1 : -1) : crossing > at ? -1 : 1;
      // No room on that side of the court: go the other way, across the ball's
      // line, rather than step into the wall.
      if (Math.abs(at + direction * DODGE_REACH) > COURT.halfWidth)
        direction = direction === 1 ? -1 : 1;
      return {
        direction,
        startAt: time + DODGE[pace].reaction * (1 - 0.2 * form),
        endAt: Infinity,
      };
    },
    /** A new session: the teaching ball is thrown again, at the level as designed. */
    reset() {
      thrown = 0;
      form = 0;
    },
  };
}

/**
 * The throw a plan produces, decided at the moment of release and never
 * steered afterwards. The aim is where the plan's target is, moved along the
 * player's current velocity by the plan's lead, plus its error.
 */
export function plannedBotThrow(s: DuelState, plan: BotPlan): ThrowInput {
  const hand = { ...s.poses[1].rightHand };
  const player = s.poses[0],
    before = s.previous[0];
  const point =
    plan.target === "head"
      ? player.head
      : { ...player.root, y: player.root.y + 0.2 };
  const was = plan.target === "head" ? before.head : before.root;
  const now = plan.target === "head" ? player.head : player.root;
  // Velocity over the last physics step, limited to what a body can do.
  const limit = (v: number) => Math.max(-2.5, Math.min(2.5, v));
  const vx = limit((now.x - was.x) / FIXED_STEP),
    vy = limit((now.y - was.y) / FIXED_STEP);
  const x = Math.max(
    -COURT.headHalfWidth,
    Math.min(
      COURT.headHalfWidth,
      point.x + vx * plan.flight * plan.lead + plan.error.x,
    ),
  );
  const y = Math.max(
    0.3,
    Math.min(2.4, point.y + vy * plan.flight * plan.lead + plan.error.y),
  );
  // The bot's frame mirrors the player's sideways and looks the other way.
  return solveFlight(
    hand,
    { x: -x, y, z: COURT_DISTANCE - point.z },
    plan.flight,
    s.physics,
  );
}
