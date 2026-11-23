import type { Vec3 } from "../../pov/physics";
import { armTo } from "./aim";
import { chestAxes, gloveOf } from "./sampler";
import { SIZE, type Body, type GuardPlace, type Rig } from "./types";
import { add, dot, rotate, scale, smooth, sub, unit, v3 } from "./vec";

/**
 * Layers laid over the recorded motion. None of this is recorded: the
 * recordings hold one guard, nobody tired, nobody hurt and nobody hit. Each
 * is a small formula on top of whatever clip is playing, as the animation
 * study allows for layers (aim, breath, impact), and each is kept small so
 * the recorded motion still shows through.
 */

/** Being hit: the head and chest knocked by an offset from outside (reaction.ts), the spine keeping its lengths. Arms go with the chest. */
export function applyHit(b: Body, hit: { head: Vec3; chest: Vec3 } | null): Body {
  if (!hit) return b;
  const chest = add(b.hips, scale(unit(sub(add(b.chest, hit.chest), b.hips)), SIZE.chest));
  const by = sub(chest, b.chest);
  const head = add(chest, scale(unit(sub(add(add(b.head, by), hit.head), chest)), SIZE.head));
  const m = (p: Vec3) => add(p, by);
  return {
    ...b,
    chest,
    head,
    shoulders: [m(b.shoulders[0]), m(b.shoulders[1])],
    elbows: [m(b.elbows[0]), m(b.elbows[1])],
    wrists: [m(b.wrists[0]), m(b.wrists[1])],
  };
}

/**
 * Tired and hurt, on the trunk. Tired: it leans forward and the head comes
 * down. Hurt: the head hangs and the body sways slowly from side to side.
 */
export function slump(r: Rig, tired: number, hurt: number, time: number): Rig {
  if (tired <= 0 && hurt <= 0) return r;
  const DEG = Math.PI / 180;
  // About the line of the shoulders: positive tips the top forward.
  const forward = (d: Vec3, angle: number) => rotate(d, unit(r.across, v3(1, 0, 0)), angle);
  const sway = hurt * Math.sin(time * 2 * Math.PI * 0.6);
  let spine = forward(r.spine, (5 * tired - 3 * hurt) * DEG);
  // Sideways, about the way it faces.
  spine = rotate(spine, v3(0, 0, 1), 3 * DEG * sway);
  const neck = forward(r.neck, (6 * tired + 10 * hurt) * DEG);
  return { ...r, hips: v3(r.hips.x + 0.03 * sway, r.hips.y - 0.02 * hurt, r.hips.z), spine, neck };
}

/** How much of each place other than the chin a glove has moved to, 0 to 1; and how free the hand is to guard at all (0 while it punches). */
export interface GuardWeights {
  cover: number;
  low: number;
  down: number;
  free: number;
}
export const AT_CHIN: GuardWeights = { cover: 0, low: 0, down: 0, free: 1 };

/** Where the wrist goes for each place, in the chest's own axes, for the right hand (the left is mirrored). */
const PLACE: Record<Exclude<GuardPlace, "chin">, Vec3> = {
  // Lifted in front of the brow and temple.
  cover: v3(0.1, 0.2, 0.17),
  // Elbow down by the ribs, glove at the bottom of the chest.
  low: v3(0.17, -0.2, 0.16),
  // Hanging by the hip.
  down: v3(0.21, -0.5, 0.05),
};

/** A glove on its way from where it was to a place, begun at `since`. `punching`: the hand has left the guard altogether. */
export interface GuardMove {
  from: GuardWeights;
  to: GuardPlace;
  punching: boolean;
  since: number;
}
export const RESTING: GuardMove = { from: AT_CHIN, to: "chin", punching: false, since: -Infinity };

/** The weights at a time: it sets off gently and arrives gently, `seconds` after it began. */
export function guardAt(move: GuardMove, t: number, seconds: number): GuardWeights {
  const k = seconds <= 0 ? 1 : smooth((t - move.since) / seconds);
  const to = (from: number, on: boolean) => from + ((on ? 1 : 0) - from) * k;
  return {
    cover: to(move.from.cover, !move.punching && move.to === "cover"),
    low: to(move.from.low, !move.punching && move.to === "low"),
    down: to(move.from.down, !move.punching && move.to === "down"),
    free: to(move.from.free, !move.punching),
  };
}

/**
 * One glove of the guard moved toward the places the weights say, and
 * lowered by tiredness and hurt. With no weight and neither, the recorded
 * guard is left exactly as it is.
 */
export function placeGuard(b: Body, hand: 0 | 1, w: GuardWeights, tiredness: number, hurting: number): Body {
  const total = w.cover + w.low + w.down;
  // A punching hand is not lowered: it is the punch's.
  const tired = tiredness * w.free,
    hurt = hurting * w.free;
  if (total < 1e-4 && tired <= 0 && hurt <= 0) return b;
  const axes = chestAxes(sub(b.chest, b.hips), sub(b.shoulders[1], b.shoulders[0]));
  const side = hand ? 1 : -1;
  const rel = sub(b.wrists[hand], b.chest);
  let at = v3(dot(rel, axes.x), dot(rel, axes.y), dot(rel, axes.z));
  const toward = (place: Vec3, k: number) => {
    at = v3(at.x + (side * place.x - at.x) * k, at.y + (place.y - at.y) * k, at.z + (place.z - at.z) * k);
  };
  // One after another, so that weights that add to one land on the place.
  let left = 1;
  for (const key of ["cover", "low", "down"] as const) {
    const k = w[key];
    if (k <= 1e-4 || left <= 1e-4) continue;
    toward(PLACE[key], Math.min(1, k / left));
    left -= k;
  }
  // Tired hands hang lower; hurt ones lower still and apart.
  at = v3(at.x + side * 0.05 * hurt, at.y - 0.07 * tired - 0.1 * hurt, at.z - 0.03 * hurt);
  const wrist = add(b.chest, add(add(scale(axes.x, at.x), scale(axes.y, at.y)), scale(axes.z, at.z)));
  return armTo(b, hand, gloveOf(b.shoulders[hand], wrist));
}
