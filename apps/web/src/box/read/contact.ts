import type { ArmLengths } from "../../pov/body";
import { armSample, type ArmSample, type ArmSource, type Hand, type Punch, type PunchShape, type PunchStart } from "../punch";
import { solveArm, zoneOf, type AimMarks, type AimSetup, type AimSource, type Level, type Point, type Third } from "./aim";
import { QUALITY, createQuality } from "./quality";

/**
 * The player's punch, judged at its start, with its contact scheduled ahead.
 *
 * The punch reader starts a punch on one pose and confirms it a moment later.
 * A fist is out in a fifth of a second and the camera is a tenth behind, so a
 * hit shown at the confirmation comes after the arm has ended. Here a punch
 * becomes an event at its start, with the time its fist will reach full
 * stretch: this player's usual time from the reader's start to the far point,
 * a running middle for each hand and shape. That time is on the one line (see
 * timeline.ts) and may lie a little ahead of now or behind it. If no
 * confirmation comes the punch is cancelled, and when the arm's real end is
 * seen the time is corrected and joins what the next one is scheduled by.
 *
 * No curve is fitted to the first poses. The study measured it: at the first
 * usable pose a fitted end time is 47 ms off, a learned constant 41 ms; with
 * 1.5 cm of noise the fit is 140 ms off and the constant 63.
 *
 * "Full stretch" is the first moment the fist is within a little of its far
 * point. The last centimetre of a reach takes long and hits nothing.
 *
 * What the game knows, and when:
 * - `start`: at the reader's start. The contact time is known; the zone and
 *   the quality are first readings. `trusted` says this player's starts have
 *   been keeping their word, so the punch may be charged at once.
 * - `confirm`: the reader confirmed it. Charge for it here if not before.
 * - `cancel`: no confirmation came, or the hand was lost. `feint` says a real
 *   hand went out alone and no punch followed: the opponent may have bitten.
 * - `end`: the arm's real end was seen. The time, the zone, the reach and the
 *   speed are measured now. `short` marks a flick that went less than far.
 * - `home`: the hand came back, or did not.
 *
 * Everything here was measured on the scripted person only.
 */
