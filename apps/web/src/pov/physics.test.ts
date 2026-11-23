import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHYSICS,
  MAX_STEP_SECONDS,
  stepBall,
  sweptMovingSphereHit,
  sweptSphereHit,
  type BallPhysics,
  type BallState,
} from "./physics";

const zero = () => ({ x: 0, y: 0, z: 0 });
const initial = (): BallState => ({
  position: { x: 1, y: 2, z: 3 },
  velocity: { x: 8, y: 6, z: -12 },
  spin: zero(),
  radius: 0.12,
});
const vacuum: BallPhysics = { ...DEFAULT_PHYSICS, airDensity: 0, spinDecay: 0 };
const energy = (b: BallState, p: BallPhysics) =>
  p.mass *
  ((b.velocity.x ** 2 + b.velocity.y ** 2 + b.velocity.z ** 2) / 2 +
    p.gravity * b.position.y);

function advance(b: BallState, seconds: number, p: BallPhysics) {
  const ticks = Math.round(seconds * 120);
  for (let i = 0; i < ticks; i++) b = stepBall(b, 1 / 120, p);
  return b;
}

describe("SI projectile model", () => {
  it("matches the analytic ideal parabola independently in all axes", () => {
    const b = initial(),
      t = 2;
    const next = advance(b, t, vacuum);
    expect(next.position.x).toBeCloseTo(b.position.x + b.velocity.x * t, 10);
    expect(next.position.z).toBeCloseTo(b.position.z + b.velocity.z * t, 10);
    expect(next.position.y).toBeCloseTo(
      b.position.y + b.velocity.y * t - 0.5 * vacuum.gravity * t * t,
      10,
    );
    expect(next.velocity.y).toBeCloseTo(b.velocity.y - vacuum.gravity * t, 10);
  });

  it("matches the analytic one-dimensional quadratic-drag solution", () => {
    const p = {
      ...DEFAULT_PHYSICS,
      gravity: 0,
      magnusCoefficient: 0,
      spinDecay: 0,
    };
    const b = {
        ...initial(),
        position: zero(),
        velocity: { x: 20, y: 0, z: 0 },
      },
      t = 2;
    const k =
      (0.5 * p.airDensity * Math.PI * b.radius ** 2 * p.dragCoefficient) /
      p.mass;
    const next = advance(b, t, p);
    expect(next.velocity.x).toBeCloseTo(20 / (1 + k * 20 * t), 8);
    expect(next.position.x).toBeCloseTo(Math.log(1 + k * 20 * t) / k, 8);
    expect(next.velocity.y).toBe(0);
    expect(next.velocity.z).toBe(0);
  });

  it("drag dissipates translational mechanical energy even with gravity and spin", () => {
    const p = { ...DEFAULT_PHYSICS };
    let b = { ...initial(), spin: { x: 10, y: 30, z: -12 } };
    for (let i = 0; i < 360; i++) {
      const before = energy(b, p);
      b = stepBall(b, 1 / 120, p);
      expect(energy(b, p)).toBeLessThanOrEqual(before + 1e-9);
    }
  });

  it("Magnus curves perpendicular to motion, reverses with spin, and does no work", () => {
    const p = {
      ...DEFAULT_PHYSICS,
      gravity: 0,
      dragCoefficient: 0,
      spinDecay: 0,
    };
    const b = {
      ...initial(),
      position: zero(),
      velocity: { x: 0, y: 0, z: -15 },
      spin: { x: 0, y: 30, z: 0 },
    };
    const left = advance(b, 2, p);
    const right = advance({ ...b, spin: { x: 0, y: -30, z: 0 } }, 2, p);
    expect(left.position.x).toBeLessThan(0);
    expect(right.position.x).toBeGreaterThan(0);
    expect(left.position.x).toBeCloseTo(-right.position.x, 10);
    expect(left.position.z).toBeCloseTo(right.position.z, 10);
    expect(energy(left, p)).toBeCloseTo(energy(b, p), 8);
  });

  it("has no Magnus lift for spin parallel to velocity or for zero air density", () => {
    const b = {
      ...initial(),
      position: zero(),
      velocity: { x: 0, y: 0, z: -15 },
      spin: { x: 0, y: 0, z: 30 },
    };
    const p = { ...DEFAULT_PHYSICS, gravity: 0, dragCoefficient: 0 };
    expect(advance(b, 1, p).position.x).toBe(0);
    const empty = advance({ ...b, spin: { x: 0, y: 30, z: 0 } }, 1, {
      ...p,
      airDensity: 0,
    });
    expect(empty.position.x).toBe(0);
    expect(empty.position.z).toBeCloseTo(-15, 10);
  });

  it("decays spin exponentially without changing its direction", () => {
    const b = { ...initial(), spin: { x: 10, y: -20, z: 30 } };
    const next = advance(b, 1, { ...vacuum, spinDecay: 0.8 });
    expect(next.spin.x).toBeCloseTo(10 * Math.exp(-0.8), 10);
    expect(next.spin.y).toBeCloseTo(-20 * Math.exp(-0.8), 10);
    expect(next.spin.z).toBeCloseTo(30 * Math.exp(-0.8), 10);
  });

  it("is independent of caller frame partitions when they share fixed substeps", () => {
    const b = { ...initial(), spin: { x: 10, y: 20, z: -5 } };
    const one = stepBall(b, 0.1);
    let split = b;
    for (let i = 0; i < 12; i++) split = stepBall(split, 1 / 120);
    expect(one.position.x).toBeCloseTo(split.position.x, 10);
    expect(one.position.y).toBeCloseTo(split.position.y, 10);
    expect(one.position.z).toBeCloseTo(split.position.z, 10);
  });

  it("never mutates the supplied state, including a zero-duration step", () => {
    const b = initial();
    Object.freeze(b.position);
    Object.freeze(b.velocity);
    Object.freeze(b.spin);
    Object.freeze(b);
    const snapshot = JSON.stringify(b);
    const next = stepBall(b, 0.1);
    const clone = stepBall(b, 0);
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(next).not.toBe(b);
    expect(clone).toEqual(b);
    expect(clone.position).not.toBe(b.position);
    expect(clone.velocity).not.toBe(b.velocity);
    expect(clone.spin).not.toBe(b.spin);
  });

  it.each([NaN, Infinity, -1, MAX_STEP_SECONDS + 0.001])(
    "rejects invalid dt %s instead of dropping elapsed time",
    (dt) => {
      expect(() => stepBall(initial(), dt)).toThrow(RangeError);
    },
  );

  it("rejects nonfinite state, invalid physics and pathologically stiff combinations", () => {
    expect(() =>
      stepBall({ ...initial(), velocity: { x: NaN, y: 0, z: 0 } }, 0.01),
    ).toThrow(RangeError);
    expect(() =>
      stepBall(initial(), 0.01, { ...DEFAULT_PHYSICS, mass: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      stepBall(initial(), 0.01, { ...DEFAULT_PHYSICS, dragCoefficient: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      stepBall({ ...initial(), radius: 2 }, 0.25, {
        ...DEFAULT_PHYSICS,
        mass: 0.001,
        airDensity: 10,
        dragCoefficient: 5,
      }),
    ).toThrow(/substep safety budget/);
  });
});

describe("swept sphere collision", () => {
  it("detects a fast ball tunneling past a target and returns first surface contact", () => {
    expect(
      sweptSphereHit(
        { x: -10, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        zero(),
        0.1,
        0.4,
      ),
    ).toBeCloseTo(0.475, 12);
  });
  it("handles tangency, endpoint contact, initial overlap, stationary and receding paths", () => {
    expect(
      sweptSphereHit(
        { x: -2, y: 1, z: 0 },
        { x: 2, y: 1, z: 0 },
        zero(),
        0.5,
        0.5,
      ),
    ).toBeCloseTo(0.5, 12);
    expect(
      sweptSphereHit(
        { x: -2, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
        zero(),
        0.5,
        0.5,
      ),
    ).toBe(1);
    expect(sweptSphereHit(zero(), { x: 2, y: 0, z: 0 }, zero(), 0.1, 0.2)).toBe(
      0,
    );
    expect(
      sweptSphereHit(
        { x: 2, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        zero(),
        0.1,
        0.2,
      ),
    ).toBeNull();
    expect(
      sweptSphereHit(
        { x: 2, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        zero(),
        0.1,
        0.2,
      ),
    ).toBeNull();
    expect(
      sweptSphereHit(
        { x: -2, y: 1.001, z: 0 },
        { x: 2, y: 1.001, z: 0 },
        zero(),
        0.5,
        0.5,
      ),
    ).toBeNull();
  });
  it("uses relative motion for a crossing target missed by static-endpoint collision", () => {
    const start = { x: -1, y: 0, z: 0 },
      end = { x: 1, y: 0, z: 0 };
    const targetStart = { x: 0, y: 1, z: 0 },
      targetEnd = { x: 0, y: -1, z: 0 };
    expect(sweptSphereHit(start, end, targetEnd, 0.1, 0.1)).toBeNull();
    expect(
      sweptMovingSphereHit(start, end, targetStart, targetEnd, 0.1, 0.1),
    ).toBeCloseTo((Math.sqrt(2) - 0.2) / Math.sqrt(8), 12);
  });
  it("does not invent collision when both objects maintain separation", () => {
    expect(
      sweptMovingSphereHit(
        zero(),
        { x: 10, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 12, y: 0, z: 0 },
        0.1,
        0.2,
      ),
    ).toBeNull();
  });
  it("does not inflate a tiny sphere for a very long segment", () => {
    expect(
      sweptSphereHit(
        { x: -900000, y: 0.201, z: 0 },
        { x: 900000, y: 0.201, z: 0 },
        zero(),
        0.1,
        0.1,
      ),
    ).toBeNull();
    expect(
      sweptSphereHit(
        { x: -900000, y: 0, z: 0 },
        { x: 900000, y: 0, z: 0 },
        zero(),
        0.1,
        0.1,
      ),
    ).toBeCloseTo((900000 - 0.2) / 1800000, 12);
  });
  it("rejects malformed coordinates and radii", () => {
    expect(() => sweptSphereHit(zero(), zero(), zero(), -1, 0.2)).toThrow(
      RangeError,
    );
    expect(() =>
      sweptSphereHit(zero(), { x: Infinity, y: 0, z: 0 }, zero(), 0.1, 0.2),
    ).toThrow(RangeError);
    expect(() =>
      sweptMovingSphereHit(zero(), zero(), zero(), zero(), 0.1, NaN),
    ).toThrow(RangeError);
  });
});
