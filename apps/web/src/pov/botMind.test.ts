import { describe, expect, it } from "vitest";
import { assistedThrow, opponentTarget } from "./autoThrow";
import {
  createBotMind,
  dodgeShift,
  FAKE_S,
  plannedBotThrow,
  windupClock,
  type BotDodge,
  type BotPlan,
} from "./botMind";
import {
  botPose,
  createRally,
  launchBall,
  neutralPose,
  stepDuel,
  FIXED_STEP,
  type DuelState,
  type PlayerPose,
} from "./duel";

/** The bot holds the ball; the player is at `x` moving sideways at `speed`. Returns the player's hit points after the throw. */
function throwAt(plan: BotPlan, speed: number, startX = 0): number {
  const at = (t: number): PlayerPose => {
    const p = neutralPose();
    p.root.x = p.head.x = startX + speed * t;
    p.leftHand.x += p.root.x;
    p.rightHand.x += p.root.x;
    return p;
  };
  let state: DuelState = createRally(1, 0);
  // One step so the state carries the player's velocity.
  state = stepDuel(
    {
      ...state,
      poses: [at(0), state.poses[1]],
      previous: [at(0), state.poses[1]],
    },
    [at(FIXED_STEP), state.poses[1]],
  );
  state = launchBall(state, 1, plannedBotThrow(state, plan));
  expect(state.balls.length).toBe(1);
  for (let i = 0; i < 300 && state.balls.length; i++)
    state = stepDuel(state, [at(state.time + FIXED_STEP), state.poses[1]]);
  return state.hp[0];
}
const plan = (over: Partial<BotPlan> = {}): BotPlan => ({
  windup: 0.6,
  target: "head",
  lead: 0,
  error: { x: 0, y: 0 },
  flight: 0.62,
  fake: 0,
  ...over,
});

describe("how the training opponent throws", () => {
  it("hits a player who stands still, at the head or the body", () => {
    expect(throwAt(plan(), 0)).toBe(4);
    expect(throwAt(plan({ target: "torso" }), 0)).toBe(4);
    expect(throwAt(plan({ target: "torso", flight: 1.3 }), 0)).toBe(4);
  });

  it("never hit a steady sway without lead, and does with it", () => {
    // 0.45 units a second sideways: 28 cm during a 0.62 s flight, past the head's 26 cm window.
    expect(throwAt(plan(), 0.45, -0.2)).toBe(5);
    expect(throwAt(plan({ lead: 1 }), 0.45, -0.2)).toBe(4);
    expect(throwAt(plan({ lead: 1 }), -0.45, 0.2)).toBe(4);
  });

  it("misses when its aim error is larger than the target", () => {
    expect(throwAt(plan({ error: { x: 0.5, y: 0 } }), 0)).toBe(5);
    expect(throwAt(plan({ error: { x: 0.1, y: 0 } }), 0)).toBe(4);
  });

  it("varies when it releases, within each level's range, and repeats for a seed", () => {
    for (const [pace, lo, hi] of [
      ["practice", 0.9, 1.5],
      ["duel", 0.6, 1.1],
    ] as const) {
      const mind = createBotMind(7);
      const windups = Array.from({ length: 200 }, () => mind.next(pace).windup);
      expect(Math.min(...windups)).toBeGreaterThanOrEqual(lo);
      expect(Math.max(...windups)).toBeLessThanOrEqual(hi);
      // Spread across the range, not one value.
      expect(Math.max(...windups) - Math.min(...windups)).toBeGreaterThan(
        (hi - lo) * 0.8,
      );
    }
    const a = createBotMind(42),
      b = createBotMind(42);
    for (let i = 0; i < 20; i++) expect(a.next("duel")).toEqual(b.next("duel"));
  });

  it("opens practice with a slow ball at the body, once", () => {
    const mind = createBotMind(3);
    const first = mind.next("practice");
    expect(first).toMatchObject({
      target: "torso",
      flight: 1.3,
      error: { x: 0, y: 0 },
    });
    expect(mind.next("practice").flight).toBe(0.9);
    // Duel pace has no teaching ball.
    expect(createBotMind(3).next("duel").flight).toBe(0.62);
  });

  it("aims with a spread that fits the level and mixes head and body", () => {
    for (const [pace, sigma] of [
      ["practice", 0.2],
      ["duel", 0.08],
    ] as const) {
      const mind = createBotMind(11);
      mind.next(pace);
      const plans = Array.from({ length: 2000 }, () => mind.next(pace));
      const xs = plans.map((p) => p.error.x);
      const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
      const sd = Math.sqrt(
        xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length,
      );
      expect(Math.abs(mean)).toBeLessThan(sigma * 0.1);
      expect(sd).toBeGreaterThan(sigma * 0.85);
      expect(sd).toBeLessThan(sigma * 1.15);
      const heads =
        plans.filter((p) => p.target === "head").length / plans.length;
      expect(heads).toBeGreaterThan(0.2);
      expect(heads).toBeLessThan(0.6);
    }
  });

  it("hits a still player most of the time in duel and often in practice", () => {
    const rate = (pace: "practice" | "duel") => {
      const mind = createBotMind(5);
      mind.next(pace);
      let hits = 0;
      for (let i = 0; i < 300; i++)
        if (throwAt(mind.next(pace), 0) === 4) hits++;
      return hits / 300;
    };
    const duel = rate("duel"),
      practice = rate("practice");
    console.log(
      `still player hit rate: duel ${(duel * 100).toFixed(0)}%, practice ${(practice * 100).toFixed(0)}%`,
    );
    expect(duel).toBeGreaterThan(0.9);
    expect(practice).toBeGreaterThan(0.5);
    expect(practice).toBeLessThan(duel);
  });
});

