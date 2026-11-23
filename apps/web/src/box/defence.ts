import { JOINT } from "../pov/body";
import type { ArmSource } from "./punch";

/**
 * Where the gloves are, read from the wrists against the shoulder line. No
 * face landmark is used: a glove in front of the face hides the face.
 *
 * Three things are told apart:
 * - hands up: the ordinary guard, fists by the chin. Not a block, but it
 *   catches a jab and is what a coach asks for at every moment;
 * - cover: fists lifted from the guard to the forehead. Blocks any head punch;
 * - low: a fist in front of the ribs. Blocks a body shot.
 * Slips and ducks are read by the fight itself, from where the head is.
 *
 * How high a hand looks against the body shifts by some centimetres with the
 * camera's height and with the person, so "lifted" is measured against where
 * this player's own guard sits (`guardLevel`, learned by the game).
 */
export interface Guard {
  /** Gloves lifted to cover the face: 0, 1 or 2. */
  high: number;
  /** Gloves in front of the ribs: 0, 1 or 2. */
  low: number;
  /** Hands up, in the guard or higher: 0, 1 or 2. */
  up: number;
  /** Each wrist above the shoulder line, [left, right]; null when unseen or out punching. */
  heights: [number | null, number | null];
  /** Which glove is where, [left, right]: a hook is stopped by the glove on its side, a body shot by the elbow on its side. */
  sides?: { high: [boolean, boolean]; low: [boolean, boolean]; up?: [boolean, boolean] };
  /**
   * False when a hand could not be seen at all (hidden, or the model lost it).
   * A hand that was not seen is not known to be down: the doubt is the
   * player's. A hand out punching is known. Missing means known.
   */
  known?: boolean;
}
export const NO_GUARD: Guard = { high: 0, low: 0, up: 0, heights: [null, null] };
/** Starting values, in game units. */
export const BLOCK = {
  /** Where a guard sits above the shoulder line until this player's own has been seen. */
  guardLevel: 0.13,
  /** A cover is at least this far above the player's guard… */
  coverAboveGuard: 0.09,
  /** …and never less than this above the shoulder line. */
  coverFloor: 0.12,
  /** A glove already covering stays a cover until it has come this far back down: the line does not flicker. */
  coverHold: 0.035,
  /** Hands up: a wrist no lower than this under the shoulder line… */
  upBelowShoulders: 0.06,
  /** …and within this of the body's middle, as is a cover. */
  across: 0.32,
  /** A fist at least this far below the shoulder line, and this far above the hips, covers the ribs… */
  ribsBelowShoulders: 0.12,
  ribsAboveHips: 0.1,
  /** …if it is within this of the body's middle. */
  ribsAcross: 0.27,
};

/**
 * `busy` marks a hand that is out punching: it guards nothing.
 * Joints are relative to the hips, as the tracker gives them.
 */
export function readGuard(
  source: ArmSource,
  busy: readonly [boolean, boolean] = [false, false],
  guardLevel: number = BLOCK.guardLevel,
  /** Which gloves were covering at the last pose, [left, right]. */
  held: readonly [boolean, boolean] = [false, false],
): Guard {
  const { joints, jointWeights: weights } = source;
  if (!joints || !weights) return NO_GUARD;
  const left = joints[JOINT.L_SHOULDER],
    right = joints[JOINT.R_SHOULDER];
  if (!(weights[JOINT.L_SHOULDER] > 0 && weights[JOINT.R_SHOULDER] > 0))
    return NO_GUARD;
  const shoulders = (left.y + right.y) / 2,
    middle = (left.x + right.x) / 2;
  const cover = Math.max(
    BLOCK.coverFloor,
    guardLevel + BLOCK.coverAboveGuard,
  );
  const guard: Guard = {
    high: 0,
    low: 0,
    up: 0,
    heights: [null, null],
    sides: { high: [false, false], low: [false, false], up: [false, false] },
    known: true,
  };
  for (let i = 0; i < 2; i++) {
    const seen =
      weights[JOINT.L_WRIST + i] >= 0.6 &&
      (i === 0 ? source.leftHandTracked : source.rightHandTracked) !== false;
    if (!seen && !busy[i]) guard.known = false;
    if (!seen || busy[i]) continue;
    const fist = joints[JOINT.L_WRIST + i];
    const height = fist.y - shoulders,
      across = Math.abs(fist.x - middle);
    guard.heights[i] = height;
    if (height >= -BLOCK.upBelowShoulders && across <= BLOCK.across) {
      guard.up++;
      guard.sides!.up![i] = true;
      if (height >= cover - (held[i] ? BLOCK.coverHold : 0)) {
        guard.high++;
        guard.sides!.high[i] = true;
      }
    } else if (
      height <= -BLOCK.ribsBelowShoulders &&
      fist.y >= BLOCK.ribsAboveHips &&
      across <= BLOCK.ribsAcross
    ) {
      guard.low++;
      guard.sides!.low[i] = true;
    }
  }
  return guard;
}
