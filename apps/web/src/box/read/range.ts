import type { Landmark } from "@spar/protocol";

/**
 * One coarse range.
 *
 * How far the player stands is read from how large the body looks. No single
 * measure can be trusted: the shoulders look narrow in a turn (a 30° turn
 * read as a step back of 27–39 cm), the torso looks short in a crouch or a
 * lean, the head is small and noisy. Each of them only ever looks too small,
 * never too large, so the largest of the three is the body's size. It is not
 * capped, and it is smoothed over about 80 ms.
 *
 * What this can carry is one rule with two answers, in reach or out, with a
 * dead band of 15 cm and 150 ms of hold. It cannot say a punch fell 5 cm
 * short. A step back and a lean back look the same from the front and are one
 * defence: pulled back.
 *
 * A second answer says the player has come too near the screen, measured
 * against a home distance fixed at set-up. Home follows a player who settles
 * further back. It never moves nearer by itself, or the player could creep
 * up on the screen and out of the camera's view.
 *
 * Measured on the scripted person (range.test.ts): a step back of 20 cm reads
 * 1–4 cm short, a 30° turn of the shoulders reads as nothing, a crouch reads
 * 6–10 cm nearer. A step back is followed more slowly than a step in: the
 * largest measure is the last to shrink, and the head's is the slow one.
 */
export const RANGE = {
  /** Shoulders and torso are each smoothed over this long before the largest is taken, ms. */
  eachMs: 45,
  /** The head is small in the picture and noisy: smoothed over this long, and trusted a little less. */
  headMs: 200,
  headLess: 0.02,
  /** The distance itself is smoothed over this long again: about 80 ms in all. */
  rangeMs: 45,
  /** Pulled back: this much further than home, in game units (15 cm). Forward again: under this. */
  back: 0.16,
  backOff: 0.08,
  /** Too near the screen: this much nearer than home (30 cm), for this long. Back again: within this. Nothing here is in a hurry. */
  near: 0.32,
  nearOff: 0.22,
  nearAfterMs: 350,
  /** An answer, once given, stands for this long. */
  holdMs: 150,
  /** Home is the middle of this long at set-up. */
  homeMs: 600,
  /** Standing further back than home by `backOff` for this long: home follows, at this many units a second. */
  settleMs: 4000,
  settleRate: 0.06,
  /** A landmark seen less surely than this is not measured. */
  seen: 0.5,
  /** The tangent of half the lens's angle from top to bottom, when the camera does not say. Webcams run 0.36–0.47. */
  lensTan: 0.42,
};
export interface RangeReading {
  /** False until home has been taken. */
  ready: boolean;
  /** The shoulders' distance from the camera in game units (shoulders 0.4 wide), by the lens angle assumed. */
  units: number;
  /** Further than home (+) or nearer (-), in game units: about metres. Rough: ±3 cm at best. */
  away: number;
  /** Pulled back: a step or a lean of more than 15 cm. */
  back: boolean;
  /** Too near the screen. */
  near: boolean;
  /** The shoulders were not seen: the last reading is held. */
  held: boolean;
}
interface Sizes {
  shoulders: number | null;
  torso: number | null;
  head: number | null;
}
/** How large the body looks, in picture heights: shoulder to shoulder, shoulders to hips, ear to ear. */
export function bodySizes(lm: readonly Landmark[], imageAspect = 9 / 16): Sizes {
  const wide = 1 / (imageAspect || 9 / 16);
  const ok = (i: number) => {
    const p = lm[i];
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.v >= RANGE.seen;
  };
  const d = (a: number, b: number) => Math.hypot((lm[a].x - lm[b].x) * wide, lm[a].y - lm[b].y);
  const shoulders = ok(11) && ok(12) ? d(11, 12) : null;
  let torso: number | null = null;
  if (shoulders !== null && ok(23) && ok(24)) {
    const sx = (lm[11].x + lm[12].x) / 2,
      sy = (lm[11].y + lm[12].y) / 2,
      hx = (lm[23].x + lm[24].x) / 2,
      hy = (lm[23].y + lm[24].y) / 2;
    torso = Math.hypot((sx - hx) * wide, sy - hy);
  }
  return { shoulders, torso, head: ok(7) && ok(8) ? d(7, 8) : null };
}

