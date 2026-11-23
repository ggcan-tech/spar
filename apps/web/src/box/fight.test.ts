import { describe, expect, it } from "vitest";
import {
  LEVEL,
  createBoxerMind,
  type AttackKind,
  type AttackPlan,
  type BoxerMind,
} from "./boxer";
import { NO_GUARD, readGuard, type Guard } from "./defence";
import { RULES, createFight, nextRound, stepFight, type FightEvent, type FightState } from "./fight";
import type { Punch } from "./punch";
import { syntheticFrame } from "../pov/syntheticBody";
import { createPovTracker } from "../pov/tracking";
import { AT_REST, punchMotion, stance } from "./scriptedBoxer";

const STEP = 1 / 120;
const plan = (kind: AttackKind, over: Partial<AttackPlan> = {}): AttackPlan => ({
  kind,
  hand: kind === "cross" ? "right" : "left",
  windup: 0.5,
  feint: false,
  follow: null,
  counterWindow: 0.8,
  recover: 0.4,
  teaching: false,
  // Aimed late (0.16 s before a half-second punch lands), as for a practised
  // player, unless a test says otherwise.
  aimAfter: 0.47,
  ...over,
});
/** A guard as the camera would report it. */
const guard = (high = 0, low = 0, up = high ? 2 : 0): Guard => ({
  high,
  low,
  up,
  heights: [null, null],
});
/** Fists by the chin: what a player standing ready has. */
const HANDS_UP = guard(0, 0, 2);
/** An opponent that throws exactly what it is told, and never moves its guard. */
function scripted(plans: AttackPlan[], idle = 1): BoxerMind & { said: string[] } {
  const said: string[] = [];
  let i = 0;
  return {
    said,
    next: () => plans[Math.min(i++, plans.length - 1)],
    follow: (_level, kind, first) => ({ ...first, kind, follow: null, windup: 0.26 }),
    idle: () => idle,
    coverAfter: () => null,
    report: (what) => void said.push(what),
    form: () => 0,
    reset: () => {},
    setOpeners: () => {},
  };
}
const HEAD = { x: 0, y: 1.65 };
type Script = (s: FightState) => {
  head?: { x: number; y: number };
  guard?: Guard;
  punches?: Punch[];
  rise?: boolean;
  blind?: boolean;
};
/** Run until `seconds` or the fight ends; the script says what the player does at each step. */
function fight(
  mind: BoxerMind,
  seconds: number,
  script: Script = () => ({}),
  start = createFight("contender", 0.2),
) {
  let s = start;
  const events: FightEvent[] = [];
  const seen = new Set<number>();
  while (s.time < seconds && !s.over) {
    const act = script(s);
    s = stepFight(
      s,
      STEP,
      {
        head: act.head ?? HEAD,
        guard: act.guard ?? HANDS_UP,
        punches: act.punches ?? [],
        rise: act.rise,
        blind: act.blind,
      },
      mind,
    );
    for (const e of s.events)
      if (!seen.has(e.id)) {
        seen.add(e.id);
        events.push(e);
      }
  }
  return { s, events, kinds: events.map((e) => e.kind) };
}
const punch = (over: Partial<Punch> = {}): Punch => ({
  hand: "right",
  shape: "straight",
  target: "head",
  power: 1,
  t: 0,
  ...over,
});
/** A script that throws `p` once at `at` and otherwise does `rest`. */
const throwing = (at: number, p: Punch, rest: Script = () => ({})): Script => {
  const due = once(at, p);
  return (s) => ({ ...rest(s), punches: due(s) });
};
/** Throw `p` once, at the first step at or after `at`. */
const once = (at: number, p: Punch) => {
  let done = false;
  return (s: FightState) => {
    if (done || s.time < at) return [];
    done = true;
    return [p];
  };
};

