import type { Vec3 } from "../../pov/physics";

/**
 * One clock, and the delay hidden.
 *
 * There were four clocks: the page's, the even pose clock, the rules' and the
 * sound's. Here there is one line: the page's clock, and a thing's time on it
 * is when it happened in the room. A pose's time is when the camera took it,
 * not when the page got it. A punch's contact is a time on the same line, and
 * may lie a little ahead of now or behind it. A sound for a moment on the line
 * is started early by the sound's own delay.
 *
 * The delay is not removed, only allowed for, and all of it:
 *
 * - The game knows the room `behindMs` late (camera, model, and one pose more
 *   so that a reading falls between two measured poses). So at page time
 *   `now` the rules judge the moment `now - behindMs`.
 * - What is drawn now is seen `leadMs - behindMs` later (the screen). For the
 *   player to have seen, at a moment, what the rules judge at that moment,
 *   the opponent is drawn `leadMs` ahead of the judged moment: the whole
 *   measured delay of this device, however long. Its moves are therefore
 *   planned that far ahead, and it cannot react inside that window.
 *
 * Nothing here predicts. Asked for a time newer than the newest pose, it says
 * where the player was at the newest pose and how stale that is. The study
 * measured why: 100 ms ahead a head is 11–19 cm from where any predictor puts
 * it (on a scripted person).
 */
export interface LineDelay {
  /** From the room to the page's own stamp on a pose: the camera. */
  cameraMs: number;
  /** From the room to a reading the rules can use. */
  behindMs: number;
  /** How far ahead of the judged moment the opponent is drawn. Never capped. */
  leadMs: number;
}
export const NO_DELAY: LineDelay = { cameraMs: 0, behindMs: 0, leadMs: 0 };

/** What the timeline keeps of one pose: the tracker's result, as it stood. */
export interface PoseLike {
  valid: boolean;
  head: Vec3;
  root: Vec3;
  leftHand: Vec3;
  rightHand: Vec3;
  leftHandTracked?: boolean;
  rightHandTracked?: boolean;
  joints?: readonly Vec3[];
  jointWeights?: readonly number[];
  /** A pose the tracker is holding over a dropout is not a measurement. */
  held?: boolean;
}
export interface Reading {
  /** The time asked for. */
  t: number;
  /** A measured, followed body stands behind this reading. */
  valid: boolean;
  head: Vec3;
  root: Vec3;
  leftHand: Vec3;
  rightHand: Vec3;
  /** Each hand was seen in the poses used, [left, right]. */
  hands: [boolean, boolean];
  joints: Vec3[] | null;
  jointWeights: number[] | null;
  /** True: worked out between two measured poses. False: the nearest pose, as it was. */
  between: boolean;
  /** How far the time asked for lies from the pose used, ms. 0 when between two poses. */
  staleMs: number;
}
interface Kept {
  t: number;
  pose: PoseLike;
}
const mix = (a: Vec3, b: Vec3, k: number): Vec3 => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
  z: a.z + (b.z - a.z) * k,
});
const measured = (p: PoseLike) => p.valid && !p.held;

/**
 * A pose's time on the line: the camera's own capture time when the browser
 * reports one, otherwise the even pose clock less the camera's measured delay.
 */
export function lineTime(
  frame: { t: number; motionT?: number; capturedAt?: number },
  delay: Pick<LineDelay, "cameraMs">,
): number {
  if (typeof frame.capturedAt === "number" && Number.isFinite(frame.capturedAt) && frame.capturedAt <= frame.t)
    return frame.capturedAt;
  const even = typeof frame.motionT === "number" && Number.isFinite(frame.motionT) ? frame.motionT : frame.t;
  return even - delay.cameraMs;
}

