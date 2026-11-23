import { describe, it, expect } from "vitest";
import {
  assistedThrow,
  createAutoThrowTracker,
  opponentTarget,
} from "./autoThrow";
import {
  COURT_DISTANCE,
  createRally,
  launchBall,
  neutralPose,
  stepDuel,
} from "./duel";

type Tracker = ReturnType<typeof createAutoThrowTracker>;
const STEP = 33;
/** Neutral hips are at height 1, so y = 1.6 is a hand held beside the head. */
const pose = (t: number, z = -0.1, y = 1.6, x = 0.3) => {
  const p = neutralPose();
  p.rightHand = { x, y, z };
  return { ...p, t };
};
/** Hold the hand up by the shoulder until the tracker is ready. Returns the next pose time. */
const raise = (tracker: Tracker, from = 100) => {
  let t = from;
  for (let i = 0; i < 5; i++, t += STEP) tracker.update(pose(t), t);
  return t;
};
/** Feed one pose per depth value; returns every update. */
const drive = (tracker: Tracker, from: number, depths: number[]) =>
  depths.map((z, i) =>
    tracker.update(pose(from + i * STEP, z), from + i * STEP),
  );
const FORWARD = [0.05, 0.25, 0.45, 0.55, 0.56, 0.56, 0.56];
const speedOf = (v: { x: number; y: number; z: number }) =>
  Math.hypot(v.x, v.y, v.z);