describe("defending against the opponent", () => {
  it("is hit by a straight punch when standing still, harder with the hands down", () => {
    const { s, events } = fight(scripted([plan("cross")]), 1.2);
    expect(events.map((e) => e.kind)).toEqual(["telegraph", "hit-me"]);
    expect(s.me.hp).toBe(RULES.health - RULES.hurt.cross);
    // The opponent's right hand lands on the player's left.
    expect(s.me.hurtSide).toBe(-1);
    const down = fight(scripted([plan("cross")]), 1.2, () => ({ guard: NO_GUARD }));
    expect(down.s.me.hp).toBe(RULES.health - RULES.hurt.cross * RULES.handsDown);
    expect(down.events.at(-1)).toMatchObject({ kind: "hit-me", open: true });
  });
  it("catches a jab on a guard that is up, and nothing heavier", () => {
    const jab = fight(scripted([plan("jab")]), 1.2);
    expect(jab.events.at(-1)).toMatchObject({ kind: "blocked-me", how: "catch" });
    expect(jab.s.me.hp).toBe(RULES.health - RULES.hurt.jab * RULES.caught);
    expect(jab.s.me.stamina).toBe(RULES.stamina);
    expect(fight(scripted([plan("jab")]), 1.2, () => ({ guard: NO_GUARD })).kinds).toContain("hit-me");
  });
  it("aims a lesson where the head was when the punch was first shown, so moving at the word works", () => {
    // The player moves 0.4 s after the punch is shown and stays there.
    const moved = (s: FightState) => ({ head: s.time > 0.6 ? { x: 0.25, y: 1.65 } : HEAD });
    const lesson = fight(scripted([plan("cross", { windup: 1.1, aimAfter: 0 })]), 1.8, moved);
    expect(lesson.kinds).toEqual(["telegraph", "dodged"]);
    // Aimed a fifth of a second after it is shown, as for a contender: the same move still works.
    const quick = fight(scripted([plan("cross", { windup: 0.5, aimAfter: 0.2 })]), 1.5, moved);
    expect(quick.kinds).toEqual(["telegraph", "dodged"]);
    // A hook passes over anyone who is down when it arrives, however early they went.
    const under = fight(scripted([plan("hook", { windup: 1.1 })]), 1.8, (s) => ({
      head: s.time > 0.4 ? { x: 0, y: 1.4 } : HEAD,
    }));
    expect(under.events.at(-1)).toMatchObject({ kind: "dodged", how: "duck" });
    // Aimed late, the punch follows the early mover, and says so.
    const late = fight(scripted([plan("cross", { windup: 1.1, aimAfter: 1.07 })]), 1.8, moved);
    expect(late.events.at(-1)).toMatchObject({ kind: "hit-me", early: true });
    // Already off to one side when it is shown: it is aimed there, whatever the level.
    const camping = fight(scripted([plan("cross", { windup: 1.1, aimAfter: 0 })]), 1.8, () => ({ head: { x: 0.3, y: 1.65 } }));
    expect(camping.events.at(-1)).toMatchObject({ kind: "hit-me", early: false });
  });
  it("makes it miss by moving the head after it has aimed, sideways or down", () => {
    const impact = 0.2 + 0.5 + RULES.strike;
    const slip = fight(scripted([plan("cross")]), 1.2, (s) => ({
      head: s.time > impact - 0.12 ? { x: 0.2, y: 1.65 } : HEAD,
    }));
    expect(slip.kinds).toEqual(["telegraph", "dodged"]);
    expect(slip.s.me.hp).toBe(RULES.health);
    const duck = fight(scripted([plan("cross")]), 1.2, (s) => ({
      head: s.time > impact - 0.12 ? { x: 0, y: 1.4 } : HEAD,
    }));
    expect(duck.events.at(-1)).toMatchObject({ kind: "dodged", how: "duck" });
    // Standing off to one side from the start is not a dodge: it aims where the head is.
    const early = fight(scripted([plan("cross")]), 1.2, () => ({ head: { x: 0.3, y: 1.65 } }));
    expect(early.kinds).toEqual(["telegraph", "hit-me"]);
    // A small movement is not enough.
    const little = fight(scripted([plan("cross")]), 1.2, (s) => ({
      head: s.time > impact - 0.12 ? { x: 0.1, y: 1.6 } : HEAD,
    }));
    expect(little.kinds).toEqual(["telegraph", "hit-me"]);
  });
  it("needs a duck for a hook and a block for a body shot", () => {
    const impact = 0.2 + 0.5 + RULES.strike;
    const late = (head: { x: number; y: number }) => (s: FightState) => ({
      head: s.time > impact - 0.12 ? head : HEAD,
    });
    expect(fight(scripted([plan("hook")]), 1.2, late({ x: 0.3, y: 1.65 })).kinds).toContain("hit-me");
    expect(fight(scripted([plan("hook")]), 1.2, late({ x: 0, y: 1.4 })).kinds).toContain("dodged");
    expect(fight(scripted([plan("body")]), 1.2, late({ x: 0.3, y: 1.3 })).kinds).toContain("hit-me");
    const low = fight(scripted([plan("body")]), 1.2, () => ({ guard: guard(0, 2) }));
    expect(low.events.at(-1)).toMatchObject({ kind: "blocked-me", hands: 2 });
    expect(low.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.body * (1 - RULES.block[2]));
    // Covering the face does nothing for the ribs.
    expect(fight(scripted([plan("body")]), 1.2, () => ({ guard: guard(2) })).kinds).toContain("hit-me");
  });
  it("blocks a head punch with the gloves, better with two, at a cost in stamina", () => {
    const two = fight(scripted([plan("cross")]), 0.86, () => ({ guard: guard(2) }));
    expect(two.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.cross * (1 - RULES.block[2]));
    expect(two.s.me.stamina).toBeLessThan(RULES.stamina);
    const one = fight(scripted([plan("cross")]), 1.2, () => ({ guard: guard(1, 0, 2) }));
    expect(one.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.cross * (1 - RULES.block[1]));
  });
  it("shows a feint and does not throw it", () => {
    const { kinds, s } = fight(scripted([plan("cross", { feint: true }), plan("jab")]), 1.2);
    expect(kinds.slice(0, 2)).toEqual(["telegraph", "feint"]);
    expect(s.me.hp).toBe(RULES.health);
  });
  it("follows a jab with a second punch unless the jab was made to miss", () => {
    const both = fight(scripted([plan("jab", { follow: "cross" })], 5), 2);
    // The jab is caught on the guard; the cross behind it is not.
    expect(both.kinds).toEqual(["telegraph", "blocked-me", "telegraph", "hit-me"]);
    const impact = 0.2 + 0.5 + RULES.strike;
    const dodged = fight(scripted([plan("jab", { follow: "cross" })], 5), 2, (s) => ({
      head: s.time > impact - 0.12 && s.time < impact + 0.1 ? { x: 0.2, y: 1.65 } : HEAD,
    }));
    expect(dodged.kinds).toEqual(["telegraph", "dodged"]);
  });
});

