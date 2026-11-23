import { CLIP_TIMES, COMBO_GAPS, FOUND_TIMES, KIND_TIMES, STEP_TIMES } from "./times.generated";
import type { MotionKind } from "./types";

/**
 * Real punch times, for the rules. Every number comes from the recorded
 * clips the game plays (see `times.generated.ts`, written by
 * `node tools/anim/build.mjs`, and docs/production/evidence/real-clips.md).
 * Nothing here is tuned by hand: change the clips and these change.
 */

/** Seconds: first movement to the commit (the fist leaving), commit to contact, contact to the hand home. */
export interface PunchTime {
  load: number;
  strike: number;
  home: number;
}
const KINDS: MotionKind[] = ["jab", "cross", "hook", "uppercut", "body"];
const each = <T>(of: (kind: MotionKind) => T): Record<MotionKind, T> =>
  Object.fromEntries(KINDS.map((k) => [k, of(k)])) as Record<MotionKind, T>;

/** For each kind of punch: the mean of the takes kept of it. Played at these times the clips run at their own speed. */
export const PUNCH_TIMES: Record<MotionKind, PunchTime> = each((k) => ({
  load: KIND_TIMES[k].load,
  strike: KIND_TIMES[k].strike,
  home: KIND_TIMES[k].home,
}));

/**
 * The same in the shape `real/rules.ts` reads (`PunchTimes`): `commit` and
 * `impact` both counted from the first movement, `home` from contact.
 * `slower` stretches the load only, as far as the clips allow (1 to 1/0.6):
 * a beginner's punch takes longer to start, not longer to fly.
 */
export function rulesTimes(slower = 1): Record<MotionKind, { commit: number; impact: number; home: number }> {
  const k = Math.max(1, Math.min(1 / 0.6, slower));
  return each((kind) => {
    const t = PUNCH_TIMES[kind];
    return { commit: +(t.load * k).toFixed(3), impact: +(t.load * k + t.strike).toFixed(3), home: t.home };
  });
}

/**
 * What a designer needs to know about the tell, in milliseconds, for each
 * kind of punch:
 *  - `body`: the body is moving this long before the fist leaves (hips or
 *    shoulders turning the punch's way, or the hand drawing back);
 *  - `clear`: of that, how long it stands out from the boxer's own bounce
 *    (three times his usual movement in the guard). This is the part a
 *    player could read;
 *  - `flight`: the fist leaving to contact.
 * `kept` is the mean of the takes the game plays; `found` is the middle
 * value over every punch of that kind in the recordings, with how many.
 */
export const TELLS: Record<
  MotionKind,
  { kept: { body: number; clear: number; flight: number }; found: { count: number; body: number; clear: number; flight: number } }
> = each((k) => ({
  kept: {
    body: Math.round(KIND_TIMES[k].load * 1000),
    clear: Math.round(KIND_TIMES[k].seen * 1000),
    flight: Math.round(KIND_TIMES[k].strike * 1000),
  },
  found: {
    count: FOUND_TIMES[k].count,
    body: Math.round(FOUND_TIMES[k].load * 1000),
    clear: Math.round(FOUND_TIMES[k].seen * 1000),
    flight: Math.round(FOUND_TIMES[k].strike * 1000),
  },
}));

/** The least and most time from first movement to contact that each kind can be asked for without breaking the clip's limits (load 0.6 to 1.0, strike 0.9 to 1.1), seconds. */
export const PUNCH_SPAN: Record<MotionKind, { least: number; most: number }> = each((k) => {
  const t = PUNCH_TIMES[k];
  return { least: +(t.load + t.strike / 1.1).toFixed(3), most: +(t.load / 0.6 + t.strike / 0.9).toFixed(3) };
});

export { CLIP_TIMES, COMBO_GAPS, FOUND_TIMES, KIND_TIMES, STEP_TIMES };
