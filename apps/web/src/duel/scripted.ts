import { JOINT, JOINT_COUNT } from "../pov/body";
import type { SyntheticMotion } from "../pov/syntheticBody";
import { p2, type FlatPose, type P2, type Side } from "./body";

/**
 * Scripted bodies for tests and for checking pages without a camera. They say
 * nothing about how a real camera reads a real person: that is what the
 * founder's recordings are for.
 */

/** A flat pose built from hand positions, metres against the hips. */
export interface FlatSpec {
  t: number;
  /** The sling hand and the pulling hand, against the hips (x the player's right). */
  left: P2;
  right: P2;
  root?: P2;
  /** Hips lowered by this much (travel), metres. */
  duck?: number;
  held?: boolean;
  /** Weights of the wrists; 1 when seen. */
  seen?: [number, number];
}
export const SHOULDER = { half: 0.18, y: 0.47 };

export function flatAt(s: FlatSpec): FlatPose {
  const j: P2[] = Array.from({ length: JOINT_COUNT }, () => p2());
  j[JOINT.L_HIP] = p2(-0.1, 0);
  j[JOINT.R_HIP] = p2(0.1, 0);
  j[JOINT.L_SHOULDER] = p2(-SHOULDER.half, SHOULDER.y);
  j[JOINT.R_SHOULDER] = p2(SHOULDER.half, SHOULDER.y);
  j[JOINT.NOSE] = p2(0, SHOULDER.y + 0.17);
  j[JOINT.L_EAR] = p2(-0.07, SHOULDER.y + 0.18);
  j[JOINT.R_EAR] = p2(0.07, SHOULDER.y + 0.18);
  j[JOINT.L_WRIST] = s.left;
  j[JOINT.R_WRIST] = s.right;
  j[JOINT.L_ELBOW] = p2((j[JOINT.L_SHOULDER].x + s.left.x) / 2, (j[JOINT.L_SHOULDER].y + s.left.y) / 2 - 0.04);
  j[JOINT.R_ELBOW] = p2((j[JOINT.R_SHOULDER].x + s.right.x) / 2, (j[JOINT.R_SHOULDER].y + s.right.y) / 2 - 0.04);
  const w = Array<number>(JOINT_COUNT).fill(1);
  if (s.seen) {
    w[JOINT.L_WRIST] = s.seen[0];
    w[JOINT.R_WRIST] = s.seen[1];
  }
  const root = s.root ?? p2();
  return {
    t: s.t,
    cap: s.t,
    j,
    w,
    root: p2(root.x, root.y - (s.duck ?? 0)),
    metres: 0.78,
    edges: [
      { side: 0.6, top: 0.5 },
      { side: 0.6, top: 0.5 },
    ],
    held: !!s.held,
  };
}

/** Where the hands are in each part of a sling shot, against the hips, for a sling arm on `side`. */
export function slingHands(side: Side, part: "rest" | "nock" | "draw" | "flicked", lift = 0.0): { left: P2; right: P2 } {
  const dir = side === "left" ? -1 : 1;
  const chin = p2(0.04 * -dir, SHOULDER.y + 0.08);
  const sling = p2(dir * (SHOULDER.half + 0.56), SHOULDER.y + lift);
  const rest = { left: p2(-0.24, -0.02), right: p2(0.24, -0.02) };
  let s: P2, pull: P2;
  if (part === "rest") return rest;
  if (part === "nock") {
    s = p2(dir * 0.05, SHOULDER.y - 0.12);
    pull = p2(-dir * 0.05, SHOULDER.y - 0.12);
  } else if (part === "draw") {
    s = sling;
    pull = chin;
  } else {
    s = sling;
    pull = p2(chin.x - dir * 0.24, chin.y + 0.05);
  }
  return side === "left" ? { left: s, right: pull } : { left: pull, right: s };
}

const ease = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
const mixP = (a: P2, b: P2, k: number) => p2(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);

/** The hands along one shot: rest, nock, draw, hold, flick, rest. Times in seconds from the shot's start. */
export const SHOT = { nock: 0.5, draw: 0.9, hold: 1.5, flick: 1.58, rest: 2.3 };
export function slingShotAt(side: Side, s: number, lift = 0): { left: P2; right: P2 } {
  const rest = slingHands(side, "rest"),
    nock = slingHands(side, "nock"),
    draw = slingHands(side, "draw", lift),
    flicked = slingHands(side, "flicked", lift);
  const mixH = (a: typeof rest, b: typeof rest, k: number) => ({ left: mixP(a.left, b.left, ease(k)), right: mixP(a.right, b.right, ease(k)) });
  if (s < SHOT.nock) return mixH(rest, nock, s / SHOT.nock);
  if (s < SHOT.draw) return mixH(nock, draw, (s - SHOT.nock) / (SHOT.draw - SHOT.nock));
  if (s < SHOT.hold) return draw;
  if (s < SHOT.flick) return mixH(draw, flicked, (s - SHOT.hold) / (SHOT.flick - SHOT.hold));
  if (s < SHOT.rest) return mixH(flicked, rest, (s - SHOT.flick) / (SHOT.rest - SHOT.flick));
  return rest;
}

/**
 * The scripted person for `?duel=1&scripted`: in person space (the pov
 * synthetic body: hands against their shoulders, metres, +z toward the camera).
 * Left arm is the sling. A shot every 4 s, a duck now and then, a step.
 */
export function slingRoutine(seconds: number): SyntheticMotion {
  const cycle = 4;
  const k = seconds % cycle;
  const n = Math.floor(seconds / cycle);
  const lift = [0, 0.12, 0.25, 0.05][n % 4];
  const hands = slingShotAt("left", k, lift);
  // From hips-relative flat hands to the synthetic body's hands against their own shoulders.
  const toShoulder = (h: P2, side: -1 | 1) => ({ x: h.x - side * 0.185, y: h.y - 0.48, z: 0.06 });
  const duck = k > 2.6 && k < 3.6 && n % 2 === 1 ? 0.22 * Math.sin(((k - 2.6) / 1.0) * Math.PI) : 0;
  return {
    leftHand: toShoulder(hands.left, -1),
    rightHand: toShoulder(hands.right, 1),
    crouch: duck,
    step: 0.25 * Math.sin(seconds * 0.4),
    hideLegs: true,
  };
}
