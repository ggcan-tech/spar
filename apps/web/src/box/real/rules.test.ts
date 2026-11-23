import { describe, expect, it } from "vitest";
import type { Guard } from "../defence";
import { BOXERS, LADDER, beatOf, createMind, scriptedMind } from "./mind";
import {
  PUNCH,
  RULES,
  breakBout,
  createBout,
  handOut,
  keptOut,
  nextRound,
  reaches,
  spotsOf,
  standsAt,
  stepBout,
  type Blow,
  type Body,
  type Bout,
  type BoutEvent,
  type BoutInput,
  type BoutOptions,
  type Mind,
  type Place,
  type Step,
} from "./rules";

const STEP = 1 / 120;
/** A plain opponent for tests: round punch times, table guard, no habits. */
const BODY: Body = {
  times: {
    jab: { commit: 0.1, impact: 0.3, home: 0.25 },
    cross: { commit: 0.2, impact: 0.4, home: 0.3 },
    hook: { commit: 0.25, impact: 0.45, home: 0.35 },
    body: { commit: 0.25, impact: 0.45, home: 0.35 },
    uppercut: { commit: 0.25, impact: 0.45, home: 0.35 },
  },
  gap: 0.3,
  stepIn: 0.25,
  stepOut: 0.35,
  follows: 0.6,
  power: 1,
  tight: { chin: 1, cover: 1, low: 1 },
  guardMove: 0.2,
  lowFor: 1,
  shellAfter: 99,
  answerDelay: 0.3,
  answerEvery: 1,
  sags: 0,
  wind: 1,
};
/** A guard as the camera would report it: where the left and the right glove are. */
const guard = (left: Place, right: Place): Guard => {
  const is = (p: Place) => [left === p, right === p] as [boolean, boolean];
  const n = (pair: [boolean, boolean]) => (pair[0] ? 1 : 0) + (pair[1] ? 1 : 0);
  const high = is("cover"),
    low = is("low"),
    up: [boolean, boolean] = [left === "chin" || left === "cover", right === "chin" || right === "cover"];
  return { high: n(high), low: n(low), up: n(up), heights: [null, null], sides: { high, low, up }, known: true };
};
const UP = guard("chin", "chin");
const COVER = guard("cover", "cover");
const DOWN = guard("down", "down");
const HEAD = { x: 0, y: RULES.standing };
type Act = Partial<BoutInput>;
type Script = (s: Bout) => Act;
const bout = (over: Partial<BoutOptions> = {}) => createBout({ boxer: BODY, opening: 0.2, ...over });
/** Run until `seconds` or the bout stops; the script says what the player does at each step. */
function run(mind: Mind, seconds: number, script: Script = () => ({}), start: Bout = bout()) {
  let s = start;
  const events: BoutEvent[] = [];
  const seen = new Set<number>();
  while (s.time < seconds - 1e-9 && !s.over && !s.rest) {
    const act = script(s);
    s = stepBout(s, STEP, { punches: [], head: HEAD, guard: UP, ...act }, mind);
    for (const e of s.events)
      if (!seen.has(e.id)) {
        seen.add(e.id);
        events.push(e);
      }
  }
  const of = <K extends BoutEvent["kind"]>(kind: K) => events.filter((e): e is Extract<BoutEvent, { kind: K }> => e.kind === kind);
  return { s, events, its: of("its"), mine: of("mine"), of };
}
const blow = (over: Partial<Blow> = {}): Blow => ({ hand: "right", shape: "straight", level: "head", third: "middle", quality: 1, at: 0, ...over });
/** A script that throws `b` once, reported at `at` as having reached full stretch at `b.at` (or `at`). */
const throwing = (at: number, b: Partial<Blow> = {}, rest: Script = () => ({})): Script => {
  let done = false;
  return (s) => {
    const act = rest(s);
    if (done || s.time + STEP < at) return act;
    done = true;
    return { ...act, punches: [blow({ at: s.time + STEP, ...b })] };
  };
};
/** An opponent that throws the given combinations and otherwise does nothing. */
const foe = (visits: Step[][], options: Parameters<typeof scriptedMind>[1] = {}) => scriptedMind(visits, { wait: 30, ...options });
/** An opponent that never comes. */
const idle = (options: Parameters<typeof scriptedMind>[1] = {}) => scriptedMind([["j"]], { wait: 99, ...options });
const waiting = (over: Partial<BoutOptions> = {}) => bout({ opening: 99, ...over });

describe("the cover table: what a glove keeps out, by where it is", () => {
  it("by the chin: jab 0.30, cross 0.22, uppercut 0.10 a glove, and two add", () => {
    expect(keptOut(["chin", "chin"], "head", "jab", 0)).toBeCloseTo(0.6);
    expect(keptOut(["chin", "chin"], "head", "cross", 0)).toBeCloseTo(0.44);
    expect(keptOut(["chin", "chin"], "head", "uppercut", 0)).toBeCloseTo(0.2);
    expect(keptOut(["chin", "down"], "head", "cross", 0)).toBeCloseTo(0.22);
  });
  it("by the chin: a hook meets only the glove on its side, 0.30", () => {
    expect(keptOut(["chin", "down"], "head", "hook", 0)).toBeCloseTo(0.3);
    expect(keptOut(["chin", "down"], "head", "hook", 1)).toBe(0);
  });
  it("covering: a straight 0.45 a glove, an uppercut 0.20, a hook 0.75 on its side only", () => {
    expect(keptOut(["cover", "cover"], "head", "jab", 0)).toBeCloseTo(0.9);
    expect(keptOut(["cover", "cover"], "head", "cross", 0)).toBeCloseTo(0.9);
    expect(keptOut(["cover", "cover"], "head", "uppercut", 0)).toBeCloseTo(0.4);
    expect(keptOut(["cover", "chin"], "head", "hook", 0)).toBeCloseTo(0.75);
    expect(keptOut(["chin", "cover"], "head", "hook", 0)).toBeCloseTo(0.3);
  });
  it("the body, elbow down: a straight 0.45 a glove, a hook 0.85 on its side", () => {
    expect(keptOut(["low", "low"], "body", "cross", 0)).toBeCloseTo(0.9);
    expect(keptOut(["low", "chin"], "body", "hook", 0)).toBeCloseTo(0.85);
    expect(keptOut(["chin", "low"], "body", "hook", 0)).toBeCloseTo(0.35);
  });
  it("the body, gloves up: by the chin 0.15 and 0.35, covering 0 and 0.10", () => {
    expect(keptOut(["chin", "chin"], "body", "jab", 0)).toBeCloseTo(0.3);
    expect(keptOut(["chin", "chin"], "body", "hook", 1)).toBeCloseTo(0.35);
    expect(keptOut(["cover", "cover"], "body", "cross", 0)).toBe(0);
    expect(keptOut(["cover", "cover"], "body", "hook", 0)).toBeCloseTo(0.1);
  });
  it("a hand that is out, or hanging, keeps out nothing", () => {
    expect(keptOut(["out", "down"], "head", "cross", 0)).toBe(0);
    expect(keptOut(["out", "chin"], "head", "jab", 0)).toBeCloseTo(0.3);
    expect(keptOut(["low", "low"], "head", "cross", 0)).toBe(0);
  });
  it("a straight aimed at one side meets that glove squarely and the far one hardly", () => {
    // Its right hand is out: the side to hit is the side where no glove is.
    expect(keptOut(["chin", "out"], "head", "cross", 0, 1)).toBeCloseTo(0.11);
    expect(keptOut(["chin", "out"], "head", "cross", 0, -1)).toBeCloseTo(0.22);
    expect(keptOut(["chin", "out"], "head", "cross", 0, 0)).toBeCloseTo(0.33);
    // Against two gloves in the same place, the side makes no difference.
    expect(keptOut(["chin", "chin"], "head", "cross", 0, 1)).toBeCloseTo(0.44);
  });
  it("a tighter guard keeps out more, place by place", () => {
    expect(keptOut(["chin", "chin"], "head", "cross", 0, -1, { chin: 1.1, cover: 1, low: 1 })).toBeCloseTo(0.484);
  });
  it("reads the camera's guard into places, and a hand that is out into nothing", () => {
    expect(spotsOf(guard("cover", "chin"), false, false).spots).toEqual(["cover", "chin"]);
    expect(spotsOf(guard("low", "down"), false, true).spots).toEqual(["low", "out"]);
    // Only counts, no sides: nobody knows which glove is which.
    const counts: Guard = { high: 1, low: 0, up: 2, heights: [null, null] };
    expect(spotsOf(counts, false, false)).toEqual({ spots: ["cover", "chin"], sided: false });
    expect(keptOut(["cover", "chin"], "head", "hook", 1, -1, null, false)).toBeCloseTo(0.75);
  });
});

