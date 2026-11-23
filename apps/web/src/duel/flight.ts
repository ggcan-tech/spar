import { p2, type P2 } from "./body";
import { FIELD, FLIGHT, SLING, ZONES } from "./tune";

/**
 * A goo ball's flight, flat: launched from the sling hand, pulled down by the
 * game's gravity, over (or into) the wall in the middle. Pure functions.
 */
export interface Flight {
  from: P2;
  /** Metres a second. */
  vx: number;
  vy: number;
  /** Launch time, ms. */
  t0: number;
  /** Launch angle above level, degrees, and the fan band it shows. */
  angle: number;
  /** 0–1 share of the full draw. */
  power: number;
}

export type Fan = "flat" | "middle" | "high";
export const fanOf = (angle: number): Fan => (angle < FLIGHT.fanFlat ? "flat" : angle < FLIGHT.fanMiddle ? "middle" : "high");

/** The launch angle from the hand line (both degrees): 40° + gain × (line − own level), held 40–65°. */
export function launchAngle(handLine: number, ownLevel: number = SLING.ownLevel): number {
  const a = SLING.angleBase + SLING.angleGain * (handLine - ownLevel);
  return Math.max(SLING.angleMin, Math.min(SLING.angleMax, a));
}

/** Launch speed from the share of the full draw. Under the least draw there is no shot (null). */
export function launchSpeed(power: number): number | null {
  if (!(power >= SLING.powerMin)) return null;
  const k = (Math.min(1, power) - SLING.powerMin) / (1 - SLING.powerMin);
  return SLING.speedMin + (SLING.speedMax - SLING.speedMin) * k;
}

export function launch(from: P2, toward: 1 | -1, angle: number, speed: number, t0: number, power = 1): Flight {
  const rad = (angle * Math.PI) / 180;
  return { from, vx: toward * speed * Math.cos(rad), vy: speed * Math.sin(rad), t0, angle, power };
}

/** Where the ball is `s` seconds after launch. */
export const at = (f: Flight, s: number): P2 => p2(f.from.x + f.vx * s, f.from.y + f.vy * s - 0.5 * FLIGHT.gravity * s * s);
export const velocityAt = (f: Flight, s: number): P2 => p2(f.vx, f.vy - FLIGHT.gravity * s);

/** Seconds until the ball reaches x, or null if it never does. */
export function timeToX(f: Flight, x: number): number | null {
  if (Math.abs(f.vx) < 1e-6) return null;
  const s = (x - f.from.x) / f.vx;
  return s >= 0 ? s : null;
}

/** Seconds until the ball's bottom touches the floor. */
export function timeToFloor(f: Flight): number {
  const g = FLIGHT.gravity,
    h = f.from.y - ZONES.ball;
  // h + vy s - g s²/2 = 0
  return (f.vy + Math.sqrt(f.vy * f.vy + 2 * g * Math.max(0, h))) / g;
}

/**
 * Where the ball meets the wall: the time it is level with the wall's face, and
 * whether it goes over. A ball that goes over is drawn on the far side from then on
 * ("dark until the wall": plain balls are hidden from the dodger until this moment).
 */
export function wallCrossing(f: Flight): { s: number; over: boolean } | null {
  const face = (FIELD.wallThick / 2 + ZONES.ball) * -Math.sign(f.vx);
  const s = timeToX(f, face);
  if (s === null) return null;
  // Over if the ball is above the wall top while it is above the wall's width.
  const s2 = timeToX(f, -face) ?? s;
  const low = Math.min(at(f, s).y, at(f, s2).y);
  return { s, over: low > FIELD.wallHeight + ZONES.ball * 0.5 };
}

/** The highest point of the flight. */
export function apex(f: Flight): P2 {
  const s = Math.max(0, f.vy / FLIGHT.gravity);
  return at(f, s);
}

/**
 * The launch that sends a ball from `from` through `target`: the angle within
 * the sling's range and the speed it needs, or null if no legal launch does.
 * `prefer` picks the flattest legal angle ("fast"), the steepest ("lob"), or the
 * nearest to a given angle.
 */
export function solveLaunch(
  from: P2,
  target: P2,
  prefer: "fast" | "lob" | number = "fast",
): { angle: number; speed: number; seconds: number } | null {
  const dx = Math.abs(target.x - from.x),
    dy = target.y - from.y,
    g = FLIGHT.gravity;
  const found: { angle: number; speed: number; seconds: number }[] = [];
  for (let a = SLING.angleMin; a <= SLING.angleMax + 1e-9; a += 0.5) {
    const rad = (a * Math.PI) / 180;
    const c = Math.cos(rad),
      lift = dx * Math.tan(rad) - dy;
    if (lift <= 0) continue;
    const v = Math.sqrt((g * dx * dx) / (2 * c * c * lift));
    if (v < SLING.speedMin - 1e-9 || v > SLING.speedMax + 1e-9) continue;
    // It must go over the wall on the way.
    const f = launch(from, target.x > from.x ? 1 : -1, a, v, 0);
    const w = wallCrossing(f);
    if (w && !w.over) continue;
    found.push({ angle: a, speed: v, seconds: dx / (v * c) });
  }
  if (!found.length) return null;
  if (prefer === "fast") return found[0];
  if (prefer === "lob") return found[found.length - 1];
  return found.reduce((best, x) => (Math.abs(x.angle - prefer) < Math.abs(best.angle - prefer) ? x : best));
}

/** The power (share of the full draw) that gives a launch speed. */
export function powerFor(speed: number): number {
  const k = (speed - SLING.speedMin) / (SLING.speedMax - SLING.speedMin);
  return SLING.powerMin + Math.max(0, Math.min(1, k)) * (1 - SLING.powerMin);
}
