import { JOINT } from "../pov/body";
import { p2, standardFigure, type Figure, type P2 } from "./body";
import { at, fanOf, launch, powerFor, solveLaunch, timeToFloor, type Fan, type Flight } from "./flight";
import { overlap } from "./hit";
import { BOT, FIELD, SLING } from "./tune";

/**
 * Training bots (DUEL.md 11, step 3), dummies and the walking target (step 1).
 * A bot is a standard figure moved by numbers: where its hips are, how deep it
 * ducks, whether it holds its sling. It never sees a dark ball before the
 * ball clears the wall, the same as a person.
 */
export interface BotState {
  x: number;
  duck: number;
  /** Where it is going. */
  tx: number;
  tduck: number;
  toward: 1 | -1;
  sling: { angle: number; draw: number } | null;
  flickedUntil: number;
}

export function createBotBody(x: number, toward: 1 | -1) {
  const s: BotState = { x, duck: 0, tx: x, tduck: 0, toward, sling: null, flickedUntil: -Infinity };
  return {
    state: () => s,
    moveTo(x: number, duck: number) {
      s.tx = x;
      s.tduck = Math.max(0, Math.min(0.36, duck));
    },
    holdSling(sling: { angle: number; draw: number } | null) {
      s.sling = sling;
    },
    flick(now: number) {
      s.flickedUntil = now + 250;
    },
    /** Move toward the target at human speeds, inside the lane. */
    step(dtS: number, span: [number, number]) {
      const vx = BOT.trunkSpeed * (s.sling ? 0.6 : 1);
      const dx = s.tx - s.x;
      s.x += Math.sign(dx) * Math.min(Math.abs(dx), vx * dtS);
      s.x = Math.max(span[0] + 0.12, Math.min(span[1] - 0.12, s.x));
      const dd = s.tduck - s.duck;
      s.duck += Math.sign(dd) * Math.min(Math.abs(dd), BOT.duckSpeed * dtS);
    },
    figure(now: number): Figure {
      const flicked = now < s.flickedUntil;
      return standardFigure({ x: s.x, duck: s.duck, toward: s.toward, sling: s.sling ?? (flicked ? { angle: 55, draw: 1 } : null), flicked });
    },
    /** Where its sling hand would be, holding a draw at this angle. */
    hand(angle: number): P2 {
      const f = standardFigure({ x: s.x, duck: s.duck, toward: s.toward, sling: { angle, draw: 1 } });
      return s.toward < 0 ? f.j[JOINT.L_WRIST] : f.j[JOINT.R_WRIST];
    },
  };
}
export type BotBody = ReturnType<typeof createBotBody>;

/**
 * The best place to be when this ball arrives: the nearest spot and duck,
 * inside the lane, that the ball's path misses and that the body can reach in
 * time. Null if none can be reached (then stay and hope).
 */
export function planDodge(
  f: Flight,
  nowMs: number,
  from: { x: number; duck: number },
  span: [number, number],
  toward: 1 | -1,
): { x: number; duck: number } | null {
  const s0 = Math.max(0, (nowMs - f.t0) / 1000);
  const end = timeToFloor(f);
  const pts: { s: number; q: P2 }[] = [];
  for (let s = s0; s <= end; s += 0.012) pts.push({ s, q: at(f, s) });
  let best: { x: number; duck: number; cost: number } | null = null;
  for (let x = span[0] + 0.15; x <= span[1] - 0.15 + 1e-9; x += 0.05)
    for (const duck of [0, 0.12, 0.2, 0.28, 0.35]) {
      const fig = standardFigure({ x, duck, toward });
      // The first moment the ball is near this spot: the body must be there by then.
      let danger = Infinity,
        safe = true;
      for (const { s, q } of pts) {
        if (Math.abs(q.x - x) < 0.45 && danger === Infinity) danger = s;
        if (overlap(fig, q, 0.07 + 0.03)) {
          safe = false;
          break;
        }
      }
      if (!safe) continue;
      const reach = Math.max(Math.abs(x - from.x) / BOT.trunkSpeed, Math.abs(duck - from.duck) / BOT.duckSpeed);
      if (danger !== Infinity && s0 + reach > danger - 0.05) continue;
      const cost = Math.abs(x - from.x) + 1.5 * Math.abs(duck - from.duck) + duck * 0.2;
      if (!best || cost < best.cost) best = { x, duck, cost };
    }
  return best ? { x: best.x, duck: best.duck } : null;
}

/** What a bot does about the balls coming at it: "wall" reads perfectly 0.3 s after a ball appears; "coach" guesses from the fan, reads slower, and has habits. */
export type Defender = "wall" | "coach" | "still";

export interface Incoming {
  id: number;
  flight: Flight;
  /** When it became visible to the bot (cleared the wall, or at launch if not dark), ms; null while dark. */
  seenAt: number | null;
  /** The fan band shown before the release. */
  fan: Fan | null;
}