describe("camera-only automatic throw", () => {
  it("throws once when a raised hand drives forward, as the hand slows", () => {
    const tracker = createAutoThrowTracker();
    const t = raise(tracker);
    expect(tracker.update(pose(t), t).cue).toBe("throw-forward");
    const updates = drive(tracker, t + STEP, FORWARD);
    const shots = updates.filter((u) => u.shot);
    expect(shots.length).toBe(1);
    const at = updates.findIndex((u) => u.shot);
    // Not at the first sign of movement: the ball leaves near the end of the drive.
    expect(at).toBeGreaterThanOrEqual(3);
    expect(shots[0].cue).toBe("released");
    expect(shots[0].shot!.origin).toEqual(pose(0, FORWARD[at]).rightHand);
    expect(shots[0].shot!.velocity.z).toBeGreaterThan(0);
    expect(updates.at(-1)!.state).toBe("released");
  });

  it("throws from the downward follow-through when no depth is reported", () => {
    const tracker = createAutoThrowTracker();
    let t = raise(tracker);
    const shots = [];
    for (const y of [1.55, 1.42, 1.28, 1.16, 1.1, 1.08, 1.08]) {
      shots.push(tracker.update(pose(t, -0.1, y), t).shot);
      t += STEP;
    }
    expect(shots.filter(Boolean).length).toBe(1);
  });

  it("does not throw from a hand that was never raised above the waist", () => {
    const tracker = createAutoThrowTracker();
    let t = 100;
    for (let i = 0; i < 5; i++, t += STEP) tracker.update(pose(t, 0, 0.95), t);
    for (const z of FORWARD) {
      const result = tracker.update(pose(t, z, 0.95), t);
      expect(result.shot).toBeNull();
      expect(result.cue).toBe("bring-back");
      t += STEP;
    }
  });

  it("does not throw while the hand is raised or drawn back", () => {
    const tracker = createAutoThrowTracker();
    let t = 100;
    for (let i = 0; i <= 12; i++, t += STEP)
      expect(
        tracker.update(pose(t, 0.1 - i * 0.03, 0.95 + i * 0.06), t).shot,
      ).toBeNull();
  });

  it("does not throw from a slow reach or small adjustments", () => {
    const tracker = createAutoThrowTracker();
    let t = raise(tracker);
    for (let i = 1; i <= 30; i++, t += STEP)
      expect(tracker.update(pose(t, -0.1 + i * 0.02), t).shot).toBeNull();
  });

  it("does not throw from whole-body movement", () => {
    const tracker = createAutoThrowTracker();
    let t = raise(tracker);
    for (let i = 1; i <= 5; i++, t += STEP) {
      const p = pose(t);
      p.root.x = -i * 0.08;
      p.root.z = i * 0.05;
      p.rightHand.x += p.root.x;
      p.rightHand.z += p.root.z;
      expect(tracker.update(p, t).shot).toBeNull();
    }
  });

  it("skips poses in which the wrist is not seen instead of starting over", () => {
    const tracker = createAutoThrowTracker();
    let t = raise(tracker);
    const shots = [];
    for (const [i, z] of FORWARD.entries()) {
      shots.push(
        tracker.update(pose(t, z), t, { handTracked: i !== 1 && i !== 2 }).shot,
      );
      t += STEP;
    }
    expect(shots.filter(Boolean).length).toBe(1);
  });

  it("starts over after a long gap and needs the hand raised again", () => {
    const tracker = createAutoThrowTracker();
    const t = raise(tracker) + 400;
    const updates = drive(tracker, t, [0.3, 0.5, 0.6]);
    expect(updates.every((u) => u.shot === null)).toBe(true);
    expect(updates[0].cue).toBe("bring-back");
  });

  it("ignores stale poses and repeated captures", () => {
    const tracker = createAutoThrowTracker();
    const t = raise(tracker);
    expect(tracker.update(pose(t), t + 260).state).toBe("no-pose");
    const again = createAutoThrowTracker();
    const next = raise(again);
    again.update(pose(next, 0.05), next);
    // The same capture seen on later render frames is not new motion.
    for (let now = next + 5; now < next + 60; now += 16)
      expect(again.update(pose(next, 0.05), now).shot).toBeNull();
  });

  describe("a throwing motion that does not throw", () => {
    const hints = (updates: { hint?: string; shot: unknown }[]) => ({
      hints: updates.map((u) => u.hint).filter(Boolean),
      shots: updates.filter((u) => u.shot).length,
    });
    it("says the throw was too soft when a raised hand is pushed gently", () => {
      const tracker = createAutoThrowTracker();
      const t = raise(tracker);
      // 18 cm forward at about 1.8 units a second, then still: nearly a throw.
      const gentle = [-0.04, 0.02, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08];
      expect(hints(drive(tracker, t, gentle))).toEqual({
        hints: ["too-soft"],
        shots: 0,
      });
    });
    it("says the hand was too low when a real throw starts below the waist", () => {
      const tracker = createAutoThrowTracker();
      let t = 100;
      const updates = [];
      for (let i = 0; i < 5; i++, t += STEP)
        updates.push(tracker.update(pose(t, 0, 0.95), t));
      for (const z of [...FORWARD, 0.56, 0.56]) {
        updates.push(tracker.update(pose(t, z, 0.95), t));
        t += STEP;
      }
      expect(hints(updates)).toEqual({ hints: ["hand-low"], shots: 0 });
    });
    it("stays quiet for a real throw, for raising the hand and for holding it", () => {
      const thrown = createAutoThrowTracker();
      expect(hints(drive(thrown, raise(thrown), FORWARD)).hints).toEqual([]);
      const raising = createAutoThrowTracker();
      let t = 100;
      const up = [];
      for (let i = 0; i <= 12; i++, t += STEP)
        up.push(raising.update(pose(t, 0.1 - i * 0.03, 0.95 + i * 0.06), t));
      for (let i = 0; i < 20; i++, t += STEP)
        up.push(raising.update(pose(t, -0.26, 1.67), t));
      expect(hints(up)).toEqual({ hints: [], shots: 0 });
    });
    it("does not nag: one hint per second and a half at most", () => {
      const tracker = createAutoThrowTracker();
      let t = raise(tracker);
      const all = [];
      for (let round = 0; round < 3; round++)
        for (const z of [-0.04, 0.02, 0.08, 0.08, 0.08, 0.08, 0, -0.1, -0.1]) {
          all.push(tracker.update(pose(t, z), t));
          t += STEP;
        }
      // Three gentle pushes in under a second.
      expect(hints(all).hints.length).toBe(1);
    });
  });

  it("gives a faster ball for a faster hand, toward the target it is given", () => {
    const origin = pose(0).rightHand;
    const target = { x: 0, y: 1.2, z: COURT_DISTANCE };
    const slow = assistedThrow(origin, target, 2),
      fast = assistedThrow(origin, target, 6);
    expect(speedOf(fast.velocity)).toBeGreaterThan(speedOf(slow.velocity));
    expect(speedOf(fast.velocity)).toBeLessThanOrEqual(18.000001);
    expect(
      assistedThrow(origin, { ...target, x: -0.5 }, 4).velocity.x,
    ).toBeLessThan(assistedThrow(origin, { ...target, x: 0.5 }, 4).velocity.x);
  });

  it("goes straight ahead when no target is given", () => {
    const tracker = createAutoThrowTracker();
    const shot = drive(tracker, raise(tracker), FORWARD).find(
      (u) => u.shot,
    )!.shot!;
    expect(Math.abs(shot.velocity.x)).toBeLessThan(0.05);
  });

  it("aims at the opponent's torso and lands there with the real ball physics", () => {
    for (const x of [-0.5, 0, 0.5]) {
      const opponent = neutralPose();
      opponent.root.x = opponent.head.x = x;
      const target = opponentTarget(opponent);
      expect(target).toEqual({ x: -x, y: 1.2, z: COURT_DISTANCE });
      const tracker = createAutoThrowTracker();
      let t = raise(tracker),
        shot = null;
      for (const z of FORWARD) {
        shot ??= tracker.update(pose(t, z), t, { target }).shot;
        t += STEP;
      }
      const mine = neutralPose();
      mine.rightHand = { ...shot!.origin };
      let state = createRally(0, 0);
      state = { ...state, poses: [mine, opponent], previous: [mine, opponent] };
      state = launchBall(state, 0, shot!);
      expect(state.balls.length).toBe(1);
      for (let i = 0; i < 240 && state.hp[1] === 5; i++)
        state = stepDuel(state, state.poses);
      expect(state.hp[1]).toBe(4);
    }
  });
});