describe("its punches arriving: three outcomes", () => {
  it("lands a cross partly on hands held by the chin, clean on hands down, and on the gloves of a cover", () => {
    const up = run(foe([["c"]]), 1.2);
    expect(up.its).toHaveLength(1);
    expect(up.its[0]).toMatchObject({ outcome: "partly", solid: true });
    expect(up.its[0].kept).toBeCloseTo(0.44);
    expect(up.s.me.health).toBeCloseTo(RULES.health - RULES.hit.cross * 0.56);
    const down = run(foe([["c"]]), 1.2, () => ({ guard: DOWN }));
    expect(down.its[0]).toMatchObject({ outcome: "clean", why: { low: true } });
    expect(down.s.me.health).toBeCloseTo(RULES.health - RULES.hit.cross * RULES.handsDown);
    const cover = run(foe([["c"]]), 1.2, () => ({ guard: COVER }));
    expect(cover.its[0]).toMatchObject({ outcome: "gloves", solid: false });
    // On the gloves scores nothing; partly blocked scores nothing either; clean scores.
    expect(cover.s.card.rounds[0].points[1]).toBe(0);
    expect(up.s.card.rounds[0].points[1]).toBe(0);
    expect(down.s.card.rounds[0].points[1]).toBe(RULES.card.power);
  });
  it("does not count a hidden hand as a low one", () => {
    const hidden = run(foe([["c"]]), 1.2, () => ({ guard: { ...DOWN, known: false } }));
    expect(hidden.its[0].why.low).toBe(false);
    expect(hidden.s.me.health).toBeCloseTo(RULES.health - RULES.hit.cross);
  });
  it("comes round a guard: a hook is stopped only by the glove on its side", () => {
    // Its lead hook is its left hand: it arrives on the player's right.
    const right = run(foe([["h"]]), 1.5, () => ({ guard: guard("chin", "cover") }));
    expect(right.its[0]).toMatchObject({ code: "h", hand: "left", outcome: "gloves" });
    const wrong = run(foe([["h"]]), 1.5, () => ({ guard: guard("cover", "down") }));
    expect(wrong.its[0]).toMatchObject({ outcome: "clean" });
  });
  it("takes a body shot on the elbow, and not on a cover", () => {
    const elbow = run(foe([["bc"]]), 1.2, () => ({ guard: guard("low", "low") }));
    expect(elbow.its[0]).toMatchObject({ level: "body", outcome: "gloves" });
    const covered = run(foe([["bc"]]), 0.75, () => ({ guard: COVER }));
    expect(covered.its[0]).toMatchObject({ outcome: "clean" });
    // A body punch does three quarters of the damage, and takes the wind.
    const damage = RULES.hit.cross * RULES.bodyShare;
    expect(covered.s.me.health).toBeCloseTo(RULES.health - damage);
    expect(covered.s.me.breath).toBeCloseTo(RULES.breath - damage * RULES.bodyBreath, 0);
  });
  it("makes blocking cost breath, and a tired guard keep out less", () => {
    const fresh = run(foe([["c"]]), 0.7, () => ({ guard: COVER }));
    expect(fresh.s.me.breath).toBeCloseTo(RULES.breath - RULES.hit.cross * 0.9 * RULES.blockCost, 0);
    expect(fresh.s.me.breath).toBeLessThan(RULES.breath);
    const start = bout();
    const tired = run(foe([["c"]]), 1.2, () => ({ guard: COVER }), { ...start, me: { ...start.me, breath: 12 } });
    expect(tired.its[0].kept).toBeCloseTo(0.9 * RULES.tiredGuard.keeps);
    expect(tired.its[0].outcome).toBe("partly");
  });
  it("gives a hand that is punching no guard until it is home", () => {
    // The player's right hand is out: only the left glove is by the chin.
    const out = run(foe([["c"]]), 1.2, () => ({ busy: [false, true] }));
    expect(out.its[0].kept).toBeCloseTo(0.22);
    expect(out.its[0]).toMatchObject({ outcome: "clean", why: { out: [false, true] } });
    // A punch read from that hand keeps it out for a moment after full stretch, whatever the guard says.
    const read = run(foe([["c"]]), 1.2, throwing(0.55, { hand: "right" }), bout());
    expect(read.its[0].why.out).toEqual([false, true]);
  });
});

describe("a punch is one motion", () => {
  it("has a first movement, a moment the aim is fixed, contact and the hand home, and nothing before", () => {
    const { events, s } = run(foe([["c"]]), 0.5);
    const thrown = events.filter((e) => e.kind === "throw");
    expect(thrown).toHaveLength(1);
    const p = s.foe.punch!;
    expect(p).toMatchObject({ code: "c", hand: "right", level: "head", shape: "straight", feint: false, index: 0, of: 1 });
    expect(p.commit - p.start).toBeCloseTo(0.2);
    expect(p.impact - p.start).toBeCloseTo(0.4);
    expect(p.home - p.impact).toBeCloseTo(0.3);
    // No step, no cue, no event of any kind before the first movement.
    expect(events[0].kind).toBe("throw");
    expect(handOut(s.foe, "right", s.time)).toBe(true);
    expect(handOut(s.foe, "left", s.time)).toBe(false);
  });
  it("reads its times from the table the bout was made with", () => {
    const times = { ...BODY.times, cross: { commit: 0.3, impact: 0.6, home: 0.5 } };
    const { s } = run(foe([["c"]]), 0.5, undefined, bout({ times }));
    expect(s.foe.punch!.impact - s.foe.punch!.start).toBeCloseTo(0.6);
  });
  it("spaces a combination by contact, and says each punch's place in it", () => {
    const { its, of } = run(foe([["j", "c", "h"]]), 3);
    expect(of("throw").map((e) => [e.code, e.index, e.of])).toEqual([["j", 0, 3], ["c", 1, 3], ["h", 2, 3]]);
    expect(its.map((e) => e.code)).toEqual(["j", "c", "h"]);
    const landed = of("throw").map((e) => e.impact);
    expect(landed[1] - landed[0]).toBeCloseTo(BODY.gap, 1);
    expect(landed[2] - landed[1]).toBeCloseTo(BODY.gap, 1);
  });
  it("stands the opponent the same way round as a left-handed player", () => {
    const { s } = run(foe([["j"]]), 0.4, undefined, bout({ lead: "right" }));
    expect(s.foe.punch).toMatchObject({ code: "j", hand: "right" });
  });
});

