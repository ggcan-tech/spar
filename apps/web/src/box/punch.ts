import { BODY, JOINT, type ArmLengths } from "../pov/body";
import type { Vec3 } from "../pov/physics";

/**
 * Reading punches from one camera.
 *
 * Each fist is followed relative to its own shoulder, so a slip, a duck or a
 * step is not a punch, and is measured from where it last rested in the guard.
 *
 * A fist thrown at the screen travels about a third of a metre. How that shows
 * depends on where the camera is. Seen from in front it hardly moves across
 * the picture: the arm looks shorter and the model's depth for the wrist
 * changes. Seen from a laptop on a desk, tipped up at the player, the same
 * punch rises a hand's length in the picture and the arm does not look
 * shorter at all. So the distance travelled is put together from all three:
 * movement across the picture, and the larger of the model's depth and what
 * the arm's shortening implies. A punch must show in at least two of them,
 * which is what keeps one bad landmark from being a punch.
 *
 * Hooks and uppercuts are read from movement across the picture alone.
 *
 * A punch is read in two steps. The start of its drive sends the glove out and
 * is heard; the next pose confirms it, and only then is it judged and paid
 * for. A fist is out in about a fifth of a second and the camera is already a
 * tenth behind, so waiting for full extension would land the hit after the arm
 * had come back; a single pose's evidence is not enough to charge for.
 *
 * Nothing here counts poses. Speeds are slopes over a fixed stretch of time,
 * "a moment ago" is a time, and a start is confirmed by a pose a set time
 * later, so a camera giving 24, 30 or 60 pictures a second is read the same
 * way. And nothing trusts the landmarks more than they deserve: each hand's
 * own jitter is measured whenever it is still, and no threshold is ever
 * smaller than a few times that. On a clean camera the numbers below apply
 * as written; on a noisy one a punch is simply called a little later.
 *
 * Every number here is a starting value from scripted punches seen from six
 * camera positions, not from people.
 */
export type Hand = "left" | "right";
export type PunchShape = "straight" | "hook" | "uppercut";
export interface Punch {
  hand: Hand;
  shape: PunchShape;
  target: "head" | "body";
  /** 0.85 to 1.15: how sharply it was thrown. Kept narrow: nothing stops a fist thrown at air. */
  power: number;
  /** Pose time at which it was confirmed, ms. */
  t: number;
}
/** The start of a punch, before it is confirmed: enough to send the glove out. */
export interface PunchStart {
  hand: Hand;
  shape: PunchShape;
  target: "head" | "body";
  t: number;
}
export const PUNCH = {
  /** A fist this far below its shoulder, or higher, is up; one hanging by the hip is not. */
  armedAbove: -0.38,
  /** A fist is at rest when it has moved slower than this across the picture for `restMs`. */
  restSpeed: 0.8,
  restMs: 90,
  /** A resting place is good for this long after the fist leaves it. */
  restFor: 1500,
  /** How far a fist has travelled from rest to start a straight punch, and how fast. */
  straight: { travel: 0.1, speed: 1.0 },
  /** Rise from the lowest point in the last quarter second, and speed, that start a hook or an uppercut. */
  hook: { travel: 0.17, speed: 1.6 },
  uppercut: { travel: 0.22, speed: 2.2 },
  /** What the arm's shortening is worth as distance toward the camera. */
  shortening: 2.2,
  /** What counts as showing in each of the three cues. */
  cue: { across: 0.04, shortening: 0.06, depth: 0.07 },
  /** Depth alone is believed only when it is this large and lasts. */
  depthAlone: 0.2,
  /** A hook is mostly sideways: this share of its travel. */
  hookShare: 0.55,
  /** An uppercut dips at least this far below the guard, never below this, and ends above the guard. */
  dip: 0.07,
  dipFloor: -0.3,
  /** A fist that ends this far below where this player's head punches end is going to the body. */
  bodyBelow: 0.15,
  /** A confirmation must come within this long of the start. */
  confirmMs: 130,
  /** After a punch the hand can punch again once it has come a quarter of the way back… */
  rearm: 0.25,
  /** …or after this long whatever it did. */
  maxOutMs: 420,
  /** A gap in the hand's poses longer than this starts it over. */
  maxGapMs: 200,
  /** Both hands going the same way within this long is the guard moving, not a punch. */
  togetherMs: 80,
  /** The same punch again from the same hand needs this long. */
  sameHandMs: 120,
  /** Speeds are slopes over this stretch of time, whatever the camera's rate. */
  speedMs: 90,
  /** "A moment ago", for "is it still going": one pose at 30 a second. */
  stepMs: 33,
  /** A start is confirmed by a pose at least this long after it; when only the model's depth showed, this long. */
  confirmAfterMs: 25,
  confirmAloneMs: 58,
  /** No threshold is smaller than this many times the hand's own measured jitter… */
  noiseTimes: 4,
  /** …except the three cues of a straight, two of which must agree: each needs only this many times its own. */
  cueTimes: 2.5,
  /** Both hands moving the same way at least this fast is the guard moving; never less than this many times the jitter's speed. */
  guardSpeed: 0.5,
  guardNoiseTimes: 2.5,
  /** Jitter is taken from the last stretch of this long with the hand up. */
  noiseMs: 1500,
  /**
   * Restless hands. A fist that drifts a few centimetres about its guard
   * comes to rest in a different place each time; how far apart those places
   * were over the last `strayMs` is how far this hand strays. A straight punch
   * must go `strayTimes` that far, though never more than `strayMost` is
   * asked (about half a straight's whole travel): a punch is told from the
   * hand's own wandering by going clearly further than it ever wanders.
   */
  strayMs: 1500,
  strayTimes: 1.25,
  strayMost: 0.2,
};
export type PunchTuning = typeof PUNCH;
/** One fist relative to its own shoulder. */
export interface ArmSample {
  /** Toward the body's middle, across the picture. */
  in: number;
  /** Up the picture. */
  up: number;
  /** The model's depth for the wrist, toward the camera, relative to the shoulders. */
  depth: number;
  /** How much shorter than its true length the arm looks. */
  short: number;
}
/** What the punch reader needs from the tracker's result. */
export interface ArmSource {
  joints?: readonly Vec3[];
  jointWeights?: readonly number[];
  leftHand: Vec3;
  rightHand: Vec3;
  leftHandTracked?: boolean;
  rightHandTracked?: boolean;
}

