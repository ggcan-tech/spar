import type { DuelState, PlayerPose } from "./duel";
import type { Vec3 } from "./physics";
import { blendBody } from "./body";

/** Render-only arrival-time interpolation. Never extrapolates or changes authority. */
export function createSnapshotBuffer({
  delayMs = 50,
}: { delayMs?: number } = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 500)
    throw new RangeError("delayMs must be within [0, 500]");
  let frames: { state: DuelState; at: number }[] = [];
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const vector = (a: Vec3, b: Vec3, t: number): Vec3 => ({
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    z: mix(a.z, b.z, t),
  });
  const pose = (a: PlayerPose, b: PlayerPose, t: number): PlayerPose => {
    const body = blendBody(a.body, b.body, t);
    return {
      head: vector(a.head, b.head, t),
      root: vector(a.root, b.root, t),
      leftHand: vector(a.leftHand, b.leftHand, t),
      rightHand: vector(a.rightHand, b.rightHand, t),
      ...(body ? { body } : {}),
    };
  };
  return {
    reset() {
      frames = [];
    },
    push(state: DuelState, arrivalMs: number) {
      if (!Number.isFinite(arrivalMs) || !Number.isFinite(state.time))
        throw new RangeError("Snapshot times must be finite");
      const last = frames.at(-1);
      // A new round or clock discontinuity must not blend unrelated worlds.
      if (last && (arrivalMs < last.at || state.time < last.state.time))
        frames = [];
      const snapshot = { state: structuredClone(state), at: arrivalMs };
      if (frames.at(-1)?.at === arrivalMs) frames[frames.length - 1] = snapshot;
      else frames.push(snapshot);
      if (frames.length > 8) frames.shift();
    },
    sample(nowMs: number): DuelState | null {
      if (!Number.isFinite(nowMs))
        throw new RangeError("Presentation time must be finite");
      if (!frames.length) return null;
      const latest = frames[frames.length - 1].state,
        target = nowMs - delayMs;
      let left = frames[0],
        right = left;
      if (target >= frames[frames.length - 1].at)
        left = right = frames[frames.length - 1];
      else
        for (let i = 1; i < frames.length; i++) {
          if (target < frames[i].at) {
            left = frames[i - 1];
            right = frames[i];
            break;
          }
        }
      const t =
        right.at > left.at
          ? Math.max(0, Math.min(1, (target - left.at) / (right.at - left.at)))
          : 0;
      const out = structuredClone(latest);
      out.time = mix(left.state.time, right.state.time, t);
      out.poses = [
        pose(left.state.poses[0], right.state.poses[0], t),
        pose(left.state.poses[1], right.state.poses[1], t),
      ];
      out.previous = structuredClone(out.poses);
      const rightBalls = new Map(right.state.balls.map((b) => [b.id, b]));
      const alive = new Set(latest.balls.map((b) => b.id));
      // Spawn at its first snapshot, never before. Despawn immediately when authority
      // removes an ID, so an already-scored hit cannot resurrect a projectile.
      out.balls = left.state.balls
        .filter((b) => alive.has(b.id))
        .map((a) => {
          const b = rightBalls.get(a.id);
          return b
            ? {
                ...a,
                position: vector(a.position, b.position, t),
                velocity: vector(a.velocity, b.velocity, t),
                spin: vector(a.spin, b.spin, t),
                age: mix(a.age, b.age, t),
              }
            : structuredClone(a);
        });
      return out;
    },
  };
}
