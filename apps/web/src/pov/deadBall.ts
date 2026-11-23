import { stepBall, type BallState, type Vec3 } from "./physics";

/**
 * What a ball does after the game is finished with it. A ball that missed
 * used to vanish in mid-air two metres behind its target, and one that hit
 * the floor vanished at first touch. Here it stays an object: it bounces off
 * the floor and the walls, rebounds off a body it hit, rolls and stops.
 *
 * Display only. These balls are not in the game state and cannot hit anyone.
 */
export const ROOM = {
  /** Inner faces of the side walls, and of the walls behind each player. */
  side: 4.875,
  near: 6.9,
  far: -14.9,
} as const;
const FLOOR_BOUNCE = 0.62;
const FLOOR_GRIP = 0.85;
const WALL_BOUNCE = 0.55;
/** A bounce slower than this does not leave the floor again. */
const SETTLE_SPEED = 0.45;

export interface DeadBallStep {
  ball: BallState;
  /** Speed of an impact on this step, for sound; null when nothing was struck. */
  bounce: number | null;
}

export function stepDeadBall(ball: BallState, dt: number): DeadBallStep {
  if (!(dt > 0)) return { ball, bounce: null };
  const next = stepBall(ball, Math.min(dt, 0.05));
  const position = { ...next.position },
    velocity = { ...next.velocity };
  let bounce: number | null = null;
  const r = next.radius;
  if (position.y <= r) {
    position.y = r;
    if (velocity.y < 0) {
      const impact = -velocity.y;
      if (impact > SETTLE_SPEED) {
        bounce = impact;
        velocity.y = impact * FLOOR_BOUNCE;
        velocity.x *= FLOOR_GRIP;
        velocity.z *= FLOOR_GRIP;
      } else velocity.y = 0;
    }
    if (velocity.y === 0) {
      // Rolling: the floor takes the rest of the speed away.
      const slow = Math.max(0, 1 - 1.6 * dt);
      velocity.x *= slow;
      velocity.z *= slow;
      if (Math.hypot(velocity.x, velocity.z) < 0.05)
        velocity.x = velocity.z = 0;
    }
  }
  const wall = (axis: "x" | "z", limit: number, sign: 1 | -1) => {
    if ((position[axis] - limit) * sign > -r && velocity[axis] * sign > 0) {
      position[axis] = limit - sign * r;
      bounce = Math.max(bounce ?? 0, Math.abs(velocity[axis]));
      velocity[axis] = -velocity[axis] * WALL_BOUNCE;
    }
  };
  wall("x", ROOM.side, 1);
  wall("x", -ROOM.side, -1);
  wall("z", ROOM.near, 1);
  wall("z", ROOM.far, -1);
  return { ball: { ...next, position, velocity }, bounce };
}

/** The velocity of a ball coming off a body centred at `centre`: turned about the contact normal, most of its speed lost. */
export function rebound(
  velocity: Vec3,
  at: Vec3,
  centre: Vec3,
  keep = 0.35,
): Vec3 {
  const n = { x: at.x - centre.x, y: at.y - centre.y, z: at.z - centre.z };
  const length = Math.hypot(n.x, n.y, n.z);
  if (!(length > 1e-6))
    return {
      x: -velocity.x * keep,
      y: velocity.y * keep,
      z: -velocity.z * keep,
    };
  n.x /= length;
  n.y /= length;
  n.z /= length;
  const into = velocity.x * n.x + velocity.y * n.y + velocity.z * n.z;
  // Already moving away from the body: just slow it.
  const turn = into < 0 ? 2 * into : 0;
  return {
    x: (velocity.x - turn * n.x) * keep,
    y: (velocity.y - turn * n.y) * keep,
    z: (velocity.z - turn * n.z) * keep,
  };
}
