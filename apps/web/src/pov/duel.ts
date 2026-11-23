import {
  stepBall,
  sweptMovingSphereHit,
  type BallPhysics,
  type BallState,
  type Vec3,
} from "./physics";
import { blendBody, validBody } from "./body";

/** SI world. Player-local +x is their right, +z is forward. No camera pixel coordinates here. */
export interface PlayerPose {
  head: Vec3;
  root: Vec3;
  leftHand: Vec3;
  rightHand: Vec3;
  /**
   * Optional full skeleton in JOINT order (see body.ts), player-local like the
   * points above. Presentation only: collisions still use head and root.
   */
  body?: Vec3[];
}
export interface ThrowInput {
  origin: Vec3;
  velocity: Vec3;
  spin: Vec3;
}
export interface DuelBall extends BallState {
  id: number;
  owner: 0 | 1;
  age: number;
}
export interface DuelEvent {
  id: number;
  /** "catch": the target took the ball out of the air with both hands. */
  kind: "hit" | "floor" | "out" | "catch";
  target: 0 | 1;
  position: Vec3;
  at: number;
}
export interface DuelState {
  time: number;
  poses: [PlayerPose, PlayerPose];
  previous: [PlayerPose, PlayerPose];
  balls: DuelBall[];
  hp: [number, number];
  cooldown: [number, number];
  nextId: number;
  message: string;
  hits: number;
  misses: number;
  events?: DuelEvent[];
  rally?: { turn: 0 | 1; phase: "ready" | "flight"; readyAt: number };
  /** Game time at which each player's hands were last apart (see CATCH). */
  handsApartAt?: [number, number];
  /** The court's ball physics; absent means the real-world default. */
  physics?: Readonly<BallPhysics>;
}
/**
 * The two-hand catch: a second answer to an incoming ball besides dodging.
 * Both hands must close on the ball as it arrives. Hands parked together in
 * front of the face are not a catch, so they must have been apart a moment
 * before; and each must be at the ball, sideways and in height, when it comes
 * within reach. Depth is not used for the hands: one camera does not measure
 * it well enough. Numbers are design guesses, to be tuned by playing.
 */
export const CATCH = {
  /** Hands farther apart than this are open. */
  apart: 0.5,
  /** Hands this close have closed on something. */
  together: 0.42,
  /** They must have been open this recently, seconds. */
  window: 0.3,
  /** Each hand within this of the ball's centre, sideways and in height. */
  reach: 0.32,
  /** The ball can be caught from this far in front of the hips down to this far. */
  far: 0.75,
  near: 0.1,
  /** A caught ball may be thrown back this soon; any other after 0.6 s. */
  readyIn: 0.15,
};
const handGap = (p: PlayerPose) =>
  Math.hypot(p.leftHand.x - p.rightHand.x, p.leftHand.y - p.rightHand.y);
/** A world point in a player's own frame: the inverse of worldPoint. */
export function localPoint(v: Vec3, player: 0 | 1): Vec3 {
  return player === 0
    ? { x: v.x, y: v.y, z: -v.z }
    : { x: -v.x, y: v.y, z: v.z + COURT_DISTANCE };
}
export const TRAINING_PACE = {
  practice: { label: "Practice", flight: 0.9, interval: 2.4 },
  duel: { label: "Duel", flight: 0.62, interval: 1.65 },
} as const;
export type TrainingPace = keyof typeof TRAINING_PACE;
export const COURT_DISTANCE = 8;
export const FIXED_STEP = 1 / 120;
export const COURT = { halfWidth: 0.6, halfDepth: 0.25, headHalfWidth: 0.85 };
/**
 * The wide lane of CORE.md 2.5: ±1.6 m for the hips, ±2.05 m for a leaning
 * head. Set once, before the scene is made, by the pages that use it.
 */