describe("hitting the opponent", () => {
  it("lands where the guard is not, and is blocked where it is", () => {
    // The opponent starts with its guard high and idles for a long time.
    const quiet = () => scripted([plan("jab")], 30);
    const start = () => createFight("contender", 30);
    const body = fight(quiet(), 0.5, throwing(0.1, punch({ target: "body" })), start());
    expect(body.kinds).toEqual(["landed"]);
    // Into the gap of a guard that is simply waiting: less than full weight.
    expect(body.s.foe.hp).toBeCloseTo(RULES.health - RULES.cross * RULES.bodyShare * RULES.set);
    const head = fight(quiet(), 0.5, throwing(0.1, punch()), start());
    expect(head.kinds).toEqual(["blocked"]);
    expect(head.s.foe.hp).toBeCloseTo(RULES.health - RULES.cross * RULES.chip);
  });
  it("breaks a guard that keeps being hit", () => {
    let last = -1;
    const { kinds, s } = fight(scripted([plan("jab")], 30), 3, (st) => {
      const due = Math.floor(st.time / 0.5);
      if (due === last) return {};
      last = due;
      return { punches: [punch({ shape: "hook" })] };
    }, createFight("contender", 30));
    expect(kinds).toContain("guard-broken");
    expect(kinds.filter((k) => k === "blocked").length).toBeGreaterThanOrEqual(3);
    // Stunned with its guard broken, the next ones land.
    expect(kinds.indexOf("landed")).toBeGreaterThan(kinds.indexOf("guard-broken"));
    expect(s.foe.hp).toBeLessThan(RULES.health - 10);
  });
  it("counts double on an opponent that was just made to miss", () => {
    const impact = 0.2 + 0.5 + RULES.strike;
    // Aimed early, and the head moved in good time.
    const early = (s: FightState) =>
      s.time > 0.2 + 0.2 && s.time < impact + 0.2 ? { x: 0.2, y: 1.65 } : HEAD;
    const jab = () => scripted([plan("jab", { aimAfter: 0.1 })], 30);
    const counter = fight(jab(), 1.4, throwing(impact + 0.15, punch(), (s) => ({ head: early(s) })));
    const landed = counter.events.find((e) => e.kind === "landed")!;
    expect(landed).toMatchObject({ counter: true });
    expect(counter.events.find((e) => e.kind === "dodged")).toMatchObject({ late: false });
    expect(counter.s.foe.hp).toBeCloseTo(RULES.health - RULES.cross * RULES.counter);
    expect(counter.s.foe.phase).toBe("stagger");
    // Too late: the window has closed and its guard is back.
    const late = fight(jab(), 2.2, throwing(impact + 1, punch(), (s) => ({ head: early(s) })));
    expect(late.kinds).toContain("blocked");
  });
  it("pays more for a dodge left to the last moment", () => {
    const impact = 0.2 + 0.5 + RULES.strike;
    // Still on the line a fifth of a second before it lands, gone when it does.
    const dodge = (s: FightState) =>
      s.time > impact - 0.12 && s.time < impact + 0.2 ? { x: 0.2, y: 1.65 } : HEAD;
    const counter = fight(scripted([plan("jab")], 30), 1.4, throwing(impact + 0.15, punch(), (s) => ({ head: dodge(s) })));
    expect(counter.events.find((e) => e.kind === "dodged")).toMatchObject({ late: true });
    expect(counter.s.foe.hp).toBeCloseTo(RULES.health - RULES.cross * RULES.counter * RULES.lateBonus);
    // A hook ducked at the last moment likewise; one ducked from the start is an ordinary dodge.
    const duck = (from: number) => (s: FightState) => ({ head: s.time > from ? { x: 0, y: 1.3 } : HEAD });
    expect(fight(scripted([plan("hook")], 30), 1.2, duck(impact - 0.1)).events.find((e) => e.kind === "dodged")).toMatchObject({ late: true });
    expect(fight(scripted([plan("hook")], 30), 1.2, duck(0.3)).events.find((e) => e.kind === "dodged")).toMatchObject({ late: false });
  });
  it("stops a hook or a body shot early in its showing with a straight punch, and nothing else", () => {
    const hook = fight(scripted([plan("hook", { windup: 0.7 })], 30), 1.5, throwing(0.4, punch()));
    expect(hook.kinds).toEqual(["telegraph", "landed", "stopped"]);
    expect(hook.s.me.hp).toBe(RULES.health);
    // Showing a punch, its other glove still half covers where its guard was.
    expect(hook.s.foe.hp).toBeCloseTo(RULES.health - RULES.cross * (1 - RULES.halfCover));
    // The jab hand stops it too: a straight beats a wide punch.
    const lead = fight(scripted([plan("body", { windup: 0.7 })], 30), 1.5, throwing(0.4, punch({ hand: "left" })));
    expect(lead.kinds).toEqual(["telegraph", "landed", "stopped"]);
    // Too late: the second half of the showing.
    const late = fight(scripted([plan("hook", { windup: 0.7 })], 30), 1.5, throwing(0.62, punch()));
    expect(late.kinds).toEqual(["telegraph", "landed", "hit-me"]);
    // A hook does not stop a hook, a jab or cross must be defended, and a lesson is never stopped.
    const wide = fight(scripted([plan("hook", { windup: 0.7 })], 30), 1.5, throwing(0.4, punch({ shape: "hook" })));
    expect(wide.kinds).toEqual(["telegraph", "landed", "hit-me"]);
    const straight = fight(scripted([plan("cross", { windup: 0.7 })], 30), 1.5, throwing(0.4, punch()));
    expect(straight.kinds).toEqual(["telegraph", "landed", "hit-me"]);
    const lesson = fight(scripted([plan("hook", { windup: 0.7, teaching: true })], 30), 1.5, throwing(0.4, punch()));
    expect(lesson.kinds).toEqual(["telegraph", "landed", "hit-me"]);
  });
  it("makes combinations pay, and covers where it has just been hit", () => {
    const run = (punches: Punch[], level: "rookie" | "contender" = "contender") => {
      let i = 0;
      return fight(scripted([plan("jab")], 30), 2, (s) => {
        if (i < punches.length && s.time >= 0.1 + i * 0.3) return { punches: [punches[i++]] };
        return {};
      }, { ...createFight(level, 30), foe: { ...createFight(level, 30).foe, guard: "high" } });
    };
    const body = (over: Partial<Punch>) => punch({ target: "body", ...over });
    // A contender's guard comes down after one to the body; the head is then open.
    const mixed = run([body({ hand: "left" }), body({}), punch({ shape: "hook", hand: "left" })]);
    expect(mixed.kinds).toEqual(["landed", "blocked", "landed"]);
    const landed = mixed.events.filter((e) => e.kind === "landed") as { damage: number; combo: number }[];
    expect(landed.map((e) => e.combo)).toEqual([1, 2]);
    expect(landed[1].damage).toBeCloseTo(RULES.hook * RULES.set * (1 + RULES.comboStep));
    // And it has gone back up after the hook to the head.
    expect(mixed.s.foe.guard).toBe("high");
    // A rookie needs telling twice: two land, the third meets the guard.
    const same = run([body({}), body({ hand: "left" }), body({})], "rookie");
    expect(same.kinds).toEqual(["landed", "landed", "blocked"]);
  });
  it("runs out of breath when swinging without rest, and a spent punch does not land", () => {
    let n = 0;
    let atEmpty: number | null = null;
    const flail = fight(scripted([plan("jab")], 30), 4, (s) => {
      if (atEmpty === null && s.events.some((e) => e.kind === "gassed")) atEmpty = s.foe.hp;
      if (s.time >= n * 0.18) {
        n++;
        // Head, then body, and round again, so some always find the gap.
        return { punches: [punch({ shape: "hook", target: n % 2 ? "body" : "head", hand: n % 2 ? "left" : "right" })] };
      }
      return {};
    }, createFight("contender", 30));
    expect(flail.kinds.filter((k) => k === "gassed").length).toBeGreaterThan(3);
    expect(flail.s.me.stamina).toBeLessThan(RULES.cost.hook);
    // From the moment the breath ran out, nothing more got through.
    expect(atEmpty).not.toBeNull();
    expect(flail.s.foe.hp).toBe(atEmpty);
    const rested = fight(scripted([plan("jab")], 30), 6, () => ({}), flail.s);
    expect(rested.s.me.stamina).toBeGreaterThan(25);
    // Behind a cover, breath does not come back.
    const covering = fight(scripted([plan("jab")], 30), 6, () => ({ guard: guard(2) }), flail.s);
    expect(covering.s.me.stamina).toBeLessThan(RULES.cost.hook);
  });
});