export function createTimeline(options: { keepMs?: number; maxGapMs?: number; delay?: LineDelay } = {}) {
  const keepMs = options.keepMs ?? 1200;
  /** Two poses further apart than this are not joined: something was missed between them. */
  const maxGapMs = options.maxGapMs ?? 150;
  let delay: LineDelay = options.delay ?? NO_DELAY;
  let kept: Kept[] = [];
  const hold = (k: Kept, t: number): Reading => ({
    t,
    valid: measured(k.pose),
    head: { ...k.pose.head },
    root: { ...k.pose.root },
    leftHand: { ...k.pose.leftHand },
    rightHand: { ...k.pose.rightHand },
    hands: [k.pose.leftHandTracked !== false, k.pose.rightHandTracked !== false],
    joints: k.pose.joints ? k.pose.joints.map((p) => ({ ...p })) : null,
    jointWeights: k.pose.jointWeights ? [...k.pose.jointWeights] : null,
    between: false,
    staleMs: Math.abs(t - k.t),
  });
  /** Index of the last pose at or before `t`, or -1. */
  const before = (t: number) => {
    let lo = -1,
      hi = kept.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (kept[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const api = {
    /** The delay of this device, from delay.ts. May be set again whenever it is measured again. */
    setDelay(next: LineDelay) {
      delay = next;
    },
    delay: () => delay,
    /** A new pose, with its time on the line (see `lineTime`). Out of order or repeated times are dropped. */
    push(t: number, pose: PoseLike) {
      if (!Number.isFinite(t)) return;
      if (kept.length && t <= kept[kept.length - 1].t) return;
      kept.push({ t, pose });
      while (kept.length > 2 && t - kept[0].t > keepMs) kept.shift();
    },
    /** The moment the rules may judge at page time `now`. */
    judged: (now: number) => now - delay.behindMs,
    /** The moment to draw the opponent at, at page time `now`. */
    drawn: (now: number) => now - delay.behindMs + delay.leadMs,
    /** The time of the newest pose, or -Infinity. */
    newest: () => (kept.length ? kept[kept.length - 1].t : -Infinity),
    size: () => kept.length,
    /**
     * Where the head and the hands were at `t`. Between two measured poses it
     * is worked out between them. Outside what is known, or across a gap, it
     * is the nearest pose and `staleMs` says how far off. Null with no poses.
     */
    at(t: number): Reading | null {
      if (!kept.length) return null;
      const i = before(t);
      if (i < 0) return hold(kept[0], t);
      if (i === kept.length - 1) return hold(kept[i], t);
      const a = kept[i],
        b = kept[i + 1];
      const nearer = t - a.t <= b.t - t ? a : b;
      if (!measured(a.pose) || !measured(b.pose) || b.t - a.t > maxGapMs) {
        // Not joined: the nearer of the two if it was measured, else the other.
        const pick = measured(nearer.pose) ? nearer : nearer === a ? b : a;
        return hold(pick, t);
      }
      const k = (t - a.t) / (b.t - a.t);
      const hands: [boolean, boolean] = [
        a.pose.leftHandTracked !== false && b.pose.leftHandTracked !== false,
        a.pose.rightHandTracked !== false && b.pose.rightHandTracked !== false,
      ];
      const ja = a.pose.joints,
        jb = b.pose.joints;
      const wa = a.pose.jointWeights,
        wb = b.pose.jointWeights;
      return {
        t,
        valid: true,
        head: mix(a.pose.head, b.pose.head, k),
        root: mix(a.pose.root, b.pose.root, k),
        // A hand seen in only one of the two is taken from that one.
        leftHand: hands[0] ? mix(a.pose.leftHand, b.pose.leftHand, k) : { ...nearer.pose.leftHand },
        rightHand: hands[1] ? mix(a.pose.rightHand, b.pose.rightHand, k) : { ...nearer.pose.rightHand },
        hands,
        joints: ja && jb && ja.length === jb.length ? ja.map((p, j) => mix(p, jb[j], k)) : null,
        // A joint is as sure as the less sure of the two poses.
        jointWeights: wa && wb && wa.length === wb.length ? wa.map((w, j) => Math.min(w, wb[j])) : null,
        between: true,
        staleMs: 0,
      };
    },
    /** The reading the rules use at page time `now`. */
    me: (now: number) => api.at(now - delay.behindMs),
    /**
     * Was the player seen all the way from `from` to `to`: measured poses at
     * both ends and no gap between poses longer than `maxGap`? A punch can
     * hurt only if this is true from its start to its landing. `hand` also
     * asks that this hand (0 left, 1 right) was seen in every one of them.
     */
    seenThrough(from: number, to: number, hand?: 0 | 1, maxGap = maxGapMs): boolean {
      if (!kept.length) return false;
      const first = Math.max(0, before(from));
      if (kept[first].t > from + maxGap) return false;
      let last = kept[first].t;
      for (let i = first; i < kept.length; i++) {
        const k = kept[i];
        if (k.t - last > maxGap) return false;
        const seen =
          measured(k.pose) &&
          (hand === undefined || (hand === 0 ? k.pose.leftHandTracked : k.pose.rightHandTracked) !== false);
        // Every pose from the one just before `from` to the one that reaches `to`.
        if (!seen && k.t >= from - maxGap) return false;
        last = k.t;
        if (k.t >= to) return true;
      }
      // The newest pose is older than `to`: seen so far, if it is not too old.
      return to - last <= maxGap;
    },
    /**
     * How far the head moved across the picture in the `ms` before `t`, in
     * game units. Under 4 cm in the last 100 ms, a punch drawn on its way is
     * a certain hit and its sound need not wait for the pose that proves it.
     */
    headMoved(t: number, ms = 100): number {
      const a = api.at(t - ms),
        b = api.at(t);
      if (!a || !b || !a.valid || !b.valid) return Infinity;
      return Math.hypot(b.head.x - a.head.x, b.head.y - a.head.y);
    },
    reset() {
      kept = [];
    },
  };
  return api;
}
export type Timeline = ReturnType<typeof createTimeline>;
