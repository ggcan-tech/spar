import { FIXED_STEP } from "./duel";
import { stepBall, type BallState } from "./physics";

/**
 * Where a ball is drawn, as opposed to where the simulation has it.
 *
 * Two reasons to draw it ahead:
 *
 * 1. Physics runs in whole 1/120 s steps. The part of the current frame not yet
 *    simulated is flown here, so the ball moves evenly between frames.
 *
 * 2. The game learns where the player's body is one pose-age late (camera,
 *    model and waiting for the next pose: roughly a tenth of a second). The hit
 *    test compares the ball now with the body as it was then. Drawing a ball
 *    that is coming at the player one pose-age ahead makes those the same
 *    moment: when the drawn ball reaches the player's head, the body the game
 *    tests is the body the player had at that instant. Without it, a ball can
 *    visibly miss and still count. The simulation itself is untouched.
 *
 * The cost is that the player sees the flight one pose-age shorter than it is
 * simulated. That time was never theirs: before, it was lost invisibly, as a
 * dodge that registered late.
 */

/** Longest lead applied for pose age, seconds. */
export const MAX_HIT_LAG = 0.2;
/** The lead grows over this much of the flight, so the ball does not jump out of the hand. */
const EASE_IN = 0.15;

/** The ball `seconds` from now, flown with the real physics; it stops at the floor. */
export function leadBall<T extends BallState>(ball: T, seconds: number): T {
  if (!(seconds > 0)) return ball;
  let state: BallState = ball;
  let left = Math.min(seconds, 0.5);
  while (left > 1e-6) {
    const dt = Math.min(FIXED_STEP, left);
    state = stepBall(state, dt);
    left -= dt;
    if (state.position.y <= state.radius) {
      state = {
        ...state,
        position: { ...state.position, y: state.radius },
      };
      break;
    }
  }
  return { ...ball, ...state };
}

/** How far ahead to draw a ball coming at the camera-tracked player. */
export function incomingLead(flightAge: number, poseAge: number): number {
  const lag = Math.max(0, Math.min(MAX_HIT_LAG, poseAge));
  const k = Math.max(0, Math.min(1, flightAge / EASE_IN));
  return lag * k * k * (3 - 2 * k);
}