export function createRangeReader(options: { lensTan?: number } = {}) {
  const lensTan = options.lensTan ?? RANGE.lensTan;
  type Key = keyof Sizes;
  const keys: Key[] = ["shoulders", "torso", "head"];
  /** Each measure, smoothed. */
  let smooth: Record<Key, number | null> = { shoulders: null, torso: null, head: null };
  /** What each measured at home. */
  let base: Record<Key, number | null> = { shoulders: null, torso: null, head: null };
  let homing: { from: number; sums: Record<Key, number>; counts: Record<Key, number> } | null = null;
  let lastT = -Infinity;
  /** The distance at set-up, where the sizes were taken, and home, which may move back from it. */
  let first = 0,
    home = 0,
    range = 0;
  let back = false,
    near = false,
    backAt = -Infinity,
    nearAt = -Infinity,
    furtherSince = -1,
    nearSince = -1;
  let reading: RangeReading = { ready: false, units: 0, away: 0, back: false, near: false, held: true };
  const startHome = (t: number) => {
    homing = {
      from: t,
      sums: { shoulders: 0, torso: 0, head: 0 },
      counts: { shoulders: 0, torso: 0, head: 0 },
    };
  };
  return {
    /**
     * Take home again from the next `homeMs` of poses: at set-up, and in the
     * corner between rounds if the player has moved. The player should be
     * standing square in their stance.
     */
    rehome() {
      homing = null;
      base = { shoulders: null, torso: null, head: null };
      first = home = range = 0;
      back = near = false;
      backAt = nearAt = -Infinity;
      furtherSince = nearSince = -1;
      reading = { ready: false, units: 0, away: 0, back: false, near: false, held: true };
    },
    /** Call once for each pose with the camera's landmarks and the pose's time, ms. */
    update(frame: { lm: readonly Landmark[]; imageAspect?: number }, t: number): RangeReading {
      if (!(t > lastT)) return reading;
      const dt = Number.isFinite(lastT) ? Math.min(250, t - lastT) : 0;
      const gap = t - lastT > 250;
      lastT = t;
      const now = bodySizes(frame.lm, frame.imageAspect);
      if (now.shoulders === null) {
        reading = { ...reading, held: true };
        return reading;
      }
      for (const k of keys) {
        const v = now[k];
        if (v === null) continue;
        const old = smooth[k];
        const tau = k === "head" ? RANGE.headMs : RANGE.eachMs;
        smooth[k] = old === null || gap ? v : old + (v - old) * (1 - Math.exp(-dt / tau));
      }
      if (base.shoulders === null) {
        // Taking home: the mean of each measure over a moment.
        if (!homing) startHome(t);
        const h = homing!;
        for (const k of keys) {
          const v = now[k];
          if (v !== null) {
            h.sums[k] += v;
            h.counts[k]++;
          }
        }
        if (t - h.from < RANGE.homeMs || h.counts.shoulders < 6) return reading;
        for (const k of keys) base[k] = h.counts[k] >= 6 ? h.sums[k] / h.counts[k] : null;
        homing = null;
        first = home = range = 0.4 / (base.shoulders! * 2 * lensTan);
        for (const k of keys) if (base[k] !== null) smooth[k] = base[k];
      }
      // The body's size against home: the largest of the three, each of which can only look too small.
      let size = smooth.shoulders! / base.shoulders!;
      if (base.torso !== null && now.torso !== null && smooth.torso !== null)
        size = Math.max(size, smooth.torso / base.torso);
      if (base.head !== null && now.head !== null && smooth.head !== null)
        size = Math.max(size, smooth.head / base.head - RANGE.headLess);
      const raw = first / size;
      range = gap ? raw : range + (raw - range) * (1 - Math.exp(-dt / RANGE.rangeMs));
      // Home follows a player who has settled further back, slowly. Never nearer.
      if (range - home > RANGE.backOff) {
        if (furtherSince < 0) furtherSince = t;
        // Until the player is no longer "pulled back" from it, and a little past.
        if (t - furtherSince > RANGE.settleMs)
          home = Math.min(range - 0.75 * RANGE.backOff, home + (RANGE.settleRate * dt) / 1000);
      } else furtherSince = -1;
      const away = range - home;
      if (t - backAt >= RANGE.holdMs) {
        const next = back ? away > RANGE.backOff : away >= RANGE.back;
        if (next !== back) {
          back = next;
          backAt = t;
        }
      }
      // Too near must last: one noisy reading does not bring the referee.
      if (away <= -RANGE.near) {
        if (nearSince < 0) nearSince = t;
      } else nearSince = -1;
      if (t - nearAt >= RANGE.holdMs) {
        const next = near ? away < -RANGE.nearOff : nearSince >= 0 && t - nearSince >= RANGE.nearAfterMs;
        if (next !== near) {
          near = next;
          nearAt = t;
        }
      }
      reading = { ready: true, units: range, away, back, near, held: false };
      return reading;
    },
    /** Home as it stands, in game units; 0 before set-up. */
    home: () => home,
  };
}
export type RangeReader = ReturnType<typeof createRangeReader>;
