import { describe, expect, it } from "vitest";
import { ROOM, rebound, stepDeadBall } from "./deadBall";
import type { BallState } from "./physics";

const ball = (over: Partial<BallState> = {}): BallState => ({
  position: { x: 0, y: 2, z: -4 },
  velocity: { x: 0, y: 0, z: 0 },
  spin: { x: 0, y: 0, z: 0 },
  radius: 0.11,
  ...over,
});
function run(start: BallState, seconds: number) {
  let state = start;
  const bounces: number[] = [],
    heights: number[] = [];
  let lowest = Infinity,
    top = 0,
    rising = false;
  for (let t = 0; t < seconds; t += 1 / 60) {
    const step = stepDeadBall(state, 1 / 60);
    if (step.bounce !== null) {
      bounces.push(step.bounce);
      if (rising) heights.push(top);
      top = 0;
    }
    rising = step.ball.velocity.y > 0 || rising;
    top = Math.max(top, step.ball.position.y);
    lowest = Math.min(lowest, step.ball.position.y);
    state = step.ball;
  }
  return { state, bounces, heights, lowest };
}

describe("a ball after the game is done with it", () => {
  it("bounces lower each time, never sinks into the floor, and comes to rest", () => {
    const { state, bounces, lowest } = run(ball(), 8);
    expect(lowest).toBeGreaterThanOrEqual(0.11 - 1e-9);
    expect(bounces.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < bounces.length; i++)
      expect(bounces[i]).toBeLessThan(bounces[i - 1]);
    expect(state.position.y).toBeCloseTo(0.11);
    expect(
      Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z),
    ).toBe(0);
  });

  it("comes back off every wall, slower, and stays in the room", () => {
    for (const velocity of [
      { x: 12, y: 1, z: 0 },
      { x: -12, y: 1, z: 0 },
      { x: 0, y: 1, z: 14 },
      { x: 0, y: 1, z: -14 },
    ]) {
      const { state, bounces } = run(ball({ velocity }), 6);
      expect(bounces.length).toBeGreaterThan(0);
      expect(Math.abs(state.position.x)).toBeLessThanOrEqual(ROOM.side);
      expect(state.position.z).toBeLessThanOrEqual(ROOM.near);
      expect(state.position.z).toBeGreaterThanOrEqual(ROOM.far);
    }
    const hit = stepDeadBall(
      ball({
        position: { x: 4.7, y: 1, z: 0 },
        velocity: { x: 10, y: 0, z: 0 },
      }),
      1 / 60,
    );
    expect(hit.bounce).toBeGreaterThan(8);
    expect(hit.ball.velocity.x).toBeLessThan(0);
    expect(Math.abs(hit.ball.velocity.x)).toBeLessThan(6);
  });

  it("rebounds off a body it struck, with most of its speed gone", () => {
    // Flying down +z into a body whose centre is straight ahead.
    const out = rebound(
      { x: 0, y: 0, z: 14 },
      { x: 0, y: 1.2, z: -0.3 },
      { x: 0, y: 1.2, z: 0 },
    );
    expect(out.z).toBeLessThan(0);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(14 * 0.35);
    // A glancing blow on the right side leaves to the right.
    const glance = rebound(
      { x: 0, y: 0, z: 14 },
      { x: 0.2, y: 1.2, z: -0.2 },
      { x: 0, y: 1.2, z: 0 },
    );
    expect(glance.x).toBeGreaterThan(0);
    expect(Math.hypot(glance.x, glance.y, glance.z)).toBeCloseTo(14 * 0.35);
  });
});
