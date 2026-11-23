import { BODY, JOINT, twoBone, withinReach } from "./body";
import type { Vec3 } from "./physics";

/**
 * Feet that stay where they are put. The skeleton's ankles follow the hips, so
 * a body that sways or is moved by the dodge gain slid across the floor on
 * both feet. Here each foot holds its place on the floor until the body has
 * moved far enough from it, then takes a quick step to where it should be, one
 * foot at a time. A foot the camera sees lifted is left to the camera.
 *
 * Drawing only. Works on a body in the player's own frame.
 */
export const STEP = {
  /** A planted foot this far from where it should be takes a step. */
  drift: 0.11,
  /** Both feet step at once past this: the body is moving fast. */
  hurry: 0.3,
  /** Seconds a step takes, and how high the foot lifts in the middle of it. */
  time: 0.16,
  lift: 0.05,
  /** An ankle higher than this is in the air on the player's own account. */
  airborne: BODY.ankle + 0.05,
};
type Foot = {
  /** Where the foot is planted on the floor. */
  at: { x: number; z: number } | null;
  /** A step in progress. */
  step: { from: { x: number; z: number }; to: { x: number; z: number }; start: number } | null;
};

export function createFootPlanter() {
  const feet: [Foot, Foot] = [
    { at: null, step: null },
    { at: null, step: null },
  ];
  let lastTime = -Infinity;
  return {
    /** `time` in seconds. Returns a copy of `body` with planted ankles, knees and toes. */
    update(body: readonly Vec3[], time: number): Vec3[] {
      const out = body.map((p) => ({ ...p }));
      // A new round or a long gap: stand where the body is.
      if (time < lastTime || time - lastTime > 0.5)
        for (const foot of feet) foot.at = foot.step = null;
      lastTime = time;
      const drift = [0, 1].map((i) => {
        const want = body[JOINT.L_ANKLE + i],
          at = feet[i].at;
        return at ? Math.hypot(want.x - at.x, want.z - at.z) : 0;
      });
      for (let i = 0; i < 2; i++) {
        const foot = feet[i],
          other = feet[1 - i];
        const ankle = JOINT.L_ANKLE + i,
          knee = JOINT.L_KNEE + i,
          hip = JOINT.L_HIP + i,
          toe = JOINT.L_TOE + i;
        const want = body[ankle];
        if (!foot.at || want.y > STEP.airborne) {
          // First sight, or a foot the player lifted: it is where it is seen.
          foot.at = { x: want.x, z: want.z };
          foot.step = null;
          continue;
        }
        if (
          !foot.step &&
          drift[i] > STEP.drift &&
          // One foot at a time, the one further out first, unless hurried.
          ((!other.step && drift[i] >= drift[1 - i]) || drift[i] > STEP.hurry)
        )
          foot.step = { from: foot.at, to: { x: want.x, z: want.z }, start: time };
        let lift = 0;
        if (foot.step) {
          // The step lands where the foot should be now, not where it should
          // have been when the step began.
          foot.step.to = { x: want.x, z: want.z };
          const u = Math.min(1, (time - foot.step.start) / STEP.time);
          const k = u * u * (3 - 2 * u);
          foot.at = {
            x: foot.step.from.x + (foot.step.to.x - foot.step.from.x) * k,
            z: foot.step.from.z + (foot.step.to.z - foot.step.from.z) * k,
          };
          lift = STEP.lift * Math.sin(Math.PI * u);
          if (u >= 1) foot.step = null;
        }
        // A foot further out than the leg can reach is drawn in along the
        // floor, not lifted off it.
        const height = want.y + lift;
        const reach = BODY.thigh + BODY.shin;
        const drop = out[hip].y - height;
        const span = Math.sqrt(Math.max(0, reach * reach - drop * drop));
        const dx = foot.at.x - out[hip].x,
          dz = foot.at.z - out[hip].z;
        const flat = Math.hypot(dx, dz);
        const k = flat > span && flat > 1e-6 ? span / flat : 1;
        const placed = withinReach(
          out[hip],
          { x: out[hip].x + dx * k, y: height, z: out[hip].z + dz * k },
          reach,
        );
        // Keep the knee bending the way it was.
        const mid = {
          x: (body[hip].x + body[ankle].x) / 2,
          y: (body[hip].y + body[ankle].y) / 2,
          z: (body[hip].z + body[ankle].z) / 2,
        };
        const pole = {
          x: body[knee].x - mid.x,
          y: body[knee].y - mid.y,
          z: Math.max(0.15, body[knee].z - mid.z),
        };
        out[toe] = {
          x: placed.x + (body[toe].x - body[ankle].x),
          y: body[toe].y + (placed.y - body[ankle].y),
          z: placed.z + (body[toe].z - body[ankle].z),
        };
        out[ankle] = placed;
        out[knee] = twoBone(out[hip], placed, BODY.thigh, BODY.shin, pole);
      }
      return out;
    },
    /** True while that foot is flat on the floor (not mid-step, not lifted). */
    planted: (i: 0 | 1) => feet[i].at !== null && feet[i].step === null,
    reset() {
      for (const foot of feet) foot.at = foot.step = null;
      lastTime = -Infinity;
    },
  };
}
