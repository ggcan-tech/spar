import { describe, expect, it } from "vitest";
import { LADDER, createBoxerMind, type BoxLevel } from "./boxer";
import type { Guard } from "./defence";
import { RULES, createFight, nextRound, stepFight, type FightState } from "./fight";
import type { Punch } from "./punch";

/**
 * Ways of playing, run against the real rules and the real opponent. Not
 * people: each does one thing without tiring of it. What they show is whether
 * a way of playing that takes no skill wins.
 */
const STEP = 1 / 60;
const HEAD = { x: 0, y: 1.65 };
const up: Guard = { high: 0, low: 0, up: 2, heights: [null, null] };
const cover: Guard = { high: 2, low: 0, up: 2, heights: [null, null] };
const low: Guard = { high: 0, low: 2, up: 0, heights: [null, null] };
type Act = { head?: { x: number; y: number }; guard?: Guard; punches?: Punch[]; rise?: boolean };
type Style = (s: FightState, memo: { next: number; n: number; random: () => number }) => Act;
const p = (hand: "left" | "right", shape: Punch["shape"], target: "head" | "body"): Punch => ({ hand, shape, target, power: 1, t: 0 });

const STYLES: Record<string, Style> = {
  // Stands there.
  passive: () => ({}),
  // Three straights a second at head and body in turn, never defends.
  flailer: (s, m) => {
    if (s.time < m.next) return { rise: true };
    m.next = s.time + 0.33;
    m.n++;
    return { punches: [p(m.n % 2 ? "left" : "right", "straight", m.n % 4 < 2 ? "head" : "body")], rise: true };
  },
  // One hook a second at whatever is not covered.
  hooker: (s, m) => {
    if (s.time < m.next) return { rise: true };
    m.next = s.time + 1;
    m.n++;
    return { punches: [p(m.n % 2 ? "left" : "right", "hook", s.foe.guard === "high" ? "body" : "head")], rise: true };
  },
  // Covers the head always, drops the gloves for a body shot, pokes between.
  turtle: (s, m) => {
    const a = s.foe.attack;
    const guard = a && a.kind === "body" && s.time - a.startAt > 0.35 ? low : cover;
    if (s.time < m.next || a) return { guard, rise: true };
    m.next = s.time + 0.8;
    m.n++;
    return { guard, punches: [p("left", "straight", s.foe.guard === "high" ? "body" : "head")], rise: true };
  },
  // Reads the punch: slips, ducks or blocks low most of the time, 0.45 s after it is shown,
  // then hits back twice; otherwise waits.
  patient: (s, m) => {
    const a = s.foe.attack;
    let head = HEAD,
      guard = up;
    if (a && !a.feint && s.foe.phase !== "recover" && s.time - a.startAt > 0.45) {
      // It gets it right seven times in ten.
      const good = ((a.id * 7919) % 10) < 7;
      if (good) {
        if (a.kind === "hook") head = { x: 0, y: 1.35 };
        else if (a.kind === "body") guard = low;
        else head = { x: 0.25, y: 1.65 };
      }
    }
    // Open after a miss, and for as long as it is stunned.
    const open = (s.foe.phase === "recover" && s.time <= s.foe.counterUntil) || s.foe.phase === "stagger";
    if (open && s.time >= m.next) {
      m.next = s.time + 0.3;
      m.n++;
      return { head, guard, punches: [p(m.n % 2 ? "right" : "left", m.n % 2 ? "straight" : "hook", "head")], rise: true };
    }
    return { head, guard, rise: true };
  },
};

function run(level: BoxLevel, style: Style, fights = 8) {
  let wins = 0,
    draws = 0,
    seconds = 0,
    taken = 0;
  for (let f = 0; f < fights; f++) {
    const mind = createBoxerMind(1000 + f * 17);
    let seed = f + 1;
    const memo = {
      next: 0,
      n: 0,
      random: () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      },
    };
    // A bout as it is played: three rounds, a rest between.
    let s = createFight(level, 2, undefined, "left", 3);
    while (!s.over) {
      if (s.rest) {
        s = nextRound(s);
        continue;
      }
      const act = style(s, memo);
      s = stepFight(s, STEP, { head: act.head ?? HEAD, guard: act.guard ?? up, punches: act.punches ?? [], rise: act.rise }, mind);
    }
    if (s.over!.winner === 0) wins++;
    if (s.over!.winner === null) draws++;
    seconds += s.time;
    taken += s.dealt[1];
  }
  return { wins: wins / fights, draws: draws / fights, seconds: seconds / fights, taken: taken / fights };
}

describe("ways of playing against the real opponent", () => {
  const table: Record<string, Record<string, ReturnType<typeof run>>> = {};
  for (const level of LADDER) {
    table[level] = {};
    for (const [name, style] of Object.entries(STYLES)) table[level][name] = run(level, style);
  }
  it("prints how each fares", () => {
    for (const level of LADDER)
      for (const [name, r] of Object.entries(table[level]))
        console.log(
          `${level.padEnd(9)} ${name.padEnd(8)} wins ${(r.wins * 100).toFixed(0).padStart(3)}% draws ${(r.draws * 100).toFixed(0).padStart(3)}% in ${r.seconds.toFixed(0).padStart(3)} s, damage taken ${r.taken.toFixed(0)}`,
        );
    expect(true).toBe(true);
  });
  it("beats a player who does nothing, and loses to one who reads it", () => {
    for (const level of LADDER) {
      expect(table[level].passive.wins).toBe(0);
      expect(table[level].patient.wins).toBeGreaterThan(0.6);
    }
  });
  it("does not lose to swinging or hiding, whoever it is", () => {
    for (const level of LADDER) {
      expect(table[level].flailer.wins).toBeLessThan(0.5);
      expect(table[level].turtle.wins).toBeLessThan(0.5);
    }
    // A rookie can still be beaten by plain, unhurried punching at the gap.
    expect(table.rookie.hooker.wins).toBeGreaterThan(0.5);
    // Reading it pays better than either.
    expect(table.contender.patient.wins).toBeGreaterThan(table.contender.flailer.wins);
    expect(table.contender.patient.wins).toBeGreaterThan(table.contender.turtle.wins);
  });
});
