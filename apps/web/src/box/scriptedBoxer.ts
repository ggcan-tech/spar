import type { Vec3 } from "../pov/physics";
import type { SyntheticMotion } from "../pov/syntheticBody";

/**
 * A scripted person who boxes, for testing without a camera: a guard, the
 * three punch shapes with either hand at head or body, slips, ducks and blocks.
 * Scripts of the movements, not recordings of anyone.
 *
 * Hand positions are in metres relative to that hand's own shoulder, as
 * (inward toward the body's middle, up, forward toward the camera).
 */
export type Hand = "left" | "right";
export type PunchShape = "straight" | "hook" | "uppercut";
type Rel = { in: number; up: number; fwd: number };
const rel = (i: number, up: number, fwd: number): Rel => ({ in: i, up, fwd });
/** Fists by the chin, elbows down. */
export const GUARD: Rel = rel(0.1, 0.1, 0.2);
/** Both fists lifted in front of the eyes. */
export const HIGH_BLOCK: Rel = rel(0.15, 0.29, 0.18);
/** Both forearms in front of the ribs. */
export const LOW_BLOCK: Rel = rel(0.12, -0.2, 0.16);
const ease = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * c * (10 - 15 * c + 6 * c * c);
};
const mix = (a: Rel, b: Rel, k: number): Rel =>
  rel(
    a.in + (b.in - a.in) * k,
    a.up + (b.up - a.up) * k,
    a.fwd + (b.fwd - a.fwd) * k,
  );
/** To the skeleton's own axes: +x is the person's right. */
const toHand = (hand: Hand, r: Rel): Vec3 => ({
  x: hand === "left" ? r.in : -r.in,
  y: r.up,
  z: r.fwd,
});

export interface PunchStyle {
  /** Seconds from the guard to full extension. A beginner's jab is about 0.2. */
  extend?: number;
  /** Seconds held at the end. */
  hold?: number;
  /** Seconds back to the guard. */
  back?: number;
  /** Thrown at the body instead of the head. */
  body?: boolean;
  /** Share of a full punch: 0.5 is a half-hearted poke. */
  reach?: number;
  /**
   * How far above (or below) the shoulder a straight punch ends, in metres.
   * A punch thrown at a low camera, rather than level, ends well below it.
   */
  endUp?: number;
}
export const punchDuration = (style: PunchStyle = {}) =>
  (style.extend ?? 0.18) + (style.hold ?? 0.04) + (style.back ?? 0.22);

/** Where the fist is `seconds` into one punch, and how far the shoulders have turned. */
export function punchPath(
  shape: PunchShape,
  seconds: number,
  style: PunchStyle = {},
): { hand: Rel; turn: number } {
  const extend = style.extend ?? 0.18,
    hold = style.hold ?? 0.04,
    back = style.back ?? 0.22,
    reach = style.reach ?? 1;
  const low = style.body ? -0.24 : 0;
  // Each shape as: an optional wind, then the end of the punch.
  const [wind, end, windAt] =
    shape === "straight"
      ? ([GUARD, rel(0.13, (style.endUp ?? 0.08) + low, 0.5), 0] as const)
      : shape === "hook"
        ? ([rel(-0.07, 0.07, 0.24), rel(0.4, 0.08 + low, 0.28), 0.35] as const)
        : ([rel(0.06, -0.22, 0.18), rel(0.12, 0.26 + low, 0.33), 0.45] as const);
  const far = mix(GUARD, end, reach),
    wound = mix(GUARD, wind, reach);
  let hand: Rel, out: number;
  if (seconds <= 0) [hand, out] = [GUARD, 0];
  else if (seconds <= extend) {
    const k = seconds / extend;
    hand =
      windAt > 0 && k < windAt
        ? mix(GUARD, wound, ease(k / windAt))
        : mix(wound, far, ease((k - windAt) / (1 - windAt)));
    out = ease(k);
  } else if (seconds <= extend + hold) [hand, out] = [far, 1];
  else {
    const k = ease((seconds - extend - hold) / back);
    [hand, out] = [mix(far, GUARD, k), 1 - k];
  }
  return { hand, turn: 0.28 * out * reach };
}

