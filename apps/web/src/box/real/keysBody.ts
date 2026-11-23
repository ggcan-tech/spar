import { BODY, twoBone } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import type { Hand, PunchShape } from "../punch";
import { ME, type Me3D } from "./body3d";

/**
 * A body for the keyboard: the same kind of body the camera gives, moved by
 * keys. A key does not "land a punch": it throws an arm, and the glove goes
 * through the room and meets what it meets, like a real one. So the keyboard
 * and the tests go through the very same contact as a person does.
 */
const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
const mix = (a: Vec3, b: Vec3, k: number): Vec3 => add(a, mul(sub(b, a), k));
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
/** A thrown arm: out, a held instant, back. Milliseconds. */
export const KEY_PUNCH = { out: 110, hold: 40, back: 170 };
/** How far from its shoulder a keyboard glove may get, leaning in behind it: a straight further than a hook or an uppercut. */
const REACH: Record<PunchShape, number> = { straight: 1.12, hook: 0.86, uppercut: 0.86 };
export interface KeyState {
  slip: -1 | 0 | 1;
  duck: boolean;
  high: boolean;
  low: boolean;
  back: boolean;
}
export function createKeysBody() {
  const bones = { upperArm: BODY.upperArm, foreArm: BODY.foreArm };
  const flying: ({ shape: PunchShape; at: number; to: Vec3 } | null)[] = [null, null];
  let head = v(0, 1.65, ME.eyeForward);
  let last = -Infinity;
  return {
    /** Throw this hand at a point in the room (where the opponent is drawn). */
    punch(hand: Hand, shape: PunchShape, to: Vec3, now: number) {
      flying[hand === "left" ? 0 : 1] = { shape, at: now, to };
    },
    update(now: number, k: KeyState): Me3D {
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      const want = v(k.slip * 0.28, 1.65 - (k.duck ? 0.32 : 0), ME.eyeForward - (k.back ? 0.25 : 0));
      head = mix(head, want, Math.min(1, dt * 16));
      const hips = v(head.x * 0.3, 1 - (k.duck ? 0.18 : 0), head.z - ME.eyeForward);
      const shoulders: Vec3[] = [],
        elbows: Vec3[] = [],
        wrists: Vec3[] = [],
        gloves: Vec3[] = [];
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        let S = v(head.x + side * 0.19, head.y - 0.27, head.z - ME.eyeForward);
        // Where the glove rests: by the chin, lifted to cover, or down at the ribs.
        const rest = add(head, k.high ? v(side * 0.09, -0.03, 0.2) : k.low ? v(side * 0.14, -0.45, 0.2) : v(side * 0.11, -0.19, 0.22));
        let glove = rest;
        const f = flying[i];
        if (f) {
          const t = now - f.at;
          const total = KEY_PUNCH.out + KEY_PUNCH.hold + KEY_PUNCH.back;
          if (t >= total) flying[i] = null;
          else {
            const out = t < KEY_PUNCH.out ? 1 - (1 - t / KEY_PUNCH.out) ** 2 : t < KEY_PUNCH.out + KEY_PUNCH.hold ? 1 : 1 - (t - KEY_PUNCH.out - KEY_PUNCH.hold) / KEY_PUNCH.back;
            // No further than this arm, leaning in, can get.
            const line = sub(f.to, S);
            const far = len(line);
            const to = far > REACH[f.shape] ? add(S, mul(line, REACH[f.shape] / far)) : f.to;
            glove = mix(rest, to, out);
            // A hook comes round from its own side; an uppercut comes up from below.
            const arc = Math.sin(Math.PI * Math.min(1, out)) * (1 - out * 0.5);
            if (f.shape === "hook") glove = add(glove, v(side * 0.24 * arc, 0, -0.05 * arc));
            else if (f.shape === "uppercut") glove = add(glove, v(0, -0.2 * arc, 0));
            // The shoulder goes with it as far as the arm is short.
            const need = len(sub(glove, S)) - (bones.upperArm + bones.foreArm + ME.hand);
            if (need > 0) S = add(S, mul(sub(glove, S), need / len(sub(glove, S))));
          }
        }
        const arm = sub(glove, S);
        const wrist = add(S, mul(arm, Math.max(0, len(arm) - ME.hand) / Math.max(1e-6, len(arm))));
        const elbow = twoBone(S, wrist, bones.upperArm, bones.foreArm, v(side * 0.35, -1, -0.3));
        shoulders.push(S);
        elbows.push(elbow);
        wrists.push(wrist);
        gloves.push(glove);
      }
      return {
        t: now,
        head,
        hips,
        shoulders: shoulders as [Vec3, Vec3],
        elbows: elbows as [Vec3, Vec3],
        wrists: wrists as [Vec3, Vec3],
        gloves: gloves as [Vec3, Vec3],
        seen: [true, true],
        solved: true,
        bones,
        pointing: [flying[0] ? 1 : 0, flying[1] ? 1 : 0],
      };
    },
    /** A hand that is out. */
    busy: (): [boolean, boolean] => [flying[0] !== null, flying[1] !== null],
    reset() {
      flying[0] = flying[1] = null;
    },
  };
}