describe("range", () => {
  it("jabs from the edge without a step, and steps into the pocket before a hook", () => {
    const jab = run(foe([["j"]]), 1);
    expect(jab.of("step")).toHaveLength(0);
    const hook = run(foe([["h"]]), 0.3);
    expect(hook.of("step")[0]).toMatchObject({ to: "pocket" });
    expect(hook.s.foe.feet).toMatchObject({ from: "edge", to: "pocket" });
    expect(hook.s.foe.feet.end - hook.s.foe.feet.start).toBeCloseTo(BODY.stepIn);
    // The hook does not start until its feet are there.
    expect(hook.of("throw")).toHaveLength(0);
    const later = run(foe([["h"]]), 2);
    expect(later.of("throw")[0].at).toBeGreaterThanOrEqual(later.of("step")[0].end - 1e-9);
    // And after the visit it steps out again.
    expect(later.of("step").map((e) => e.to)).toEqual(["pocket", "edge"]);
    expect(standsAt(later.s.foe, later.s.time)).toBe("edge");
  });
  it("lets the player's straight reach from the edge, and lands their hook from there as an arm punch", () => {
    const start = waiting();
    expect(reaches(start, "straight")).toBe(true);
    expect(reaches(start, "hook")).toBe(false);
    const straight = run(idle(), 0.5, throwing(0.3, { hand: "right" }), start);
    expect(straight.mine[0]).toMatchObject({ long: false, why: { reach: true } });
    // A misread never turns a landing punch into a miss: the hook still arrives, at half.
    const hook = run(idle(), 0.5, throwing(0.3, { hand: "left", shape: "hook", third: "left" }), start);
    expect(hook.mine[0]).toMatchObject({ long: true, outcome: "partly" });
    expect(hook.mine[0].damage).toBeCloseTo(RULES.hit.hook * (1 - 0.3) * RULES.longHook);
  });
  it("makes its punch fall short of a player who pulls back after it starts", () => {
    const { its, s } = run(foe([["j"]]), 1, (b) => ({ back: b.time > 0.3 }));
    expect(its[0]).toMatchObject({ outcome: "short", why: { reach: false } });
    expect(s.me.health).toBe(RULES.health);
  });
  it("follows a player who stays back: one step out is for one exchange", () => {
    // Pulled back from the start, and still there when a jab comes two seconds later.
    const { its, s, of } = run(foe([["j"]]), 3, () => ({ back: true }), bout({ opening: 2 }));
    expect(of("step")[0]).toMatchObject({ to: "pocket" });
    expect(its[0].outcome).toBe("partly");
    // On the heels: they take more.
    expect(its[0].why.heels).toBe(true);
    expect(s.me.health).toBeCloseTo(RULES.health - RULES.hit.jab * 0.4 * RULES.heels.takes);
  });
  it("gives a player on their heels less behind their own punch", () => {
    const { mine } = run(idle(), 2.5, throwing(2, { hand: "right" }, () => ({ back: true })), waiting());
    expect(mine[0].damage).toBeCloseTo(RULES.hit.cross * (1 - 0.44) * RULES.heels.gives);
  });
  it("works with range off: everything reaches and nobody steps", () => {
    const start = bout({ range: false });
    expect(reaches(start, "hook")).toBe(true);
    const { its, of } = run(foe([["h"]]), 1.5, () => ({ back: true }), start);
    expect(of("step")).toHaveLength(0);
    expect(its[0].outcome).toBe("partly");
    const hook = run(idle(), 0.5, throwing(0.3, { hand: "left", shape: "hook", third: "left" }), waiting({ range: false }));
    expect(hook.mine[0]).toMatchObject({ long: false });
  });
});

describe("the head off the line", () => {
  /** The time the first punch's fist leaves, read from the state. */
  const moved = (after: "before" | "after", to: { x: number; y: number }): Script => (s) => {
    const p = s.foe.punches[0];
    if (!p) return {};
    return { head: (after === "after" ? s.time >= p.commit + 0.02 : s.time >= p.start) ? to : HEAD };
  };
  it("misses a head that left the line after the fist did", () => {
    const { its, s } = run(foe([["c"]]), 1.2, moved("after", { x: 0.13, y: RULES.standing }));
    expect(its[0]).toMatchObject({ outcome: "miss", how: "slip" });
    expect(s.me.health).toBe(RULES.health);
    expect(s.foe.punch === null || s.foe.punch.aim).toBeTruthy();
  });
  it("fixes the aim when the fist leaves: a head that moved before that is followed", () => {
    const { its } = run(foe([["c"]]), 1.2, moved("before", { x: 0.2, y: RULES.standing }));
    expect(its[0].outcome).toBe("partly");
  });
  it("glances off a head that is nearly off the line", () => {
    const { its } = run(foe([["c"]]), 1.2, moved("after", { x: 0.09, y: RULES.standing }));
    expect(its[0]).toMatchObject({ outcome: "partly", glance: true });
    expect(its[0].damage).toBeCloseTo(RULES.hit.cross * 0.56 * RULES.glance);
  });
  it("lands a hook on a head that only moved sideways, and misses one that is under it", () => {
    const side = run(foe([["h"]]), 1.5, moved("after", { x: 0.25, y: RULES.standing }));
    expect(side.its[0].outcome).toBe("partly");
    const under = run(foe([["h"]]), 1.5, () => ({ head: { x: 0, y: RULES.standing - 0.16 } }));
    expect(under.its[0]).toMatchObject({ outcome: "miss", how: "duck" });
  });
  it("uses the head position kindest to the player in the last 80 ms", () => {
    // Off the line just before contact, and back on it at contact: still a miss.
    const { its } = run(foe([["c"]]), 1.2, (s) => {
      const p = s.foe.punches[0];
      const dodge = p && s.time >= p.impact - 0.06 && s.time < p.impact - 0.02;
      return { head: dodge ? { x: 0.14, y: RULES.standing } : HEAD };
    });
    expect(its[0]).toMatchObject({ outcome: "miss", how: "slip" });
  });
  it("throws a hook or a body shot, not a straight, at a head that is already moving", () => {
    const sway: Script = (s) => ({ head: { x: 0.16 * Math.sin(2 * Math.PI * s.time), y: RULES.standing } });
    // From the edge a hook does not reach, so it goes to the body.
    const far = run(foe([["c"]], { will: { hook: true } }), 1.2, sway);
    expect(far.its[0]).toMatchObject({ code: "bc", level: "body" });
    const close = run(foe([["c"]], { will: { hook: true } }), 1.2, sway, bout({ range: false }));
    expect(close.its[0]).toMatchObject({ code: "rh", shape: "hook" });
  });
});

describe("the player's punches", () => {
  it("pays by the punch: a lead straight is a jab, a rear one a cross", () => {
    const jab = run(idle(), 0.5, throwing(0.3, { hand: "left" }), waiting());
    expect(jab.mine[0].damage).toBeCloseTo(RULES.hit.jab * 0.4);
    expect(jab.s.me.breath).toBeCloseTo(RULES.breath - RULES.cost.jab, 1);
    const cross = run(idle(), 0.5, throwing(0.3, { hand: "right" }), waiting());
    expect(cross.mine[0].damage).toBeCloseTo(RULES.hit.cross * 0.56);
    const body = run(idle(), 0.5, throwing(0.3, { hand: "right", level: "body" }), waiting());
    expect(body.mine[0].damage).toBeCloseTo(RULES.hit.cross * RULES.bodyShare * 0.7);
    const upper = run(idle(), 0.5, throwing(0.3, { hand: "right", shape: "uppercut" }), waiting({ range: false }));
    expect(upper.mine[0]).toMatchObject({ outcome: "clean" });
    expect(upper.mine[0].damage).toBeCloseTo(RULES.hit.uppercut * 0.8);
  });
  it("judges a punch against what the opponent showed when the fist arrived, however late it is confirmed", () => {
    // Its cross is out from about 0.2 to 0.9 s. The player's cross arrived at 0.6 and is confirmed at 1.0.
    const late = run(foe([["c"]]), 1.2, throwing(1.0, { hand: "right", at: 0.6 }, () => ({ guard: COVER })));
    expect(late.mine[0]).toMatchObject({ counter: true, outcome: "clean", why: { out: [false, true] } });
    expect(late.mine[0].judged).toBeCloseTo(0.6);
    expect(late.mine[0].damage).toBeCloseTo(RULES.hit.cross * (1 - 0.22) * RULES.counter);
    // The same punch arriving at 1.0, when its hand is home, meets both gloves.
    const now = run(foe([["c"]]), 1.2, throwing(1.0, { hand: "right" }, () => ({ guard: COVER })));
    expect(now.mine[0]).toMatchObject({ counter: false, outcome: "partly" });
  });
  it("holds an opening open 80 ms in the player's favour, and no longer", () => {
    const start = run(foe([["j"]]), 0.25).s;
    const home = start.foe.punch!.home;
    const just = run(foe([["j"]]), 1.5, throwing(home + 0.06, { hand: "right" }, () => ({ guard: COVER })));
    expect(just.mine[0].why.out).toEqual([true, false]);
    const after = run(foe([["j"]]), 1.5, throwing(home + 0.12, { hand: "right" }, () => ({ guard: COVER })));
    expect(after.mine[0].why.out).toEqual([false, false]);
  });
  it("holds a punch whose time is still to come, and judges it then", () => {
    const { mine, s } = run(idle(), 0.6, throwing(0.3, { hand: "right", at: 0.5 }), waiting());
    expect(mine).toHaveLength(1);
    expect(mine[0].at).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(s.me.coming).toHaveLength(0);
  });
  it("sends a hook round the side it lands on, by its zone", () => {
    // Its left glove covers, its right is by the chin. The player's left hook lands on its right side.
    const start = waiting({ range: false });
    const gloves: Bout = { ...start, foe: { ...start.foe, gloves: [{ ...start.foe.gloves[0], place: "cover" }, start.foe.gloves[1]] } };
    const left = run(idle(), 0.5, throwing(0.3, { hand: "left", shape: "hook", third: "left" }), gloves);
    expect(left.mine[0].kept).toBeCloseTo(0.3);
    const right = run(idle(), 0.5, throwing(0.3, { hand: "right", shape: "hook", third: "right" }), gloves);
    expect(right.mine[0].kept).toBeCloseTo(0.75);
    // With no side given, a hook lands on the side of the hand that threw it.
    const middle = run(idle(), 0.5, throwing(0.3, { hand: "right", shape: "hook", third: "middle" }), gloves);
    expect(middle.mine[0].kept).toBeCloseTo(0.75);
  });
  it("scores nothing for a push, and weighs a punch by how well it was thrown", () => {
    const start = waiting();
    const open: Bout = { ...start, foe: { ...start.foe, lowUntil: [50, 50], gloves: [{ ...start.foe.gloves[0], place: "low" }, { ...start.foe.gloves[1], place: "low" }] } };
    const good = run(idle(), 0.5, throwing(0.3, { hand: "right" }), open);
    expect(good.s.card.rounds[0].points[0]).toBe(RULES.card.power);
    const push = run(idle(), 0.5, throwing(0.3, { hand: "right", quality: 0.4 }), open);
    expect(push.mine[0].outcome).toBe("clean");
    expect(push.s.card.rounds[0].points[0]).toBe(0);
    expect(push.mine[0].damage).toBeCloseTo(RULES.hit.cross * 0.4);
  });
  it("lets the opponent slip or catch a lead it saw coming, and be ready for what follows", () => {
    const slip = run(idle({ reads: { how: "slip", answer: false } }), 0.5, throwing(0.3, { hand: "left" }), waiting());
    expect(slip.mine[0]).toMatchObject({ outcome: "miss", read: "slip" });
    // A miss costs half as much breath again.
    expect(slip.s.me.breath).toBeCloseTo(RULES.breath - RULES.cost.jab * (1 + RULES.missCost), 1);
    expect(slip.s.foe.evade).toMatchObject({ how: "slip" });
    const two = (s: Bout): Act => ({ punches: Math.abs(s.time + STEP - 0.3) < STEP / 2 ? [blow({ hand: "left", at: 0.3 })] : Math.abs(s.time + STEP - 0.6) < STEP / 2 ? [blow({ hand: "right", at: 0.6 })] : [] });
    const caught = run(idle({ reads: { how: "catch", answer: false }, will: { ready: true } }), 0.8, two, waiting());
    expect(caught.mine.map((e) => [e.read, e.outcome])).toEqual([["catch", "gloves"], ["catch", "gloves"]]);
  });
});

