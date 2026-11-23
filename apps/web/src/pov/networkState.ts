import {
  COURT_DISTANCE,
  validPose,
  type DuelBall,
  type DuelEvent,
  type DuelState,
  type PlayerPose,
} from "./duel";
import { DEFAULT_PHYSICS, type Vec3 } from "./physics";
import { JOINT_COUNT } from "./body";

const MAX_TIME_SECONDS = 7 * 24 * 60 * 60;
const MAX_BALLS = 64;
const EPSILON = 1e-6;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const integer = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number => number(value, min, max) && Number.isSafeInteger(value);
const pair = (value: unknown): value is [unknown, unknown] =>
  Array.isArray(value) && value.length === 2;
function vec(value: unknown): Vec3 | null {
  if (
    !record(value) ||
    !number(value.x, -1e6, 1e6) ||
    !number(value.y, -1e6, 1e6) ||
    !number(value.z, -1e6, 1e6)
  )
    return null;
  return { x: value.x, y: value.y, z: value.z };
}
function pose(value: unknown): PlayerPose | null {
  if (!record(value)) return null;
  const head = vec(value.head),
    root = vec(value.root),
    leftHand = vec(value.leftHand),
    rightHand = vec(value.rightHand);
  if (!head || !root || !leftHand || !rightHand) return null;
  const parsed: PlayerPose = { head, root, leftHand, rightHand };
  // The skeleton is optional, but a malformed one rejects the whole snapshot.
  if (value.body !== undefined) {
    if (!Array.isArray(value.body) || value.body.length !== JOINT_COUNT)
      return null;
    const body: Vec3[] = [];
    for (const joint of value.body) {
      const point = vec(joint);
      if (!point) return null;
      body.push(point);
    }
    parsed.body = body;
  }
  return validPose(parsed) ? parsed : null;
}
function poses(value: unknown): [PlayerPose, PlayerPose] | null {
  if (!pair(value)) return null;
  const a = pose(value[0]),
    b = pose(value[1]);
  return a && b ? [a, b] : null;
}
function ball(value: unknown, time: number, nextId: number): DuelBall | null {
  if (
    !record(value) ||
    !integer(value.id, 1, nextId - 1) ||
    (value.owner !== 0 && value.owner !== 1) ||
    !number(value.age, 0, Math.min(5 + EPSILON, time + EPSILON)) ||
    !number(value.radius, 0.11 - EPSILON, 0.11 + EPSILON)
  )
    return null;
  const position = vec(value.position),
    velocity = vec(value.velocity),
    spin = vec(value.spin);
  if (!position || !velocity || !spin) return null;
  // Current duel launches at <=18m/s and <=100rad/s, expires balls after 5s,
  // and only gravity adds speed (drag removes energy, Magnus is perpendicular).
  // These are protocol-v0 envelopes, not a general-purpose physics decoder.
  const speedLimit = Math.min(
    500,
    18 + DEFAULT_PHYSICS.gravity * value.age + 0.01,
  );
  const positionLimit =
    COURT_DISTANCE +
    4 +
    18 * value.age +
    0.5 * DEFAULT_PHYSICS.gravity * value.age ** 2;
  if (
    Math.hypot(velocity.x, velocity.y, velocity.z) > speedLimit ||
    Math.hypot(spin.x, spin.y, spin.z) > 100 + EPSILON ||
    Math.hypot(position.x, position.y, position.z) > positionLimit
  )
    return null;
  return {
    id: value.id,
    owner: value.owner,
    age: value.age,
    radius: value.radius,
    position,
    velocity,
    spin,
  };
}

/**
 * Decode the full authoritative v0 snapshot into a detached, canonical value.
 * Invalid values return null; do not fall back to partially parsed state.
 * This validates shape/numerical game envelopes, not authenticity or ordering.
 * Caller must verify the server channel and discard old/out-of-order snapshots.
 */
export function parseNetworkState(value: unknown): DuelState | null {
  try {
    if (
      !record(value) ||
      !number(value.time, 0, MAX_TIME_SECONDS) ||
      !integer(value.nextId, 1) ||
      !integer(value.hits) ||
      !integer(value.misses) ||
      typeof value.message !== "string" ||
      value.message.length > 300 ||
      !Array.isArray(value.balls) ||
      value.balls.length > MAX_BALLS ||
      !pair(value.hp) ||
      !pair(value.cooldown)
    )
      return null;
    const current = poses(value.poses),
      previous = poses(value.previous);
    if (
      !current ||
      !previous ||
      !integer(value.hp[0], 0, 5) ||
      !integer(value.hp[1], 0, 5) ||
      !number(value.cooldown[0], 0, value.time + 1 + EPSILON) ||
      !number(value.cooldown[1], 0, value.time + 1 + EPSILON)
    )
      return null;
    const launched = value.nextId - 1;
    // No counter can claim events from balls that have never been launched.
    if (
      value.hits > launched ||
      value.misses > launched ||
      value.hits + value.misses + value.balls.length > launched
    )
      return null;
    const ids = new Set<number>(),
      balls: DuelBall[] = [];
    for (const item of value.balls) {
      const parsed = ball(item, value.time, value.nextId);
      if (!parsed || ids.has(parsed.id)) return null;
      ids.add(parsed.id);
      balls.push(parsed);
    }
    const events: DuelEvent[] = [];
    if (value.events !== undefined) {
      if (!Array.isArray(value.events) || value.events.length > MAX_BALLS)
        return null;
      const eventIds = new Set<number>();
      for (const event of value.events) {
        if (
          !record(event) ||
          !integer(event.id, 1, value.nextId - 1) ||
          eventIds.has(event.id) ||
          ids.has(event.id) ||
          !["hit", "floor", "out", "catch"].includes(event.kind as string) ||
          (event.target !== 0 && event.target !== 1) ||
          !number(event.at, 0, value.time + EPSILON)
        )
          return null;
        const position = vec(event.position);
        if (!position) return null;
        eventIds.add(event.id);
        events.push({
          id: event.id,
          kind: event.kind as DuelEvent["kind"],
          target: event.target,
          at: event.at,
          position,
        });
      }
    }
    let rally: DuelState["rally"];
    if (value.rally !== undefined) {
      const r = value.rally;
      if (
        !record(r) ||
        (r.turn !== 0 && r.turn !== 1) ||
        (r.phase !== "ready" && r.phase !== "flight") ||
        !number(r.readyAt, 0, value.time + 2.2 + EPSILON) ||
        (r.phase === "ready" && balls.length !== 0) ||
        (r.phase === "flight" &&
          (balls.length !== 1 || balls[0].owner !== r.turn))
      )
        return null;
      rally = { turn: r.turn, phase: r.phase, readyAt: r.readyAt };
    }
    return {
      time: value.time,
      poses: current,
      previous,
      balls,
      hp: [value.hp[0] as number, value.hp[1] as number],
      cooldown: [value.cooldown[0] as number, value.cooldown[1] as number],
      nextId: value.nextId,
      message: value.message,
      hits: value.hits,
      misses: value.misses,
      events,
      ...(rally ? { rally } : {}),
    };
  } catch {
    // JSON input has no getters, but unknown callers must not turn malformed
    // host values into an exception in the network event handler.
    return null;
  }
}
