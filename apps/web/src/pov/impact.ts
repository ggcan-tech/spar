import type { PlayerPose } from "./duel";

/**
 * What a hit looks like, beyond the score changing. All of it is display only:
 * nothing here moves a pose the game tests for hits.
 */

/** The simulation holds still this long on a hit, so the moment registers. */
export const HIT_STOP_MS = { self: 90, opponent: 60 } as const;
const KICK_MS = 90;
const FLINCH_MS = 60;

/**
 * The first-person camera's jolt when the player is hit: pushed back along the
 * ball's travel and rolled away from the side it struck, decaying in a quarter
 * of a second. `side` is -1 when the ball struck left of the head, 1 right.
 */
export function cameraKick(sinceMs: number, side: number) {
  if (!(sinceMs >= 0) || sinceMs > 500) return { back: 0, roll: 0 };
  const e = Math.exp(-sinceMs / KICK_MS);
  return {
    back: 0.07 * e,
    roll: -0.05 * e * Math.max(-1, Math.min(1, side)),
  };
}

/**
 * The opponent's recoil when the player's ball lands: the head and shoulders
 * snap back, the hands come up, then everything returns. An impulse, so the
 * pose starts and ends exactly where the game has it.
 */
export function flinch(pose: PlayerPose, sinceMs: number): PlayerPose {
  if (!(sinceMs >= 0) || sinceMs > 600 || pose.body) return pose;
  const k = (sinceMs / FLINCH_MS) * Math.exp(1 - sinceMs / FLINCH_MS);
  return {
    ...pose,
    head: { ...pose.head, y: pose.head.y - 0.05 * k, z: pose.head.z - 0.2 * k },
    root: { ...pose.root, z: pose.root.z - 0.08 * k },
    leftHand: { ...pose.leftHand, y: pose.leftHand.y + 0.12 * k },
    rightHand: { ...pose.rightHand, y: pose.rightHand.y + 0.12 * k },
  };
}
