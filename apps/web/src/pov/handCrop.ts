import type { Landmark } from "@spar/protocol";

/**
 * Where to look for a hand. At playing distance a hand is some fifty pixels
 * tall in the camera's picture, and the finger model first shrinks the whole
 * picture to a couple of hundred pixels: the hand is then a smudge and is
 * rarely found. The body model already knows where each wrist is, so the
 * finger model is given a square cut from the full-size picture around that
 * hand instead.
 */
export interface HandFocus {
  /** The person's own left or right hand. */
  side: "Left" | "Right";
  /** Top-left corner and side of the square, in camera pixels. */
  sx: number;
  sy: number;
  size: number;
}
const SEEN = 0.5;
/** MediaPipe pose landmarks: shoulders 11/12, elbows 13/14, wrists 15/16, index knuckles 19/20. */
const PARTS = {
  Left: { shoulder: 11, elbow: 13, wrist: 15, knuckle: 19 },
  Right: { shoulder: 12, elbow: 14, wrist: 16, knuckle: 20 },
} as const;

/**
 * The square around `side`'s hand, or null when that wrist is not seen.
 * `lm` are the body model's landmarks, 0 to 1 across the picture.
 */
export function handCrop(
  lm: readonly Landmark[],
  side: "Left" | "Right",
  width: number,
  height: number,
): HandFocus | null {
  const part = PARTS[side];
  const px = (i: number) => {
    const p = lm[i];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.v >= SEEN
      ? { x: p.x * width, y: p.y * height }
      : null;
  };
  const wrist = px(part.wrist);
  if (!wrist || !(width > 0) || !(height > 0)) return null;
  const elbow = px(part.elbow),
    knuckle = px(part.knuckle),
    left = px(PARTS.Left.shoulder),
    right = px(PARTS.Right.shoulder);
  const forearm = elbow ? Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y) : 0;
  const shoulders =
    left && right ? Math.hypot(left.x - right.x, left.y - right.y) : 0;
  // A hand is about as long as two thirds of the shoulders are wide. The
  // forearm is used too, but it shortens to nothing when it points at the
  // camera, which is exactly when a throw is made.
  const hand = Math.max(forearm * 0.7, shoulders * 0.45, 24);
  // The palm is past the wrist, along the knuckle when it is seen and along
  // the forearm otherwise.
  const along = knuckle
    ? { x: knuckle.x - wrist.x, y: knuckle.y - wrist.y }
    : elbow
      ? { x: wrist.x - elbow.x, y: wrist.y - elbow.y }
      : { x: 0, y: -1 };
  const reach = Math.hypot(along.x, along.y) || 1;
  const centre = {
    x: wrist.x + (along.x / reach) * hand * 0.5,
    y: wrist.y + (along.y / reach) * hand * 0.5,
  };
  // Room for the fingers spread in any direction.
  const size = Math.round(Math.min(width, height, Math.max(96, hand * 2.8)));
  return {
    side,
    sx: Math.round(Math.max(0, Math.min(width - size, centre.x - size / 2))),
    sy: Math.round(Math.max(0, Math.min(height - size, centre.y - size / 2))),
    size,
  };
}

/** A point found inside the square, back in the whole picture's 0-to-1 coordinates. */
export function fromCrop(
  p: { x: number; y: number; z: number },
  focus: HandFocus,
  width: number,
  height: number,
) {
  return {
    x: (focus.sx + p.x * focus.size) / width,
    y: (focus.sy + p.y * focus.size) / height,
    z: (p.z * focus.size) / width,
  };
}
