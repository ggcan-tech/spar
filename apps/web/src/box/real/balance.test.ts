import { describe, expect, it } from "vitest";
import { BOXERS, LADDER, type BoxerName } from "./mind";
import { STYLES, playBout, playMany, type StyleName } from "./players";

/**
 * Ways of playing, run against the real rules and the five real opponents.
 * Not people: each script does one thing without tiring of it. This is the
 * gate for every change to a rule or to an opponent's row:
 *
 * - a way of playing that takes no skill must not win, whoever it meets;
 * - a beginner who keeps their hands up beats the first opponent and is not
 *   put down in round one;
 * - a middle-level player is an even match for the fifth opponent, and no
 *   opponent further up the ladder is easier for them than one below.
 *
 * Every bout is seeded, so the table is the same every run.
 */
type Cell = ReturnType<typeof playMany>;
/** Ways of playing that take no skill. Each must win under one bout in ten against everybody. */
const NO_SKILL: StyleName[] = ["nothing", "swings", "hides", "hides and pokes", "leans back", "only jabs"];
/** The rest of the table: shown, and a few of them held to a line. */
const OTHERS: StyleName[] = ["swings, mixed", "leans back, jabs", "sways, one-twos", "beginner", "sloppy beginner", "middle", "good"];
/** Bouts a cell. More where a band is narrow. */
const bouts = (style: StyleName, boxer: BoxerName) =>
  style === "middle" ? 100 : style === "beginner" && boxer === "beginner" ? 60 : style === "good" && boxer === "counter" ? 40 : NO_SKILL.includes(style) ? 14 : 10;

const table = new Map<string, Cell>();
const cell = (style: StyleName, boxer: BoxerName) => table.get(`${style}|${boxer}`)!;
for (const style of [...NO_SKILL, ...OTHERS]) for (const boxer of LADDER) table.set(`${style}|${boxer}`, playMany(BOXERS[boxer], STYLES[style], bouts(style, boxer)));

const pct = (v: number) => `${(100 * v).toFixed(0).padStart(3)}%`;

