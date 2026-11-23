import type { Vec3 } from "./physics";

/**
 * Keeping the player's own hand and the ball they hold on screen.
 *
 * In first person the camera sits at the head. A hand raised beside the head
 * to aim is level with the camera or behind it, so it is not in the picture:
 * while aiming, the player could not see their own hand or the ball. Games
 * with a first-person view solve this by drawing the arm where it can be
 * seen, not where it is. This does the same: a point is moved the least
 * distance needed to sit in front of the eye and inside the frame.
 *
 * Display only. The game's hand, and where a throw starts, are unchanged.
 */
export const VIEW_MODEL = {
  /** Nearest the drawn hand may come to the eye, game units. */
  near: 0.8,
  /**
   * Share of the half-frame the hand may reach sideways, upward and downward.
   * Upward is kept low so a raised hand and its ball sit at the side of the
   * view, not over the opponent or the score.
   */
  side: 0.78,
  up: 0.3,
  down: 0.9,
  /** The held ball is drawn at this share of its size while it is kept in view. */
  ballScale: 0.7,
} as const;

/**
 * `point` in camera space: +x right, +y up, and `depth` forward from the eye
 * (negative is behind). `tanHalfFov` is of the vertical field of view; `aspect`
 * is width over height.
 */
export function keepInView(
  point: { x: number; y: number; depth: number },
  tanHalfFov: number,
  aspect: number,
): { x: number; y: number; depth: number } {
  const depth = Math.max(point.depth, VIEW_MODEL.near);
  const halfHeight = depth * tanHalfFov,
    halfWidth = halfHeight * aspect;
  return {
    x: Math.max(
      -halfWidth * VIEW_MODEL.side,
      Math.min(halfWidth * VIEW_MODEL.side, point.x),
    ),
    y: Math.max(
      -halfHeight * VIEW_MODEL.down,
      Math.min(halfHeight * VIEW_MODEL.up, point.y),
    ),
    depth,
  };
}

/** Where the ball sits in the hand: beyond the wrist, along the forearm. */
export function palm(elbow: Vec3, wrist: Vec3, reach = 0.13): Vec3 {
  const d = {
    x: wrist.x - elbow.x,
    y: wrist.y - elbow.y,
    z: wrist.z - elbow.z,
  };
  const length = Math.hypot(d.x, d.y, d.z);
  if (!(length > 1e-6)) return { ...wrist };
  return {
    x: wrist.x + (d.x / length) * reach,
    y: wrist.y + (d.y / length) * reach,
    z: wrist.z + (d.z / length) * reach,
  };
}
