import type { Vec3 } from "./physics";

/**
 * The cameras (CORE.md 2.1). Every number is in the player's own frame:
 * +x their right, +y up, +z toward the opponent, metres, 0 = home on the floor.
 * The scene turns them into the world with `worldPoint(p, local)`, which is
 * right for both seats, so nothing is ever mirrored.
 *
 * Rules: the dodge camera never moves while a ball is live; never mirror; never
 * cross to the opponent's side; never follow the body.
 */
export interface Shot {
  eye: Vec3;
  look: Vec3;
  /** Vertical lens, degrees. */
  fov: number;
}
export type DodgeKey = 1 | 2 | 3 | 4;

/** Keys 1–4 on the test page. 4 is first person (no chase camera). LANE (1) is the default. */
export const DODGE_PRESETS: Record<Exclude<DodgeKey, 4>, Shot & { name: string }> = {
  1: { name: "LANE", eye: { x: 0, y: 2.8, z: -3.5 }, look: { x: 0, y: 0, z: 4.3 }, fov: 41 },
  2: { name: "MID", eye: { x: 0, y: 2.5, z: -2.4 }, look: { x: 0, y: 0, z: 3.35 }, fov: 48 },
  // His GTA idea, fitted so his whole body and both lane walls stay on screen (hard review, must-fix 2).
  3: { name: "YOUR GTA IDEA", eye: { x: 0.45, y: 1.9, z: -4.5 }, look: { x: 0, y: 0.6, z: 6 }, fov: 35 },
};
export const KEY_NAMES: Record<DodgeKey, string> = { 1: "LANE", 2: "MID", 3: "YOUR GTA IDEA", 4: "FIRST PERSON" };

/** Your turn: over your right shoulder, the ball at the bottom middle, the opponent's chest in the middle. */
export const THROW_CAM: Shot = { eye: { x: 0.35, y: 2.15, z: -1.7 }, look: { x: 0, y: 0.8, z: 8 }, fov: 32 };

/** Blend times between shots, ms. */
export const BLEND_MS = { toThrow: 700, toDodge: 900 };

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};

/** A smooth blend between two shots, k from 0 (a) to 1 (b). */
export function blendShot(a: Shot, b: Shot, k: number): Shot {
  const e = ease(k);
  return {
    eye: { x: mix(a.eye.x, b.eye.x, e), y: mix(a.eye.y, b.eye.y, e), z: mix(a.eye.z, b.eye.z, e) },
    look: { x: mix(a.look.x, b.look.x, e), y: mix(a.look.y, b.look.y, e), z: mix(a.look.z, b.look.z, e) },
    fov: mix(a.fov, b.fov, e),
  };
}

/**
 * Which shot the screen shows: the throw camera on your turn, the chosen dodge
 * camera otherwise, blending when the turn changes. Holds its own clock.
 */
export function createCameraRig(key: DodgeKey = 1) {
  let dodgeKey: DodgeKey = key;
  let current: "throw" | "dodge" = "dodge";
  let from: Shot | null = null;
  let since = 0;
  let last: Shot | null = null;
  const dodgeShot = (): Shot | null => (dodgeKey === 4 ? null : DODGE_PRESETS[dodgeKey]);
  return {
    key: () => dodgeKey,
    setKey(k: DodgeKey) {
      dodgeKey = k;
      from = null;
    },
    /**
     * The shot for now; null means first person. `throwing` is true on the
     * player's own turn. A ball coming at the player freezes the camera where it is.
     */
    shot(now: number, throwing: boolean, ballLive: boolean): Shot | null {
      const want: "throw" | "dodge" = throwing ? "throw" : "dodge";
      const target = want === "throw" ? THROW_CAM : dodgeShot();
      if (want !== current) {
        from = last;
        since = now;
        current = want;
      }
      if (!target) {
        last = null;
        return null;
      }
      if (ballLive && want === "dodge" && last && !from) return last;
      const ms = want === "throw" ? BLEND_MS.toThrow : BLEND_MS.toDodge;
      const k = from ? (now - since) / ms : 1;
      const shot = from && k < 1 ? blendShot(from, target, k) : target;
      if (k >= 1) from = null;
      last = shot;
      return shot;
    },
  };
}
export type CameraRig = ReturnType<typeof createCameraRig>;
