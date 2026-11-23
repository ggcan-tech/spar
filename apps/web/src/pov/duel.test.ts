import { describe, it, expect } from "vitest";
import {
  createDuel,
  launchBall,
  stepDuel,
  neutralPose,
  worldPoint,
  validPose,
  botThrow,
  botPose,
} from "./duel";
describe("POV duel contract", () => {
  it("puts both players in the same world from opposite POVs", () => {
    expect(worldPoint({ x: 0.2, y: 1, z: 0.3 }, 0)).toEqual({
      x: 0.2,
      y: 1,
      z: -0.3,
    });
    expect(worldPoint({ x: 0.2, y: 1, z: 0.3 }, 1)).toEqual({
      x: -0.2,
      y: 1,
      z: -7.7,
    });
  });
  it("rejects out-of-area body poses without changing the motion gain", () => {
    const p = neutralPose();
    p.root.x = 0.7;
    expect(validPose(p)).toBe(false);
    const s = createDuel();
    expect(stepDuel(s, [p, neutralPose()]).poses[0]).toBe(s.poses[0]);
  });
  it("rejects impossible launches and enforces cooldown", () => {
    const s = createDuel(),
      shot = {
        origin: s.poses[0].rightHand,
        velocity: { x: 0, y: 3, z: 10 },
        spin: { x: 0, y: 0, z: 0 },
      };
    const a = launchBall(s, 0, shot);
    expect(a.balls).toHaveLength(1);
    expect(launchBall(a, 0, shot)).toBe(a);
    expect(
      launchBall(s, 0, { ...shot, velocity: { x: 0, y: 0, z: 100 } }),
    ).toBe(s);
  });
  it("records each contact once and does not mutate the input", () => {
    const s = createDuel();
    s.balls = [
      {
        id: 1,
        owner: 0,
        age: 0,
        position: { x: 0, y: 1.65, z: -7.65 },
        velocity: { x: 0, y: 0, z: -18 },
        spin: { x: 0, y: 0, z: 0 },
        radius: 0.11,
      },
    ];
    let next = stepDuel(s, s.poses);
    next = stepDuel(next, next.poses);
    expect(s.hp[1]).toBe(5);
    expect(next.hp[1]).toBe(4);
    expect(next.balls).toHaveLength(0);
    expect(stepDuel(next, next.poses).hp[1]).toBe(4);
  });
});

