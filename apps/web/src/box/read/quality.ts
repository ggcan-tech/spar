import type { Hand, PunchShape } from "../punch";

/**
 * Is it a punch or a push?
 *
 * A push scores nothing in a ring. What one camera can see of the difference:
 * - how fast the fist went, against this player's own best. Under half of
 *   that it is a touch: no score, and it can be countered;
 * - how far the arm went: near 90% of the player's arm for a straight punch.
 *   Full credit at 90%. Locking the elbow out is never rewarded: that is how
 *   boxers' elbows are hurt, punching at air;
 * - whether the hand came home, within 300–400 ms of full stretch.
 *
 * Force, a clenched fist and the wrist's line cannot be seen and are never
 * claimed. A fast punch is not a hard one; this only tells a thrown punch
 * from a hand put out.
 *
 * The three are known at different times: speed when the punch is read,
 * reach when the arm ends, the return a third of a second later. Each rating
 * uses what is known by then.
 *
 * Numbers are starting values from the scripted person and the coach's
 * study, not from people.
 */
export const QUALITY = {
  /** Until this player has thrown a few: a snapped punch's fastest moment, in game units a second (about metres a second). */
  startBest: 3.2,
  /** A player's own best never counts as less than this: someone who only pushes does not set the bar. */
  leastBest: 2.8,
  /** Own best is the high end (this share up the list) of the last so many punches. */
  bestOf: 16,
  bestAt: 0.8,
  /** Under this share of own best it is a touch. */
  touch: 0.5,
  /** A straight's reach: full credit from this share of the arm; a punch that goes half-way keeps this much. */
  reach: 0.9,
  shortKeeps: 0.5,
  /** The hand home within the first of these, ms: full credit. Later than the second: this much. */
  home: [400, 800],
  lateKeeps: 0.7,
  /** The rules' own bounds: 1 is a good punch, and a touch is always under `push`. */
  least: 0.3,
  most: 1.2,
  push: 0.5,
};
export interface PunchFacts {
  hand: Hand;
  shape: PunchShape;
  /** The fist's fastest moment, in game units a second. */
  speed: number;
  /** Shoulder to wrist over the arm's length at the far point, when it is known. Used for straights only. */
  reach?: number | null;
  /** Milliseconds from full stretch to the hand being most of the way home, when it is known. */
  backMs?: number | null;
}
export interface Quality {
  /** How well it was thrown: 1 is a good punch, 0.3 to 1.2. Under 0.5 it scores nothing. */
  value: number;
  /** Under half the player's own speed: a hand put out, not a punch. */
  touch: boolean;
  /** The parts: speed against own best; and the credit for reach and for the return (1 when not yet known). */
  speed: number;
  reach: number;
  home: number;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function createQuality() {
  const speeds: Record<Hand, number[]> = { left: [], right: [] };
  /** This hand's own best: the high end of what it has thrown, never under the floor. */
  const best = (hand: Hand): number => {
    const mine = speeds[hand];
    // The other hand's punches stand in until this one has thrown a few.
    const list = mine.length >= 3 ? mine : [...mine, ...speeds[hand === "left" ? "right" : "left"]];
    if (list.length < 3) return QUALITY.startBest;
    const sorted = [...list].sort((a, b) => a - b);
    return Math.max(QUALITY.leastBest, sorted[Math.floor((sorted.length - 1) * QUALITY.bestAt)]);
  };
  return {
    best,
    /** Rate a punch from what is known of it so far. Does not learn from it. */
    rate(facts: PunchFacts): Quality {
      const speed = facts.speed / best(facts.hand);
      const touch = speed < QUALITY.touch;
      // Reach matters to a straight punch. A hook is thrown with a bent arm.
      let reach = 1;
      if (facts.shape === "straight" && typeof facts.reach === "number") {
        const k = clamp((facts.reach - QUALITY.reach / 2) / (QUALITY.reach / 2), 0, 1);
        reach = QUALITY.shortKeeps + (1 - QUALITY.shortKeeps) * k;
      }
      let home = 1;
      if (typeof facts.backMs === "number") {
        const [soon, late] = QUALITY.home;
        home = 1 - (1 - QUALITY.lateKeeps) * clamp((facts.backMs - soon) / (late - soon), 0, 1);
      }
      let value = clamp(speed * reach * home, QUALITY.least, QUALITY.most);
      if (touch) value = Math.min(value, QUALITY.push - 0.05);
      return { value, touch, speed, reach, home };
    },
    /** A punch was thrown: its speed joins what this hand's best is taken from. */
    learn(hand: Hand, speed: number) {
      if (!(speed > 0) || !Number.isFinite(speed)) return;
      const list = speeds[hand];
      list.push(speed);
      if (list.length > QUALITY.bestOf) list.shift();
    },
    reset() {
      speeds.left = [];
      speeds.right = [];
    },
  };
}
export type QualityMeter = ReturnType<typeof createQuality>;