describe("knockdowns and the end", () => {
  it("puts the opponent down, lets it up twice, and ends on the third", () => {
    const mind = scripted([plan("jab")], 300);
    let s = createFight("contender", 300);
    const kinds: string[] = [];
    const seen = new Set<number>();
    let next = 0.2;
    while (s.time < 60 && !s.over) {
      // Whenever it is standing, it is one punch from going down.
      if (s.foe.phase !== "down" && s.foe.hp > 3) s = { ...s, foe: { ...s.foe, hp: 3 } };
      const due = s.time >= next && s.foe.phase !== "down";
      if (due) next = s.time + 1;
      s = stepFight(
        s,
        STEP,
        {
          head: HEAD,
          guard: HANDS_UP,
          punches: due ? [punch({ target: s.foe.guard === "high" ? "body" : "head", shape: "hook" })] : [],
        },
        mind,
      );
      for (const e of s.events)
        if (!seen.has(e.id)) {
          seen.add(e.id);
          kinds.push(e.kind);
        }
    }
    expect(kinds.filter((k) => k === "foe-down").length).toBe(3);
    expect(kinds.filter((k) => k === "foe-up").length).toBe(2);
    expect(s.over).toEqual({ winner: 0, how: "ko" });
    expect(kinds.at(-1)).toBe("over");
    // Each time it got up, it was told to come on harder.
    expect(mind.said.filter((w) => w === "got-up").length).toBe(2);
  });
  it("puts the player down, and lets them up by covering up", () => {
    const { kinds, s } = fight(scripted([plan("hook")], 0.3), 60, (st) => ({
      guard: NO_GUARD,
      rise: st.me.down,
    }));
    expect(kinds.filter((k) => k === "me-down").length).toBe(3);
    expect(kinds.filter((k) => k === "me-up").length).toBe(2);
    expect(s.over).toEqual({ winner: 1, how: "ko" });
    // Down, the player is not hit again until they are up and have had a moment.
    const downs = fight(scripted([plan("hook")], 0.3), 60, () => ({ guard: NO_GUARD }));
    const first = downs.events.findIndex((e) => e.kind === "me-down");
    expect(downs.kinds[first + 1]).toBe("me-up");
    expect(downs.events[first + 1].at - downs.events[first].at).toBeCloseTo(RULES.downMax, 1);
  });
  it("goes to points when the clock runs out, and to a draw when there is nothing between them", () => {
    const { s } = fight(scripted([plan("jab", { feint: true })], 2), RULES.clock + 1, throwing(1, punch({ target: "body" })));
    expect(s.over).toEqual({ winner: 0, how: "points" });
    const quiet = fight(scripted([plan("jab", { feint: true })], 2), RULES.clock + 1);
    expect(quiet.s.over).toEqual({ winner: null, how: "draw" });
  });
});

