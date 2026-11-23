import type { Vec3 } from "../../pov/physics";

/** Small vector helpers for the motion code. All pure: nothing is changed in place. */
export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => v3(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const mix = (a: Vec3, b: Vec3, k: number): Vec3 =>
  v3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
/** `a` at length one; `fallback` when it has no length. */
export const unit = (a: Vec3, fallback: Vec3 = v3(0, 1, 0)): Vec3 => {
  const l = length(a);
  return l > 1e-9 ? v3(a.x / l, a.y / l, a.z / l) : fallback;
};
export const clamp = (k: number, low = 0, high = 1): number => Math.max(low, Math.min(high, k));
/** 0 to 1 with no speed at either end. */
export const smooth = (k: number): number => {
  const c = clamp(k);
  return c * c * (3 - 2 * c);
};
/** The angle between two directions, radians. */
export const angleBetween = (a: Vec3, b: Vec3): number => {
  const la = length(a),
    lb = length(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  // atan2 of cross and dot stays exact near 0 and near a half turn, where acos does not.
  return Math.atan2(length(cross(a, b)), dot(a, b));
};
/** `p` turned by `angle` radians about the unit `axis` (right-hand rule). */
export const rotate = (p: Vec3, axis: Vec3, angle: number): Vec3 => {
  if (angle === 0) return p;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const d = dot(axis, p) * (1 - c);
  const x = cross(axis, p);
  return v3(p.x * c + x.x * s + axis.x * d, p.y * c + x.y * s + axis.y * d, p.z * c + x.z * s + axis.z * d);
};
/** Some direction square to `a`. */
export const anySquareTo = (a: Vec3): Vec3 =>
  unit(cross(a, Math.abs(a.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)), v3(1, 0, 0));
export const ZERO: Vec3 = v3(0, 0, 0);
