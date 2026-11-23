import { LANDMARK_COUNT, LM, type PoseFrame } from '@spar/protocol';

export interface Vec3 { x: number; y: number; z: number }

/**
 * Landmarks re-expressed in the fighter's body frame:
 *  - origin = mid-shoulder (3D),
 *  - unit   = shoulder width (image-normalized, after aspect correction),
 *  - rotated so the shoulder line is horizontal,
 *  - +x = fighter's own LEFT (image +x when facing the camera; image is not mirrored),
 *  - +y = down (image convention), z = depth in the same units (smaller = closer to camera).
 */
export interface BodyFrame {
  t: number;
  /** 33 landmarks in body units. */
  pts: Vec3[];
  /** visibility per landmark, passed through from the input. */
  vis: number[];
  /** true when both shoulders are visible and not degenerate. */
  valid: boolean;
  /** shoulder distance in image-normalized units (x-normalized, aspect-corrected). Drives STEP_IN/OUT. */
  shoulderWidthPx: number;
  /** mid-shoulder in image coordinates (aspect-corrected y). */
  midShoulder: { x: number; y: number };
  /** hip center image x divided by shoulderWidthPx (in "units"). */
  hipCenterX: number;
  /** hip center raw image x (normalized 0..1). */
  hipCenterXImg: number;
  hipVisible: boolean;
  /** Projected shoulder-to-hip center length, independent of shoulder yaw foreshortening. */
  torsoLengthPx: number;
  /** nose raw image y (aspect-corrected), used for DUCK relative to a calibrated neutral. */
  noseYImg: number;
}

export function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Angle at `b` between segments b→a and b→c, in degrees (3D). */
export function angleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const nu = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const nv = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (nu < 1e-9 || nv < 1e-9) return 180;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (nu * nv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * @param aspect image height / width. MediaPipe normalizes x by width and y by height, so a real
 *   camera frame needs `aspect = videoHeight / videoWidth` to make the body frame isotropic.
 * @param visibilityMin shoulders below this visibility make the frame `valid: false`.
 */
export function toBodyFrame(frame: PoseFrame, aspect = 1, visibilityMin = 0.5): BodyFrame {
  const aspectValid = Number.isFinite(aspect) && aspect > 0;
  if (!aspectValid) aspect = 1;
  const lm = Array.from({ length: LANDMARK_COUNT }, (_, i) => {
    const p = frame.lm?.[i];
    return p && [p.x, p.y, p.z, p.v].every(Number.isFinite)
      ? p : { x: 0, y: 0, z: 0, v: 0 };
  });
  const L = lm[LM.L_SHOULDER];
  const R = lm[LM.R_SHOULDER];
  const Lx = L.x, Ly = L.y * aspect, Rx = R.x, Ry = R.y * aspect;
  const midX = (Lx + Rx) / 2, midY = (Ly + Ry) / 2, midZ = (L.z + R.z) / 2;
  const dx = Lx - Rx, dy = Ly - Ry;
  let sw = Math.sqrt(dx * dx + dy * dy);
  const valid = aspectValid && L.v >= visibilityMin && R.v >= visibilityMin && sw > 1e-6;
  if (sw <= 1e-6) sw = 1e-6;
  // u = unit vector along the shoulder line (R → L = fighter's left); perp = u rotated +90° (y down)
  const ux = dx / sw, uy = dy / sw;
  const px = -uy, py = ux;

  const pts: Vec3[] = new Array(LANDMARK_COUNT);
  const vis: number[] = new Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = lm[i];
    if (!p) { pts[i] = { x: 0, y: 0, z: 0 }; vis[i] = 0; continue; }
    const qx = p.x - midX, qy = p.y * aspect - midY;
    pts[i] = { x: (qx * ux + qy * uy) / sw, y: (qx * px + qy * py) / sw, z: (p.z - midZ) / sw };
    vis[i] = p.v;
  }

  const hl = lm[LM.L_HIP], hr = lm[LM.R_HIP];
  const hipVisible = !!hl && !!hr && hl.v >= visibilityMin && hr.v >= visibilityMin;
  const hipCenterXImg = hl && hr ? (hl.x + hr.x) / 2 : midX;
  const nose = lm[LM.NOSE];

  return {
    t: frame.t,
    pts,
    vis,
    valid,
    shoulderWidthPx: sw,
    midShoulder: { x: midX, y: midY },
    hipCenterX: hipCenterXImg / sw,
    hipCenterXImg,
    hipVisible,
    torsoLengthPx: hipVisible ? Math.hypot(hipCenterXImg - midX, (hl.y + hr.y) * aspect / 2 - midY) : 0,
    noseYImg: nose ? nose.y * aspect : midY,
  };
}
