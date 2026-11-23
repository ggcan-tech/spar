/** SI units, +Y upward. A bounded numerical model, not measured ball aerodynamics. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface BallState {
  position: Vec3;
  velocity: Vec3;
  spin: Vec3;
  radius: number;
}
export interface BallPhysics {
  mass: number; // kg
  airDensity: number; // kg/m³, still air
  dragCoefficient: number; // dimensionless, frontal area πr²
  magnusCoefficient: number; // dimensionless slope in CL ≈ coefficient × spin parameter
  spinDecay: number; // s⁻¹; angular velocity decays exponentially
  gravity: number; // m/s², acts along -Y
}

/** Illustrative tuning values, NOT calibrated measurements for a specific ball. */
export const DEFAULT_PHYSICS: Readonly<BallPhysics> = Object.freeze({
  mass: 0.27,
  airDensity: 1.225,
  dragCoefficient: 0.47,
  magnusCoefficient: 0.25,
  spinDecay: 0.15,
  gravity: 9.81,
});
/**
 * The duel court's ball (CORE.md 2.7): one gravity per match, 3.8 m/s², so a
 * fast throw stays flat and dodgeable and a soft one loops. A 0.30 kg ball with
 * low drag. Guesses to be tuned by play.
 */
export const MATCH_PHYSICS: Readonly<BallPhysics> = Object.freeze({
  mass: 0.3,
  airDensity: 1.225,
  dragCoefficient: 0.2,
  magnusCoefficient: 0.25,
  spinDecay: 0.15,
  gravity: 3.8,
});
export const MAX_STEP_SECONDS = 0.25;
export const MAX_SUBSTEP_SECONDS = 1 / 240;
const MAX_SUBSTEPS = 4096;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const scale = (v: Vec3, k: number): Vec3 => ({
  x: v.x * k,
  y: v.y * k,
  z: v.z * k,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function bounded(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
}
function vector(v: Vec3, limit: number, label: string): void {
  if (!v || ![v.x, v.y, v.z].every(Number.isFinite) || norm(v) > limit) {
    throw new RangeError(
      `${label} must be a finite vector with magnitude <= ${limit}`,
    );
  }
}
function validBall(ball: BallState): void {
  vector(ball.position, 1e6, "position");
  vector(ball.velocity, 500, "velocity");
  vector(ball.spin, 2000, "spin");
  bounded(ball.radius, 0.001, 2, "radius");
}
function validPhysics(p: BallPhysics): void {
  bounded(p.mass, 0.001, 100, "mass");
  bounded(p.airDensity, 0, 10, "airDensity");
  bounded(p.dragCoefficient, 0, 5, "dragCoefficient");
  bounded(p.magnusCoefficient, 0, 5, "magnusCoefficient");
  bounded(p.spinDecay, 0, 100, "spinDecay");
  bounded(p.gravity, 0, 100, "gravity");
}
function weighted(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec3 {
  return {
    x: a.x + 2 * b.x + 2 * c.x + d.x,
    y: a.y + 2 * b.y + 2 * c.y + d.y,
    z: a.z + 2 * b.z + 2 * c.z + d.z,
  };
}

/**
 * Immutable RK4 integration, internally substepped to <=1/240s and a stiffness budget.
 * Air is stationary. No target is accepted: the trajectory cannot home or correct its aim.
 * dt=0 returns an independent clone. dt>0.25 or excessive stiffness throws rather than
 * silently dropping time or producing an unbounded catch-up. Caller owns pause/fixed tick policy.
 * Ground impacts, catches and collision responses are deliberately outside this integrator.
 */
export function stepBall(
  ball: BallState,
  dt: number,
  physics: Readonly<BallPhysics> = DEFAULT_PHYSICS,
): BallState {
  validBall(ball);
  validPhysics(physics);
  bounded(dt, 0, MAX_STEP_SECONDS, "dt");
  let position = { ...ball.position },
    velocity = { ...ball.velocity },
    spin = { ...ball.spin };
  if (dt === 0) return { position, velocity, spin, radius: ball.radius };
  const area = Math.PI * ball.radius * ball.radius;
  const dragK =
    (0.5 * physics.airDensity * area * physics.dragCoefficient) / physics.mass;
  const magnusK =
    (0.5 *
      physics.airDensity *
      area *
      physics.magnusCoefficient *
      ball.radius) /
    physics.mass;
  // Drag removes speed, Magnus is perpendicular, spin decays: gravity supplies a safe
  // exact-solution upper speed estimate across this interval. Reject pathological coefficients.
  const stiffness =
    dragK * (norm(velocity) + physics.gravity * dt) +
    magnusK * norm(spin) +
    physics.spinDecay;
  const steps = Math.max(
    1,
    Math.ceil(dt / MAX_SUBSTEP_SECONDS),
    Math.ceil((dt * stiffness) / 0.1),
  );
  if (steps > MAX_SUBSTEPS)
    throw new RangeError(
      "physics combination exceeds the substep safety budget",
    );
  const h = dt / steps;
  const acceleration = (v: Vec3, w: Vec3): Vec3 => {
    const drag = scale(v, -dragK * norm(v));
    const lift = scale(cross(w, v), magnusK);
    return {
      x: drag.x + lift.x,
      y: drag.y + lift.y - physics.gravity,
      z: drag.z + lift.z,
    };
  };
  for (let i = 0; i < steps; i++) {
    const halfSpin = scale(spin, Math.exp(-physics.spinDecay * h * 0.5));
    const endSpin = scale(spin, Math.exp(-physics.spinDecay * h));
    const a1 = acceleration(velocity, spin);
    const v2 = add(velocity, scale(a1, h * 0.5));
    const a2 = acceleration(v2, halfSpin);
    const v3 = add(velocity, scale(a2, h * 0.5));
    const a3 = acceleration(v3, halfSpin);
    const v4 = add(velocity, scale(a3, h));
    const a4 = acceleration(v4, endSpin);
    position = add(position, scale(weighted(velocity, v2, v3, v4), h / 6));
    velocity = add(velocity, scale(weighted(a1, a2, a3, a4), h / 6));
    spin = endSpin;
  }
  const result = { position, velocity, spin, radius: ball.radius };
  validBall(result);
  return result;
}

/** Unchecked relative-motion quadratic, called only after public input validation. */
function intersection(
  start: Vec3,
  end: Vec3,
  center: Vec3,
  radius: number,
): number | null {
  const offset = sub(start, center),
    direction = sub(end, start);
  const c = dot(offset, offset) - radius * radius;
  if (c <= 0) return 0; // Initial overlap/touch is already contact, even while moving away.
  const a = dot(direction, direction);
  if (a === 0) return null;
  const b = dot(offset, direction);
  if (b >= 0) return null; // Moving away from the target.
  // Compute closest separation geometrically instead of subtracting b²-a*c. The latter
  // loses small-radius misses when the segment is very long compared with the sphere.
  const closest = add(offset, scale(direction, -b / a));
  const closestSquared = dot(closest, closest);
  const gap = radius * radius - closestSquared;
  const tolerance = 16 * Number.EPSILON * (radius * radius + closestSquared);
  if (gap < -tolerance) return null;
  const root = Math.sqrt(a * Math.max(0, gap));
  const fraction = c / (-b + root); // Stable entry root; avoids subtracting close large numbers.
  return fraction >= 0 && fraction <= 1 ? fraction : null;
}

/** First contact fraction [0,1] along a straight segment; null=no contact. Both radii in metres. */
export function sweptSphereHit(
  start: Vec3,
  end: Vec3,
  targetCenter: Vec3,
  ballRadius: number,
  targetRadius: number,
): number | null {
  vector(start, 1e6, "start");
  vector(end, 1e6, "end");
  vector(targetCenter, 1e6, "targetCenter");
  bounded(ballRadius, 0, 1000, "ballRadius");
  bounded(targetRadius, 0, 1000, "targetRadius");
  return intersection(start, end, targetCenter, ballRadius + targetRadius);
}

/**
 * First sphere/sphere contact when BOTH centers move linearly over the same time interval.
 * This handles crossing between endpoints; it does not predict future player movement.
 */
export function sweptMovingSphereHit(
  start: Vec3,
  end: Vec3,
  targetStart: Vec3,
  targetEnd: Vec3,
  ballRadius: number,
  targetRadius: number,
): number | null {
  vector(start, 1e6, "start");
  vector(end, 1e6, "end");
  vector(targetStart, 1e6, "targetStart");
  vector(targetEnd, 1e6, "targetEnd");
  bounded(ballRadius, 0, 1000, "ballRadius");
  bounded(targetRadius, 0, 1000, "targetRadius");
  return intersection(
    sub(start, targetStart),
    sub(end, targetEnd),
    ZERO,
    ballRadius + targetRadius,
  );
}