describe("the opponent's brain", () => {
  it("teaches each defence with a slow punch first, in a rookie fight only", () => {
    const mind = createBoxerMind(3);
    const first = [0, 1, 2].map(() => mind.next("rookie"));
    expect(first.map((p) => p.kind)).toEqual(["jab", "hook", "body"]);
    expect(first.every((p) => p.teaching && p.windup === 1.1 && !p.feint && !p.follow)).toBe(true);
    expect(mind.next("rookie").teaching).toBe(false);
    expect(createBoxerMind(3).next("contender").teaching).toBe(false);
  });
  it("is quicker, feints and throws combinations as a contender; a rookie does neither", () => {
    const sample = (level: "rookie" | "contender", reports: number) => {
      const mind = createBoxerMind(11);
      for (let i = 0; i < reports; i++) mind.report("dodged-by-player");
      for (let i = 0; i < -reports; i++) mind.report("hit-player");
      const plans = Array.from({ length: 800 }, () => mind.next(level)).slice(5);
      const jab = plans.filter((p) => p.kind === "jab" && !p.teaching);
      return {
        jab: jab.reduce((a, p) => a + p.windup, 0) / jab.length,
        feints: plans.filter((p) => p.feint).length / plans.length,
        combos: plans.filter((p) => p.follow).length / plans.length,
        kinds: new Set(plans.map((p) => p.kind)).size,
        idle: mind.idle(level),
        form: mind.form(),
      };
    };
    const rookie = sample("rookie", 0),
      contender = sample("contender", 0);
    expect(rookie.jab).toBeCloseTo(LEVEL.rookie.windup.jab, 5);
    expect(contender.jab).toBeCloseTo(LEVEL.contender.windup.jab, 5);
    expect(rookie.feints + rookie.combos).toBe(0);
    expect(contender.feints).toBeGreaterThan(0.08);
    expect(contender.combos).toBeGreaterThan(0.06);
    expect(contender.kinds).toBe(4);
    // It plays to the player.
    const hard = sample("contender", 12),
      easy = sample("contender", -10);
    expect(hard.form).toBe(1);
    expect(easy.form).toBe(-1);
    expect(hard.jab).toBeLessThan(contender.jab);
    expect(easy.jab).toBeGreaterThan(contender.jab);
    expect(hard.feints).toBeGreaterThan(easy.feints);
  });
  it("moves its guard to where it keeps being hit", () => {
    const mind = createBoxerMind(5);
    let s = createFight("contender", 30);
    let n = 0;
    const kinds: string[] = [];
    while (s.time < 6) {
      const due = s.time >= n * 0.9;
      if (due) n++;
      s = stepFight(s, STEP, { head: HEAD, guard: NO_GUARD, punches: due ? [punch({ target: "body", hand: n % 2 ? "left" : "right" })] : [] }, mind);
      for (const e of s.events) if (e.at === s.time) kinds.push(e.kind);
    }
    // The first body punches land; then its guard comes down and they are blocked.
    expect(kinds[0]).toBe("landed");
    expect(kinds).toContain("blocked");
    expect(s.foe.guard).toBe("low");
  });
});