describe("the opening is the hand that is out", () => {
  it("brings its gloves up when touched: the second punch to the head meets them, the body is open", () => {
    const two = (second: Partial<Blow>): Script => (s) => ({
      punches: Math.abs(s.time + STEP - 0.3) < STEP / 2 ? [blow({ hand: "left", at: 0.3 })] : Math.abs(s.time + STEP - 0.7) < STEP / 2 ? [blow({ hand: "right", at: 0.7, ...second })] : [],
    });
    const head = run(idle({ will: { cover: true } }), 1, two({}), waiting());
    expect(head.mine[1]).toMatchObject({ outcome: "gloves", why: { spots: ["cover", "cover"] } });
    const body = run(idle({ will: { cover: true } }), 1, two({ level: "body" }), waiting());
    expect(body.mine[1]).toMatchObject({ outcome: "clean" });
    // The gloves stay up for 0.8 s and then come back.
    const g = head.s.foe.gloves[0];
    expect(g.place).toBe("cover");
    // Touched again at 0.7: up for 0.8 s from when they got there, and a moment to come back.
    expect(g.until).toBeCloseTo(0.7 + BODY.guardMove + RULES.coverHold + BODY.guardMove, 1);
    const later = run(idle({ will: { cover: true } }), 2.4, two({}), waiting());
    expect(later.s.foe.gloves.map((x) => x.place)).toEqual(["chin", "chin"]);
  });
  it("drops the elbow on the side it is hit in the body, and the head opens", () => {
    const two: Script = (s) => ({
      punches: Math.abs(s.time + STEP - 0.3) < STEP / 2 ? [blow({ hand: "right", level: "body", at: 0.3 })] : Math.abs(s.time + STEP - 0.7) < STEP / 2 ? [blow({ hand: "right", at: 0.7 })] : [],
    });
    // A body straight is solid against gloves by the chin, so both elbows come down.
    const { mine, s } = run(idle({ will: { elbow: true } }), 1, two, waiting());
    expect(mine[1]).toMatchObject({ outcome: "clean", why: { spots: ["low", "low"] } });
    expect(s.foe.lowUntil[0]).toBeCloseTo(0.3 + BODY.guardMove + BODY.lowFor, 1);
  });
  it("counts a counter only while the target's own punch is in flight or has just landed", () => {
    // The player's fist reached full stretch 0.1 s before its cross landed: caught punching.
    const start = run(foe([["c"]]), 0.25).s;
    const impact = start.foe.punch!.impact;
    // (Its guard is made tight enough that the player's jab does not land solidly: that would be a trade.)
    const tight = { ...BODY, tight: { chin: 2, cover: 1, low: 1 } };
    const caught = run(foe([["c"]]), 1.2, throwing(impact - 0.1, { hand: "left" }, () => ({ guard: DOWN })), bout({ boxer: tight }));
    expect(caught.its[0]).toMatchObject({ counter: true });
    // Half a second before: the hand is long home. No bonus, and no window to hit into either.
    const early = run(foe([["c"]]), 1.2, throwing(0.05, { hand: "left" }, () => ({ guard: DOWN })), bout({ opening: 0.3 }));
    expect(early.its[0]).toMatchObject({ counter: false });
    expect(caught.its[0].damage).toBeCloseTo(RULES.hit.cross * RULES.counter);
    expect(early.its[0].damage).toBeCloseTo(RULES.hit.cross * RULES.handsDown);
    // A hand seen driving out with no punch read yet is in flight.
    const driving = run(foe([["c"]]), 1.2, (s) => ({ guard: DOWN, busy: [s.time > impact - 0.1, false] }));
    expect(driving.its[0]).toMatchObject({ counter: true });
  });
  it("has no window after a miss: the same punch a moment after its hand is home is no counter", () => {
    const start = run(foe([["j"]]), 0.25).s;
    const home = start.foe.punch!.home;
    const { mine } = run(foe([["j"]]), 1.5, throwing(home + 0.2, { hand: "right" }, () => ({ head: { x: 0.2, y: RULES.standing } })));
    expect(mine[0]).toMatchObject({ counter: false, outcome: "partly" });
  });
  it("takes the weight off a punch that is beaten by a solid power counter", () => {
    const start = run(foe([["c"]]), 0.25).s;
    const impact = start.foe.punch!.impact;
    const { its, mine } = run(foe([["c"]]), 1.2, throwing(impact - 0.2, { hand: "right" }, () => ({ guard: DOWN })));
    expect(mine[0]).toMatchObject({ counter: true, solid: true });
    // Half the weight, and no counter bonus for it: it was hit solidly a moment before.
    expect(its[0]).toMatchObject({ counter: false });
    expect(its[0].damage).toBeCloseTo(RULES.hit.cross * RULES.beaten);
  });
});