describe("ways of playing against the five opponents", () => {
  it("prints how each fares", () => {
    const lines = ["way of playing    opponent  wins draws  stopped: it / me  seconds  knockdowns: me / it  down in round 1  punches a minute: me / it"];
    for (const style of [...NO_SKILL, ...OTHERS])
      for (const boxer of LADDER) {
        const r = cell(style, boxer);
        lines.push(
          `${style.padEnd(17)} ${boxer.padEnd(8)} ${pct(r.wins)} ${pct(r.draws)}       ${pct(r.stopped)} / ${pct(r.stoppedBy)}    ${r.seconds.toFixed(0).padStart(4)}           ${r.downsMe.toFixed(1)} / ${r.downsIt.toFixed(1)}             ${pct(r.r1Down)}                 ${r.myRate.toFixed(0).padStart(3)} / ${r.itsRate.toFixed(0).padStart(2)}`,
        );
      }
    console.log(lines.join("\n"));
    expect(table.size).toBe((NO_SKILL.length + OTHERS.length) * LADDER.length);
  });

  it("does not lose to doing nothing, swinging, hiding, hiding and poking, leaning back or only jabbing, whoever it is", () => {
    for (const style of NO_SKILL) for (const boxer of LADDER) expect(cell(style, boxer).wins, `${style} v ${boxer}`).toBeLessThan(0.1);
  });

  it("is beaten at the first step of the ladder by a beginner who keeps their hands up, without a knockdown in round one", () => {
    const r = cell("beginner", "beginner");
    expect(r.wins).toBeGreaterThan(0.8);
    expect(r.r1Down).toBeLessThan(0.1);
    // Nobody is knocked down in round one by the first opponent just for having their hands up.
    expect(cell("hides", "beginner").r1Down).toBeLessThan(0.1);
  });

  it("is an even match at the top of the ladder for a middle-level player", () => {
    const r = cell("middle", "counter");
    expect(r.wins).toBeGreaterThanOrEqual(0.45);
    expect(r.wins).toBeLessThanOrEqual(0.65);
  });

  it("never gets easier for that player further up the ladder", () => {
    const wins = LADDER.map((boxer) => cell("middle", boxer).wins);
    for (let i = 1; i < wins.length; i++) expect(wins[i], `${LADDER[i]} after ${LADDER[i - 1]}`).toBeLessThanOrEqual(wins[i - 1]);
    // And the top is a real step up from the bottom.
    expect(wins[0]).toBeGreaterThan(0.95);
    expect(wins[wins.length - 1]).toBeLessThan(wins[0] - 0.25);
  });

  it("has between one and three knockdowns in an even fight, and few in a beginner's", () => {
    const even = cell("middle", "counter");
    expect(even.downsMe + even.downsIt).toBeGreaterThanOrEqual(1);
    expect(even.downsMe + even.downsIt).toBeLessThanOrEqual(3);
    // The first opponent does not put a hands-up beginner down at all.
    expect(cell("beginner", "beginner").downsMe).toBeLessThan(0.3);
  });

  it("rewards the same player a year on", () => {
    expect(cell("good", "counter").wins).toBeGreaterThan(cell("middle", "counter").wins);
  });

  it("throws about as many punches a minute as a boxer of that kind does", () => {
    // Left alone, the beginner throws 12 to 16 a minute; under fire he freezes.
    const alone = cell("nothing", "beginner").itsRate;
    expect(alone).toBeGreaterThanOrEqual(12);
    expect(alone).toBeLessThanOrEqual(16);
    // The others in a real fight, within two of the coach's figures.
    const bands: [BoxerName, number, number][] = [
      ["swinger", 20, 25],
      ["jabber", 22, 26],
      ["pressure", 26, 30],
      ["counter", 18, 22],
    ];
    for (const [boxer, lo, hi] of bands) {
      const rate = cell("middle", boxer).itsRate;
      expect(rate, boxer).toBeGreaterThanOrEqual(lo - 2);
      expect(rate, boxer).toBeLessThanOrEqual(hi + 2);
    }
  });
});

describe("the same game with range turned off, and at lower stakes", () => {
  it("still does not lose to ways of playing that take no skill, and still lets a hands-up beginner win", () => {
    for (const style of NO_SKILL)
      for (const boxer of ["beginner", "counter"] as const)
        expect(playMany(BOXERS[boxer], STYLES[style], 8, { range: false }).wins, `${style} v ${boxer}`).toBeLessThan(0.1);
    expect(playMany(BOXERS.beginner, STYLES.beginner, 20, { range: false }).wins).toBeGreaterThan(0.8);
  });

  it("puts nobody down in touch sparring or open sparring, and still finds a winner", () => {
    for (const stakes of ["touch", "open"] as const) {
      let decided = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const r = playBout(BOXERS.counter, STYLES.middle, seed * 31, { stakes });
        expect(r.downs).toEqual([0, 0]);
        expect(r.how).not.toBe("stoppage");
        if (stakes === "touch") expect(r.hurts).toEqual([0, 0]);
        if (r.winner) decided++;
      }
      expect(decided).toBeGreaterThan(0);
    }
    // Doing nothing loses touch sparring too.
    expect(playMany(BOXERS.beginner, STYLES.nothing, 6, { stakes: "touch" }).wins).toBe(0);
  });

  it("gives the same bout for the same seed, and still runs when punches are reported late", () => {
    const a = playBout(BOXERS.counter, STYLES.middle, 99),
      b = playBout(BOXERS.counter, STYLES.middle, 99);
    expect(a).toEqual(b);
    // A punch reported a tenth of a second late is still judged where it landed.
    const late = playBout(BOXERS.counter, STYLES.middle, 99, { lag: 0.1 });
    expect(late.thrown[0]).toBeGreaterThan(50);
    expect(late.clean[0]).toBeGreaterThan(0);
  });
});