export function useWideCourt(on: boolean) {
  COURT.halfWidth = on ? 1.6 : 0.6;
  COURT.headHalfWidth = on ? 2.05 : 0.85;
}
export const neutralPose = (): PlayerPose => ({
  head: { x: 0, y: 1.65, z: 0 },
  root: { x: 0, y: 1, z: 0 },
  leftHand: { x: -0.25, y: 1.35, z: 0.65 },
  rightHand: { x: 0.25, y: 1.35, z: 0.65 },
});
export function createDuel(): DuelState {
  return {
    time: 0,
    poses: [neutralPose(), neutralPose()],
    previous: [neutralPose(), neutralPose()],
    balls: [],
    hp: [5, 5],
    cooldown: [0, 0],
    nextId: 1,
    message: "Read the release. Move into the gap.",
    hits: 0,
    misses: 0,
    events: [],
  };
}
/** One ball, alternating possession. Omitted rally retains the physics sandbox. */
export function createRally(first: 0 | 1 = 1, delay = 2.2): DuelState {
  return {
    ...createDuel(),
    rally: { turn: first, phase: "ready", readyAt: delay },
  };
}
export function ownsBall(s: DuelState, player: 0 | 1): boolean {
  return (
    s.hp.every((hp) => hp > 0) &&
    (!s.rally || (s.rally.turn === player && s.rally.phase === "ready"))
  );
}
export function canRelease(s: DuelState, player: 0 | 1): boolean {
  return (
    ownsBall(s, player) &&
    s.cooldown[player] <= s.time &&
    (!s.rally || s.time >= s.rally.readyAt)
  );
}
export function worldPoint(v: Vec3, player: 0 | 1): Vec3 {
  return player === 0
    ? { x: v.x, y: v.y, z: -v.z }
    : { x: -v.x, y: v.y, z: -COURT_DISTANCE + v.z };
}
export function worldVector(v: Vec3, player: 0 | 1): Vec3 {
  return player === 0
    ? { x: v.x, y: v.y, z: -v.z }
    : { x: -v.x, y: v.y, z: v.z };
}
const finite = (p: Vec3) => p && [p.x, p.y, p.z].every(Number.isFinite);
export function validPose(p: PlayerPose): boolean {
  return (
    !!p &&
    [p.head, p.root, p.leftHand, p.rightHand].every(finite) &&
    Math.abs(p.root.x) <= COURT.halfWidth &&
    Math.abs(p.root.z) <= COURT.halfDepth &&
    Math.abs(p.head.x) <= COURT.headHalfWidth &&
    Math.abs(p.head.z) <= 0.5 &&
    p.head.y >= 0.2 &&
    p.head.y <= 3.1 &&
    p.root.y >= 0.1 &&
    p.root.y <= 2.2 &&
    [p.leftHand, p.rightHand].every(
      (h) => Math.hypot(h.x - p.root.x, h.y - p.root.y, h.z - p.root.z) <= 1.6,
    ) &&
    (p.body === undefined || validBody(p.body, p.root))
  );
}
export function copyPose(p: PlayerPose): PlayerPose {
  return {
    head: { ...p.head },
    root: { ...p.root },
    leftHand: { ...p.leftHand },
    rightHand: { ...p.rightHand },
    ...(p.body ? { body: p.body.map((j) => ({ ...j })) } : {}),
  };
}
/** Linear blend of every point, including the skeleton when both poses carry one. */
export function blendPose(a: PlayerPose, b: PlayerPose, t: number): PlayerPose {
  const mix = (x: Vec3, y: Vec3): Vec3 => ({
    x: x.x + (y.x - x.x) * t,
    y: x.y + (y.y - x.y) * t,
    z: x.z + (y.z - x.z) * t,
  });
  const body = blendBody(a.body, b.body, t);
  return {
    head: mix(a.head, b.head),
    root: mix(a.root, b.root),
    leftHand: mix(a.leftHand, b.leftHand),
    rightHand: mix(a.rightHand, b.rightHand),
    ...(body ? { body } : {}),
  };
}
export function launchBall(
  s: DuelState,
  player: 0 | 1,
  shot: ThrowInput,
): DuelState {
  if (
    !canRelease(s, player) ||
    !shot ||
    ![shot.origin, shot.velocity, shot.spin].every(finite)
  )
    return s;
  const speed = Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z),
    spin = Math.hypot(shot.spin.x, shot.spin.y, shot.spin.z);
  const hand = s.poses[player].rightHand;
  if (
    speed < 2 - 1e-9 ||
    speed > 18 + 1e-9 ||
    spin > 100 + 1e-9 ||
    shot.velocity.z <= 0 ||
    Math.hypot(
      shot.origin.x - hand.x,
      shot.origin.y - hand.y,
      shot.origin.z - hand.z,
    ) > 0.35
  )
    return s;
  // worldVector includes a reflection for player 0; angular velocity is an axial vector.
  const axial = worldVector(shot.spin, player);
  const ball: DuelBall = {
    id: s.nextId,
    owner: player,
    age: 0,
    position: worldPoint(shot.origin, player),
    velocity: worldVector(shot.velocity, player),
    spin: { x: -axial.x, y: -axial.y, z: -axial.z },
    radius: 0.11,
  };
  const cooldown: [number, number] = [...s.cooldown];
  cooldown[player] = s.time + 1;
  return {
    ...s,
    ...(s.rally ? { rally: { ...s.rally, phase: "flight" as const } } : {}),
    balls: [...s.balls, ball],
    nextId: s.nextId + 1,
    cooldown,
    message: "Released — the flight is now committed.",
  };
}
export function stepDuel(
  s: DuelState,
  poses: [PlayerPose, PlayerPose],
  dt = FIXED_STEP,
  /** Which players may catch. Off unless asked for: the training opponent never does. */
  canCatch: readonly [boolean, boolean] = [false, false],
): DuelState {
  if (!Number.isFinite(dt) || dt <= 0 || dt > 0.025)
    throw new Error("Duel requires a positive bounded fixed step");
  if (s.hp.some((h) => h <= 0)) return s;
  const nextPoses: [PlayerPose, PlayerPose] = [
    validPose(poses[0]) ? poses[0] : s.poses[0],
    validPose(poses[1]) ? poses[1] : s.poses[1],
  ];
  const out: DuelState = {
    ...s,
    time: s.time + dt,
    previous: s.poses,
    poses: nextPoses,
    balls: [],
    hp: [...s.hp],
    events: (s.events ?? []).filter((event) => s.time + dt - event.at < 0.7),
  };
  if (canCatch[0] || canCatch[1]) {
    const apart = s.handsApartAt ?? [-Infinity, -Infinity];
    out.handsApartAt = [
      handGap(nextPoses[0]) > CATCH.apart ? out.time : apart[0],
      handGap(nextPoses[1]) > CATCH.apart ? out.time : apart[1],
    ];
  }
  for (const b of s.balls) {
    const next = { ...b, ...stepBall(b, dt, s.physics), age: b.age + dt };
    const target = (1 - b.owner) as 0 | 1;
    const oldPose = s.poses[target],
      p = nextPoses[target];
    const head = sweptMovingSphereHit(
      b.position,
      next.position,
      worldPoint(oldPose.head, target),
      worldPoint(p.head, target),
      b.radius,
      0.15,
    );
    const torso = sweptMovingSphereHit(
      b.position,
      next.position,
      worldPoint({ ...oldPose.root, y: oldPose.root.y + 0.2 }, target),
      worldPoint({ ...p.root, y: p.root.y + 0.2 }, target),
      b.radius,
      0.24,
    );
    const hit = Math.min(head ?? Infinity, torso ?? Infinity);
    const event = (kind: DuelEvent["kind"], fraction: number, readyIn = 0.6) => {
      if (out.rally)
        out.rally = {
          turn: target,
          phase: "ready",
          readyAt: out.time + readyIn,
        };
      out.events!.push({
        id: b.id,
        kind,
        target,
        at: s.time + dt * fraction,
        position: {
          x: b.position.x + (next.position.x - b.position.x) * fraction,
          y: b.position.y + (next.position.y - b.position.y) * fraction,
          z: b.position.z + (next.position.z - b.position.z) * fraction,
        },
      });
    };
    const floor =
      b.position.y <= b.radius
        ? 0
        : next.position.y <= b.radius
          ? (b.position.y - b.radius) / (b.position.y - next.position.y)
          : Infinity;
    if (canCatch[target] && out.handsApartAt) {
      const at = localPoint(next.position, target);
      const ahead = at.z - p.root.z;
      const reaches = (hand: Vec3) =>
        Math.hypot(hand.x - at.x, hand.y - at.y) <= CATCH.reach;
      if (
        ahead <= CATCH.far &&
        ahead >= CATCH.near &&
        handGap(p) <= CATCH.together &&
        out.time - out.handsApartAt[target] <= CATCH.window &&
        reaches(p.leftHand) &&
        reaches(p.rightHand)
      ) {
        out.message = `${target === 0 ? "Near" : "Far"} player caught the ball`;
        event("catch", 1, CATCH.readyIn);
        continue;
      }
    }
    if (hit !== Infinity && hit <= floor) {
      out.hp[target] = Math.max(0, out.hp[target] - 1);
      out.hits++;
      out.message = `${target === 0 ? "Near" : "Far"} player hit`;
      event("hit", hit);
      continue;
    }
    if (
      floor !== Infinity ||
      Math.abs(next.position.x) > 5 ||
      next.position.z > 2 ||
      next.position.z < -COURT_DISTANCE - 2 ||
      next.age > 5
    ) {
      out.misses++;
      out.message = "No contact. The ball passed or reached the floor.";
      event(
        floor !== Infinity ? "floor" : "out",
        floor !== Infinity ? floor : 1,
      );
      continue;
    }
    out.balls.push(next);
  }
  return out;
}
export function botPose(
  t: number,
  throwIn = Infinity,
  sinceThrow = Infinity,
  /** Sideways step on top of the idle sway, e.g. a dodge. Kept inside the court. */
  shift = 0,
): PlayerPose {
  const p = neutralPose();
  const x = Math.max(
    -COURT.halfWidth,
    Math.min(COURT.halfWidth, 0.42 * Math.sin(t * 0.8) + shift),
  );
  const smooth = (v: number) => {
    const k = Math.max(0, Math.min(1, v));
    return k * k * (3 - 2 * k);
  };
  const blend = (a: Vec3, b: Vec3, k: number): Vec3 => ({
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
  });
  // Standing ready: arms relaxed and slightly bent, not held out straight.
  const idleRight = { x: x + 0.22, y: 1.02, z: 0.2 },
    idleLeft = { x: x - 0.22, y: 1.02, z: 0.2 };
  // A throw the player can read from across the court: the hand goes up and
  // out beside the head while the body leans back and the other hand points,
  // then everything comes forward in the last tenth of a second.
  const cocked = { x: x + 0.42, y: 1.78, z: 0.05 },
    released = { x: x + 0.2, y: 1.5, z: 0.8 },
    finished = { x: x - 0.1, y: 0.95, z: 0.6 };
  let rightHand: Vec3 = idleRight,
    leftHand: Vec3 = idleLeft,
    lean = 0,
    dip = 0;
  if (throwIn >= 0 && throwIn <= 0.6) {
    const draw = smooth((0.6 - throwIn) / 0.42);
    const whip = smooth((0.12 - throwIn) / 0.12);
    rightHand = blend(blend(idleRight, cocked, draw), released, whip);
    leftHand = blend(
      idleLeft,
      { x: x - 0.1, y: 1.35, z: 0.55 },
      draw * (1 - whip),
    );
    lean = -0.12 * draw * (1 - whip) + 0.2 * whip;
    dip = 0.08 * whip;
  } else if (sinceThrow >= 0 && sinceThrow < 0.45) {
    const follow = smooth(sinceThrow / 0.2),
      recover = smooth((sinceThrow - 0.2) / 0.25);
    rightHand = blend(blend(released, finished, follow), idleRight, recover);
    lean = 0.2 * (1 - recover);
    dip = 0.08 * (1 - recover);
  }
  return {
    ...p,
    root: { ...p.root, x, z: lean },
    head: { ...p.head, x, y: 1.6 + 0.05 * Math.sin(t) - dip, z: lean * 1.2 },
    leftHand,
    rightHand,
  };
}
/** A telegraphed training throw, aimed at release time, never steered in flight. */
export function botThrow(
  s: DuelState,
  pace: TrainingPace = "practice",
): ThrowInput {
  const hand = { ...s.poses[1].rightHand },
    target = { ...s.poses[0].head };
  const aim = { x: -target.x, y: target.y, z: COURT_DISTANCE - target.z };
  return solveFlight(hand, aim, TRAINING_PACE[pace].flight);
}
/** Ballistic assist to a fixed point, using the actual drag model; never homing. */
export function solveFlight(hand: Vec3, aim: Vec3, flight: number, physics?: Readonly<BallPhysics>): ThrowInput {
  const steps = Math.ceil(flight / FIXED_STEP),
    dt = flight / steps;
  // Solve in player-local coordinates using the same drag model as flight.
  // Target is captured once; no opponent data enters integration after release.
  let velocity = {
    x: (aim.x - hand.x) / flight,
    y: (aim.y - hand.y) / flight + ((physics?.gravity ?? 9.81) * flight) / 2,
    z: (aim.z - hand.z) / flight,
  };
  for (let iteration = 0; iteration < 6; iteration++) {
    let ball: BallState = {
      position: hand,
      velocity,
      spin: { x: 0, y: 0, z: 0 },
      radius: 0.11,
    };
    for (let tick = 0; tick < steps; tick++) ball = stepBall(ball, dt, physics);
    velocity = {
      x: velocity.x + (aim.x - ball.position.x) / flight,
      y: velocity.y + (aim.y - ball.position.y) / flight,
      z: velocity.z + (aim.z - ball.position.z) / flight,
    };
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed > 18)
      velocity = {
        x: (velocity.x * 18) / speed,
        y: (velocity.y * 18) / speed,
        z: (velocity.z * 18) / speed,
      };
  }
  return { origin: hand, velocity, spin: { x: 0, y: 0, z: 0 } };
}