/** One punch with one hand; the other stays in the guard. */
export function punchMotion(
  hand: Hand,
  shape: PunchShape,
  seconds: number,
  style: PunchStyle = {},
): SyntheticMotion {
  const path = punchPath(shape, seconds, style);
  return {
    leftHand: toHand("left", hand === "left" ? path.hand : GUARD),
    rightHand: toHand("right", hand === "right" ? path.hand : GUARD),
    // The punching shoulder comes forward.
    twist: hand === "right" ? path.turn : -path.turn,
  };
}

/**
 * Standing in the guard, with optional lean (slip), crouch (duck) and block.
 * `high` and `low` are 0 to 1: how far the hands have gone to that block.
 */
export function stance(
  o: {
    lean?: number;
    crouch?: number;
    block?: "high" | "low";
    high?: number;
    low?: number;
    step?: number;
  } = {},
): SyntheticMotion {
  const high = o.block === "high" ? 1 : (o.high ?? 0),
    low = o.block === "low" ? 1 : (o.low ?? 0);
  const hands = mix(mix(GUARD, HIGH_BLOCK, high), LOW_BLOCK, low);
  return {
    leftHand: toHand("left", hands),
    rightHand: toHand("right", hands),
    lean: o.lean ?? 0,
    sway: (o.lean ?? 0) * 0.4,
    crouch: o.crouch ?? 0,
    step: o.step ?? 0,
  };
}
/** Arms hanging at the sides, as before a round. */
export const AT_REST: SyntheticMotion = {};

const pulse = (s: number, start: number, duration: number) => {
  const k = (s - start) / duration;
  return k <= 0 || k >= 1 ? 0 : Math.sin(Math.PI * k) ** 2;
};
/** What the demo boxer does and when, in a 16-second loop after a still start. */
const ROUTINE: {
  at: number;
  hand: Hand;
  shape: PunchShape;
  style?: PunchStyle;
}[] = [
  { at: 0.6, hand: "left", shape: "straight" },
  { at: 1.5, hand: "left", shape: "straight" },
  { at: 1.85, hand: "right", shape: "straight" },
  { at: 4.2, hand: "left", shape: "hook" },
  { at: 6.4, hand: "right", shape: "uppercut" },
  { at: 7.6, hand: "left", shape: "straight", style: { body: true } },
  { at: 8.0, hand: "right", shape: "straight" },
  { at: 10.6, hand: "left", shape: "straight" },
  { at: 10.95, hand: "right", shape: "straight" },
  { at: 11.35, hand: "left", shape: "hook" },
  { at: 13.2, hand: "right", shape: "hook", style: { body: true } },
];
/**
 * A looping round of shadow boxing: stands still for setup, raises the guard,
 * then punches, slips, ducks and blocks.
 */
export function boxDemoMotion(seconds: number): SyntheticMotion {
  if (seconds < 2.2) return AT_REST;
  // Both hands up to the face: the gesture that starts a round.
  if (seconds < 4) {
    const k = ease((seconds - 2.2) / 0.35);
    const up = stance({ high: seconds < 3.6 ? 1 : 1 - ease((seconds - 3.6) / 0.3) });
    const rest = (side: number): Vec3 => ({ x: side * 0.05, y: -0.5, z: 0.08 });
    const lift = (from: Vec3, to: Vec3): Vec3 => ({
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      z: from.z + (to.z - from.z) * k,
    });
    return {
      leftHand: lift(rest(-1), up.leftHand!),
      rightHand: lift(rest(1), up.rightHand!),
    };
  }
  const s = (seconds - 4) % 16;
  const punch = ROUTINE.find(
    (p) => s >= p.at && s < p.at + punchDuration(p.style),
  );
  const lean = 0.15 * pulse(s, 2.6, 1.1) - 0.15 * pulse(s, 9, 1.1);
  const crouch = 0.24 * pulse(s, 5.2, 1.0) + 0.24 * pulse(s, 12.2, 0.9);
  // Hands to a block and back, each over a quarter of a second.
  const held = (start: number, end: number) =>
    Math.min(ease((s - start) / 0.25), 1 - ease((s - end) / 0.25));
  const body = stance({
    lean,
    crouch,
    high: Math.max(0, held(14.1, 14.8)),
    low: Math.max(0, held(15.0, 15.6)),
  });
  if (!punch) return body;
  const thrown = punchMotion(punch.hand, punch.shape, s - punch.at, punch.style);
  return { ...body, ...thrown };
}
