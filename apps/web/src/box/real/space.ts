import { twoBone } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import type { FoePose } from "../opponentPose";
import type { Me3D } from "./body3d";

/**
 * Real contact. Two bodies in one room, in the same units: a punch lands
 * when a glove reaches a head or a body, where it reaches it, going the way
 * it was going. It is stopped when it meets a glove or a forearm first.
 * Nothing here knows what a "jab" is or which "zone" it went to.
 *
 * The player's room: origin at their spot, +x their right, +y up, +z toward
 * the opponent. The opponent's own frame (FoePose) has its origin between
 * its feet, +x its right, +z toward the player; it stands `distance` away.
 *
 * What one camera gives is good across the picture and fair in depth with
 * the arm out (see body3d.ts), so:
 * - the player's punch is a ball swept through the room against the
 *   opponent's shapes, with a little kindness on the size of what can be hit;
 * - the opponent's punch against the player's guard is judged in the plane
 *   facing it, where the player's gloves are known to the centimetre: the
 *   glove is on the line or it is not. How far in front of the face a guard
 *   glove is held is the one thing the camera cannot say, and is not asked.
 */
export interface Ball {
  c: Vec3;
  r: number;
}
export interface Stick {
  a: Vec3;
  b: Vec3;
  r: number;
}
export interface FoeShape {
  head: Ball;
  /** Hips to the base of the neck. */
  trunk: Stick;
  /** [its left, its right] */
  gloves: [Ball, Ball];
  /** Elbow to glove. */
  arms: [Stick, Stick];
}
export const SIZE = {
  head: 0.115,
  trunk: 0.15,
  glove: 0.1,
  arm: 0.05,
  /** The player's own glove. */
  mine: 0.09,
  /** Added to its head and body, not to its guard: doubt goes to the player. */
  kind: 0.03,
  /** A glove that passed this near its guard on the way in was partly stopped. */
  graze: 0.04,
  /** How far along a punch's path is looked at a time. */
  step: 0.015,
};
const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mix = (a: Vec3, b: Vec3, k: number): Vec3 => v(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
/** The nearest point of the stick's middle line to `p`. */
function nearestOn(p: Vec3, s: Stick): Vec3 {
  const d = sub(s.b, s.a);
  const l2 = d.x * d.x + d.y * d.y + d.z * d.z;
  const k = l2 > 1e-9 ? clamp(((p.x - s.a.x) * d.x + (p.y - s.a.y) * d.y + (p.z - s.a.z) * d.z) / l2, 0, 1) : 0;
  return mix(s.a, s.b, k);
}

/** A point of the opponent's own frame in the player's room. */
export const foeToRoom = (p: Vec3, distance: number): Vec3 => v(-p.x, p.y, distance - p.z);
/** A direction of the player's room in the opponent's own frame. */
export const roomToFoeDir = (d: Vec3): Vec3 => v(-d.x, d.y, -d.z);

/** The opponent's body as shapes in the player's room. */
export function foeShape(pose: FoePose, distance: number): FoeShape {
  const at = (p: Vec3) => foeToRoom(p, distance);
  const gloves = pose.gloves.map((g) => ({ c: at(g), r: SIZE.glove })) as [Ball, Ball];
  const arms = pose.gloves.map((g, i) => {
    const shoulder = pose.shoulders[i];
    // As it is drawn: the wrist a tenth of the way back from the glove, the elbow by its pole.
    const wrist = mix(g, shoulder, 0.1);
    const elbow = twoBone(shoulder, wrist, 0.3, 0.28, pose.poles[i]);
    return { a: at(elbow), b: at(g), r: SIZE.arm };
  }) as [Stick, Stick];
  return {
    head: { c: at(pose.head), r: SIZE.head },
    trunk: { a: at(pose.hips), b: at(v(pose.chest.x, pose.chest.y + 0.04, pose.chest.z)), r: SIZE.trunk },
    gloves,
    arms,
  };
}

export interface Touch {
  /** What the glove met first. */
  what: "head" | "body" | "glove" | "arm";
  /** Which of its gloves or arms, [its left, its right]; null for head and body. */
  which: 0 | 1 | null;
  /** How far along the path, 0 to 1. */
  k: number;
  /** Where the middle of the player's glove was then, in the room. */
  at: Vec3;
  /** From the middle of what was hit to the glove, in the room: which side of it was hit. */
  off: Vec3;
  /** On the way in it brushed the guard: 0 not at all, up to 1 nearly stopped. */
  grazed: number;
}
/**
 * The player's glove carried from `from` to `to`: what it meets first, if
 * anything. A glove that is already inside something at `from` has met it
 * before, and that thing is not met again.
 */
export function sweep(from: Vec3, to: Vec3, shape: FoeShape, r: number = SIZE.mine): Touch | null {
  const steps = Math.max(1, Math.min(60, Math.ceil(len(sub(to, from)) / SIZE.step)));
  const within = (p: Vec3) => {
    const found: { what: Touch["what"]; which: 0 | 1 | null; depth: number; c: Vec3 }[] = [];
    let nearGuard = Infinity;
    for (const i of [0, 1] as const) {
      const g = shape.gloves[i];
      const dg = len(sub(p, g.c)) - g.r - r;
      const mid = nearestOn(p, shape.arms[i]);
      const da = len(sub(p, mid)) - shape.arms[i].r - r;
      nearGuard = Math.min(nearGuard, dg, da);
      if (dg <= 0) found.push({ what: "glove", which: i, depth: -dg, c: g.c });
      else if (da <= 0) found.push({ what: "arm", which: i, depth: -da, c: mid });
    }
    const dh = len(sub(p, shape.head.c)) - shape.head.r - SIZE.kind - r;
    if (dh <= 0) found.push({ what: "head", which: null, depth: -dh, c: shape.head.c });
    const spine = nearestOn(p, shape.trunk);
    const db = len(sub(p, spine)) - shape.trunk.r - SIZE.kind - r;
    if (db <= 0) found.push({ what: "body", which: null, depth: -db, c: spine });
    return { found, nearGuard };
  };
  const already = new Set(within(from).found.map((f) => `${f.what}${f.which}`));
  let closest = Infinity;
  for (let n = 1; n <= steps; n++) {
    const k = n / steps;
    const p = mix(from, to, k);
    const { found, nearGuard } = within(p);
    closest = Math.min(closest, nearGuard);
    const fresh = found.filter((f) => !already.has(`${f.what}${f.which}`));
    if (!fresh.length) continue;
    // Its guard is met before what is behind it.
    const first = fresh.find((f) => f.what === "glove" || f.what === "arm") ?? fresh[0];
    const body = first.what === "head" || first.what === "body";
    return {
      what: first.what,
      which: first.which,
      k,
      at: p,
      off: sub(p, first.c),
      grazed: body ? clamp(1 - closest / SIZE.graze, 0, 1) : 0,
    };
  }
  return null;
}

/**
 * How much of one of its punches the player's guard keeps out, 0 to 1,
 * judged in the plane facing the opponent. `to` is where its glove arrives
 * (the room's x and y); `from`, for a hook or an uppercut, where its line
 * comes from in that plane: anything on the line stops it. A straight punch
 * comes down the line of sight and is a point. A hand that is out punching
 * guards nothing.
 */
export function coverOf(me: Me3D, to: { x: number; y: number }, from: { x: number; y: number } | null, out: readonly [boolean, boolean]): number {
  const start = from ?? to;
  let best = 0;
  /** From the punch's line to the nearest point of a line of the player's, in the plane. */
  const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    let least = Infinity;
    for (let n = 0; n <= 8; n++) {
      const px = start.x + ((to.x - start.x) * n) / 8,
        py = start.y + ((to.y - start.y) * n) / 8;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const k = l2 > 1e-9 ? clamp(((px - a.x) * dx + (py - a.y) * dy) / l2, 0, 1) : 0;
      least = Math.min(least, Math.hypot(px - (a.x + dx * k), py - (a.y + dy * k)));
    }
    return least;
  };
  for (let i = 0; i < 2; i++) {
    if (out[i] || !me.seen[i]) continue;
    // Its glove and the player's: wholly on it when their middles are within a third of a glove, not at all when they only touch edges.
    const glove = apart(me.gloves[i], me.gloves[i]);
    best = Math.max(best, clamp((SIZE.glove + SIZE.mine - glove) / (SIZE.glove + SIZE.mine - 0.06), 0, 1));
    // The forearm is narrower and takes less.
    const arm = apart(me.elbows[i], me.wrists[i]);
    best = Math.max(best, 0.8 * clamp((SIZE.glove + SIZE.arm - arm) / (SIZE.glove + SIZE.arm - 0.04), 0, 1));
  }
  return best;
}
