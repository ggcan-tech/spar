import { describe, it, expect } from "vitest";
import { createDuel, type DuelBall } from "./duel";
import { createSnapshotBuffer } from "./presentation";
import { JOINT, solveBody } from "./body";
const ball = (id: number, x = 0): DuelBall => ({
  id,
  owner: 0,
  age: x,
  position: { x, y: 1, z: 0 },
  velocity: { x, y: 0, z: 0 },
  spin: { x, y: 0, z: 0 },
  radius: 0.11,
});
describe("render snapshot interpolation", () => {
  it("interpolates by ID and arrival time while retaining latest authority", () => {
    const b = createSnapshotBuffer(),
      a = createDuel(),
      z = createDuel();
    a.balls = [ball(1), ball(2, 20)];
    z.time = 1;
    z.balls = [ball(2, 30), ball(1, 10)];
    z.poses[0].head.x = 0.6;
    z.hp = [5, 4];
    z.hits = 1;
    b.push(a, 100);
    b.push(z, 200);
    const s = b.sample(200)!;
    expect(s.time).toBe(0.5);
    expect(s.poses[0].head.x).toBe(0.3);
    expect(s.balls.map((v) => v.position.x)).toEqual([5, 25]);
    expect(s.balls[0].velocity.x).toBe(5);
    expect(s.balls[0].spin.x).toBe(5);
    expect(s.hp).toEqual([5, 4]);
    expect(s.hits).toBe(1);
    s.poses[0].head.x = 999;
    s.balls[0].position.x = 999;
    expect(b.sample(200)!.balls[0].position.x).toBe(5);
    expect(a.balls[0].position.x).toBe(0);
  });
  it("does not spawn early or resurrect an authoritative removed projectile", () => {
    const b = createSnapshotBuffer({ delayMs: 0 }),
      a = createDuel(),
      z = createDuel();
    z.time = 1;
    z.balls = [ball(1)];
    b.push(a, 0);
    b.push(z, 100);
    expect(b.sample(99)!.balls).toHaveLength(0);
    expect(b.sample(100)!.balls).toHaveLength(1);
    const gone = createDuel();
    gone.time = 2;
    gone.hp = [5, 4];
    b.push(gone, 200);
    expect(b.sample(100)!.balls).toHaveLength(0);
    expect(b.sample(100)!.hp[1]).toBe(4);
  });
  it("clamps before/after available snapshots and bounds retained history", () => {
    const b = createSnapshotBuffer({ delayMs: 0 });
    expect(b.sample(0)).toBeNull();
    for (let i = 0; i < 12; i++) {
      const s = createDuel();
      s.time = i;
      s.poses[0].head.x = i;
      b.push(s, i * 100);
    }
    expect(b.sample(-100)!.time).toBe(4);
    expect(b.sample(99999)!.time).toBe(11);
  });
  it("resets discontinuities and replaces same-arrival snapshots without division by zero", () => {
    const b = createSnapshotBuffer(),
      a = createDuel();
    a.time = 10;
    b.push(a, 100);
    const z = createDuel();
    z.time = 11;
    b.push(z, 100);
    expect(b.sample(100)!.time).toBe(11);
    const fresh = createDuel();
    b.push(fresh, 200);
    expect(b.sample(0)!.time).toBe(0);
    fresh.time = 3;
    b.push(fresh, 50);
    expect(b.sample(0)!.time).toBe(3);
    fresh.time = 999;
    expect(b.sample(0)!.time).toBe(3);
    b.reset();
    expect(b.sample(0)).toBeNull();
  });
  it("rejects nonfinite timing and unbounded delay", () => {
    expect(() => createSnapshotBuffer({ delayMs: Infinity })).toThrow();
    const b = createSnapshotBuffer();
    expect(() => b.push(createDuel(), NaN)).toThrow();
    expect(() => b.sample(Infinity)).toThrow();
  });
  it("interpolates every skeleton joint and adopts a skeleton that appears mid-stream", () => {
    const b = createSnapshotBuffer(),
      a = createDuel(),
      z = createDuel();
    a.poses[1].body = solveBody(a.poses[1]);
    z.time = 1;
    z.poses[1].body = solveBody(z.poses[1]);
    z.poses[1].body[JOINT.R_ELBOW].y += 0.4;
    z.poses[0].body = solveBody(z.poses[0]);
    b.push(a, 100);
    b.push(z, 200);
    const s = b.sample(200)!;
    expect(s.poses[1].body![JOINT.R_ELBOW].y).toBeCloseTo(
      a.poses[1].body[JOINT.R_ELBOW].y + 0.2,
    );
    expect(s.poses[1].body![JOINT.L_KNEE]).toEqual(a.poses[1].body[JOINT.L_KNEE]);
    expect(s.poses[0].body).toEqual(z.poses[0].body);
    s.poses[1].body![0].x = 99;
    expect(b.sample(200)!.poses[1].body![0].x).not.toBe(99);
  });
});