describe("breath", () => {
  it("charges more for each punch thrown without a breath, and gives it back after a rest", () => {
    const flurry: Script = (s) => {
      const n = Math.round((s.time + STEP) / STEP);
      // A jab every 0.25 s from 0.25 to 1.0.
      return { punches: n % 30 === 0 && s.time + STEP <= 1.001 ? [blow({ hand: "left", at: s.time + STEP })] : [] };
    };
    const { s } = run(idle(), 1.05, flurry, waiting());
    const more = 1 + RULES.flurry.more;
    expect(s.me.breath).toBeCloseTo(RULES.breath - RULES.cost.jab * (1 + more + more ** 2 + more ** 3), 1);
    // Nothing comes back for 0.6 s; then 8 a second.
    const rested = run(idle(), 2.6, flurry, waiting());
    expect(rested.s.me.breath - s.me.breath).toBeCloseTo(RULES.regen * (2.6 - 1 - RULES.regenAfter), 0);
  });
  it("comes back at a quarter behind a cover", () => {
    const start = waiting();
    const spent: Bout = { ...start, me: { ...start.me, breath: 50 } };
    expect(run(idle(), 2, () => ({ guard: UP }), spent).s.me.breath).toBeCloseTo(50 + RULES.regen * 2, 0);
    expect(run(idle(), 2, () => ({ guard: COVER }), spent).s.me.breath).toBeCloseTo(50 + RULES.regen * 2 * RULES.coverRegen, 0);
  });
  it("puts less behind a tired punch, and next to nothing behind a spent one", () => {
    const start = waiting();
    const at = (breath: number) => run(idle(), 0.5, throwing(0.3, { hand: "right" }), { ...start, me: { ...start.me, breath } }).mine[0].damage;
    expect(at(25)).toBeCloseTo(at(100) * RULES.tired.does);
    expect(at(5)).toBeCloseTo(at(100) * RULES.spent.does);
  });
  it("is one meter for both: the opponent pays, tires and waits too", () => {
    const { s } = run(foe([["j", "c"]]), 0.9);
    expect(s.foe.breath).toBeLessThan(RULES.breath - RULES.cost.jab - RULES.cost.cross + 1);
    const start = bout();
    const blown = run(foe([["c"]]), 1.2, () => ({ guard: DOWN }), { ...start, foe: { ...start.foe, breath: 36 } });
    expect(blown.its[0].damage).toBeCloseTo(RULES.hit.cross * RULES.handsDown);
    const empty = run(foe([["c"]]), 1.2, undefined, { ...start, foe: { ...start.foe, breath: 20 } });
    // Out of breath, it does not come at all.
    expect(empty.of("throw")).toHaveLength(0);
  });
});

describe("two books: the card and hurt", () => {
  const open = (s: Bout, health = RULES.health): Bout => ({
    ...s,
    foe: { ...s.foe, health, lowUntil: [50, 50], gloves: [{ ...s.foe.gloves[0], place: "low" }, { ...s.foe.gloves[1], place: "low" }] },
  });
  /** A punch every 0.3 s from 0.3 s on, alternating hands. */
  const volley = (b: Partial<Blow>, n = 9): Script => (s) => {
    const k = Math.round((s.time + STEP) / STEP);
    const i = k / 36;
    return { punches: k % 36 === 0 && i <= n ? [blow({ hand: i % 2 ? "right" : "left", shape: "hook", third: i % 2 ? "right" : "left", at: s.time + STEP, ...b })] : [] };
  };
  it("scores a clean punch one and a clean power punch one and a half", () => {
    const jab = run(idle(), 0.5, throwing(0.3, { hand: "left" }), open(waiting()));
    expect(jab.s.card.rounds[0]).toMatchObject({ clean: [1, 0], points: [RULES.card.clean, 0], thrown: [1, 0], touches: [1, 0] });
    const cross = run(idle(), 0.5, throwing(0.3, { hand: "right" }), open(waiting()));
    expect(cross.s.card.rounds[0].points[0]).toBe(RULES.card.power);
  });
  it("never hurts with jabs, however many land clean", () => {
    const jabs: Script = (s) => {
      const k = Math.round((s.time + STEP) / STEP);
      return { punches: k % 30 === 0 ? [blow({ hand: "left", at: s.time + STEP })] : [] };
    };
    const { s, of } = run(idle(), 6, jabs, open(waiting({ range: false }), 3));
    expect(of("hurt")).toHaveLength(0);
    // Worn to nothing by jabs, and still standing: only a solid power punch puts anyone down.
    expect(s.foe.health).toBe(0);
    expect(of("down")).toHaveLength(0);
  });
  it("hurts with solid power punches close together, and the pile drains when they are not", () => {
    const close = run(idle(), 1, volley({}, 2), open(waiting({ range: false })));
    expect(close.of("hurt")[0]).toMatchObject({ who: "foe" });
    expect(close.s.foe.hurtUntil).toBeCloseTo(close.of("hurt")[0].at + RULES.hurt.lasts);
    // One clean hook is under the line, and a second three seconds later starts from nothing.
    const apart: Script = (s) => ({ punches: [0.3, 3.3].some((t) => Math.abs(s.time + STEP - t) < STEP / 2) ? [blow({ hand: "left", shape: "hook", third: "left", at: s.time + STEP })] : [] });
    expect(run(idle(), 4, apart, open(waiting({ range: false }))).of("hurt")).toHaveLength(0);
  });
  it("comes sooner to a worn fighter", () => {
    const one = throwing(0.3, { hand: "left", shape: "hook", third: "left" });
    expect(run(idle(), 0.5, one, open(waiting({ range: false }), 100)).of("hurt")).toHaveLength(0);
    const worn = run(idle(), 0.5, throwing(0.3, { hand: "left", shape: "hook", third: "left" }), open(waiting({ range: false }), 30));
    expect(worn.of("hurt")).toHaveLength(1);
  });
  it("makes a hurt fighter take more and guard worse", () => {
    const start = waiting();
    const hurt: Bout = { ...start, foe: { ...start.foe, hurtUntil: 5, mode: "hurt" } };
    const { mine } = run(idle(), 0.5, throwing(0.3, { hand: "right" }), hurt);
    expect(mine[0].kept).toBeCloseTo(0.44 * RULES.hurt.guard);
    expect(mine[0].damage).toBeCloseTo(RULES.hit.cross * (1 - 0.44 * RULES.hurt.guard) * RULES.hurt.takes);
    const mineHurt: Bout = { ...start, me: { ...start.me, hurtUntil: 5 } };
    expect(run(idle(), 0.5, throwing(0.3, { hand: "right" }), mineHurt).mine[0].damage).toBeCloseTo(RULES.hit.cross * 0.56 * RULES.hurt.gives);
  });
  it("puts a hurt fighter down with three more solid power punches, and not with two", () => {
    const three = run(idle(), 2.5, volley({}, 5), open(waiting({ range: false })));
    expect(three.of("hurt")).toHaveLength(1);
    const down = three.of("down")[0];
    expect(down).toMatchObject({ who: "foe", by: "finish", standing: false, downs: 1 });
    // Hurt came on the second punch; the third, fourth and fifth finished it.
    expect(three.mine.filter((e) => e.at <= down.at)).toHaveLength(5);
    expect(three.s.downs).toEqual([1, 0]);
    expect(three.s.card.rounds[0].downs).toEqual([1, 0]);
    const two = run(idle(), 2.5, volley({}, 4), open(waiting({ range: false })));
    expect(two.of("down")).toHaveLength(0);
  });
  it("gets up after the count with some health, and three knockdowns stop the bout", () => {
    const three = run(idle(), 2.5 + RULES.count, volley({}, 5), open(waiting({ range: false })));
    expect(three.of("up")).toHaveLength(1);
    expect(three.s.foe.down).toBeNull();
    // It kept what it had, which was more than the least it gets up with.
    expect(three.s.foe.health).toBeGreaterThanOrEqual(RULES.health * RULES.rise[0]);
    const start = open(waiting({ range: false }), 0);
    const twice: Bout = { ...start, downs: [2, 0] };
    const { s, of } = run(idle(), 0.5, throwing(0.3, { hand: "right" }), twice);
    expect(of("down")[0]).toMatchObject({ by: "worn", downs: 3 });
    expect(s.over).toEqual({ winner: "me", how: "stoppage" });
  });
  it("puts the player down the same way, and stands them up again", () => {
    const start = bout({ range: false });
    const worn: Bout = { ...start, me: { ...start.me, health: 0 } };
    const { s, of } = run(foe([["c"]]), 1, () => ({ guard: DOWN }), worn);
    expect(of("down")[0]).toMatchObject({ who: "me", by: "worn" });
    expect(s.me.down).not.toBeNull();
    const later = run(foe([["c"]]), 1 + RULES.count, () => ({ guard: DOWN }), worn);
    expect(later.s.me.down).toBeNull();
    expect(later.s.me.health).toBe(RULES.health * RULES.rise[0]);
    expect(later.s.me.breath).toBeGreaterThanOrEqual(RULES.riseBreath);
  });
});

