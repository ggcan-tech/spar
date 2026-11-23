import { clamp } from "./vec";

/**
 * Making contact fall on the time the rules chose.
 *
 * A recorded punch has its own times. The rules ask for others. The clip is
 * played a little slower or faster, part by part, so that the fist leaves
 * at the commit and lands at the impact:
 *  - the load (first movement to the fist leaving) at 0.6 to 1.0 of its
 *    speed: slower than 0.6 reads as slow motion;
 *  - the strike (the fist leaving to contact) at 0.9 to 1.1: a fist's flight
 *    cannot be stretched without showing.
 * Contact always lands on the impact. When the limits cannot give the rest,
 * the clip starts late (the guard goes on until then) or starts part-way
 * through its load. No frame is ever held: every rate is above zero.
 */
export const RATE_LIMITS = {
  load: [0.6, 1.0] as [number, number],
  strike: [0.9, 1.1] as [number, number],
  /** The hand coming home. Not in the study: a hand may hurry or dawdle a little more than a fist in flight. */
  home: [0.7, 1.3] as [number, number],
};
export type RateLimits = typeof RATE_LIMITS;

/** A punch's own times in its clip, seconds from the clip's first frame. */
export interface ClipTimes {
  first: number;
  launch: number;
  contact: number;
  guard: number;
  /** The clip's last frame. */
  end: number;
}
/** The times the rules want, on the fight's clock. */
export interface WantedTimes {
  start: number;
  commit: number;
  impact: number;
  home: number;
}
/** Fight time to clip time: straight lines between knots, always rising. */
export interface TimeMap {
  knots: { at: number; clip: number }[];
  /** The speed each part plays at, for tests and the viewer. */
  rates: { load: number; strike: number; home: number };
  /** Fight times: the clip begins, the fist leaves, it lands, the hand is home, the clip's last frame. */
  begins: number;
  launches: number;
  lands: number;
  homes: number;
  ends: number;
}

/**
 * The plan for one punch. `from` lets a plan be made again part-way through
 * (the rules moved the impact): it then runs on from where the clip is now.
 */
export function planPunch(
  clip: ClipTimes,
  want: WantedTimes,
  limits: RateLimits = RATE_LIMITS,
  from: { at: number; clip: number } | null = null,
): TimeMap {
  const strikeClip = clip.contact - clip.launch;
  const loadClip = clip.launch - clip.first;
  const knots: { at: number; clip: number }[] = [];
  const [slow, fast] = limits.strike;
  let strike: number;
  let load = 1;
  let launches: number;
  let lands = want.impact;
  if (from && from.clip >= clip.launch) {
    // Already in flight: only the rest of the strike can still be bent, and
    // only within its limits. If the rules moved the impact further than
    // that, the fist lands when it lands.
    const left = Math.max(0, clip.contact - from.clip);
    strike = clamp(left / Math.max(1e-3, want.impact - from.at), slow, fast);
    launches = from.at - (from.clip - clip.launch) / strike;
    lands = from.at + left / strike;
    knots.push({ at: from.at, clip: from.clip });
  } else {
    const startAt = from ? from.at : want.start;
    const startClip = from ? from.clip : clip.first;
    // The strike first: it ends on the impact whatever else happens.
    strike = clamp(strikeClip / Math.max(1e-3, want.impact - want.commit), slow, fast);
    launches = want.impact - strikeClip / strike;
    if (launches < startAt) {
      // No room for any load: the strike at its fastest buys a little.
      strike = fast;
      launches = want.impact - strikeClip / strike;
    }
    const room = launches - startAt;
    if (room < 0) {
      // Not even room for the strike: come in part-way through it.
      knots.push({ at: startAt, clip: Math.min(clip.contact - 1e-3, clip.contact - (want.impact - startAt) * strike) });
    } else {
      const loadLeft = clip.launch - startClip;
      load = clamp(loadLeft / Math.max(1e-6, room), limits.load[0], limits.load[1]);
      const needs = loadLeft / load;
      // Even at its slowest the load is over too soon: start late, and the
      // guard goes on until then. Or it does not fit: skip its beginning, and
      // the blend covers the join.
      if (needs <= room) knots.push({ at: launches - needs, clip: startClip });
      else knots.push({ at: startAt, clip: clip.launch - room * load });
      if (room > 0) knots.push({ at: launches, clip: clip.launch });
    }
  }
  knots.push({ at: lands, clip: clip.contact });
  // The hand comes home by the time the rules say, within what a hand can do.
  const homeClip = Math.max(0, clip.guard - clip.contact);
  const home = clamp(homeClip / Math.max(1e-3, want.home - lands), limits.home[0], limits.home[1]);
  const homeAt = lands + homeClip / home;
  if (homeClip > 0) knots.push({ at: homeAt, clip: clip.guard });
  // Whatever is left of the clip after that plays as recorded.
  const ends = homeAt + Math.max(0, clip.end - clip.guard);
  if (clip.end > clip.guard) knots.push({ at: ends, clip: clip.end });
  void loadClip;
  return { knots, rates: { load, strike, home }, begins: knots[0].at, launches, lands, homes: homeAt, ends };
}

/**
 * A feint: the punch is shown up to two frames before its launch, reaching
 * that at `pullAt`, and goes no further. The blend back to the guard does
 * the rest.
 */
export function planFeint(clip: ClipTimes, start: number, pullAt: number, frame: number, limits: RateLimits = RATE_LIMITS): TimeMap {
  const stop = Math.max(clip.first + frame, clip.launch - 2 * frame);
  const shown = stop - clip.first;
  const load = clamp(shown / Math.max(1e-3, pullAt - start), limits.load[0], limits.load[1]);
  const needs = shown / load;
  const room = pullAt - start;
  // As for a punch: start late rather than hold, or skip the beginning.
  const knots =
    needs <= room
      ? [
          { at: pullAt - needs, clip: clip.first },
          { at: pullAt, clip: stop },
        ]
      : [
          { at: start, clip: stop - room * load },
          { at: pullAt, clip: stop },
        ];
  return { knots, rates: { load, strike: 1, home: 1 }, begins: knots[0].at, launches: Infinity, lands: Infinity, homes: pullAt, ends: pullAt };
}

/** The same, but before the first knot the clip is run backwards from it at its own speed: what it "would have shown" a frame before it began, which a blend needs to know how fast the join is closing. */
export function clipTimeLoose(map: TimeMap, at: number): number {
  const first = map.knots[0];
  return at < first.at ? first.clip - (first.at - at) : clipTimeAt(map, at);
}

/** The clip's time at a fight time. Before the first knot the clip has not begun; after the last it has ended. */
export function clipTimeAt(map: TimeMap, at: number): number {
  const k = map.knots;
  if (at <= k[0].at) return k[0].clip;
  for (let i = 1; i < k.length; i++)
    if (at <= k[i].at) {
      const span = k[i].at - k[i - 1].at;
      return span <= 0 ? k[i].clip : k[i - 1].clip + ((k[i].clip - k[i - 1].clip) * (at - k[i - 1].at)) / span;
    }
  return k[k.length - 1].clip;
}
