import type { PlayerPose } from "./duel";
import type { Vec3 } from "./physics";

/**
 * Tracking that returns after a loss puts the body somewhere else in one frame:
 * the view and the avatar popped. This carries the difference between what was
 * last drawn and the new pose, and lets it die away over a fifth of a second,
 * so every discontinuity becomes a short glide. Drawing only: hits and throws
 * use the measured pose.
 */
export function createInertialBlend(ms = 180) {
  type Offset = {
    head: Vec3;
    root: Vec3;
    leftHand: Vec3;
    rightHand: Vec3;
    body?: Vec3[];
  };
  let target: PlayerPose | null = null;
  let shown: PlayerPose | null = null;
  let offset: Offset | null = null;
  let since = 0;
  let lastNow = -Infinity;
  const sub = (a: Vec3, b: Vec3): Vec3 => ({
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  });
  const lean = (a: Vec3, o: Vec3, k: number): Vec3 => ({
    x: a.x + o.x * k,
    y: a.y + o.y * k,
    z: a.z + o.z * k,
  });
  const far = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return {
    /**
     * `cut` marks a known discontinuity (tracking just came back). A jump no
     * body could make is treated as one too.
     */
    update(next: PlayerPose, now: number, cut = false): PlayerPose {
      const dt = (now - lastNow) / 1000;
      lastNow = now;
      const jumped =
        target !== null &&
        dt > 0 &&
        [
          far(next.head, target.head),
          far(next.root, target.root),
        ].some((d) => d > 0.08 && d / dt > 8);
      if (shown && (cut || jumped)) {
        const from = shown;
        offset = {
          head: sub(from.head, next.head),
          root: sub(from.root, next.root),
          leftHand: sub(from.leftHand, next.leftHand),
          rightHand: sub(from.rightHand, next.rightHand),
          ...(from.body && next.body && from.body.length === next.body.length
            ? { body: from.body.map((p, i) => sub(p, next.body![i])) }
            : {}),
        };
        since = now;
      }
      target = next;
      let out = next;
      if (offset) {
        const u = Math.max(0, Math.min(1, (now - since) / ms));
        // Starts at the full difference and lands with no speed left.
        const k = 1 - u * u * (3 - 2 * u);
        if (k <= 0) offset = null;
        else {
          const o = offset;
          out = {
            head: lean(next.head, o.head, k),
            root: lean(next.root, o.root, k),
            leftHand: lean(next.leftHand, o.leftHand, k),
            rightHand: lean(next.rightHand, o.rightHand, k),
            ...(next.body
              ? {
                  body: next.body.map((p, i) =>
                    o.body ? lean(p, o.body[i], k) : p,
                  ),
                }
              : {}),
          };
        }
      }
      shown = out;
      return out;
    },
    reset() {
      target = shown = null;
      offset = null;
      lastNow = -Infinity;
    },
  };
}