describe("stakes", () => {
  const open = (s: Bout, health = RULES.health): Bout => ({
    ...s,
    foe: { ...s.foe, health, lowUntil: [50, 50], gloves: [{ ...s.foe.gloves[0], place: "low" }, { ...s.foe.gloves[1], place: "low" }] },
  });
  it("counts touches in touch sparring, and hurts nobody", () => {
    const start = waiting({ stakes: "touch" });
    const { s, mine } = run(idle(), 0.5, throwing(0.3, { hand: "right" }), start);
    // Partly blocked is still a touch.
    expect(mine[0]).toMatchObject({ outcome: "partly", damage: 0 });
    expect(s.card.rounds[0]).toMatchObject({ touches: [1, 0], points: [1, 0] });
    expect(s.foe.health).toBe(RULES.health);
    const took = run(foe([["c"]]), 1, () => ({ guard: DOWN }), bout({ stakes: "touch" }));
    expect(took.s.me.health).toBe(RULES.health);
    expect(took.s.card.rounds[0].points).toEqual([0, 1]);
    expect(took.of("hurt")).toHaveLength(0);
  });
  it("gives a standing count in open sparring: hurt, but nobody on the floor", () => {
    const start = open(waiting({ stakes: "open", range: false }), 0);
    const { s, of } = run(idle(), 0.5, throwing(0.3, { hand: "right" }), start);
    expect(of("down")[0]).toMatchObject({ who: "foe", standing: true });
    expect(s.downs).toEqual([0, 0]);
    expect(s.card.rounds[0]).toMatchObject({ downs: [0, 0], counts: [1, 0] });
    expect(s.over).toBeNull();
    // However many counts, open sparring is not stopped.
    const many: Bout = { ...start, card: { ...start.card, rounds: [{ ...start.card.rounds[0], counts: [5, 0] }] } };
    expect(run(idle(), 0.5, throwing(0.3, { hand: "right" }), many).s.over).toBeNull();
  });
});

describe("doubt goes to the player", () => {
  it("lets a punch that was in the air while the player was not seen count for nothing", () => {
    const { its, s } = run(foe([["c"]]), 1.2, (b) => ({ guard: DOWN, blind: b.time > 0.35 && b.time < 0.4 }));
    expect(its[0]).toMatchObject({ outcome: "unseen", damage: 0 });
    expect(s.me.health).toBe(RULES.health);
    expect(s.me.breath).toBe(RULES.breath);
    expect(s.card.rounds[0].points).toEqual([0, 0]);
    expect(s.card.rounds[0].clean).toEqual([0, 0]);
  });
  it("starts nothing new while the player cannot be seen", () => {
    const { of, s } = run(foe([["c"]]), 1, () => ({ blind: true }));
    expect(of("throw")).toHaveLength(0);
    expect(s.foe.punches).toHaveLength(0);
    const after = run(foe([["c"]]), 1.2, (b) => ({ blind: b.time < 0.6 }));
    expect(after.of("throw")[0].at).toBeGreaterThanOrEqual(0.6);
  });
});

describe("the edges", () => {
  it("both punch at once: both land, and neither is a counter", () => {
    const start = run(foe([["c"]]), 0.25).s;
    const impact = start.foe.punch!.impact;
    const { its, mine } = run(foe([["c"]]), 1.2, throwing(impact + 0.01, { hand: "right" }, (s) => ({ guard: DOWN, busy: [false, s.time > impact - 0.2] })));
    expect(mine[0]).toMatchObject({ counter: false });
    expect(its[0]).toMatchObject({ counter: false });
    expect(mine[0].damage).toBeGreaterThan(0);
    expect(its[0].damage).toBeGreaterThan(0);
  });
  it("counts gloves that are in place within 40 ms after contact, and not later ones", () => {
    const start = run(foe([["c"]]), 0.25).s;
    const impact = start.foe.punch!.impact;
    const just = run(foe([["c"]]), 1.2, (s) => ({ guard: s.time + STEP >= impact + 0.03 ? COVER : DOWN }));
    expect(just.its[0].outcome).toBe("gloves");
    const late = run(foe([["c"]]), 1.2, (s) => ({ guard: s.time + STEP >= impact + 0.07 ? COVER : DOWN }));
    expect(late.its[0].outcome).toBe("clean");
    // A punch already on the gloves is called at once, not 40 ms later.
    const blocked = run(foe([["c"]]), 1.2, () => ({ guard: COVER }));
    expect(blocked.its[0].at - impact).toBeLessThan(RULES.late);
  });
  it("calls off punches in the air at the bell, and sends both to their corners", () => {
    const clock = 0.45;
    const { s, of, its } = run(foe([["j", "c"]]), 2, undefined, bout({ clock, rounds: 2 }));
    expect(s.rest).toBe(true);
    expect(of("bell")[0]).toMatchObject({ round: 1 });
    expect(of("called-off").length).toBeGreaterThanOrEqual(1);
    expect(its).toHaveLength(0);
    expect(s.foe.punch).toBeNull();
    expect(s.foe.visit).toBeNull();
    // Nothing moves in the corner.
    expect(stepBout(s, STEP, { punches: [blow()], head: HEAD, guard: UP }, idle())).toBe(s);
  });
  it("shows a feint that costs nothing to cover, and whose cross catches a player who punched at it", () => {
    const covered = run(foe([["f", "c"]]), 1.5, () => ({ guard: COVER }));
    const shown = covered.of("throw");
    expect(shown.map((e) => [e.code, e.feint])).toEqual([["j", true], ["c", false]]);
    expect(covered.its).toHaveLength(1);
    expect(covered.its[0]).toMatchObject({ code: "c", outcome: "gloves" });
    expect(shown[1].at - shown[0].at).toBeCloseTo(RULES.feint, 1);
    // The feinting hand never left its guard.
    const during = run(foe([["f", "c"]]), 0.3);
    expect(during.s.foe.punch).toMatchObject({ feint: true, code: "j" });
    expect(handOut(during.s.foe, "left", during.s.time)).toBe(false);
    // Punching at the feint: the fist is still on its way when the real cross arrives.
    const impact = covered.of("throw")[1].impact;
    const bit = run(foe([["f", "c"]]), 1.5, throwing(impact + 0.08, { hand: "right" }, (s) => ({ busy: [false, s.time > impact - 0.2] })));
    expect(bit.its[0]).toMatchObject({ code: "c", counter: true, outcome: "clean", why: { out: [false, true] } });
    expect(bit.its[0].damage).toBeCloseTo(RULES.hit.cross * (1 - 0.22) * RULES.counter);
  });
  it("ignores a punch thrown after a knockdown or the bell, at no cost", () => {
    const start = waiting();
    const floored: Bout = { ...start, foe: { ...start.foe, down: { since: 0, until: 3, standing: false } } };
    const { s, mine } = run(idle(), 0.5, throwing(0.3, { hand: "right" }), floored);
    expect(mine).toHaveLength(0);
    expect(s.me.breath).toBe(RULES.breath);
    expect(s.card.rounds[0].thrown).toEqual([0, 0]);
    const rest: Bout = { ...start, rest: true };
    expect(stepBout(rest, STEP, { punches: [blow()], head: HEAD, guard: UP }, idle())).toBe(rest);
  });
  it("saves a fighter who is down at the bell, and scores the round ten to eight", () => {
    const start = bout({ clock: 1, rounds: 2, range: false });
    const worn: Bout = { ...start, me: { ...start.me, health: 0 } };
    const { s, of } = run(foe([["c"]]), 2, () => ({ guard: DOWN }), worn);
    expect(of("down")).toHaveLength(1);
    expect(s.rest).toBe(true);
    expect(s.me.down).toBeNull();
    expect(s.card.scores).toEqual([[8, 10]]);
  });
  it("lets a glove that is in the path by luck block: place is the rule", () => {
    // Elbows down for no reason when a body shot comes.
    expect(run(foe([["bc"]]), 1.2, () => ({ guard: guard("low", "low") })).its[0].outcome).toBe("gloves");
  });
});