export const CONTACT = {
  /**
   * From the reader's start to full stretch, ms, until this player's own
   * punches say: the middles of scripted punches of 150–300 ms at 30 and 60
   * poses a second (contact.test.ts prints them).
   */
  toGo: { straight: 75, hook: 35, uppercut: 25 } as Record<PunchShape, number>,
  /** A hand and shape's own middle is used from this many punches; before, the shape's, then the number above. */
  learnFrom: 3,
  keep: 9,
  /** Never scheduled further ahead than this, nor learned from a time outside 0 to this. */
  mostMs: 260,
  /** Full stretch: within this share of the far point, or this much, whichever is more (game units). */
  nearShare: 0.04,
  nearLeast: 0.012,
  /**
   * The far point is behind us when the fist, averaged over `steadyMs`, has
   * come back by this share of its travel, or has gone no further for this
   * long. Averaged, because the model's depth jitters by centimetres and a
   * slow push would otherwise seem to end at every jitter.
   */
  endBack: 0.15,
  endAfterMs: 150,
  steadyMs: 80,
  /** Home: back to within this share of the way from rest to the far point. Not home after this long: it stayed out. */
  homeShare: 0.4,
  homeWithinMs: 700,
  /** A start not confirmed within this long is cancelled; the reader gives up at 130 ms. */
  confirmWithinMs: 150,
  /** A hand not seen for this long while its punch is in the air: the punch is cancelled. Any pause cancels a punch in flight. */
  unseenMs: 100,
  /** A fist is at rest when it has stayed within this of its place for this long. */
  restWithin: 0.035,
  restMs: 100,
  restFor: 1500,
  /** What the arm's shortening is worth as distance toward the camera: the reader's own number. */
  shortening: 2.2,
  /**
   * Speed is how far the fist went between two levels over the time between
   * them: from this share of its far point to where it is now, or to full
   * stretch once that is known. A slope over a few poses would be mostly the
   * jitter of the model's depth; two crossings far apart are not.
   */
  speedFrom: 0.3,
  /** How far a punch of each shape goes, in game units, until this hand's own punches say. */
  usualTravel: { straight: 0.36, hook: 0.45, uppercut: 0.45 } as Record<PunchShape, number>,
  /** A start is trusted without its confirmation when this share of the last so many starts were confirmed, and the hand jitters less than this (game units). */
  trustShare: 0.9,
  trustOf: 10,
  trustJitter: 0.012,
  /** A feint: the fist really went this far, did not drop or swing out by more than `feintAside` (that is a wind-up), and the other hand did not start within this long. */
  feintTravel: 0.08,
  feintAside: 0.05,
  togetherMs: 100,
  /** A straight that went less than this share of the hand's usual travel is a flick. */
  short: 0.6,
  /** A straight is this share of the way out when the reader starts it, until this player's own punches say. */
  shareAtStart: 0.57,
};
export interface ContactInput {
  /** This pose's time on the line, ms: when the camera took it. */
  t: number;
  /** The tracker's result for this pose. */
  tracking: ArmSource & Partial<AimSource>;
  arms?: ArmLengths | null;
  /** What the punch reader made of this pose. */
  starts: readonly PunchStart[];
  punches: readonly Punch[];
  /** The reader's `busy` after this pose: lets a dropped start be cancelled one pose later instead of at the time limit. */
  busy?: readonly [boolean, boolean];
  /** The reader's `jitter`, [left, right]. */
  jitter?: readonly [number, number];
  /** For zones in real distances: the aim set-up and the range now. Without it the reader's own head-or-body is used. */
  aim?: { setup: AimSetup; range: number; marks?: AimMarks } | null;
}
export interface Contact {
  id: number;
  hand: Hand;
  shape: PunchShape;
  level: Level;
  /** As the player sees the opponent. */
  third: Third;
  /** Where the fist goes, in the plane facing the opponent, from home, in arm lengths; null without an aim set-up. */
  point: Point | null;
  /** How well it was thrown, as far as is known: 1 is a good punch. Under 0.5 it scores nothing. */
  quality: number;
  /** A hand put out, not a punch. */
  touch: boolean;
  /** When the fist reaches full stretch, on the line, ms. Ahead of the pose or behind it. */
  at: number;
  /** The pose that showed this, on the line. */
  t: number;
}
export type ContactEvent =
  | ({ kind: "start"; trusted: boolean } & Contact)
  | ({ kind: "confirm" } & Contact)
  | ({ kind: "end"; reach: number | null; short: boolean } & Contact)
  | { kind: "cancel"; id: number; hand: Hand; shape: PunchShape; feint: boolean; why: "unconfirmed" | "unseen"; t: number }
  | { kind: "home"; id: number; hand: Hand; quality: number; touch: boolean; backMs: number | null; t: number };

