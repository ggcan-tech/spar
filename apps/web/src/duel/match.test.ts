import { describe, expect, it } from "vitest";
import { JOINT } from "../pov/body";
import type { Target } from "./arena";
import { standardFigure } from "./body";
import { aimShot, botLaunch, createBotBody, createDefender, planDodge, type Incoming } from "./bot";
import { launch, solveLaunch } from "./flight";
import { overlap } from "./hit";
import { createMatch, type MatchEvent } from "./match";
import { FIELD, RULES } from "./tune";

const fig = (who: 0 | 1, duck = 0) => standardFigure({ x: who === 0 ? -FIELD.laneMiddle : FIELD.laneMiddle, toward: who === 0 ? 1 : -1, duck });
const targets = (): [Target, Target] => [
  { fig: fig(0), judge: "drawn" },
  { fig: fig(1), judge: "drawn" },
];

function play(match: ReturnType<typeof createMatch>, from: number, to: number, each?: (now: number) => void) {
  const out: MatchEvent[] = [];
  for (let now = from; now <= to; now += 16) {
    each?.(now);
    out.push(...match.step(now, targets(), [null, null]));
  }
  return out;
}

describe("the match", () => {
  it("serves both balls to the server; the second clock waits for the first throw", () => {
    const m = createMatch({ server: 0, countMs: 100 });
    m.start(0);
    play(m, 0, 200);
    expect(m.phase()).toBe("play");
    expect(m.players()[0].held).toHaveLength(2);
    expect(m.players()[1].held).toHaveLength(0);
    expect(m.clocks(0, 1200)[1]).toBe(1);
    expect(m.release(0, 1200)).toBe(true);
    // The second must wait a second after the first.
    expect(m.release(0, 1700)).toBe(false);
    expect(m.clocks(0, 1700)[0]).toBeLessThan(1);
    expect(m.release(0, 2300)).toBe(true);
    expect(m.release(1, 2300)).toBe(false);
  });

  it("a ball held too long drops on its holder, then goes to the other player", () => {
    const m = createMatch({ server: 0, countMs: 0, balls: 1 });
    m.start(0);
    const ev = play(m, 0, 9000);
    expect(ev.some((e) => e.kind === "self-lob" && e.who === 0)).toBe(true);
    // Standing still under it: it lands on his head.
    expect(ev.some((e) => e.kind === "damage" && e.who === 0)).toBe(true);
    expect(m.players()[1].held.length).toBe(1);
  });

  it("thrown balls that hit cost hearts: head 2, chest 1, and come to the one hit", () => {
    const m = createMatch({ server: 1, countMs: 0, balls: 1 });
    m.start(0);
    play(m, 0, 50);
    const shooter = standardFigure({ x: FIELD.laneMiddle, toward: -1, sling: { angle: 55, draw: 1 } }).j[JOINT.L_WRIST];
    const sol = solveLaunch(shooter, fig(0).head.c, "fast")!;
    expect(m.release(1, 100)).toBe(true);
    m.throwBall(1, launch(shooter, -1, sol.angle, sol.speed, 100));
    const ev = play(m, 116, 3000);
    const dmg = ev.find((e) => e.kind === "damage");
    expect(dmg && dmg.kind === "damage" && dmg.zone).toBe("head");
    expect(m.players()[0].hearts).toBe(RULES.hearts - 2);
    expect(m.players()[0].held.length).toBe(1);
  });

  it("the squeeze takes the lanes' back edges at 40 and 50 s and the round ends at 75 s", () => {
    const m = createMatch({ server: 0, countMs: 0, balls: 1 });
    m.start(0);
    // Keep throwing the ball away so no clock runs out on anyone's head.
    const ev = play(m, 0, 76_000, (now) => {
      for (const who of [0, 1] as const)
        if (m.canThrow(who, now)) {
          m.release(who, now);
          m.throwBall(who, launch({ x: who === 0 ? -0.9 : 0.9, y: 1.4 }, who === 0 ? 1 : -1, 66, 2.3, now));
        }
    });
    expect(ev.filter((e) => e.kind === "squeeze")).toHaveLength(2);
    const end = ev.find((e) => e.kind === "round-end");
    expect(end && end.kind === "round-end" && end.how).toBe("time");
    expect(m.phase()).toBe("rest");
    // The loser serves next.
    expect(m.server()).toBe(end && end.kind === "round-end" ? 1 - end.winner : -1);
  });
});

describe("the bots", () => {
  it("the perfect defender finds a spot every plain ball misses, and gets there", () => {
    const body = createBotBody(-FIELD.laneMiddle, 1);
    const shooterBody = createBotBody(FIELD.laneMiddle, -1);
    let hits = 0;
    for (const kind of ["fast", "middle", "lob"] as const)
      for (const zone of ["head", "chest"] as const) {
        const shot = aimShot(shooterBody, body.figure(0), { kind, zone, lead: 0, now: 0, drawS: 0, holdS: 0 })!;
        expect(shot).not.toBeNull();
        const f = botLaunch(shooterBody, shot, 0);
        const plan = planDodge(f, 300, { x: -FIELD.laneMiddle, duck: 0 }, [-FIELD.laneMiddle - 0.5, -FIELD.laneMiddle + 0.5], 1);
        expect(plan).not.toBeNull();
        // Walk the plan and check the ball misses.
        const def = createDefender("wall");
        const b = createBotBody(-FIELD.laneMiddle, 1);
        let hit = false;
        for (let now = 0; now < 2500; now += 16) {
          const inc: Incoming[] = [{ id: 1, flight: f, seenAt: 0, fan: shot.fan }];
          def.update(now, b, inc, [-FIELD.laneMiddle - 0.5, -FIELD.laneMiddle + 0.5]);
          b.step(0.016, [-FIELD.laneMiddle - 0.5, -FIELD.laneMiddle + 0.5]);
          const s = (now - f.t0) / 1000;
          const q = { x: f.from.x + f.vx * s, y: f.from.y + f.vy * s - 1.75 * s * s };
          if (overlap(b.figure(now), q)) hit = true;
        }
        if (hit) hits++;
      }
    // A visible plain ball, read 0.3 s after release: the wall bot escapes nearly all.
    expect(hits).toBeLessThanOrEqual(1);
  });
});