describe("how the training opponent dodges", () => {
  /**
   * The player throws at the opponent's torso while it stands at the far end of
   * its idle sway, where it is nearly still. Returns its hit points afterwards.
   */
  const AT_REST = Math.PI / 2 / 0.8;
  function throwAtBot(handSpeed: number, reaction: number | null): number {
    const dodge: BotDodge | null =
      reaction === null
        ? null
        : { direction: -1, startAt: AT_REST + reaction, endAt: Infinity };
    let state: DuelState = { ...createRally(0, 0), time: AT_REST };
    const bot = (t: number) =>
      botPose(t, Infinity, Infinity, dodgeShift(dodge, t));
    const me = neutralPose();
    state = {
      ...state,
      poses: [me, bot(AT_REST)],
      previous: [me, bot(AT_REST)],
      rally: { turn: 0, phase: "ready", readyAt: AT_REST },
    };
    const shot = assistedThrow(
      me.rightHand,
      opponentTarget(state.poses[1]),
      handSpeed,
    );
    state = launchBall(state, 0, shot);
    expect(state.balls.length).toBe(1);
    for (let i = 0; i < 300 && state.balls.length; i++)
      state = stepDuel(state, [me, bot(state.time + FIXED_STEP)]);
    return state.hp[1];
  }

  it("is hit when it does not move", () => {
    expect(throwAtBot(2, null)).toBe(4);
    expect(throwAtBot(7, null)).toBe(4);
  });

  it("steps out of the way of a slow lob but not of a hard throw", () => {
    // Duel reaction time, 0.28 s. A slow hand gives a 0.9 s flight, a fast one 0.58 s.
    expect(throwAtBot(2, 0.28)).toBe(5);
    expect(throwAtBot(7, 0.28)).toBe(4);
    // Practice reacts later and still avoids the lob.
    expect(throwAtBot(2, 0.38)).toBe(5);
  });

  it("starts from rest like a body, stays in the court and comes back", () => {
    const dodge: BotDodge = { direction: 1, startAt: 1, endAt: 2 };
    expect(dodgeShift(dodge, 0.9)).toBe(0);
    expect(dodgeShift(dodge, 1.1)).toBeCloseTo(0.02);
    expect(dodgeShift(dodge, 1.3)).toBeCloseTo(0.18);
    expect(dodgeShift(dodge, 1.9)).toBeCloseTo(0.5);
    expect(dodgeShift(dodge, 2.25)).toBeCloseTo(0.3);
    expect(dodgeShift(dodge, 3)).toBe(0);
    expect(dodgeShift(null, 1)).toBe(0);
    for (let t = 0; t < 12; t += 0.05) {
      const x = botPose(t, Infinity, Infinity, dodgeShift(dodge, t % 4)).root.x;
      expect(Math.abs(x)).toBeLessThanOrEqual(0.6);
    }
  });

  it("only dodges a ball that would hit, more often in duel than in practice, away from the ball", () => {
    const rate = (pace: "practice" | "duel") => {
      const mind = createBotMind(9);
      let dodges = 0;
      for (let i = 0; i < 1000; i++) if (mind.dodge(pace, 0.05, 0, 3)) dodges++;
      return dodges / 1000;
    };
    expect(rate("practice")).toBeGreaterThan(0.18);
    expect(rate("practice")).toBeLessThan(0.32);
    expect(rate("duel")).toBeGreaterThan(0.52);
    expect(rate("duel")).toBeLessThan(0.68);
    const mind = createBotMind(4);
    for (let i = 0; i < 200; i++) {
      // Going a metre wide: never dodged.
      expect(mind.dodge("duel", 1, 0, 3)).toBeNull();
      const right = mind.dodge("duel", 0.2, 0, 3);
      if (right) {
        expect(right.direction).toBe(-1);
        expect(right.startAt).toBeCloseTo(3.28);
      }
      // At the court's edge with the ball inside: it steps inward, not out.
      const edge = mind.dodge("duel", 0.5, 0.55, 3);
      if (edge) expect(edge.direction).toBe(-1);
      const cornered = mind.dodge("duel", 0.3, 0.55, 3);
      if (cornered) expect(cornered.direction).toBe(-1);
    }
  });
});

