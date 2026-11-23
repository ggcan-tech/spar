import { BODY, JOINT } from "./body";
import type { Vec3 } from "./physics";

/**
 * Which way the head is turned, read from where the nose sits between the ears
 * across the picture. The old way took it from the three points' depth: a few
 * centimetres of depth noise on a 9 cm lever swung a still head by many
 * degrees. Across the picture the same landmarks are steady.
 *
 * Angles are in radians in the player's own frame: yaw positive toward the
 * player's right, pitch positive upward, roll positive with the right ear high.
 */
export interface HeadAngles {
  yaw: number;
  pitch: number;
  roll: number;
}
/** A real head: ear to ear over how far the nose tip is ahead of the ear line. */
export const EARS_OVER_NOSE = 1.45;
const MAX = { yaw: 1.05, pitch: 0.7, roll: 0.6 };
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * Raw reading from one pose. `level` is how far above the ear line the nose
 * sits when the head looks straight ahead (as the sine of an angle); it
 * depends on the face and on how high the camera is, so it is learned.
 * Returns null when the ears are too close together to read.
 */
export function headAngles(
  nose: Vec3,
  leftEar: Vec3,
  rightEar: Vec3,
  level = 0,
  earsOverNose = EARS_OVER_NOSE,
): (HeadAngles & { lift: number }) | null {
  const ex = rightEar.x - leftEar.x,
    ey = rightEar.y - leftEar.y;
  if (!(Math.hypot(ex, ey) > 0.02)) return null;
  const dx = nose.x - (leftEar.x + rightEar.x) / 2,
    dy = nose.y - (leftEar.y + rightEar.y) / 2;
  // A turned head shows its ears closer together, and a nodding one its nose
  // nearer the ear line: each angle needs the others, so go round a few times.
  let cosYaw = 1,
    sinYaw = 0,
    sinPitch = 0,
    lift = 0;
  for (let i = 0; i < 40; i++) {
    const ears = Math.hypot(ex / cosYaw, ey);
    const noseAhead = ears / earsOverNose;
    lift = dy / noseAhead;
    sinPitch = clamp(lift - level, -0.95, 0.95);
    const cosPitch = Math.sqrt(1 - sinPitch * sinPitch);
    sinYaw = clamp(dx / (noseAhead * cosPitch), -0.95, 0.95);
    cosYaw = Math.sqrt(1 - sinYaw * sinYaw);
  }
  return {
    yaw: clamp(Math.asin(sinYaw), -MAX.yaw, MAX.yaw),
    pitch: clamp(Math.asin(sinPitch), -MAX.pitch, MAX.pitch),
    roll: clamp(Math.atan2(ey, ex / cosYaw), -MAX.roll, MAX.roll),
    lift,
  };
}

/** Smoothed head angles over time, with the straight-ahead level learned as the player stands. */
export function createHeadTurn() {
  let angles: HeadAngles = { yaw: 0, pitch: 0, roll: 0 };
  let level: number | null = null;
  let lastT = -Infinity;
  return {
    /** Hip-relative joints and their weights from the tracker, at pose time `t` (ms). */
    update(
      joints: readonly Vec3[] | undefined,
      weights: readonly number[] | undefined,
      t: number,
    ): HeadAngles {
      if (t === lastT) return angles;
      const dt = Math.max(0, Math.min(250, t - lastT));
      lastT = t;
      const seen =
        joints &&
        weights &&
        weights[JOINT.NOSE] >= 1 &&
        weights[JOINT.L_EAR] >= 1 &&
        weights[JOINT.R_EAR] >= 1;
      const raw = seen
        ? headAngles(
            joints[JOINT.NOSE],
            joints[JOINT.L_EAR],
            joints[JOINT.R_EAR],
            level ?? undefined,
          )
        : null;
      if (!raw) {
        // Unseen: ease back to straight ahead rather than hold a stale turn.
        const k = Math.exp(-dt / 400);
        angles = {
          yaw: angles.yaw * k,
          pitch: angles.pitch * k,
          roll: angles.roll * k,
        };
        return angles;
      }
      // Straight ahead is where the head is most of the time: a slow average.
      level =
        level === null
          ? raw.lift
          : level + (raw.lift - level) * (1 - Math.exp(-dt / 5000));
      const fresh =
        headAngles(
          joints![JOINT.NOSE],
          joints![JOINT.L_EAR],
          joints![JOINT.R_EAR],
          level,
        ) ?? raw;
      const a = 1 - Math.exp(-dt / 70);
      angles = {
        yaw: angles.yaw + (fresh.yaw - angles.yaw) * a,
        pitch: angles.pitch + (fresh.pitch - angles.pitch) * a,
        roll: angles.roll + (fresh.roll - angles.roll) * a,
      };
      return angles;
    },
    reset() {
      angles = { yaw: 0, pitch: 0, roll: 0 };
      level = null;
      lastT = -Infinity;
    },
  };
}

/** Where the ears go for a head at `nose` turned by `angles`: [left, right]. */
export function earsFor(nose: Vec3, angles: HeadAngles): [Vec3, Vec3] {
  const cy = Math.cos(angles.yaw),
    sy = Math.sin(angles.yaw),
    cp = Math.cos(angles.pitch),
    sp = Math.sin(angles.pitch),
    cr = Math.cos(angles.roll),
    sr = Math.sin(angles.roll);
  const turn = (p: Vec3): Vec3 => {
    // Roll about the facing direction, then pitch, then yaw.
    const x1 = p.x * cr - p.y * sr,
      y1 = p.x * sr + p.y * cr,
      z1 = p.z;
    const y2 = y1 * cp + z1 * sp,
      z2 = -y1 * sp + z1 * cp;
    return {
      x: nose.x + x1 * cy + z2 * sy,
      y: nose.y + y2,
      z: nose.z - x1 * sy + z2 * cy,
    };
  };
  return [
    turn({ x: -BODY.earHalf, y: 0, z: -BODY.earBack }),
    turn({ x: BODY.earHalf, y: 0, z: -BODY.earBack }),
  ];
}