export function createDefender(kind: Defender, seed = 1) {
  let r = seed;
  const rnd = () => {
    r = (r * 16807) % 2147483647;
    return r / 2147483647;
  };
  const decided = new Map<number, { x: number; duck: number; at: number; final: boolean }>();
  return {
    /** Decide where to go now. */
    update(now: number, body: BotBody, balls: Incoming[], span: [number, number]) {
      if (kind === "still") return;
      const s = body.state();
      // The nearest threat first.
      const live = balls.filter((b) => (now - b.flight.t0) / 1000 < timeToFloor(b.flight));
      if (!live.length) {
        // Drift back toward the middle of the lane.
        body.moveTo(s.tx + ((span[0] + span[1]) / 2 - s.tx) * 0.02, 0);
        return;
      }
      live.sort((a, b) => a.flight.t0 - b.flight.t0);
      const b = live[0];
      const read = kind === "wall" ? BOT.wallReadMs : 450;
      const prev = decided.get(b.id);
      if (b.seenAt !== null && now - b.seenAt >= read && !(prev?.final && now - prev.at < 120)) {
        const plan = planDodge(b.flight, now, { x: s.x, duck: s.duck }, span, s.toward);
        if (plan && (!prev || !prev.final || kind === "wall")) {
          // The coach sometimes reads it wrong and stays.
          if (kind === "coach" && !prev?.final && rnd() < 0.18) decided.set(b.id, { x: s.x, duck: s.duck, at: now, final: true });
          else decided.set(b.id, { ...plan, at: now, final: true });
        }
      } else if (kind === "coach" && !decided.has(b.id)) {
        // A guess from the fan before the ball shows: duck a flat one, step back from a high one.
        const guess = b.fan === "flat" ? { x: s.x, duck: 0.26 } : b.fan === "high" ? { x: s.x - s.toward * 0.3, duck: 0 } : { x: s.x + s.toward * 0.2, duck: 0.2 };
        if (rnd() < 0.7) decided.set(b.id, { ...guess, at: now, final: false });
      }
      const d = decided.get(b.id);
      if (d) body.moveTo(d.x, d.duck);
    },
  };
}

/** A shot a bot means to take: when to draw, when to let go, at what. */
export interface BotShot {
  drawAt: number;
  releaseAt: number;
  angle: number;
  speed: number;
  fan: Fan;
  kind: "fast" | "middle" | "lob";
  aimedAt: P2;
}

/**
 * Pick a shot at a figure: a fast ball, a middle arc or a lob, at the head or
 * the chest, sometimes led toward where the dodger will go.
 */
export function aimShot(
  body: BotBody,
  target: Figure,
  o: { kind: "fast" | "middle" | "lob"; zone: "head" | "chest" | "neck"; lead: number; now: number; drawS: number; holdS: number },
): BotShot | null {
  const s = body.state();
  const pt = o.zone === "head" ? target.head.c : o.zone === "neck" ? p2(target.head.c.x, target.head.c.y - 0.12) : p2((target.chest.x0 + target.chest.x1) / 2, (target.chest.y0 + target.chest.y1) / 2 + 0.04);
  const aimed = p2(pt.x + o.lead, pt.y);
  const prefer = o.kind === "fast" ? "fast" : o.kind === "lob" ? "lob" : 58;
  let sol = solveLaunch(body.hand(o.kind === "lob" ? 62 : o.kind === "fast" ? 52 : 58), aimed, prefer);
  if (!sol) return null;
  sol = solveLaunch(body.hand(sol.angle), aimed, sol.angle) ?? sol;
  return {
    drawAt: o.now,
    releaseAt: o.now + (o.drawS + o.holdS) * 1000,
    angle: sol.angle,
    speed: sol.speed,
    fan: fanOf(sol.angle),
    kind: o.kind,
    aimedAt: aimed,
  };
}

/** The flight a bot's shot makes when it lets go now. */
export function botLaunch(body: BotBody, shot: BotShot, now: number): Flight {
  return launch(body.hand(shot.angle), body.state().toward, shot.angle, shot.speed, now, powerFor(shot.speed));
}

/** Still dummies at the front, middle and back of a lane, facing the other way. */
export function dummies(laneMiddle: number, toward: 1 | -1): { name: string; fig: Figure }[] {
  return [
    { name: "front", x: laneMiddle + toward * 0.35 },
    { name: "middle", x: laneMiddle },
    { name: "back", x: laneMiddle - toward * 0.35 },
  ].map((d) => ({ name: d.name, fig: standardFigure({ x: d.x, toward }) }));
}

/** A target that walks across its lane and ducks now and then. */
export function walkerAt(laneMiddle: number, toward: 1 | -1, seconds: number): { x: number; duck: number } {
  const x = laneMiddle + 0.38 * Math.sin(seconds * 0.55);
  const k = seconds % 7;
  const duck = k > 5 && k < 6.2 ? 0.25 * Math.sin(((k - 5) / 1.2) * Math.PI) : 0;
  return { x, duck };
}

export { FIELD, SLING };