/** Where a fist is, from the tracker's result, or null when that arm is not seen. */
export function armSample(
  source: ArmSource,
  hand: Hand,
  arms?: ArmLengths | null,
): ArmSample | null {
  const { joints, jointWeights: weights } = source;
  if (!joints || !weights) return null;
  const i = hand === "left" ? 0 : 1;
  const s = joints[JOINT.L_SHOULDER + i],
    e = joints[JOINT.L_ELBOW + i],
    w = joints[JOINT.L_WRIST + i];
  if (
    !(
      weights[JOINT.L_SHOULDER + i] >= 0.6 &&
      weights[JOINT.L_ELBOW + i] >= 0.6 &&
      weights[JOINT.L_WRIST + i] >= 0.6
    ) ||
    (hand === "left" ? source.leftHandTracked : source.rightHandTracked) ===
      false
  )
    return null;
  const across = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y);
  const full =
    (arms?.upperArm ?? BODY.upperArm) + (arms?.foreArm ?? BODY.foreArm);
  // Against the shoulders, not the hips: a lean forward is not a punch.
  const shoulders =
    (joints[JOINT.L_SHOULDER].z + joints[JOINT.R_SHOULDER].z) / 2;
  // The player's left shoulder is at -x, so inward for the left hand is +x.
  const side = hand === "left" ? 1 : -1;
  return {
    in: side * (w.x - s.x),
    up: w.y - s.y,
    depth: (hand === "left" ? source.leftHand : source.rightHand).z - shoulders,
    // Signed: from below, an arm unfolding toward the screen looks longer.
    short: full - across(s, e) - across(e, w),
  };
}