describe("rounds", () => {
  const scored = (points: [number, number], downs: [number, number] = [0, 0]) => {
    const start = bout({ clock: 0.1, rounds: 1, opening: 99 });
    const s: Bout = { ...start, card: { ...start.card, rounds: [{ ...start.card.rounds[0], points, downs }] } };
    return run(idle(), 1, undefined, s).s;
  };
  it("gives the round to whoever landed more clean, ten to nine", () => {
    expect(scored([5, 3]).card.scores).toEqual([[10, 9]]);
    expect(scored([3, 5]).card.scores).toEqual([[9, 10]]);
    expect(scored([4, 4.5]).card.scores).toEqual([[10, 10]]);
  });
  it("makes it ten to eight for a knockdown, or a round nobody could call close", () => {
    expect(scored([3, 5], [1, 0]).card.scores).toEqual([[10, 8]]);
    expect(scored([14, 4]).card.scores).toEqual([[10, 8]]);
    expect(scored([9, 4]).card.scores).toEqual([[10, 9]]);
  });
  it("decides the bout on the cards, and a level bout is a draw", () => {
    expect(scored([5, 3]).over).toEqual({ winner: "me", how: "points" });
    expect(scored([3, 5]).over).toEqual({ winner: "foe", how: "points" });
    expect(scored([0, 0]).over).toEqual({ winner: null, how: "draw" });
  });
  it("rests between rounds: half the missing health back, breath full, a fresh tally", () => {
    const start = bout({ clock: 0.5, rounds: 3, opening: 99 });
    const worn: Bout = { ...start, me: { ...start.me, health: 40, breath: 20 }, foe: { ...start.foe, health: 60, breath: 50 } };
    const { s } = run(idle(), 1, undefined, worn);
    expect(s.rest).toBe(true);
    expect(nextRound(start)).toBe(start);
    const next = nextRound(s);
    expect(next).toMatchObject({ rest: false, round: 2 });
    expect(next.me.health).toBe(70);
    expect(next.me.breath).toBe(RULES.breath);
    expect(next.foe.health).toBe(80);
    expect(next.card.rounds).toHaveLength(2);
    expect(next.foe.nextAt).toBeCloseTo(s.time + RULES.roundOpening);
    expect(standsAt(next.foe, next.time)).toBe("edge");
    // A boxer with little wind is still blowing.
    const short = nextRound({ ...s, boxer: { ...BODY, wind: 0.5 } });
    expect(short.foe.breath).toBeLessThan(RULES.breath);
  });
});

describe("the state", () => {
  it("is never changed in place, and the same inputs give the same bout", () => {
    const play = () => {
      const mind = createMind(BOXERS.counter, 7);
      let s = createBout({ boxer: BOXERS.counter });
      const states: Bout[] = [];
      for (let i = 0; i < 1200; i++) {
        const frozen = JSON.stringify(s);
        const before = s;
        const t = s.time + STEP;
        const punches = i % 90 === 45 ? [blow({ hand: i % 180 === 45 ? "left" : "right", at: t })] : [];
        s = stepBout(s, STEP, { punches, head: { x: 0.05 * Math.sin(t), y: RULES.standing }, guard: i % 400 < 200 ? UP : COVER }, mind);
        if (i % 97 === 0) expect(JSON.stringify(before)).toBe(frozen);
        states.push(s);
      }
      return states[states.length - 1];
    };
    const a = play(),
      b = play();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.card.rounds[0].thrown[1]).toBeGreaterThan(0);
  });
  it("refuses a step that is not small and positive", () => {
    expect(() => stepBout(bout(), 0, { punches: [], head: HEAD, guard: UP }, idle())).toThrow();
    expect(() => stepBout(bout(), 0.5, { punches: [], head: HEAD, guard: UP }, idle())).toThrow();
  });
  it("gives the same punch the same verdict at 30, 60 and 120 steps a second", () => {
    for (const rate of [30, 60, 120]) {
      let s = bout();
      const mind = foe([["c"]]);
      let outcome = "";
      while (s.time < 1.2) {
        s = stepBout(s, 1 / rate, { punches: [], head: HEAD, guard: UP }, mind);
        for (const e of s.events) if (e.kind === "its") outcome = `${e.outcome} ${e.kept.toFixed(2)} ${e.damage.toFixed(3)}`;
      }
      expect(outcome).toBe("partly 0.44 1.344");
    }
  });
  it("says where each glove is and until when", () => {
    const { s } = run(idle({ will: { cover: true } }), 0.35, throwing(0.3, { hand: "left" }), waiting());
    const g = s.foe.gloves[0];
    // Touched at 0.3: still by the chin, on its way up.
    expect(g).toMatchObject({ place: "chin", next: { place: "cover" } });
    expect(g.until).toBeCloseTo(0.3 + BODY.guardMove, 1);
  });
});

describe("the opponent's habits, as the rules play them", () => {
  it("covers up when hit solidly too often, and comes out of it", () => {
    const body = { ...BODY, shellAfter: 2 };
    const two: Script = (s) => ({ punches: [0.3, 0.6].some((t) => Math.abs(s.time + STEP - t) < STEP / 2) ? [blow({ hand: "right", at: s.time + STEP })] : [] });
    const { s } = run(idle({ shell: 1 }), 0.9, two, waiting({ boxer: body }));
    expect(s.foe.mode).toBe("shell");
    expect(s.foe.gloves.map((g) => g.place)).toEqual(["cover", "cover"]);
    const out = run(idle({ shell: 1 }), 2.2, two, waiting({ boxer: body }));
    expect(out.s.foe.mode).toBe("set");
  });
  it("answers a punch that did nothing, after its delay", () => {
    const { of } = run(idle({ will: { answer: true }, reply: ["c"] }), 1.2, throwing(0.3, { hand: "left" }, () => ({ guard: COVER })), waiting());
    expect(of("throw")[0]).toMatchObject({ code: "c" });
    expect(of("throw")[0].at).toBeCloseTo(0.3 + BODY.answerDelay, 1);
  });
  it("drops its other hand as it punches, if that is its habit", () => {
    const { s } = run(foe([["c"]], { will: { drop: true } }), 0.5);
    // Its cross is its right hand: the left has dropped.
    expect(s.foe.gloves[0].place).toBe("low");
    expect(s.foe.lowUntil[0]).toBeCloseTo(s.foe.punch!.home);
  });
  it("brings a hand home low, if that is its habit, and lifts it again", () => {
    const { s } = run(foe([["j"]], { homeLow: 0.5 }), 0.9);
    expect(s.foe.gloves[0].place).toBe("low");
    expect(run(foe([["j"]], { homeLow: 0.5 }), 2).s.foe.gloves[0].place).toBe("chin");
  });
  it("rests its hands at its chest when it is out of breath", () => {
    const body = { ...BODY, sags: 50 };
    const start = waiting({ boxer: body });
    const { s } = run(idle(), 0.5, undefined, { ...start, foe: { ...start.foe, breath: 30 } });
    expect(s.foe.gloves.map((g) => g.place)).toEqual(["low", "low"]);
  });
  it("is stopped in its step by a stiff jab, if that is its habit", () => {
    const start = waiting({ boxer: BODY });
    const open: Bout = { ...start, foe: { ...start.foe, nextAt: 0.2, lowUntil: [50, 50], gloves: [{ ...start.foe.gloves[0], place: "low" }, { ...start.foe.gloves[1], place: "low" }] } };
    const { s, of } = run(foe([["h"]], { will: { stop: true } }), 1, throwing(0.3, { hand: "left" }), open);
    expect(of("throw")).toHaveLength(0);
    expect(standsAt(s.foe, s.time)).toBe("edge");
  });
  it("comes in on a hurt player with what finishes", () => {
    const start = bout();
    const soft: Bout = { ...start, me: { ...start.me, health: 20 } };
    const mind = foe([["c"], ["bh", "rh", "h"]], { will: { press: true }, wait: 30 });
    const { of } = run(mind, 2.5, () => ({ guard: DOWN }), soft);
    expect(of("hurt")[0]).toMatchObject({ who: "me" });
    // It did not wait its thirty seconds.
    expect(of("throw").map((e) => e.code)).toEqual(["c", "bh", "rh", "h"]);
  });
});