describe("reading a block from the camera", () => {
  const read = (motion: Parameters<typeof syntheticFrame>[1], busy: [boolean, boolean] = [false, false]) => {
    const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative" });
    let t = 1000,
      result = tracker.sample(t);
    for (let i = 0; i < 45; i++) result = tracker.update(syntheticFrame((t += 33), AT_REST), t);
    for (let i = 0; i < 12; i++) result = tracker.update(syntheticFrame((t += 33), motion), t);
    return readGuard(result, busy);
  };
  it("tells hands up, covering the face and covering the ribs apart, and hanging arms from all three", () => {
    expect(read(stance())).toMatchObject({ high: 0, low: 0, up: 2 });
    expect(read(AT_REST)).toMatchObject({ high: 0, low: 0, up: 0 });
    expect(read(stance({ block: "high" }))).toMatchObject({ high: 2, low: 0, up: 2 });
    expect(read(stance({ block: "low" }))).toMatchObject({ high: 0, low: 2, up: 0 });
    // Slipping or ducking with the hands in the guard is not a block.
    expect(read(stance({ lean: 0.15 }))).toMatchObject({ high: 0, low: 0, up: 2 });
    expect(read(stance({ crouch: 0.2 }))).toMatchObject({ high: 0, low: 0, up: 2 });
  });
  it("needs no face to read a cover, and measures it against the player's own guard", () => {
    const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative", hiddenHeadFromShoulders: true });
    let t = 1000,
      result = tracker.sample(t);
    for (let i = 0; i < 45; i++) result = tracker.update(syntheticFrame((t += 33), AT_REST), t);
    // Gloves in front of the face: the pose model stops seeing the nose and ears.
    for (let i = 0; i < 30; i++) {
      const frame = syntheticFrame((t += 33), stance({ block: "high" }));
      for (const hidden of [0, 7, 8]) frame.lm[hidden] = { ...frame.lm[hidden], v: 0.2 };
      result = tracker.update(frame, t);
    }
    // A second of it: still tracked, and read as a cover.
    expect(result.valid).toBe(true);
    expect(readGuard(result)).toMatchObject({ high: 2 });
    // A player whose ordinary guard reads high (a low camera) is not always covering.
    const heights = readGuard(result).heights as [number, number];
    expect(readGuard(result, [false, false], heights[0])).toMatchObject({ high: 0, up: 2 });
  });
  it("does not count a hand that is out punching", () => {
    expect(read(stance({ block: "high" }), [true, false])).toMatchObject({ high: 1, low: 0 });
    // A fist at full reach in front of the face is a punch, not a cover.
    const out = punchMotion("left", "straight", 0.2);
    expect(read(out, [true, false]).high).toBe(0);
  });
});

describe("what the rules do for a beginner", () => {
  it("opens a rookie with its hands low, so the first punch at its head lands", () => {
    expect(createFight("rookie").foe.guard).toBe("low");
    expect(createFight("contender").foe.guard).toBe("high");
    const first = fight(scripted([plan("jab")], 30), 0.5, throwing(0.1, punch()), createFight("rookie", 30));
    expect(first.kinds).toEqual(["landed"]);
  });
  it("goes to the body of a player who keeps covering their head, and back", () => {
    const asked: (string | null)[] = [];
    const mind = scripted([plan("cross")], 0.3);
    const next = mind.next;
    mind.next = (level, tired, go = null) => {
      asked.push(go);
      return next(level, tired, go);
    };
    fight(mind, 6, () => ({ guard: guard(2) }));
    // Two head punches blocked, then it is told to go low.
    expect(asked.slice(0, 3)).toEqual([null, null, "body"]);
  });
  it("hurts nobody in a lesson, throws only the punch being taught, and stands open when there is none", () => {
    const mind = scripted([plan("cross")]);
    const slip = fight(mind, 6, () => ({}), createFight("rookie", 0.5, { attack: "hook", windup: 1.1 }));
    expect(new Set(slip.events.filter((e) => e.kind === "telegraph").map((e) => (e as { attack: string }).attack))).toEqual(new Set(["hook"]));
    expect(slip.kinds).toContain("hit-me");
    expect(slip.s.me.hp).toBe(RULES.health);
    let n = 0;
    const open = fight(mind, 6, (s) => (s.time >= n * 0.5 ? (n++, { punches: [punch({ hand: n % 2 ? "left" : "right" })] }) : {}), createFight("rookie", 0.5, { attack: null, windup: 1.1 }));
    expect(open.kinds.filter((k) => k === "landed").length).toBeGreaterThan(8);
    expect(open.kinds).not.toContain("telegraph");
    expect(open.s.foe.hp).toBe(RULES.health);
    expect(open.s.over).toBeNull();
  });
});

describe("swinging and hiding do not win", () => {
  it("does not let punches keep the opponent from punching: a hit makes it flinch, not start again", () => {
    // It will throw 1 s after the bell. Hit it every 0.3 s on the way.
    let n = 0;
    const { events } = fight(scripted([plan("cross")], 5), 1.8, (s) =>
      s.time >= 0.1 + n * 0.3 && n < 3 ? (n++, { punches: [punch({ target: "body", hand: n % 2 ? "left" : "right" })] }) : {},
      createFight("contender", 1),
    );
    const shown = events.find((e) => e.kind === "telegraph")!;
    expect(shown.at).toBeLessThan(1.15);
  });
  it("costs more to be hit in the middle of a punch", () => {
    const impact = 0.2 + 0.5 + RULES.strike;
    for (const level of ["rookie", "contender"] as const) {
      const start = createFight(level, 0.2);
      const caught = fight(scripted([plan("cross")], 30), 1.2, throwing(impact - 0.1, punch({ hand: "left" })), start);
      const hit = caught.events.find((e) => e.kind === "hit-me")!;
      expect(hit).toMatchObject({ caught: true });
      expect((hit as { damage: number }).damage).toBeCloseTo(RULES.hurt.cross * LEVEL[level].caught);
    }
  });
  it("lets a hook round a cover, and a block fail when there is no breath for it", () => {
    const hook = fight(scripted([plan("hook")]), 0.86, () => ({ guard: guard(2) }));
    expect(hook.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.hook * (1 - RULES.block[2] * RULES.hookRound));
    const spent = createFight("contender", 0.2);
    spent.me.stamina = 4;
    // They have just punched: no breath comes back before it lands.
    spent.me.lastPunchAt = 0.5;
    const empty = fight(scripted([plan("cross")]), 0.86, () => ({ guard: guard(2), punches: [] }), spent);
    expect(empty.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.cross * (1 - RULES.block[2] * RULES.emptyBlock));
  });
  it("rewards gloves that arrive at the last moment: a parry", () => {
    const impact = 0.2 + 0.5 + RULES.strike;
    const parry = fight(scripted([plan("cross")], 30), 1.1, (s) => ({ guard: s.time > impact - 0.2 ? guard(2) : HANDS_UP }));
    expect(parry.kinds).toEqual(["telegraph", "parried"]);
    expect(parry.s.me.hp).toBe(RULES.health);
    expect(parry.s.me.stamina).toBe(RULES.stamina);
    // The opening it makes is shorter than a dodge's and pays less.
    const counter = fight(scripted([plan("cross")], 30), 1.4, throwing(impact + 0.2, punch({ target: "body" }), (s) => ({ guard: s.time > impact - 0.2 && s.time < impact + 0.05 ? guard(2) : HANDS_UP })));
    expect(counter.events.at(-1)).toMatchObject({ kind: "landed", counter: true });
    expect(RULES.health - counter.s.foe.hp).toBeCloseTo(RULES.cross * RULES.bodyShare * RULES.parry.bonus);
  });
  it("lets its guard recover when it is left alone", () => {
    let n = 0;
    const worn = fight(scripted([plan("jab")], 30), 1.2, (s) => (s.time >= 0.1 + n * 0.4 && n < 2 ? (n++, { punches: [punch({ shape: "hook" })] }) : {}), createFight("contender", 30));
    expect(worn.s.foe.guardLeft).toBeLessThan(RULES.guardStrength - 10);
    const rested = fight(scripted([plan("jab")], 30), 5, () => ({}), worn.s);
    expect(rested.s.foe.guardLeft).toBe(RULES.guardStrength);
  });
});