type Timed = ArmSample & { t: number };
interface Reading {
  /** Distance travelled from rest, put together from all the cues. */
  travel: number;
  /** How many of the three cues show. */
  cues: number;
  /** Only the model's depth shows. */
  depthOnly: boolean;
  /** From rest. */
  d: ArmSample;
}
interface HandState {
  history: Timed[];
  upSince: number;
  /** Where the fist last rested, and when. */
  rest: Timed | null;
  /** The places it has come to rest in lately: how far apart they are is how far this hand strays in its guard. */
  places: Timed[];
  /** A punch has started and waits to be confirmed. */
  started: {
    at: number;
    shape: PunchShape;
    /** How many of a straight's cues showed at the start: as many must still show when it is confirmed. */
    cues: number;
    /** The quantity that started it, and its value then. */
    drive: number;
    /** How long after the start a pose may confirm it, ms. */
    needs: number;
    target: "head" | "body";
    speed: number;
  } | null;
  /** A punch is out: when, its driving quantity at the peak, and at the start. */
  out: { at: number; shape: PunchShape; peak: number; fell: number } | null;
  lastPunchAt: number;
  lastT: number;
  /** This pose's movement across the picture, for the other hand to compare with: how far from rest, which way, and the speed below which it may be jitter. */
  moving: { t: number; far: number; vin: number; vup: number; floor: number };
  /** Where this player's straight punches at the head end, up the picture from rest. */
  ends: number[];
  /** This hand's jitter while still, as variances of each thing that is read. */
  noise: { in: number; up: number; short: number; depth: number };
  /** The last squared second differences each variance is taken from, and when each was taken. */
  wobble: { t: number[]; in: number[]; up: number[]; short: number[]; depth: number[] };
}
const fresh = (): HandState => ({
  history: [],
  upSince: -1,
  rest: null,
  places: [],
  started: null,
  out: null,
  lastPunchAt: -Infinity,
  lastT: -Infinity,
  moving: { t: -Infinity, far: 0, vin: 0, vup: 0, floor: PUNCH.guardSpeed },
  ends: [],
  noise: { in: 0, up: 0, short: 0, depth: 0 },
  wobble: { t: [], in: [], up: [], short: [], depth: [] },
});
/** The value a quarter of the way up a list. */
const quarter = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
};
/** The least-squares slope of a value over some poses, per second. Over three evenly spaced poses it is the last minus the first over the time between. */
function slope(points: Timed[], pick: (p: Timed) => number): number {
  const n = points.length;
  if (n < 2) return 0;
  let mt = 0,
    mv = 0;
  for (const p of points) {
    mt += p.t;
    mv += pick(p);
  }
  mt /= n;
  mv /= n;
  let top = 0,
    bottom = 0;
  for (const p of points) {
    top += (p.t - mt) * (pick(p) - mv);
    bottom += (p.t - mt) ** 2;
  }
  return bottom > 0 ? (top / bottom) * 1000 : 0;
}
/** How much jitter in a value becomes jitter in its slope over these poses, per second. */
function slopeSpread(points: Timed[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mt = points.reduce((a, p) => a + p.t, 0) / n;
  const bottom = points.reduce((a, p) => a + ((p.t - mt) / 1000) ** 2, 0);
  return bottom > 0 ? 1 / Math.sqrt(bottom) : 0;
}
/** The pose, not the newest, whose age is nearest to `ms`. */
function ago(h: Timed[], ms: number): Timed | undefined {
  const t = h[h.length - 1].t;
  let best: Timed | undefined;
  for (let i = h.length - 2; i >= 0; i--) {
    if (!best || Math.abs(t - h[i].t - ms) < Math.abs(t - best.t - ms)) best = h[i];
    else break;
  }
  return best;
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

export function createPunchReader(tuning: Partial<PunchTuning> = {}) {
  const o = { ...PUNCH, ...tuning };
  const hands: Record<Hand, HandState> = { left: fresh(), right: fresh() };
  let lastT = -Infinity;
  /** When both hands last moved the same way at once: the guard going up, down or back. */
  let guardMovedAt = -Infinity;
  /** The last pose's wrists across the picture, to catch the model swapping them. */
  let wrists: { left: { x: number; y: number } | null; right: { x: number; y: number } | null } = {
    left: null,
    right: null,
  };
  /**
   * What a hand's jitter does to each cue: nothing under `gate` is believed.
   * All zero on a clean camera, where the plain numbers apply.
   */
  interface Gates {
    across: number;
    short: number;
    depth: number;
  }
  const gatesOf = (k: HandState): Gates => {
    // A place measured against a rest that is itself a middle of three poses.
    const f = o.cueTimes * 1.25;
    return {
      across: f * Math.hypot(Math.sqrt(k.noise.in), Math.sqrt(k.noise.up)),
      short: f * o.shortening * Math.sqrt(k.noise.short),
      depth: f * Math.sqrt(k.noise.depth),
    };
  };
  const reading = (now: ArmSample, rest: ArmSample, g: Gates): Reading => {
    const d = {
      in: now.in - rest.in,
      up: now.up - rest.up,
      depth: now.depth - rest.depth,
      short: now.short - rest.short,
    };
    const across = Math.hypot(d.in, d.up);
    const shortening = o.shortening * d.short;
    const shows = [
      across >= Math.max(o.cue.across, g.across),
      shortening >= Math.max(o.cue.shortening, g.short),
      d.depth >= Math.max(o.cue.depth, g.depth),
    ];
    return {
      travel: Math.hypot(across, Math.max(0, d.depth, shortening)),
      cues: shows.filter(Boolean).length,
      depthOnly: shows[2] && !shows[0] && !shows[1],
      d,
    };
  };
  /** Where a straight punch at the head ends for this player: the high end of what they have thrown. */
  const headEnd = (k: HandState, restUp: number) => {
    if (k.ends.length >= 3) {
      const sorted = [...k.ends].sort((a, b) => a - b);
      return sorted[Math.floor((sorted.length - 1) * 0.7)];
    }
    // Until this player has thrown a few: a guard that looks high means a
    // camera looking up from below, from where a level punch rises in the
    // picture; one that looks low means a camera above, from where it falls.
    return Math.max(-0.14, Math.min(0.24, 2.27 * restUp - 0.275));
  };

  function read(
    hand: Hand,
    sample: ArmSample | null,
    t: number,
    starts: PunchStart[],
    punches: Punch[],
  ) {
    const k = hands[hand];
    const other = hands[hand === "left" ? "right" : "left"];
    if (!sample) {
      // Unseen for a moment is skipped; unseen for longer starts over.
      if (t - k.lastT > o.maxGapMs) hands[hand] = { ...fresh(), ends: k.ends, noise: k.noise, wobble: k.wobble };
      return;
    }
    if (t - k.lastT > o.maxGapMs) Object.assign(k, { ...fresh(), ends: k.ends, noise: k.noise, wobble: k.wobble });
    k.lastT = t;
    k.history.push({ ...sample, t });
    k.history = k.history.filter((p) => t - p.t <= 450);
    const h = k.history;
    const last = h[h.length - 1];
    /** About one pose ago at 30 a second: "is it still going?" is asked against this. */
    const before = h.length >= 2 ? ago(h, o.stepMs) : undefined;
    /** The poses a speed is taken over: a fixed stretch of time, or the last two from a slow camera. */
    const within = h.filter((p) => t - p.t <= o.speedMs);
    const span = within.length >= 2 ? within : h.slice(-2);
    if (sample.up >= o.armedAbove) {
      if (k.upSince < 0) k.upSince = t;
    } else {
      k.upSince = -1;
      k.rest = null;
    }
    // This pose's movement across the picture, kept whatever state the hand
    // is in: the other hand compares itself with it.
    const vin = slope(span, (p) => p.in),
      vup = slope(span, (p) => p.up);
    const spread = slopeSpread(span);
    const sd = {
      in: Math.sqrt(k.noise.in),
      up: Math.sqrt(k.noise.up),
      short: Math.sqrt(k.noise.short),
      depth: Math.sqrt(k.noise.depth),
    };
    const jitter = Math.hypot(sd.in, sd.up);
    const gates = gatesOf(k);
    /** An uppercut's dip is up and down only. */
    const dipNeed = Math.max(o.dip, 3 * 1.25 * sd.up);
    const recent = h.filter((p) => t - p.t <= 250);
    const low = (axis: "in" | "up") =>
      Math.min(...recent.slice(0, -1).map((p) => p[axis]), last[axis]);
    const rise = { in: last.in - low("in"), up: last.up - low("up") };
    // Slower than this across the picture may be nothing but jitter.
    const floor = Math.max(o.guardSpeed, o.guardNoiseTimes * jitter * spread);
    k.moving = { t, far: 0, vin, vup, floor };
    // Quiet: slow across the picture for a moment, with the hand up. Judged
    // by how far any pose of that moment is from the newest, not by its two
    // ends: a fist that dips and comes back in a tenth of a second ends where
    // it began and has not been still.
    const slow = h.filter((p) => t - p.t <= o.restMs + 40);
    const wander = Math.max(...slow.map((p) => Math.hypot(last.in - p.in, last.up - p.up)));
    const quiet =
      k.upSince >= 0 &&
      t - k.upSince >= o.restMs &&
      slow.length >= 3 &&
      last.t - slow[0].t >= o.restMs - 35 &&
      // Jitter alone puts poses a few times its size apart.
      wander < o.restSpeed * (Math.max(1, last.t - slow[0].t) / 1000) + 3 * jitter;
    // The hand's jitter, measured whenever it is up and not punching. The
    // second difference of three poses is blind to a steady drift. Real
    // movement makes some of them large, so the size is taken from the
    // smallest quarter of the last second and a half: a hand may be moving
    // for most of that and still be measured truly.
    if (k.upSince >= 0 && !k.out && !k.started && h.length >= 3) {
      const b = h[h.length - 2],
        c = h[h.length - 3];
      const log = k.wobble;
      log.t.push(t);
      for (const axis of ["in", "up", "short", "depth"] as const) {
        const second = last[axis] - 2 * b[axis] + c[axis];
        log[axis].push(second * second);
      }
      while (log.t.length > 90 || t - log.t[0] > o.noiseMs) {
        log.t.shift();
        for (const axis of ["in", "up", "short", "depth"] as const) log[axis].shift();
      }
      // A quarter of a squared bell-shaped value's spread lies under 0.1015 of its mean;
      // a second difference has six times the variance.
      if (log.t.length >= 12)
        for (const axis of ["in", "up", "short", "depth"] as const)
          k.noise[axis] = quarter(log[axis]) / 0.1015 / 6;
    }
    // At rest: quiet, and neither getting shorter nor nearer. A punch at a
    // camera in front hardly moves across the picture.
    const resting =
      quiet &&
      Math.abs(last.short - slow[0].short) < Math.max(0.03, 3 * Math.SQRT2 * sd.short) &&
      Math.abs(last.depth - slow[0].depth) < Math.max(0.1, 3 * Math.SQRT2 * sd.depth);
    const rest = k.rest && t - k.rest.t <= o.restFor ? k.rest : null;
    const now = rest ? reading(last, rest, gates) : null;
    if (now) k.moving.far = Math.hypot(now.d.in, now.d.up);
    /**
     * Both hands going the same way across the picture at once is the guard
     * moving (up to cover, down to block, back from either), not a punch: a
     * punch is one hand. A hand that has just punched is on its way back and
     * does not count.
     */
    const together = () => {
      // For a quarter of a second after the guard has moved, a hand that is
      // still on its way, or settling, is not punching.
      if (t - guardMovedAt < 250) return true;
      const m = other.moving;
      if (t - m.t > o.togetherMs) return false;
      if (other.started !== null) return true;
      return false;
    };
    {
      // The hand that guards while the other punches is all but still, and a
      // hand coming back from a punch goes the other way. Each hand's speed
      // must clear its own jitter, or two noisy hands would look like a guard
      // on the move.
      const m = other.moving;
      const outLong = other.out !== null && t - other.out.at > o.togetherMs;
      if (
        t - m.t <= o.togetherMs &&
        !outLong &&
        !k.out &&
        Math.hypot(m.vin, m.vup) >= m.floor &&
        Math.hypot(vin, vup) >= floor &&
        m.vin * vin + m.vup * vup > 0
      )
        guardMovedAt = t;
    }

    if (k.out) {
      const drive =
        k.out.shape === "straight"
          ? (now?.travel ?? 0)
          : k.out.shape === "hook"
            ? last.in
            : last.up;
      if (drive > k.out.peak) {
        k.out.peak = drive;
        k.out.fell = 0;
      } else if (before) k.out.fell++;
      const base = k.out.shape === "straight" ? 0 : k.out.shape === "hook" ? (rest?.in ?? last.in) : (rest?.up ?? last.up);
      const back = k.out.peak - drive >= o.rearm * Math.max(0.05, k.out.peak - base);
      // The far end of a straight at the head teaches where this player's end.
      if (back || t - k.out.at >= o.maxOutMs) k.out = null;
      // Still on its way out: nothing else to decide for this hand.
      else return;
    }
    if (k.started) {
      const s = k.started;
      const drive =
        s.shape === "straight" ? (now?.travel ?? 0) : s.shape === "hook" ? rise.in : rise.up;
      if (t - s.at > o.confirmMs) k.started = null;
      else if (together()) {
        k.started = null;
        other.started = null;
      } else if (
        drive >= 0.5 * s.drive &&
        (s.shape !== "uppercut" || (now !== null && now.d.up >= dipNeed)) &&
        // Jitter that looked like a punch for one pose does not look like one for two.
        (s.shape !== "straight" || (now !== null && now.cues >= Math.min(2, s.cues)))
      ) {
        // Confirmed by a pose a set time after the start, however many came between.
        if (t - s.at >= s.needs) {
          // Decided now, where the fist has got to, not at the first instant.
          const target =
            s.shape !== "uppercut" &&
            now !== null &&
            now.d.up <= headEnd(k, rest?.up ?? last.up) - o.bodyBelow
              ? "body"
              : "head";
          if (s.shape === "straight" && now && target === "head") {
            k.ends.push(now.d.up);
            if (k.ends.length > 12) k.ends.shift();
          }
          punches.push({
            hand,
            shape: s.shape,
            target,
            power: Math.max(0.85, Math.min(1.15, 0.85 + (0.3 * (s.speed - 1.5)) / 2.5)),
            t,
          });
          k.out = { at: t, shape: s.shape, peak: s.shape === "straight" ? (now?.travel ?? 0) : s.shape === "hook" ? last.in : last.up, fell: 0 };
          k.lastPunchAt = t;
          k.started = null;
        }
      } else k.started = null;
      return;
    }
    if (resting && !k.out) {
      // The middle of the last few poses: one noisy pose does not move the rest.
      const r = slow.filter((p) => t - p.t <= 70);
      const some = r.length >= 3 ? r : slow.slice(-3);
      k.rest = {
        t,
        in: median(some.map((p) => p.in)),
        up: median(some.map((p) => p.up)),
        depth: median(some.map((p) => p.depth)),
        short: median(some.map((p) => p.short)),
      };
      // Not while the guard itself is being moved, nor on the way home from a punch: those are not wandering.
      if (t - guardMovedAt >= 400 && t - k.lastPunchAt >= 600) k.places.push(k.rest);
      while (k.places.length && (t - k.places[0].t > o.strayMs || k.places.length > 60)) k.places.shift();
      return;
    }
    if (!rest || !now || !before || h.length < 3) return;
    if (t - k.lastPunchAt < o.sameHandMs) return;
    // How far this hand has been straying in its guard: the spread of its resting places, less what jitter alone would spread them.
    let stray = 0;
    {
      const lately = k.places.filter((p) => t - p.t <= o.strayMs);
      if (lately.length >= 4) {
        const range = (axis: "in" | "up" | "short", sigma: number) => {
          let lo = Infinity,
            hi = -Infinity;
          for (const p of lately) {
            lo = Math.min(lo, p[axis]);
            hi = Math.max(hi, p[axis]);
          }
          return Math.max(0, hi - lo - 4 * sigma);
        };
        stray = Math.hypot(range("in", sd.in), range("up", sd.up), o.shortening * range("short", sd.short));
      }
    }
    const straightFrom = Math.min(Math.max(o.strayMost, o.straight.travel), Math.max(o.straight.travel, o.strayTimes * stray));
    // How fast the distance from rest is growing, over the same stretch of time.
    const travelled = new Map(span.map((p) => [p, reading(p, rest, gates).travel]));
    const speed = slope(span, (p) => travelled.get(p) ?? 0);
    const moving = now.travel - reading(before, rest, gates).travel > 0;
    // A value's own jitter, and what that is as a speed over this stretch.
    const noisy = (value: number, base: number) => Math.max(base, o.noiseTimes * value);
    let shape: PunchShape | null = null,
      drive = 0,
      needs = o.confirmAfterMs;
    // An uppercut came from the guard, dipped and is rising past it.
    const dipped = rest.up - low("up") >= dipNeed && low("up") >= o.dipFloor;
    if (
      rise.up >= noisy(Math.SQRT2 * sd.up, o.uppercut.travel) &&
      vup >= noisy(sd.up * spread, o.uppercut.speed) &&
      dipped &&
      now.d.up >= 0.02 &&
      last.up - before.up > 0
    ) {
      shape = "uppercut";
      drive = rise.up;
    } else if (
      rise.in >= noisy(Math.SQRT2 * sd.in, o.hook.travel) &&
      vin >= noisy(sd.in * spread, o.hook.speed) &&
      last.in - before.in > 0 &&
      now.d.in >= o.hookShare * now.travel
    ) {
      shape = "hook";
      drive = rise.in;
    } else if (
      now.travel >= straightFrom &&
      speed >= Math.max(o.straight.speed, 2 * jitter * spread) &&
      moving &&
      // Not mostly sideways (a hook swinging out, or coming across)…
      Math.abs(now.d.in) < 0.45 * now.travel &&
      // …and a real share of it toward the screen (an uppercut's dip is not).
      Math.max(now.d.depth, o.shortening * now.d.short) >= 0.3 * now.travel &&
      (now.cues >= 2 || (now.depthOnly && now.d.depth >= Math.max(o.depthAlone, 2 * gates.depth)))
    ) {
      shape = "straight";
      drive = now.travel;
      // Depth is the noisiest thing the model reports: on its own it must last.
      needs = now.cues >= 2 ? o.confirmAfterMs : o.confirmAloneMs;
    }
    if (!shape) return;
    if (together()) {
      // Neither hand punches for a moment.
      other.started = null;
      return;
    }
    const target =
      shape !== "uppercut" &&
      now.d.up <= headEnd(k, rest.up) - o.bodyBelow - 0.05
        ? "body"
        : "head";
    k.started = { at: t, shape, cues: now.cues, drive, needs, target, speed: Math.hypot(vin, vup, speed) };
    starts.push({ hand, shape, target, t });
  }
  return {
    /**
     * Call once for each new pose with the tracker's result and the pose's time
     * (the even clock when there is one). `starts` are punches that began on
     * this pose: send the glove. `punches` are ones confirmed on it: judge them.
     */
    update(
      source: ArmSource,
      t: number,
      arms?: ArmLengths | null,
    ): { starts: PunchStart[]; punches: Punch[] } {
      const starts: PunchStart[] = [],
        punches: Punch[] = [];
      if (!(t > lastT)) return { starts, punches };
      lastT = t;
      let left = armSample(source, "left", arms),
        right = armSample(source, "right", arms);
      // The model sometimes swaps the wrists, or puts both on one fist, for a
      // pose or two; in the guard they are a hand's width apart. Such a pose
      // is not evidence of anything.
      const j = source.joints;
      const at = (i: number) => (j ? { x: j[JOINT.L_WRIST + i].x, y: j[JOINT.L_WRIST + i].y } : null);
      const nowWrists = { left: left ? at(0) : null, right: right ? at(1) : null };
      const gap = (a: { x: number; y: number } | null, b: { x: number; y: number } | null) =>
        a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
      const swapped =
        gap(nowWrists.left, wrists.right) < 0.06 &&
        gap(nowWrists.right, wrists.left) < 0.06 &&
        gap(wrists.left, wrists.right) > 0.12;
      const merged =
        gap(nowWrists.left, nowWrists.right) < 0.05 &&
        gap(wrists.left, wrists.right) > 0.12;
      if (swapped || merged) left = right = null;
      else wrists = nowWrists;
      read("left", left, t, starts, punches);
      read("right", right, t, starts, punches);
      return { starts, punches };
    },
    /** A hand that is out punching, for [left, right]: it is not guarding. */
    busy: (t: number): [boolean, boolean] => [
      (hands.left.out !== null && t - hands.left.out.at < 260) || hands.left.started !== null,
      (hands.right.out !== null && t - hands.right.out.at < 260) || hands.right.started !== null,
    ],
    /**
     * Each hand's jitter across the picture while still, in game units (about
     * metres at the player), [left, right]. What every threshold is scaled by.
     */
    jitter: (): [number, number] => [
      Math.hypot(Math.sqrt(hands.left.noise.in), Math.sqrt(hands.left.noise.up)),
      Math.hypot(Math.sqrt(hands.right.noise.in), Math.sqrt(hands.right.noise.up)),
    ],
    reset() {
      hands.left = fresh();
      hands.right = fresh();
      lastT = -Infinity;
      guardMovedAt = -Infinity;
      wrists = { left: null, right: null };
    },
  };
}
