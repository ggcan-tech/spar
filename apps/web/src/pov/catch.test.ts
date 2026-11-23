import { describe, expect, it } from "vitest";
import { plannedBotThrow, type BotPlan } from "./botMind";
import {
  CATCH,
  FIXED_STEP,
  canRelease,
  createRally,
  launchBall,
  localPoint,
  neutralPose,
  stepDuel,
  worldPoint,
  type DuelState,
  type PlayerPose,
} from "./duel";
import { outcomeWord } from "./banner";
import { createSoundDirector } from "./soundCues";

const PLAN: BotPlan = {
  windup: 0.6,
  target: "head",
  lead: 0,
  error: { x: 0, y: 0 },
  flight: 0.62,
  fake: 0,
};
type Hands = (untilArrival: number) => {
  left: { x: number; y: number };
  right: { x: number; y: number };
};
const AT_SIDES = { left: { x: -0.3, y: 0.95 }, right: { x: 0.3, y: 0.95 } };
const ON_BALL = (y = 1.65, x = 0) => ({
  left: { x: x - 0.13, y },
  right: { x: x + 0.13, y },
});
/** Hands at the sides until `before` seconds ahead of the ball, then on it. */
const clap =
  (before: number, y = 1.65, x = 0): Hands =>
  (untilArrival) =>
    untilArrival > before ? AT_SIDES : ON_BALL(y, x);

/** The opponent throws at the head of a player whose hands follow `hands`. */
function face(
  hands: Hands,
  canCatch: readonly [boolean, boolean] = [true, false],
  plan = PLAN,
) {
  const me = (untilArrival: number): PlayerPose => {
    const p = neutralPose();
    const h = hands(untilArrival);
    p.leftHand = { ...h.left, z: 0.35 };
    p.rightHand = { ...h.right, z: 0.35 };
    return p;
  };
  let state: DuelState = createRally(1, 0);
  state = stepDuel(
    { ...state, poses: [me(9), state.poses[1]], previous: [me(9), state.poses[1]] },
    [me(9), state.poses[1]],
    FIXED_STEP,
    canCatch,
  );
  state = launchBall(state, 1, plannedBotThrow(state, plan));
  expect(state.balls.length).toBe(1);
  const launched = state.time;
  for (let i = 0; i < 300 && state.balls.length; i++)
    state = stepDuel(
      state,
      [me(plan.flight - (state.time + FIXED_STEP - launched)), state.poses[1]],
      FIXED_STEP,
      canCatch,
    );
  return state;
}

describe("the two-hand catch", () => {
  it("takes the ball out of the air when both hands close on it as it arrives", () => {
    const s = face(clap(0.2));
    expect(s.hp).toEqual([5, 5]);
    expect(s.balls).toEqual([]);
    const event = s.events!.at(-1)!;
    expect(event).toMatchObject({ kind: "catch", target: 0 });
    // Caught in front of the body, not inside it.
    const at = localPoint(event.position, 0);
    expect(at.z).toBeGreaterThan(CATCH.near);
    expect(at.z).toBeLessThanOrEqual(CATCH.far + 0.2);
    expect(s.message).toContain("caught");
  });

  it("gives the catcher the ball sooner than a dodge does", () => {
    let s = face(clap(0.2));
    expect(s.rally).toMatchObject({ turn: 0, phase: "ready" });
    expect(s.rally!.readyAt - s.time).toBeCloseTo(CATCH.readyIn);
    expect(canRelease(s, 0)).toBe(false);
    for (let i = 0; i < 0.16 / FIXED_STEP; i++) s = stepDuel(s, s.poses);
    expect(canRelease(s, 0)).toBe(true);
    // A dodged ball is not available for 0.6 s.
    const dodged = face(() => AT_SIDES, [true, false], {
      ...PLAN,
      error: { x: 0.6, y: 0 },
    });
    expect(dodged.events!.at(-1)!.kind).not.toBe("catch");
    expect(dodged.rally!.readyAt - dodged.time).toBeGreaterThan(0.4);
  });

  it("is not a shield: hands parked together in front of the face are hit", () => {
    const parked = face(() => ON_BALL());
    expect(parked.hp[0]).toBe(4);
    expect(parked.events!.at(-1)!.kind).toBe("hit");
    // Closed too early and held: the same.
    expect(face(clap(0.5)).hp[0]).toBe(4);
  });

  it("needs both hands at the ball", () => {
    // Hands closed at the waist while the ball comes at the head.
    expect(face(clap(0.2, 1.05)).hp[0]).toBe(4);
    // Closed off to one side.
    expect(face(clap(0.2, 1.65, 0.5)).hp[0]).toBe(4);
    // One hand on the ball, the other out wide.
    const oneHand: Hands = (u) =>
      u > 0.2
        ? AT_SIDES
        : { left: { x: -0.55, y: 1.3 }, right: { x: 0.1, y: 1.65 } };
    expect(face(oneHand).hp[0]).toBe(4);
    // Hands that never came together.
    const open: Hands = (u) =>
      u > 0.2
        ? AT_SIDES
        : { left: { x: -0.28, y: 1.65 }, right: { x: 0.28, y: 1.65 } };
    expect(face(open).hp[0]).toBe(4);
  });

  it("catches a ball at the body as well as at the head", () => {
    const s = face(clap(0.2, 1.2), [true, false], { ...PLAN, target: "torso" });
    expect(s.hp[0]).toBe(5);
    expect(s.events!.at(-1)!.kind).toBe("catch");
  });

  it("is off unless asked for, and only for the player it is given to", () => {
    expect(face(clap(0.2), [false, false]).hp[0]).toBe(4);
    expect(face(clap(0.2), [false, true]).hp[0]).toBe(4);
    // Default arguments: the rules as they were.
    const p = neutralPose();
    const s = createRally(1, 0);
    expect(stepDuel(s, [p, p]).handsApartAt).toBeUndefined();
  });

  it("round-trips a point between the world and a player's frame", () => {
    for (const player of [0, 1] as const) {
      const p = { x: 0.3, y: 1.2, z: 0.4 };
      const back = localPoint(worldPoint(p, player), player);
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
      expect(back.z).toBeCloseTo(p.z);
    }
  });

  it("has its own word and its own sound", () => {
    expect(outcomeWord("catch", true)).toBe("CAUGHT!");
    expect(outcomeWord("catch", false)).toBe("THEY CAUGHT IT");
    const sounds = createSoundDirector();
    const facts = {
      me: 0 as const,
      calibrated: true,
      active: true,
      running: true,
      ownsBall: false,
      windup: false,
      released: null,
      events: [],
      hp: [5, 5] as const,
    };
    sounds.update(facts);
    const s = face(clap(0.2));
    expect(
      sounds.update({ ...facts, events: s.events! }).map((c) => c.kind),
    ).toContain("caught");
  });
});
