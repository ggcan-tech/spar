import { dist, p2, type Figure, type P2 } from "./body";
import { at, timeToFloor, velocityAt, wallCrossing, type Flight } from "./flight";
import { judge, nearest, sweep, type Pending, type Zone } from "./hit";
import { FIELD, RULES, ZONES } from "./tune";

/**
 * Balls in flight between two lanes: the wall, the floor, the figures. It
 * judges touches (rule D for a real body, at once for bots and dummies) and
 * close calls, and says where each ball ends up. Who may throw and when is the
 * match's business (match.ts); the test pages drive the arena directly.
 *
 * Player 0 and 1 are the two lanes' occupants. Times are ms on the page clock.
 */
export type Who = 0 | 1;
export interface Target {
  fig: Figure;
  /** "drawn": judged on the drawing alone (bots, dummies). "rule-d": a camera body. */
  judge: "drawn" | "rule-d";
  /** Capture time of the pose drawn now (rule-d only). */
  cap?: number;
  /** The figure of the first pose captured at or after `cap`, or null if none yet (rule-d only). */
  later?: (cap: number) => Figure | null;
  /** Cannot be hit right now (just hit). */
  safe?: boolean;
}
export type BallPhase = "flying" | "squash" | "down";
export interface Ball {
  id: number;
  /** Who threw it, and at whom. */
  from: Who;
  to: Who;
  flight: Flight;
  phase: BallPhase;
  /** Hidden from the receiver until it clears the wall. */
  dark: boolean;
  /** The time it cleared (or met) the wall, ms. */
  wallAt: number | null;
  over: boolean;
  /** A self-lob drops on its own holder. */
  self?: boolean;
  /** Last drawn position and velocity. */
  pos: P2;
  vel: P2;
  /** Nearest the receiver's zones came, edge to edge. */
  gap: number;
  pending: Pending | null;
  /** Ms the flight was held while squashed (the clock is shifted by it). */
  heldMs: number;
  /** Where and when it came down, and who it goes to. */
  downAt: number | null;
  downX: number | null;
  owner: Who | null;
  hit: Zone | null;
  /** Free-form tag for test pages (which dummy it was aimed at, the block). */
  tag?: string;
}
export type ArenaEvent =
  | { kind: "launch"; ball: Ball }
  | { kind: "wall"; ball: Ball; over: boolean }
  | { kind: "touch"; ball: Ball; who: Who; zone: Zone }
  | { kind: "hit"; ball: Ball; who: Who; zone: Zone; at: P2; drawnOnly: boolean }
  | { kind: "slide"; ball: Ball; who: Who; gap: number }
  | { kind: "close"; ball: Ball; who: Who; gap: number }
  | { kind: "down"; ball: Ball; x: number; inLane: boolean }
  | { kind: "miss"; ball: Ball; gap: number };

/** A lane's floor span, with the squeeze taken off its back edge. */
export function laneSpan(who: Who, squeeze = 0): [number, number] {
  // Player 0 is the left lane, player 1 the right.
  const sign = who === 0 ? -1 : 1;
  const mid = sign * FIELD.laneMiddle;
  const near = mid - sign * FIELD.laneWidth / 2,
    far = mid + sign * (FIELD.laneWidth / 2 - squeeze);
  return [Math.min(near, far), Math.max(near, far)];
}