type Rest = ArmSample & { t: number; point: Point | null; fwd: number };
interface Open {
  id: number;
  hand: Hand;
  shape: PunchShape;
  t0: number;
  at: number;
  rest: Rest;
  /** For a hook, how far out the fist swung before it came in; for an uppercut, how low it dipped. What their going is measured from. */
  base: number;
  confirmed: boolean;
  /** The far point so far: how far, when, and where the aim put the fist then. */
  peak: number;
  peakT: number;
  /** The furthest single pose, and the furthest the averaged fist has been, and when. */
  rawPeak: number;
  trailPeak: number;
  trailPeakT: number;
  farPoint: Point | null;
  farReach: number | null;
  farFwd: number | null;
  startFwd: number | null;
  /** How fast it went, as far as is known; 0 when it cannot be told yet. */
  speed: number;
  level: Level;
  third: Third;
  point: Point | null;
  /** The far point has been passed, and when full stretch was. */
  endAt: number | null;
  short: boolean;
  lastSeen: number;
  /** How far the fist has dropped below its rest, or swung out from it, at most. */
  aside: number;
}
interface HandTrack {
  log: { t: number; a: ArmSample }[];
  rest: Rest | null;
  open: Open | null;
  lastStartAt: number;
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const IX: Record<Hand, 0 | 1> = { left: 0, right: 1 };
const freshHand = (): HandTrack => ({ log: [], rest: null, open: null, lastStartAt: -Infinity });

export function createContactReader() {
  const quality = createQuality();
  const hands: Record<Hand, HandTrack> = { left: freshHand(), right: freshHand() };
  /** Times from start to full stretch, and far points, by hand and shape. */
  const toGo: Record<string, number[]> = {};
  const travels: Record<string, number[]> = {};
  /** How far out a straight was at its start, by hand. */
  const shareAt: Record<Hand, number[]> = { left: [], right: [] };
  /** Whether each of the last starts was confirmed. */
  const kept: boolean[] = [];
  let nextId = 1;
  let lastT = -Infinity;

  const travelOf = (a: ArmSample, rest: ArmSample) => {
    const across = Math.hypot(a.in - rest.in, a.up - rest.up);
    return Math.hypot(across, Math.max(0, a.depth - rest.depth, CONTACT.shortening * (a.short - rest.short)));
  };
  /**
   * How far a punch has gone. A straight: the fist's distance from where it
   * rested. A hook winds out and an uppercut dips before they go, so their
   * distance from rest falls before it rises; they are measured across the
   * picture from the wind's far point instead, as the reader reads them.
   */
  const driveOf = (o: Pick<Open, "shape" | "rest" | "base">, a: ArmSample) =>
    o.shape === "straight" ? travelOf(a, o.rest) : o.shape === "hook" ? a.in - o.base : a.up - o.base;
  /** Where the hand's rest lies on that scale. */
  const restLevel = (o: Pick<Open, "shape" | "rest" | "base">) =>
    o.shape === "straight" ? 0 : o.shape === "hook" ? o.rest.in - o.base : o.rest.up - o.base;
  /** This hand and shape's own middle of a list, then both hands', then nothing. */
  const own = (lists: Record<string, number[]>, hand: Hand, shape: PunchShape): number | null => {
    const mine = lists[`${hand} ${shape}`] ?? [];
    if (mine.length >= CONTACT.learnFrom) return median(mine);
    const both = [...mine, ...(lists[`${hand === "left" ? "right" : "left"} ${shape}`] ?? [])];
    return both.length >= CONTACT.learnFrom ? median(both) : null;
  };
  const usual = (hand: Hand, shape: PunchShape) => own(toGo, hand, shape) ?? CONTACT.toGo[shape];
  const remember = (lists: Record<string, number[]>, hand: Hand, shape: PunchShape, value: number) => {
    const list = (lists[`${hand} ${shape}`] ??= []);
    list.push(value);
    if (list.length > CONTACT.keep) list.shift();
  };
  const word = (wasKept: boolean) => {
    kept.push(wasKept);
    if (kept.length > CONTACT.trustOf) kept.shift();
  };
  const trusted = (jitter: number | undefined) =>
    kept.length >= CONTACT.trustOf &&
    kept.filter(Boolean).length / kept.length >= CONTACT.trustShare &&
    (jitter === undefined || jitter <= CONTACT.trustJitter);
  /**
   * How far the punch has gone at each pose of the log, as the middle of
   * three poses about it: one wild pose does not make a far point. The newest
   * pose has no pose after it and stands as it is.
   */
  const series = (k: HandTrack, o: Open): { t: number; v: number }[] => {
    const raw = k.log.map((p) => driveOf(o, p.a));
    return k.log.map((p, i) => ({
      t: p.t,
      v: i > 0 && i < raw.length - 1 ? [raw[i - 1], raw[i], raw[i + 1]].sort((x, y) => x - y)[1] : raw[i],
    }));
  };
  /**
   * When a series rose through `level` on its way to index `i`, between
   * poses: the first time after it was last well under that level. Jitter
   * that dips back under the level for a pose does not start the clock again.
   * Null if what is kept does not show it.
   */
  const roseThrough = (view: { t: number; v: number }[], i: number, level: number): number | null => {
    let j = i;
    while (j >= 0 && view[j].v >= 0.6 * level) j--;
    if (j < 0) return null;
    for (let n = j + 1; n <= i; n++)
      if (view[n].v >= level) {
        const a = view[n - 1],
          b = view[n];
        return a.t + ((level - a.v) / Math.max(1e-6, b.v - a.v)) * (b.t - a.t);
      }
    return null;
  };
  /**
   * How fast the fist went out, in game units a second: from the last time it
   * rose through `speedFrom` of its far point, to full stretch if that is
   * known, else to where it is now. 0 when it cannot be told yet.
   */
  const speedOf = (k: HandTrack, o: Open, t: number): number => {
    const view = series(k, o);
    const ended = o.endAt !== null;
    const far = ended ? o.peak : Math.max(o.peak, own(travels, o.hand, o.shape) ?? CONTACT.usualTravel[o.shape]);
    const low = CONTACT.speedFrom * far;
    const until = ended ? o.peakT : t;
    let i = view.length - 1;
    while (i >= 0 && view[i].t > until) i--;
    if (i < 0) return 0;
    const top = ended ? o.peak - Math.max(CONTACT.nearLeast, CONTACT.nearShare * o.peak) : view[i].v;
    const topT = ended ? o.endAt! : view[i].t;
    const lowT = roseThrough(view, i, low);
    if (lowT === null) return 0;
    const took = topT - lowT;
    // Too little of the way, or too short a time, says nothing yet.
    if (!(took >= 12) || top - low < 0.2 * far) return 0;
    return (top - low) / (took / 1000);
  };
  const rate = (o: Open, backMs: number | null = null) => {
    // Not told yet: taken for an ordinary punch, never for a touch.
    const speed = o.speed > 0 ? o.speed : 0.75 * quality.best(o.hand);
    const q = quality.rate({ hand: o.hand, shape: o.shape, speed, reach: o.endAt !== null ? o.farReach : null, backMs });
    // A flick that went less than far is a hand put out, however fast.
    return o.short ? { ...q, touch: true, value: Math.min(q.value, QUALITY.push - 0.05) } : q;
  };
  const contactOf = (o: Open, t: number): Contact => {
    const q = rate(o);
    return {
      id: o.id,
      hand: o.hand,
      shape: o.shape,
      level: o.level,
      third: o.third,
      point: o.point,
      quality: q.value,
      touch: q.touch,
      at: o.at,
      t,
    };
  };
  /** Head or body, and which third, for a fist at `point`. A hook lands on its own side; an uppercut comes up the middle. */
  const zone = (o: Open, point: Point | null, marks: AimMarks | undefined, fallback: Level) => {
    const z = point ? zoneOf(point, o.hand, marks) : null;
    o.level = o.shape === "uppercut" ? "head" : (z?.level ?? fallback);
    o.third = o.shape === "hook" ? o.hand : o.shape === "uppercut" ? "middle" : (z?.third ?? "middle");
    o.point = point;
  };
  const aimed = (input: ContactInput, hand: Hand, guard: boolean) =>
    input.aim && input.tracking.root
      ? solveArm(input.tracking as AimSource, hand, input.aim.setup, input.aim.range, { guard })
      : null;

  function begin(hand: Hand, start: { shape: PunchShape; target: Level }, input: ContactInput, out: ContactEvent[]) {
    const k = hands[hand];
    const t = input.t;
    const now = k.log.length && k.log[k.log.length - 1].t === t ? k.log[k.log.length - 1] : null;
    // Where the fist rested; if that was never seen, where it was a quarter of a second ago.
    const rest: Rest =
      k.rest && t - k.rest.t <= CONTACT.restFor
        ? k.rest
        : { ...(k.log.find((p) => t - p.t <= 250)?.a ?? { in: 0, up: 0, depth: 0, short: 0 }), t, point: null, fwd: 0 };
    // The wind before a hook or an uppercut: the furthest out, or the lowest, the fist was just before.
    const wind = k.log.filter((p) => t - p.t <= 300).map((p) => (start.shape === "hook" ? p.a.in : p.a.up));
    const frame = { shape: start.shape, rest, base: start.shape === "straight" || !wind.length ? 0 : Math.min(...wind) };
    const gone = now ? driveOf(frame, now.a) : 0;
    const o: Open = {
      id: nextId++,
      hand,
      shape: start.shape,
      t0: t,
      at: t + Math.min(CONTACT.mostMs, Math.max(0, usual(hand, start.shape))),
      rest,
      base: frame.base,
      confirmed: false,
      peak: gone,
      peakT: t,
      rawPeak: gone,
      trailPeak: 0,
      trailPeakT: t,
      farPoint: null,
      farReach: null,
      farFwd: null,
      startFwd: null,
      speed: 0,
      level: start.target,
      third: "middle",
      point: null,
      endAt: null,
      short: false,
      lastSeen: t,
      aside: now ? Math.max(rest.up - now.a.up, rest.in - now.a.in) : 0,
    };
    o.speed = speedOf(k, o, t);
    // Where it is going. A straight travels a straight line from the guard:
    // its place now, carried on by how far out a straight usually is at its start.
    let point: Point | null = null;
    const arm = aimed(input, hand, false);
    if (arm) {
      o.startFwd = arm.fwd;
      o.farPoint = arm.point;
      o.farReach = arm.stretch;
      o.farFwd = arm.fwd;
      point = arm.point;
      if (start.shape === "straight" && rest.point) {
        const list = shareAt[hand];
        const share = list.length >= CONTACT.learnFrom ? median(list) : CONTACT.shareAtStart;
        point = {
          x: rest.point.x + (arm.point.x - rest.point.x) / share,
          y: rest.point.y + (arm.point.y - rest.point.y) / share,
        };
      }
    }
    zone(o, point, input.aim?.marks, start.target);
    k.open = o;
    k.lastStartAt = t;
    out.push({ kind: "start", trusted: trusted(input.jitter?.[IX[hand]]), ...contactOf(o, t) });
  }
  function cancel(k: HandTrack, o: Open, why: "unconfirmed" | "unseen", input: ContactInput, out: ContactEvent[]) {
    const other = hands[o.hand === "left" ? "right" : "left"];
    const jitter = input.jitter?.[IX[o.hand]];
    // A feint is a real hand that went out alone, forward, and was seen doing it.
    const feint =
      why === "unconfirmed" &&
      !o.confirmed &&
      o.peak >= Math.max(CONTACT.feintTravel, 4 * (jitter ?? 0)) &&
      o.aside <= CONTACT.feintAside &&
      Math.abs(other.lastStartAt - o.t0) > CONTACT.togetherMs &&
      (jitter === undefined || jitter <= CONTACT.trustJitter);
    if (!o.confirmed) word(false);
    out.push({ kind: "cancel", id: o.id, hand: o.hand, shape: o.shape, feint, why, t: input.t });
    k.open = null;
  }
  /** The far point of a punch as the steadied series has it, and the first moment the fist was within a little of it, between poses. */
  function fullStretch(k: HandTrack, o: Open): number {
    const view = series(k, o);
    let at = -1;
    o.peak = 0;
    for (let i = 0; i < view.length; i++)
      if (view[i].t >= o.t0 && view[i].v > o.peak) {
        o.peak = view[i].v;
        o.peakT = view[i].t;
        at = i;
      }
    if (at < 0) return o.peakT;
    const need = o.peak - Math.max(CONTACT.nearLeast, CONTACT.nearShare * o.peak);
    // The first pose at that level after the reader's start, and the moment between it and the pose before.
    for (let i = 0; i <= at; i++) {
      const b = view[i];
      if (b.t < o.t0 || b.v < need) continue;
      const a = i > 0 ? view[i - 1] : null;
      if (!a || a.v >= need) return b.t;
      return Math.max(o.t0, a.t + ((need - a.v) / (b.v - a.v)) * (b.t - a.t));
    }
    return o.peakT;
  }
  /** The far point is behind: full stretch, the zone, the reach and the speed are measured, and learned from. */
  function end(k: HandTrack, o: Open, input: ContactInput, out: ContactEvent[]) {
    const t = input.t;
    o.endAt = fullStretch(k, o);
    const took = o.endAt - o.t0;
    if (took >= 0 && took <= CONTACT.mostMs) remember(toGo, o.hand, o.shape, took);
    const usualFar = own(travels, o.hand, o.shape);
    o.short = o.shape === "straight" && usualFar !== null && o.peak < CONTACT.short * usualFar;
    // A flick does not move what a punch of this hand usually travels.
    if (!o.short) remember(travels, o.hand, o.shape, o.peak);
    if (o.shape === "straight" && o.startFwd !== null && o.farFwd !== null && o.farFwd - o.rest.fwd > 0.15) {
      const share = (o.startFwd - o.rest.fwd) / (o.farFwd - o.rest.fwd);
      if (share > 0.25 && share < 0.98) {
        shareAt[o.hand].push(share);
        if (shareAt[o.hand].length > CONTACT.keep) shareAt[o.hand].shift();
      }
    }
    o.at = o.endAt;
    // Measured now, not forecast: where the fist was at its far point.
    if (o.farPoint) zone(o, o.farPoint, input.aim?.marks, o.level);
    const speed = speedOf(k, o, t);
    if (speed > 0) o.speed = speed;
    if (o.speed > 0) quality.learn(o.hand, o.speed);
    out.push({ kind: "end", reach: o.shape === "straight" ? o.farReach : null, short: o.short, ...contactOf(o, t) });
  }
  /** A punch that will not be followed any further: its end and its return are said as they stand. */
  function closeOut(k: HandTrack, o: Open, input: ContactInput, out: ContactEvent[]) {
    if (o.endAt === null) end(k, o, input, out);
    const q = rate(o, CONTACT.homeWithinMs + 200);
    out.push({ kind: "home", id: o.id, hand: o.hand, quality: q.value, touch: q.touch, backMs: null, t: input.t });
    k.open = null;
  }

  function follow(hand: Hand, input: ContactInput, out: ContactEvent[]) {
    const k = hands[hand];
    const t = input.t;
    const a = armSample(input.tracking, hand, input.arms);
    const o = k.open;
    if (!a) {
      if (o && t - o.lastSeen > CONTACT.unseenMs && o.endAt === null) cancel(k, o, "unseen", input, out);
      return;
    }
    k.log.push({ t, a });
    while (k.log.length > 2 && t - k.log[0].t > 900) k.log.shift();
    if (!o) {
      // At rest: the fist has stayed in one place for a moment, and no punch is open.
      const recent = k.log.filter((p) => t - p.t <= CONTACT.restMs + 20);
      const still =
        recent.length >= 3 &&
        t - recent[0].t >= CONTACT.restMs - 35 &&
        recent.every(
          (p) =>
            Math.hypot(p.a.in - a.in, p.a.up - a.up) < CONTACT.restWithin + 3 * (input.jitter?.[IX[hand]] ?? 0) &&
            Math.abs(p.a.short - a.short) < 0.04 &&
            Math.abs(p.a.depth - a.depth) < 0.12,
        );
      if (still) {
        // A resting hand is a guarding hand: its forearm stands up.
        const arm = aimed(input, hand, true);
        k.rest = {
          t,
          in: median(recent.map((p) => p.a.in)),
          up: median(recent.map((p) => p.a.up)),
          depth: median(recent.map((p) => p.a.depth)),
          short: median(recent.map((p) => p.a.short)),
          point: arm?.point ?? null,
          fwd: arm?.fwd ?? 0,
        };
      }
      return;
    }
    o.lastSeen = t;
    o.aside = Math.max(o.aside, o.rest.up - a.up, o.rest.in - a.in);
    const travel = driveOf(o, a);
    if (o.endAt === null) {
      if (travel > o.rawPeak) {
        // Where the aim puts the fist at the furthest pose so far.
        o.rawPeak = travel;
        const arm = aimed(input, hand, false);
        if (arm) {
          o.farPoint = arm.point;
          o.farReach = arm.stretch;
          o.farFwd = arm.fwd;
        }
      }
      if (travel > o.peak) {
        o.peak = travel;
        o.peakT = t;
      }
      const speed = speedOf(k, o, t);
      if (speed > 0) o.speed = speed;
      // The fist averaged over a moment: has it turned back, or stopped going out?
      const recent = k.log.filter((p) => t - p.t <= CONTACT.steadyMs && p.t >= o.t0);
      const trail = recent.reduce((sum, p) => sum + driveOf(o, p.a), 0) / Math.max(1, recent.length);
      if (trail > o.trailPeak) {
        o.trailPeak = trail;
        o.trailPeakT = t;
      }
      const passed =
        t - o.trailPeakT >= CONTACT.endAfterMs || trail <= o.trailPeak - Math.max(0.03, CONTACT.endBack * o.trailPeak);
      // The end is only called on a punch the reader has confirmed.
      if (passed && o.confirmed) end(k, o, input, out);
      return;
    }
    // After the end: is the hand home?
    const home = restLevel(o);
    const back = travel <= home + CONTACT.homeShare * (o.peak - home);
    if (back || t - o.endAt > CONTACT.homeWithinMs) {
      const backMs = back ? Math.max(0, t - o.endAt) : null;
      // A hand that stayed out is rated as the slowest return.
      const q = rate(o, backMs ?? CONTACT.homeWithinMs + 200);
      out.push({ kind: "home", id: o.id, hand, quality: q.value, touch: q.touch, backMs, t });
      k.open = null;
    }
  }

  return {
    /**
     * Call once for each pose, where poses arrive, right after the punch
     * reader, with what the reader made of the same pose. Returns what
     * happened on this pose, in order.
     */
    update(input: ContactInput): ContactEvent[] {
      const out: ContactEvent[] = [];
      const t = input.t;
      if (!(t > lastT)) return out;
      lastT = t;
      for (const hand of ["left", "right"] as const) {
        const k = hands[hand];
        const start = input.starts.find((s) => s.hand === hand);
        const punch = input.punches.find((p) => p.hand === hand);
        // A new start on a hand whose last punch never came home: that one is closed as it stands.
        if (start && k.open) {
          if (!k.open.confirmed) cancel(k, k.open, "unconfirmed", input, out);
          else closeOut(k, k.open, input, out);
        }
        // The arm is followed first, so that a start sees this pose in the log.
        follow(hand, input, out);
        if (start) begin(hand, start, input, out);
        if (punch) {
          // Confirmed. With no start seen (a reset between the two), it begins and is confirmed at once.
          if (k.open && k.open.confirmed) closeOut(k, k.open, input, out);
          if (!k.open) begin(hand, { shape: punch.shape, target: punch.target }, input, out);
          const c = k.open!;
          c.confirmed = true;
          word(true);
          // Without real distances the reader's own later look at head or body is the better one.
          if (!c.point) c.level = c.shape === "uppercut" ? "head" : punch.target;
          out.push({ kind: "confirm", ...contactOf(c, t) });
        } else if (k.open && !k.open.confirmed && !start) {
          // The reader let it go: it is no longer busy with this hand and confirmed nothing.
          const dropped = input.busy ? !input.busy[IX[hand]] : false;
          if (dropped || t - k.open.t0 > CONTACT.confirmWithinMs) cancel(k, k.open, "unconfirmed", input, out);
        }
      }
      return out;
    },
    /** What has been learned so far, for the camera check and for tests. */
    learned() {
      const each = (hand: Hand) => ({
        straight: usual(hand, "straight"),
        hook: usual(hand, "hook"),
        uppercut: usual(hand, "uppercut"),
      });
      return {
        /** From the reader's start to full stretch, ms. */
        toGo: { left: each("left"), right: each("right") },
        /** The share of the last starts that were confirmed; null before any. */
        confirmed: kept.length ? kept.filter(Boolean).length / kept.length : null,
        /** Each hand's own best speed, game units a second. */
        best: { left: quality.best("left"), right: quality.best("right") },
      };
    },
    /** Hands with a punch in the air (started and not yet at its far point), [left, right]. */
    flying: (): [boolean, boolean] => [
      hands.left.open !== null && hands.left.open.endAt === null,
      hands.right.open !== null && hands.right.open.endAt === null,
    ],
    /** Forget the arms' places (a pause, a new round). What was learned of this player is kept. */
    reset() {
      hands.left = freshHand();
      hands.right = freshHand();
      lastT = -Infinity;
    },
  };
}
export type ContactReader = ReturnType<typeof createContactReader>;
