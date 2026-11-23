import { describe, expect, it } from "vitest";
import { incomingLead, leadBall, MAX_HIT_LAG } from "./ballDisplay";
import { FIXED_STEP } from "./duel";
import { stepBall, type BallState } from "./physics";

const ball = (): BallState & { id: number } => ({
  id: 7,
  position: { x: 0.2, y: 1.6, z: -6 },
  velocity: { x: 0.3, y: 1.5, z: 13 },
  spin: { x: 0, y: 0, z: 0 },
  radius: 0.11,
});

describe("where a ball is drawn", () => {
  it("is exactly where the simulation will put it that much later", () => {
    let stepped: BallState = ball();
    for (let i = 0; i < 12; i++) stepped = stepBall(stepped, FIXED_STEP);
    const drawn = leadBall(ball(), 12 * FIXED_STEP);
    expect(drawn.position.x).toBeCloseTo(stepped.position.x, 9);
    expect(drawn.position.y).toBeCloseTo(stepped.position.y, 9);
    expect(drawn.position.z).toBeCloseTo(stepped.position.z, 9);
    expect(drawn.id).toBe(7);
  });

  it("covers part of a step, and leaves the ball alone for no lead", () => {
    const half = leadBall(ball(), FIXED_STEP / 2);
    expect(half.position.z).toBeGreaterThan(-6);
    expect(half.position.z).toBeLessThan(
      stepBall(ball(), FIXED_STEP).position.z,
    );
    const same = ball();
    expect(leadBall(same, 0)).toBe(same);
    expect(leadBall(same, Number.NaN)).toBe(same);
  });

  it("stops at the floor instead of sinking through it", () => {
    const low = {
      ...ball(),
      position: { x: 0, y: 0.2, z: -1 },
      velocity: { x: 0, y: -6, z: 8 },
    };
    expect(leadBall(low, 0.2).position.y).toBe(0.11);
  });

  it("grows the lead for pose age over the first 150 ms of flight, up to a cap", () => {
    expect(incomingLead(0, 0.1)).toBe(0);
    expect(incomingLead(0.075, 0.1)).toBeCloseTo(0.05);
    expect(incomingLead(0.15, 0.1)).toBeCloseTo(0.1);
    expect(incomingLead(0.5, 0.1)).toBeCloseTo(0.1);
    expect(incomingLead(0.5, 0.9)).toBe(MAX_HIT_LAG);
    expect(incomingLead(0.5, -1)).toBe(0);
    let last = 0;
    for (let age = 0; age <= 0.2; age += 0.01) {
      const lead = incomingLead(age, 0.12);
      expect(lead).toBeGreaterThanOrEqual(last);
      last = lead;
    }
  });

  it("makes the drawn ball reach the player when the tested body is the body they had", () => {
    // A ball flying straight at a head at z = 0. The game knows the body 110 ms late.
    const lag = 0.11;
    let sim: BallState = {
      ...ball(),
      position: { x: 0, y: 1.65, z: -8 },
      velocity: { x: 0, y: 2.6, z: 13.5 },
    };
    let t = 0,
      drawnArrival = -1,
      simArrival = -1;
    for (; t < 1 && simArrival < 0; t += FIXED_STEP) {
      const drawn = leadBall(sim, incomingLead(t, lag));
      if (drawnArrival < 0 && drawn.position.z >= 0) drawnArrival = t;
      if (sim.position.z >= 0) simArrival = t;
      sim = stepBall(sim, FIXED_STEP);
    }
    // The hit test at simArrival uses the body from (simArrival - lag): the moment
    // the drawn ball arrived, to within a physics step.
    expect(Math.abs(simArrival - lag - drawnArrival)).toBeLessThanOrEqual(
      FIXED_STEP + 1e-9,
    );
  });
});