export function createArena() {
  let balls: Ball[] = [];
  let next = 1;
  return {
    balls: () => balls,
    clear() {
      balls = [];
    },
    remove(id: number) {
      balls = balls.filter((b) => b.id !== id);
    },
    launch(from: Who, flight: Flight, o: { dark?: boolean; self?: boolean; tag?: string } = {}): Ball {
      const w = wallCrossing(flight);
      const b: Ball = {
        id: next++,
        from,
        to: o.self ? from : ((1 - from) as Who),
        flight,
        phase: "flying",
        dark: !!o.dark && !o.self,
        wallAt: null,
        over: o.self ? true : !!w?.over,
        self: o.self,
        pos: flight.from,
        vel: p2(flight.vx, flight.vy),
        gap: Infinity,
        pending: null,
        heldMs: 0,
        downAt: null,
        downX: null,
        owner: null,
        hit: null,
        tag: o.tag,
      };
      balls.push(b);
      return b;
    },
    /** Is this ball drawn on this viewer's screen now? */
    visibleTo(b: Ball, viewer: Who): boolean {
      if (b.phase === "down") return false;
      if (!b.dark || viewer === b.from) return true;
      return b.wallAt !== null;
    },
    /**
     * Move every ball to `now` and judge. `targets[who]` is that lane's body;
     * `squeeze` the lanes' lost back edges.
     */
    step(now: number, targets: [Target | null, Target | null], squeeze: [number, number] = [0, 0]): ArenaEvent[] {
      const events: ArenaEvent[] = [];
      for (const b of balls) {
        if (b.phase === "down") continue;
        const target = targets[b.to];
        if (b.phase === "squash" && b.pending) {
          const later = target?.later ? target.later(b.pending.cap + ZONES.ruleDMs) : null;
          const v = judge(b.pending, later, now);
          if (v.kind === "wait") continue;
          const held = now - b.pending.drawnAt;
          if (v.kind === "hit") {
            b.hit = v.zone;
            b.phase = "down";
            b.downAt = now;
            b.downX = b.pending.at.x;
            b.owner = b.to;
            events.push({ kind: "hit", ball: b, who: b.to, zone: v.zone, at: b.pending.at, drawnOnly: !later });
          } else {
            b.heldMs += held;
            b.gap = Math.min(b.gap, Math.max(0, v.gap));
            events.push({ kind: "slide", ball: b, who: b.to, gap: v.gap });
            b.phase = "flying";
          }
          b.pending = null;
          continue;
        }
        const s0 = Math.max(0, (now - 16 - b.flight.t0 - b.heldMs) / 1000);
        const s = Math.max(0, (now - b.flight.t0 - b.heldMs) / 1000);
        const a = at(b.flight, Math.min(s0, s)),
          c = at(b.flight, s);
        b.pos = c;
        b.vel = velocityAt(b.flight, s);
        // The wall.
        if (b.wallAt === null && !b.self) {
          const w = wallCrossing(b.flight);
          if (w && s >= w.s) {
            b.wallAt = now;
            events.push({ kind: "wall", ball: b, over: w.over });
            if (!w.over) {
              // Into the wall: it drops at the wall's foot on the thrower's side and goes to the one it was thrown at.
              b.phase = "down";
              b.downAt = now;
              b.downX = (b.flight.vx > 0 ? -1 : 1) * (FIELD.wallThick / 2 + ZONES.ball);
              b.owner = b.to;
              events.push({ kind: "down", ball: b, x: b.downX, inLane: false });
              continue;
            }
          }
        }
        // The receiver's body.
        if (target && !target.safe && (b.over || b.self) && (b.wallAt !== null || b.self)) {
          const touch = sweep(target.fig, a, c);
          b.gap = Math.min(b.gap, nearest(target.fig, a, c));
          if (touch) {
            events.push({ kind: "touch", ball: b, who: b.to, zone: touch.zone });
            if (target.judge === "rule-d" && target.later && target.cap !== undefined) {
              b.phase = "squash";
              b.pos = touch.at;
              b.pending = { ball: b.id, zone: touch.zone, at: touch.at, cap: target.cap, drawnAt: now };
            } else {
              b.hit = touch.zone;
              b.phase = "down";
              b.downAt = now;
              b.downX = touch.at.x;
              b.owner = b.to;
              events.push({ kind: "hit", ball: b, who: b.to, zone: touch.zone, at: touch.at, drawnOnly: true });
            }
            continue;
          }
        }
        // The floor, or off the field.
        const floorS = timeToFloor(b.flight);
        if (s >= floorS || Math.abs(c.x) > FIELD.viewWidth / 2 + 0.6) {
          b.phase = "down";
          b.downAt = now;
          b.downX = Math.max(-FIELD.viewWidth / 2, Math.min(FIELD.viewWidth / 2, at(b.flight, Math.min(s, floorS)).x));
          const [x0, x1] = laneSpan(b.to, squeeze[b.to]);
          const inLane = b.downX >= x0 - 0.05 && b.downX <= x1 + 0.05;
          b.owner = b.to;
          events.push({ kind: "down", ball: b, x: b.downX, inLane });
          if (b.gap <= ZONES.closeCall && b.gap > 0) events.push({ kind: "close", ball: b, who: b.to, gap: b.gap });
          else events.push({ kind: "miss", ball: b, gap: b.gap });
        }
      }
      return events;
    },
    /** Balls that are down long enough to be picked up by `who`, standing with their trunk at `x`. */
    pickups(now: number, who: Who, x: number | null): Ball[] {
      const out: Ball[] = [];
      for (const b of balls) {
        if (b.phase !== "down" || b.owner !== who || b.downAt === null) continue;
        const wait = b.downX !== null && Math.abs(b.downX) < 0.3 ? RULES.strayMs : RULES.pickupMs;
        const near = x !== null && b.downX !== null && Math.abs(b.downX - x) <= RULES.pickupNear;
        if (now - b.downAt >= wait || near) out.push(b);
      }
      return out;
    },
  };
}
export type Arena = ReturnType<typeof createArena>;

/** The ball's path from now on, sampled, for drawing a trace or stub. */
export function pathOf(f: Flight, fromS: number, toS: number, step = 0.04): P2[] {
  const pts: P2[] = [];
  for (let s = fromS; s <= toS + 1e-9; s += step) {
    const q = at(f, s);
    pts.push(q);
    if (q.y < 0) break;
  }
  return pts;
}
export { dist };
