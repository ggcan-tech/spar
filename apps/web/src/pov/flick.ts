/**
 * The flick (CORE.md 2.6), first version for the stage-1 probe. Pure: samples
 * in, a throw read out. Every number is a first guess the probe is there to tune.
 *
 * - Power: the finger's speed over the last 40 ms before it lifts, against the
 *   device's window (U_MIN to U_FULL).
 * - Launch angle: how far above the ball's resting place the finger lets go
 *   ("how far you extend your finger"), in units of H, on a terrace of three
 *   flat zones, line (about 4°), arc (14°) and lob (26°), steep in between so a
 *   few millimetres inside a zone do not ruin a throw.
 * - Left/right: the stroke's chord, held within ±12°.
 * Bend (spin) is read and recorded only; spin comes later.
 */
export interface FlickSample {
  t: number;
  x: number;
  y: number;
}
export type FlickDevice = "touch" | "swipe" | "drag";
export interface DeviceProfile {
  /** Units per screen pixel of a sample: mm on glass for touch, 1 for scroll or pointer pixels. */
  scale: number;
  unit: "mm" | "px";
  uMin: number;
  uFull: number;
  /** The height unit for the terrace. */
  h: number;
}
/** CSS pixels to millimetres on a phone's glass: about 0.16 (guess); the probe records raw pixels too. */
export const MM_PER_PX = 0.16;
export const PROFILES: Record<FlickDevice, DeviceProfile> = {
  touch: { scale: MM_PER_PX, unit: "mm", uMin: 150, uFull: 850, h: 60 },
  swipe: { scale: 1, unit: "px", uMin: 600, uFull: 3500, h: 400 },
  drag: { scale: 1, unit: "px", uMin: 600, uFull: 3500, h: 400 },
};
export const FLICK = {
  windowMs: 40,
  vMin: 5.0,
  /** Top speed for every throw a person makes (hard review, must-fix 4); the practice pace limits only the bot. */
  vMax: 13.4,
  /** The terrace: zone angles (degrees) and the heights (in H) where one zone gives way to the next. */
  zones: { line: 4, arc: 14, lob: 26 },
  arcFrom: 0.6,
  lobFrom: 1.2,
  /** Half-width of the steep step between zones, in H. */
  step: 0.08,
  aimMax: 12,
  /** Most a stroke may point away from straight up, degrees: more is a drop. */
  sideMax: 75,
};

export interface FlickRead {
  device: FlickDevice;
  /** Finger speed at release, in the device's units a second. */
  speed: number;
  /** Release height above the ball's rest, in the device's units, and in H. */
  rise: number;
  e: number;
  /** Stroke direction, degrees from straight up the screen (+ to the right). */
  direction: number;
  /** How much the stroke bent, degrees. Recorded only. */
  bend: number;
  /** Stroke length, device units. */
  length: number;
  /** No throw: too slow, too short, or pointing away. */
  drop: boolean;
  shot: "line" | "arc" | "lob";
  power: number;
  launchSpeed: number;
  launchAngle: number;
  aim: number;
}

const deg = (r: number) => (r * 180) / Math.PI;
const smooth = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};

/** The terrace: e (release height in H) → launch angle, degrees. */
export function terrace(e: number): number {
  const { zones, arcFrom, lobFrom, step } = FLICK;
  const toArc = smooth((e - (arcFrom - step)) / (2 * step));
  const toLob = smooth((e - (lobFrom - step)) / (2 * step));
  return zones.line + (zones.arc - zones.line) * toArc + (zones.lob - zones.arc) * toLob;
}

export function readFlick(samples: FlickSample[], rest: { x: number; y: number }, device: FlickDevice = "touch"): FlickRead | null {
  if (samples.length < 2) return null;
  const pr = PROFILES[device];
  const last = samples[samples.length - 1];
  // Release speed over the last 40 ms (at least two samples, at most 80 ms).
  let k = samples.length - 2;
  while (k > 0 && last.t - samples[k].t < FLICK.windowMs && last.t - samples[k - 1].t <= 80) k--;
  const a = samples[k];
  const dt = Math.max(1, last.t - a.t) / 1000;
  const vx = ((last.x - a.x) * pr.scale) / dt,
    vy = ((last.y - a.y) * pr.scale) / dt;
  const speed = Math.hypot(vx, vy);
  const first = samples[0];
  const dx = (last.x - first.x) * pr.scale,
    dy = (last.y - first.y) * pr.scale;
  const length = Math.hypot(dx, dy);
  // Screen y grows downward: up the screen is toward the opponent.
  const direction = deg(Math.atan2(dx, -dy));
  const mid = samples[Math.floor(samples.length / 2)];
  let bend = deg(Math.atan2(last.x - mid.x, -(last.y - mid.y)) - Math.atan2(mid.x - first.x, -(mid.y - first.y)));
  if (bend > 180) bend -= 360;
  if (bend < -180) bend += 360;
  const rise = (rest.y - last.y) * pr.scale;
  const e = rise / pr.h;
  const p = (speed - pr.uMin) / (pr.uFull - pr.uMin);
  const tooShort = pr.unit === "mm" ? length < 10 : length < 40;
  const drop = !(p > 0) || tooShort || Math.abs(direction) > FLICK.sideMax || !(dy < 0);
  let launchAngle = terrace(e);
  // Over-hard flicks sail up: a sweet spot for power.
  if (p > 1.05) launchAngle += Math.min(10, 30 * (p - 1.05));
  const power = Math.max(0, Math.min(1, p));
  return {
    device,
    speed,
    rise,
    e,
    direction,
    bend,
    length,
    drop,
    shot: e >= FLICK.lobFrom ? "lob" : e >= FLICK.arcFrom ? "arc" : "line",
    power,
    launchSpeed: FLICK.vMin + (FLICK.vMax - FLICK.vMin) * power,
    launchAngle,
    aim: Math.max(-FLICK.aimMax, Math.min(FLICK.aimMax, direction)),
  };
}

/** The throw's starting velocity in the thrower's own frame (+z toward the opponent). */
export function flickVelocity(f: FlickRead): { x: number; y: number; z: number } {
  const up = (f.launchAngle * Math.PI) / 180,
    side = (f.aim * Math.PI) / 180;
  const flat = f.launchSpeed * Math.cos(up);
  return { x: flat * Math.sin(side), y: f.launchSpeed * Math.sin(up), z: flat * Math.cos(side) };
}

/** Where a flicked ball leaves from, in the thrower's own frame (CORE.md 2.6). */
export const FLICK_ORIGIN = { x: 0.25, y: 1.55, z: 0.4 };