describe("the five opponents", () => {
  it("are a ladder: each is quicker, tidier and reads more than the one before", () => {
    const rows = LADDER.map((name) => BOXERS[name]);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1],
        b = rows[i];
      for (const kind of ["jab", "cross", "hook", "body"] as const) {
        expect(b.times[kind].impact).toBeLessThan(a.times[kind].impact);
        expect(b.times[kind].home).toBeLessThan(a.times[kind].home);
        // The better the boxer, the later in the punch the aim is fixed: less time to get off the line.
        expect(b.times[kind].impact - b.times[kind].commit).toBeLessThanOrEqual(a.times[kind].impact - a.times[kind].commit + 1e-9);
      }
      expect(b.gap).toBeLessThan(a.gap);
      expect(b.power).toBeGreaterThan(a.power);
      expect(b.read.fresh).toBeGreaterThan(a.read.fresh);
      expect(b.tight.chin).toBeGreaterThanOrEqual(a.tight.chin);
      expect(b.guardMove).toBeLessThan(a.guardMove);
      expect(b.follows).toBeLessThan(a.follows);
    }
  });
  it("throw nothing faster than a person can: 220 ms at the least, and the aim never fixed after contact", () => {
    for (const name of LADDER)
      for (const t of Object.values(BOXERS[name].times)) {
        expect(t.impact).toBeGreaterThanOrEqual(0.22);
        expect(t.commit).toBeLessThan(t.impact);
        expect(t.home).toBeGreaterThanOrEqual(0.2);
      }
    // The floors for the best of them: jab 300 ms, cross 400, hook and body shot 450.
    expect(BOXERS.counter.times).toMatchObject({ jab: { impact: 0.3 }, cross: { impact: 0.4 }, hook: { impact: 0.45 }, body: { impact: 0.45 } });
    expect(BOXERS.beginner.times.jab.impact).toBeGreaterThanOrEqual(0.45);
  });
  it("have books made only of punches the rules know", () => {
    for (const name of LADDER) {
      const b = BOXERS[name];
      for (const [steps] of [...b.book, ...b.replies, ...(b.finish ?? [])]) for (const k of steps) expect(k === "f" || k === "w" || k === "in" || k in PUNCH).toBe(true);
      expect(beatOf(b)).toBeGreaterThan(1.5);
    }
    // A beginner has no feints and nothing longer than a one-two; the best has feints.
    expect(BOXERS.beginner.book.every(([steps]) => steps.length <= 2 && !steps.includes("f"))).toBe(true);
    expect(BOXERS.counter.book.some(([steps]) => steps.includes("f"))).toBe(true);
    expect(BOXERS.swinger.book.some(([steps]) => steps.length >= 4)).toBe(true);
  });
  it("decide the same things from the same seed", () => {
    const s = bout();
    const draw = (seed: number) => {
      const m = createMind(BOXERS.counter, seed);
      return JSON.stringify([m.visit(s), m.wait(s), m.visit(s), m.reply(s), m.will("cover", s), m.span("shell", s)]);
    };
    expect(draw(5)).toBe(draw(5));
    expect(draw(5)).not.toBe(draw(6));
  });
  it("see a repeated lead coming more often than a fresh one, if it comes soon enough to remember", () => {
    const s = waiting();
    const reads = (gap: number) => {
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const m = createMind(BOXERS.beginner, seed);
        for (let i = 0; i < 20; i++) if (m.reads({ hand: "left", shape: "straight", level: "head", at: i * gap }, s)) n++;
      }
      return n / 800;
    };
    // The same jab every second is caught; the same jab every three seconds is forgotten.
    expect(reads(1)).toBeGreaterThan(0.45);
    expect(reads(3)).toBeLessThan(0.15);
  });
  it("go to the body when the head is always covered, and step in on a player who keeps pulling back", () => {
    const s = bout();
    const first = (reports: ("head-blocked" | "short")[]) => {
      let body = 0,
        steps = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const m = createMind(BOXERS.counter, seed);
        for (const r of reports) m.report(r);
        const v = m.visit(s);
        if (v[0] === "bh" || v[0] === "bc") body++;
        if (v[0] === "in") steps++;
      }
      return [body / 200, steps / 200];
    };
    expect(first(["head-blocked", "head-blocked"])[0]).toBeGreaterThan(0.5);
    expect(first([])[0]).toBeLessThan(0.2);
    expect(first(["short", "short"])[1]).toBeGreaterThan(0.6);
  });
});

describe("the player's feint, and the referee's break", () => {
  /** A hand seen going out from `from` to `to` with no punch read from it. */
  const showing = (from: number, to: number): Script => (s) => ({ busy: [s.time >= from && s.time < to, false] });
  it("brings up the gloves of an opponent that covers when touched, and leaves its body open under them", () => {
    const { s } = run(idle({ will: { cover: true } }), 1.0, showing(0.5, 0.65), waiting());
    expect(s.foe.gloves.map((g) => g.place)).toEqual(["cover", "cover"]);
    // A body punch now meets no elbow.
    const after = run(idle({ will: { cover: true } }), 1.2, throwing(1.05, { level: "body" }), s);
    expect(after.mine[0].outcome).toBe("clean");
    // And the gloves come back down by themselves.
    expect(run(idle({ will: { cover: true } }), 2.4, () => ({}), s).s.foe.gloves.map((g) => g.place)).toEqual(["chin", "chin"]);
  });
  it("does nothing to an opponent that does not answer touches, nor for a twitch, nor for a hand whose punch was read", () => {
    const places = (mind: Mind, script: Script) => run(mind, 1.0, script, waiting()).s.foe.gloves.map((g) => g.place);
    expect(places(idle(), showing(0.5, 0.65))).toEqual(["chin", "chin"]);
    expect(places(idle({ will: { cover: true } }), showing(0.5, 0.53))).toEqual(["chin", "chin"]);
    // A punch that was thrown and read is a punch: the hand coming home afterwards is not a feint.
    const thrown = run(idle(), 1.0, throwing(0.6, { hand: "left" }, showing(0.5, 0.8)), waiting());
    expect(thrown.mine).toHaveLength(1);
    expect(thrown.s.foe.coverUntil).toBe(-1);
  });
  it("parts them: a punch in the air is called off, it steps out, and nothing comes for a second and a half", () => {
    // A cross from the pocket, stopped half way.
    const before = run(foe([["in", "h"]]), 0.2 + BODY.stepIn + 0.2).s;
    expect(before.foe.punches.some((p) => !p.done)).toBe(true);
    const parted = breakBout(before, 1.5);
    expect(parted.foe.punches).toHaveLength(0);
    expect(parted.foe.feet.to).toBe("edge");
    expect(parted.events.some((e) => e.kind === "called-off")).toBe(true);
    expect(parted.events.some((e) => e.kind === "break")).toBe(true);
    const after = run(foe([["j"]], { wait: 0.1 }), before.time + 1.4, () => ({ guard: DOWN }), parted);
    expect(after.its).toHaveLength(0);
    expect(after.of("throw").filter((e) => e.at > before.time)).toHaveLength(0);
    // Then it comes again.
    expect(run(foe([["j"]], { wait: 0.1 }), before.time + 2.2, () => ({ guard: DOWN }), parted).of("throw").filter((e) => e.at > before.time).length).toBeGreaterThan(0);
    // The state it was given is left as it was.
    expect(before.foe.punches.some((p) => !p.done)).toBe(true);
  });
});

describe("planned ahead, for a device that shows late", () => {
  it("begins a punch, a step and a glove's move that long after deciding them, and changes nothing else", () => {
    const plain = run(foe([["in", "h", "c"]]), 3, () => ({ guard: DOWN }));
    const ahead = run(foe([["in", "h", "c"]]), 3, () => ({ guard: DOWN, ahead: 0.15 }));
    // The same punches with the same outcomes, each 0.15 s later.
    expect(ahead.its.map((e) => [e.code, e.outcome])).toEqual(plain.its.map((e) => [e.code, e.outcome]));
    ahead.its.forEach((e, i) => expect(e.at - plain.its[i].at).toBeCloseTo(0.15, 2));
    // Its first movement is announced that long before it moves: time for the picture to get there.
    const throws = ahead.of("throw");
    const first = run(foe([["in", "h", "c"]]), 0.2 + 0.15 + BODY.stepIn + 0.1, () => ({ guard: DOWN, ahead: 0.15 })).s.foe.punches[0];
    expect(first.start - throws[0].at).toBeCloseTo(0.15, 2);
    // The step in starts late by the same, and the hook still leaves as the step ends.
    const step = ahead.of("step")[0];
    expect(step.end - step.at).toBeCloseTo(0.15 + BODY.stepIn, 2);
    // (To within one step of the clock.)
    expect(Math.abs(first.start - step.end)).toBeLessThan(0.01);
    // More delay than can be hidden is not hidden.
    const most = run(foe([["j"]]), 1, () => ({ ahead: 2 })).s;
    expect(most.ahead).toBe(RULES.aheadMost);
  });
});