describe("the opponent's pump fake", () => {
  const hand = (untilRelease: number, fake: number) =>
    botPose(3, windupClock(untilRelease, fake)).rightHand;
  it("leaves a throw without a fake exactly as it was", () => {
    for (const u of [2, 0.6, 0.3, 0.1, 0, -0.2, Infinity])
      expect(windupClock(u, 0)).toBe(u);
  });
  it("draws back early, starts forward, stops, and throws from the cocked arm", () => {
    const rest = hand(Infinity, 0),
      cocked = hand(0.18, 0);
    // Before the fake begins the arm is at rest.
    expect(hand(FAKE_S + 0.5, FAKE_S)).toEqual(rest);
    // Drawn back by the moment a real throw would have started forward.
    expect(hand(FAKE_S, FAKE_S).y).toBeCloseTo(cocked.y);
    // The hand comes well forward of the cocked position, then goes back.
    const jab = hand(FAKE_S - 0.1, FAKE_S);
    expect(jab.z - cocked.z).toBeGreaterThan(0.4);
    expect(hand(FAKE_S - 0.3, FAKE_S).z).toBeCloseTo(cocked.z);
    // The real throw is the ordinary one.
    for (const u of [0.18, 0.12, 0.06, 0])
      expect(hand(u, FAKE_S)).toEqual(hand(u, 0));
  });
  it("moves like an arm: no jump between physics steps", () => {
    let before = hand(1.2, FAKE_S);
    for (let u = 1.2; u >= 0; u -= FIXED_STEP) {
      const now = hand(u, FAKE_S);
      expect(
        Math.hypot(now.x - before.x, now.y - before.y, now.z - before.z),
      ).toBeLessThan(0.12);
      before = now;
    }
  });
  it("is used in duel, not in the first two balls, and not in practice", () => {
    const duel = createBotMind(21);
    const plans = Array.from({ length: 600 }, () => duel.next("duel"));
    expect(plans.slice(0, 2).every((p) => p.fake === 0)).toBe(true);
    const share = plans.filter((p) => p.fake > 0).length / plans.length;
    expect(share).toBeGreaterThan(0.12);
    expect(share).toBeLessThan(0.28);
    const practice = createBotMind(21);
    for (let i = 0; i < 300; i++) expect(practice.next("practice").fake).toBe(0);
  });
});

describe("the opponent plays to the player", () => {
  const sample = (mind: ReturnType<typeof createBotMind>) => {
    const plans = Array.from({ length: 1500 }, () => mind.next("duel"));
    const sd = Math.sqrt(
      plans.reduce((a, p) => a + p.error.x ** 2, 0) / plans.length,
    );
    let dodges = 0;
    for (let i = 0; i < 1000; i++) if (mind.dodge("duel", 0.05, 0, 3)) dodges++;
    return {
      sd,
      flight: plans[0].flight,
      lead: plans[0].lead,
      fakes: plans.filter((p) => p.fake > 0).length / plans.length,
      dodges: dodges / 1000,
    };
  };
  it("gets harder for a player who keeps dodging and landing throws", () => {
    const level = sample(createBotMind(8));
    const mind = createBotMind(8);
    for (let i = 0; i < 4; i++) {
      mind.report("missed-player");
      mind.report("was-hit");
    }
    expect(mind.form()).toBe(1);
    const hard = sample(mind);
    expect(hard.sd).toBeLessThan(level.sd * 0.75);
    expect(hard.flight).toBeLessThan(level.flight);
    expect(hard.lead).toBeGreaterThan(level.lead);
    expect(hard.fakes).toBeGreaterThan(level.fakes);
    expect(hard.dodges).toBeGreaterThan(level.dodges + 0.1);
  });
  it("eases off for a player who keeps getting hit, and never beyond its limits", () => {
    const level = sample(createBotMind(8));
    const mind = createBotMind(8);
    for (let i = 0; i < 20; i++) mind.report("hit-player");
    expect(mind.form()).toBe(-1);
    const easy = sample(mind);
    expect(easy.sd).toBeGreaterThan(level.sd * 1.25);
    expect(easy.flight).toBeGreaterThan(level.flight);
    expect(easy.lead).toBeLessThan(level.lead);
    expect(easy.fakes).toBeLessThan(level.fakes);
    expect(easy.dodges).toBeLessThan(level.dodges - 0.1);
    // One good dodge does not undo a run of hits.
    mind.report("missed-player");
    expect(mind.form()).toBeCloseTo(-0.85);
    mind.reset();
    expect(mind.form()).toBe(0);
  });
});