describe("POV continuous contact regressions", () => {
  it("removes a floor-contacted ball before a later body crossing in the same step", () => {
    const s = createDuel();
    const crouch = neutralPose();
    crouch.root.y = 0.35;
    crouch.head.y = 0.6;
    expect(validPose(crouch)).toBe(true);
    s.poses[1] = crouch;
    // Initial floor contact occurs at t=0; upward motion would reach the low torso later.
    s.balls = [
      {
        id: 1,
        owner: 0,
        age: 0,
        position: { x: 0, y: 0.05, z: -8 },
        velocity: { x: 0, y: 18, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
        radius: 0.11,
      },
    ];
    const next = stepDuel(s, s.poses, 0.025);
    expect(next.hp).toEqual([5, 5]);
    expect(next.hits).toBe(0);
    expect(next.misses).toBe(1);
    expect(next.balls).toHaveLength(0);
  });

  it("counts earlier body contact even when the segment reaches the floor afterward", () => {
    const s = createDuel();
    const crouch = neutralPose();
    crouch.root.y = 0.35;
    crouch.head.y = 0.6;
    s.poses[1] = crouch;
    // A synthetic high-speed state exercises ordering independently of the launch-speed cap.
    s.balls = [
      {
        id: 1,
        owner: 0,
        age: 0,
        position: { x: -0.5, y: 0.65, z: -8 },
        velocity: { x: 40, y: -40, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
        radius: 0.11,
      },
    ];
    const next = stepDuel(s, s.poses, 0.025);
    expect(next.hp).toEqual([5, 4]);
    expect(next.hits).toBe(1);
    expect(next.misses).toBe(0);
    expect(next.balls).toHaveLength(0);
  });

  it("mirrors the same local throw for the other player, including axial spin", () => {
    const initial = createDuel();
    const shot = {
      origin: initial.poses[0].rightHand,
      velocity: { x: 1.5, y: 4, z: 12 },
      spin: { x: 3, y: 10, z: -5 },
    };
    let near = launchBall(initial, 0, shot),
      far = launchBall(initial, 1, shot);
    for (let i = 0; i < 24; i++) {
      near = stepDuel(near, near.poses);
      far = stepDuel(far, far.poses);
    }
    expect(near.balls).toHaveLength(1);
    expect(far.balls).toHaveLength(1);
    const a = near.balls[0],
      b = far.balls[0];
    expect(b.position.x).toBeCloseTo(-a.position.x, 10);
    expect(b.position.y).toBeCloseTo(a.position.y, 10);
    expect(b.position.z).toBeCloseTo(-8 - a.position.z, 10);
    expect(b.velocity.x).toBeCloseTo(-a.velocity.x, 10);
    expect(b.velocity.y).toBeCloseTo(a.velocity.y, 10);
    expect(b.velocity.z).toBeCloseTo(-a.velocity.z, 10);
    expect(b.spin.x).toBeCloseTo(-a.spin.x, 10);
    expect(b.spin.y).toBeCloseTo(a.spin.y, 10);
    expect(b.spin.z).toBeCloseTo(-a.spin.z, 10);
    expect(initial.balls).toHaveLength(0);
  });

  it("catches a high-speed crossing even when both endpoints are outside the head", () => {
    const s = createDuel();
    // Synthetic stress case; launchBall deliberately rejects this initial speed for players.
    s.balls = [
      {
        id: 1,
        owner: 0,
        age: 0,
        position: { x: 0, y: 1.65, z: -6.8 },
        velocity: { x: 0, y: 0, z: -120 },
        spin: { x: 0, y: 0, z: 0 },
        radius: 0.11,
      },
    ];
    const next = stepDuel(s, s.poses, 0.025);
    expect(next.hp).toEqual([5, 4]);
    expect(next.hits).toBe(1);
    expect(next.balls).toHaveLength(0);
    expect(stepDuel(next, next.poses).hits).toBe(1);
  });
});

describe("committed training throw", () => {
  it("delivers the faster duel throw sooner while preserving committed flight and legal launch speed", () => {
    const timeToHit = (pace: "practice" | "duel") => {
      const initial = createDuel();
      initial.poses[1] = botPose(0, 0);
      const shot = botThrow(initial, pace);
      expect(
        Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z),
      ).toBeLessThanOrEqual(18);
      let s = launchBall(initial, 1, shot);
      for (let i = 0; i < 150 && !s.hits; i++) s = stepDuel(s, s.poses);
      expect(s.hits).toBe(1);
      expect(s.events?.at(-1)).toMatchObject({ kind: "hit", target: 0 });
      return s.time;
    };
    const slow = timeToHit("practice"),
      fast = timeToHit("duel");
    expect(fast).toBeLessThan(0.65);
    expect(slow - fast).toBeGreaterThan(0.2);
  });
  it("keeps wind-up, release and follow-through inside the same collision-valid body envelope", () => {
    for (let i = 0; i <= 90; i++) {
      const until = 0.6 - i * 0.01;
      expect(validPose(botPose(i * 0.01, until >= 0 ? until : 2, -until))).toBe(
        true,
      );
    }
    expect(botPose(1, 0.3).rightHand.z).toBeLessThan(botPose(1, 0).rightHand.z);
    expect(botPose(1, 2, 0).rightHand.z).toBeCloseTo(botPose(1, 0).rightHand.z);
  });
  it("solves a neutral head hit with the actual drag model", () => {
    const initial = createDuel(),
      shot = botThrow(initial);
    expect(
      Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z),
    ).toBeLessThanOrEqual(18);
    let state = launchBall(initial, 1, shot);
    for (let i = 0; i < 300; i++) state = stepDuel(state, state.poses);
    expect(state.hp).toEqual([4, 5]);
    expect(state.hits).toBe(1);
    expect(state.misses).toBe(0);
  });
  it("does not home after release: dodging changes contact, not trajectory", () => {
    const initial = createDuel(),
      shot = botThrow(initial);
    let still = launchBall(initial, 1, shot),
      dodged = launchBall(initial, 1, shot);
    const away = neutralPose();
    for (const key of ["head", "root", "leftHand", "rightHand"] as const)
      away[key].x += 0.6;
    expect(validPose(away)).toBe(true);
    for (let i = 0; i < 60; i++) {
      still = stepDuel(still, still.poses);
      dodged = stepDuel(dodged, [away, dodged.poses[1]]);
      expect(still.balls).toHaveLength(1);
      expect(dodged.balls).toEqual(still.balls);
    }
    for (let i = 60; i < 600; i++) {
      still = stepDuel(still, still.poses);
      dodged = stepDuel(dodged, dodged.poses);
    }
    expect(still.hits).toBe(1);
    expect(dodged.hits).toBe(0);
    expect(dodged.misses).toBe(1);
    expect(dodged.hp).toEqual([5, 5]);
  });
});