describe("stance and which glove blocks what", () => {
  it("treats the lead hand's straight as the jab, whichever hand leads", () => {
    const land = (lead: "left" | "right", hand: "left" | "right") => {
      const start = createFight("rookie", 30, undefined, lead);
      const { s } = fight(scripted([plan("jab")], 30), 0.5, throwing(0.1, punch({ hand })), start);
      return RULES.health - s.foe.hp;
    };
    // Rookie's hands are low: a head punch lands at the share for a waiting guard's gap.
    expect(land("left", "left")).toBeCloseTo(RULES.jab * RULES.set);
    expect(land("left", "right")).toBeCloseTo(RULES.cross * RULES.set);
    expect(land("right", "right")).toBeCloseTo(RULES.jab * RULES.set);
    expect(land("right", "left")).toBeCloseTo(RULES.cross * RULES.set);
  });
  it("stops a hook with the glove on the side it comes from", () => {
    const sided = (high: [boolean, boolean]): Guard => ({ high: 1, low: 0, up: 2, heights: [null, null], sides: { high, low: [false, false] } });
    // Its left hook arrives on the player's right.
    const right = fight(scripted([plan("hook", { hand: "left" })]), 0.86, () => ({ guard: sided([false, true]) }));
    expect(right.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.hook * (1 - RULES.block[2]));
    const wrong = fight(scripted([plan("hook", { hand: "left" })]), 0.86, () => ({ guard: sided([true, false]) }));
    expect(wrong.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.hook * (1 - RULES.block[1] * RULES.hookRound));
  });
  it("blocks a body shot best with the elbow on that side and the other hand still up", () => {
    const elbow: Guard = { high: 0, low: 1, up: 1, heights: [null, null], sides: { high: [false, false], low: [false, true] } };
    const good = fight(scripted([plan("body", { hand: "left" })]), 0.86, () => ({ guard: elbow }));
    expect(good.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.body * (1 - RULES.block[2]));
    // The elbow on the wrong side keeps out a single glove's share.
    const other: Guard = { ...elbow, sides: { high: [false, false], low: [true, false] } };
    const poor = fight(scripted([plan("body", { hand: "left" })]), 0.86, () => ({ guard: other }));
    expect(poor.s.me.hp).toBeCloseTo(RULES.health - RULES.hurt.body * (1 - RULES.block[1]));
  });
});

