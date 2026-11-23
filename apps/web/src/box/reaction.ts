import type { Vec3 } from "../pov/physics";
import type { Hand, PunchShape } from "./punch";

/**
 * What a landed punch does to the opponent's body, for drawing only. Every
 * punch that lands moves something, by its shape and its weight: a jab snaps
 * the head back a little, a hook turns it, an uppercut lifts the chin, a body
 * shot folds the trunk. The rules' own stagger is longer and separate.
 *
 * Offsets are in the opponent's frame: +x its right, +y up, +z toward the player.
 */
export interface Struck {
  /** Fight time of the punch, seconds. */
  at: number;
  hand: Hand;
  shape: PunchShape;
  target: "head" | "body";
  damage: number;
  /**
   * Real contact (see real/space.ts): the way the fist was going and where it
   * landed against the middle of what it hit, both in the opponent's frame.
   * Given, the body moves the way it was hit, not the way a punch of that
   * name usually moves it; and the contact is now, not a moment after.
   */
  dir?: Vec3;
  off?: Vec3;
}
export interface Reaction {
  head: Vec3;
  chest: Vec3;
  /** Radians: turned to its left (+), chin up (+), tipped (+). */
  yaw: number;
  pitch: number;
  roll: number;
  /** How far the gloves drop. */
  gloves: number;
}
export const STILL: Reaction = {
  head: { x: 0, y: 0, z: 0 },
  chest: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  roll: 0,
  gloves: 0,
};
/** The glove reaches the target this long after the punch is read. */
export const CONTACT_S = 0.05;

/** `time` is the fight's time now. */
export function reactionOf(struck: Struck | null, time: number): Reaction {
  if (!struck) return STILL;
  const body = struck.target === "body";
  const tau = body ? 0.09 : 0.055;
  const t = time - struck.at - (struck.dir ? 0 : CONTACT_S) + (struck.dir ? 0.012 : 0);
  if (!(t > 0) || t > tau * 9) return STILL;
  // Fast in, slower out: at its largest one time-constant after contact.
  const k = (t / tau) * Math.exp(1 - t / tau);
  const s = Math.max(0.35, Math.min(1.6, struck.damage / 8)) * k;
  if (struck.dir) {
    // Pushed along the fist's own line; turned by how far across it was going and by which side of the head it caught.
    const d = struck.dir;
    const side = Math.max(-1, Math.min(1, (struck.off?.x ?? 0) / 0.1));
    const into = Math.max(0, -d.z);
    if (body)
      return {
        head: { x: d.x * 0.03 * s, y: -0.02 * s * into, z: 0.08 * s * into },
        chest: { x: d.x * 0.06 * s, y: d.y * 0.03 * s - 0.03 * s * into, z: d.z * 0.05 * s },
        yaw: -d.x * 0.25 * s,
        pitch: -0.25 * s * into,
        roll: d.x * 0.1 * s,
        gloves: 0.06 * s,
      };
    return {
      head: { x: d.x * 0.12 * s, y: d.y * 0.06 * s, z: d.z * 0.1 * s },
      chest: { x: d.x * 0.03 * s, y: d.y * 0.01 * s, z: d.z * 0.03 * s },
      // A fist going across turns the head with it; one that catches a cheek going straight turns it away from that cheek.
      yaw: -d.x * 0.6 * s + side * 0.3 * s * into,
      pitch: (0.35 * into + 0.6 * Math.max(0, d.y)) * s,
      roll: d.x * 0.2 * s,
      gloves: 0,
    };
  }
  // The player's left hand travels toward the opponent's left (its -x).
  const along = struck.hand === "left" ? -1 : 1;
  if (body)
    return {
      head: { x: 0, y: -0.02 * s, z: 0.08 * s },
      chest: { x: 0, y: -0.04 * s, z: 0.05 * s },
      yaw: 0,
      pitch: -0.25 * s,
      roll: 0,
      gloves: 0.06 * s,
    };
  if (struck.shape === "hook")
    return {
      head: { x: along * 0.12 * s, y: 0, z: -0.02 * s },
      chest: { x: along * 0.03 * s, y: 0, z: 0 },
      yaw: -along * 0.6 * s,
      pitch: 0,
      roll: along * 0.2 * s,
      gloves: 0,
    };
  if (struck.shape === "uppercut")
    return {
      head: { x: 0, y: 0.06 * s, z: -0.06 * s },
      chest: { x: 0, y: 0.01 * s, z: -0.02 * s },
      yaw: 0,
      pitch: 0.6 * s,
      roll: 0,
      gloves: 0,
    };
  return {
    head: { x: along * 0.015 * s, y: 0, z: -0.1 * s },
    chest: { x: 0, y: 0, z: -0.03 * s },
    yaw: 0,
    pitch: 0.35 * s,
    roll: 0,
    gloves: 0,
  };
}

/**
 * What being hit does to the player's view: by the kind of punch, its weight
 * and the side it came from. `side` is 1 when it arrives on the player's right.
 */
export function hitKick(
  kind: "jab" | "cross" | "hook" | "body",
  side: number,
  damage: number,
  ms: number,
): { back: number; across: number; down: number; pitch: number; yaw: number; roll: number } {
  const long = kind === "body" ? 400 : 260;
  const none = { back: 0, across: 0, down: 0, pitch: 0, yaw: 0, roll: 0 };
  if (!(ms >= 0) || ms > long) return none;
  // Fast in over 30 ms, then dying away.
  const k = ms < 30 ? ms / 30 : (1 - (ms - 30) / (long - 30)) ** 2;
  const s = Math.max(0.4, Math.min(1.6, damage / 10)) * k;
  if (kind === "hook")
    // Carried along the punch's travel: away from the hand that hit.
    return { ...none, across: -side * 0.08 * s, yaw: side * 0.1 * s, roll: side * 0.06 * s };
  if (kind === "body") return { ...none, down: 0.05 * s, pitch: -0.06 * s };
  // A straight punch snaps the head back and the chin up.
  return { ...none, back: 0.07 * s, pitch: 0.05 * s, roll: side * 0.02 * s };
}