describe("rounds", () => {
  const quiet = () => scripted([plan("jab")], 1000);
  const bout = (rounds: number) => createFight("contender", 1000, undefined, "left", rounds);
  /** Run to the next bell or the end, the player doing `script`. */
  const toBell = (start: FightState, script: Script = () => ({}), mind: BoxerMind = quiet()) => {
    let s = start;
    const events: FightEvent[] = [];
    const seen = new Set<number>(start.events.map((e) => e.id));
    while (!s.rest && !s.over) {
      const act = script(s);
      s = stepFight(s, STEP, { head: act.head ?? HEAD, guard: act.guard ?? HANDS_UP, punches: act.punches ?? [], rise: act.rise }, mind);
      for (const e of s.events) if (!seen.has(e.id)) (seen.add(e.id), events.push(e));
    }
    return { s, events };
  };
  it("stops at the bell with the round scored, and waits in the corner", () => {
    // One body punch landed in the round: it is the player's, ten to nine.
    const first = toBell(bout(3), throwing(1, punch({ target: "body" })));
    expect(first.s.rest).toBe(true);
    expect(first.s.over).toBeNull();
    expect(first.s.time).toBeCloseTo(RULES.clock, 1);
    expect(first.events.at(-1)).toMatchObject({ kind: "round-over", round: 1, score: [10, 9] });
    expect(first.s.card).toEqual([[10, 9]]);
    // Nothing moves until the next round is begun.
    expect(stepFight(first.s, STEP, { head: HEAD, guard: HANDS_UP, punches: [punch()] }, quiet())).toBe(first.s);
  });
  it("comes out for the next round with breath, half the lost health back, and the knockdowns begun again", () => {
    const hurt = { ...bout(3), time: RULES.clock - 0.5 };
    hurt.me = { ...hurt.me, hp: 40, stamina: 10, downs: 1 };
    hurt.foe = { ...hurt.foe, hp: 60, downs: 2, tired: 0.8 };
    const rested = nextRound(toBell(hurt).s);
    expect(rested).toMatchObject({ rest: false, round: 2 });
    expect(rested.me).toMatchObject({ hp: 70, stamina: RULES.stamina, downs: 0 });
    expect(rested.foe).toMatchObject({ hp: 80, downs: 0, phase: "guard" });
    expect(rested.foe.tired).toBeCloseTo(0.4);
    expect(rested.roundStart).toBeCloseTo(rested.time);
    // The second round runs its own two minutes.
    const second = toBell(rested);
    expect(second.s.time - rested.time).toBeCloseTo(RULES.clock, 1);
    expect(second.s.card.length).toBe(2);
  });
  it("is decided on the card after the last round, and a level card is a draw", () => {
    const body = punch({ target: "body" });
    // The first round to the player; in the second its jab is caught and nothing answers it: nineteen each.
    const level = toBell(nextRound(toBell(bout(2), throwing(1, body)).s));
    expect(level.s.card).toEqual([[10, 9], [9, 10]]);
    expect(level.s.over).toEqual({ winner: null, how: "draw" });
    // Two punches into the gaps in the second as well (its guard went low after the first round's
    // body punch, so the head first): both rounds, twenty to eighteen.
    const high = once(RULES.clock + 3, punch()),
      low = once(RULES.clock + 4, body);
    const won = toBell(nextRound(toBell(bout(2), throwing(1, body)).s), (st) => ({ punches: [...low(st), ...high(st)] }));
    expect(won.s.card).toEqual([[10, 9], [10, 9]]);
    expect(won.s.over).toEqual({ winner: 0, how: "points" });
  });
  it("scores a round ten to eight when the loser of it went down", () => {
    const s = bout(2);
    const floored = { ...s, time: RULES.clock - 0.5, dealt: [60, 0] as [number, number], foe: { ...s.foe, downs: 1 } };
    expect(toBell(floored).s.card).toEqual([[10, 8]]);
  });
  it("stands a player up who is down at the bell", () => {
    const s = bout(2);
    const down = { ...s, time: RULES.clock - 0.2, me: { ...s.me, hp: 0, downs: 1, down: true, downAt: RULES.clock - 1 } };
    const bell = toBell(down).s;
    expect(bell.rest).toBe(true);
    expect(bell.me.down).toBe(false);
    expect(bell.me.hp).toBeCloseTo(RULES.health * RULES.riseMe[0]);
  });
});

describe("a player who stands right foot forward", () => {
  it("is thrown at from the mirrored hand", () => {
    const southpaw = createFight("contender", 0.2, undefined, "right");
    const { events, s } = fight(scripted([plan("cross")]), 1.2, () => ({}), southpaw);
    // A cross is its rear hand: for this player that is its left, landing on their right.
    expect(events[0]).toMatchObject({ kind: "telegraph", attack: "cross", hand: "left" });
    expect(s.me.hurtSide).toBe(1);
  });
});

describe("doubt goes to the player", () => {
  it("does not hurt with a punch that was in the air while the player could not be seen", () => {
    // Seen throughout: the cross lands.
    const seen = fight(scripted([plan("cross")]), 1.2, () => ({ guard: NO_GUARD }));
    expect(seen.s.me.hp).toBeLessThan(RULES.health);
    // Hidden for a moment in the middle of its showing: it glances off, and costs nothing.
    const hidden = fight(scripted([plan("cross")]), 1.2, (s) => ({ guard: NO_GUARD, blind: s.time > 0.4 && s.time < 0.5 }));
    expect(hidden.s.me.hp).toBe(RULES.health);
    expect(hidden.s.me.stamina).toBe(RULES.stamina);
    expect(hidden.events.at(-1)).toMatchObject({ kind: "blocked-me", damage: 0 });
    // A slip still counts as a slip: being unseen takes nothing away from the player.
    const impact = 0.2 + 0.5 + RULES.strike;
    const slipped = fight(scripted([plan("cross")]), 1.2, (s) => ({
      head: s.time > impact - 0.12 ? { x: 0.2, y: 1.65 } : HEAD,
      blind: s.time > 0.3 && s.time < 0.4,
    }));
    expect(slipped.kinds).toContain("dodged");
  });
  it("does not call a hidden hand a low one", () => {
    const unknown: Guard = { ...NO_GUARD, known: false };
    const hit = fight(scripted([plan("cross")]), 1.2, () => ({ guard: unknown }));
    // Hit, but not at the hands-down price, and not scolded for it.
    expect(hit.s.me.hp).toBe(RULES.health - RULES.hurt.cross);
    expect(hit.events.at(-1)).toMatchObject({ kind: "hit-me", open: false });
  });
});
