import { describe, expect, it } from "vitest";
import { JOINT } from "../pov/body";
import { createArena, laneSpan, type ArenaEvent, type Target } from "./arena";
import { p2, standardFigure, type Figure } from "./body";
import { at, fanOf, launch, launchAngle, solveLaunch, timeToX, wallCrossing } from "./flight";
import { gaps, judge, overlap, sweep } from "./hit";
import { FIELD, SLING, ZONES } from "./tune";

/** The right-lane shooter's sling hand on the standard figure, aiming at the left lane. */
const shooter = (angle = 52) => standardFigure({ x: FIELD.laneMiddle, toward: -1, sling: { angle, draw: 1 } }).j[JOINT.L_WRIST];
const dodger = (x = -FIELD.laneMiddle, duck = 0) => standardFigure({ x, toward: 1, duck });

function runArena(shots: { angle: number; speed: number; dark?: boolean; from?: ReturnType<typeof shooter> }[], target: Target | ((now: number) => Target), ms = 3000) {
  const arena = createArena();
  const events: ArenaEvent[] = [];
  for (const s of shots) arena.launch(1, launch(s.from ?? shooter(s.angle), -1, s.angle, s.speed, 0), { dark: s.dark });
  for (let now = 0; now <= ms; now += 16) {
    const t = typeof target === "function" ? target(now) : target;
    events.push(...arena.step(now, [t, null]));
  }
  return { arena, events };
}

describe("flight and the wall", () => {
  it("a natural point gives the flattest legal ball, and it clears the wall at full power", () => {
    expect(launchAngle(SLING.ownLevel)).toBe(SLING.angleMin);
    const f = launch(shooter(SLING.angleMin), -1, SLING.angleMin, SLING.speedMax, 0);
    expect(wallCrossing(f)!.over).toBe(true);
    // A weak flat ball meets the wall: pull further.
    expect(wallCrossing(launch(shooter(SLING.angleMin), -1, SLING.angleMin, SLING.speedMin, 0))!.over).toBe(false);
  });

  it("fast balls reach a head at the lane middle in about 1.2 s, lobs in about 1.6 s", () => {
    const head = dodger().head.c;
    const fast = solveLaunch(shooter(50), head, "fast")!;
    const lob = solveLaunch(shooter(62), head, "lob")!;
    expect(fast.seconds).toBeGreaterThan(1.05);
    expect(fast.seconds).toBeLessThan(1.35);
    expect(lob.seconds).toBeGreaterThan(1.45);
    expect(fanOf(fast.angle)).toBe("flat");
    expect(fanOf(lob.angle)).toBe("high");
  });

  it("every ball comes down steeply at the far lane: nothing crosses the chest flat", () => {
    for (let a = SLING.angleMin; a <= SLING.angleMax; a += 2)
      for (let v = SLING.speedMin; v <= SLING.speedMax; v += 0.2) {
        const f = launch(shooter(a), -1, a, v, 0);
        if (!wallCrossing(f)?.over) continue;
        const s = timeToX(f, -FIELD.laneMiddle);
        if (s === null) continue;
        const p = at(f, s);
        if (p.y < 0.5) continue;
        const descent = Math.atan2(-(f.vy - 3.5 * s), Math.abs(f.vx)) * (180 / Math.PI);
        expect(descent).toBeGreaterThan(25);
      }
  });
});

describe("hits", () => {
  it("zones are what is drawn: head disc and chest plate; arms never count", () => {
    const f = dodger();
    expect(overlap(f, f.head.c)).toBe("head");
    expect(overlap(f, p2((f.chest.x0 + f.chest.x1) / 2, (f.chest.y0 + f.chest.y1) / 2))).toBe("chest");
    const hand = f.j[JOINT.L_WRIST];
    expect(overlap(f, p2(hand.x - 0.12, hand.y))).toBeNull();
    expect(gaps(f, p2(f.head.c.x, f.head.c.y + 0.2)).head).toBeCloseTo(0.2 - ZONES.headRadius - ZONES.ball, 5);
  });

  it("a swept ball cannot pass through a head between two frames", () => {
    const f = dodger();
    const a = p2(f.head.c.x + 0.4, f.head.c.y + 0.05),
      b = p2(f.head.c.x - 0.4, f.head.c.y - 0.05);
    expect(sweep(f, a, b)?.zone).toBe("head");
  });

  it("an aimed ball hits a still dodger, and the ball is his", () => {
    const from = shooter(52);
    const sol = solveLaunch(from, dodger().head.c, "fast")!;
    const { events } = runArena([{ angle: sol.angle, speed: sol.speed, from }], { fig: dodger(), judge: "drawn" });
    const hit = events.find((e) => e.kind === "hit");
    expect(hit && hit.kind === "hit" && hit.zone).toBe("head");
    expect(hit && hit.kind === "hit" && hit.ball.owner).toBe(0);
  });

  it("a duck under a head ball is a close call, not a hit", () => {
    const from = shooter(52);
    const sol = solveLaunch(from, dodger().head.c, "fast")!;
    // Duck 25 cm just before it arrives.
    const { events } = runArena([{ angle: sol.angle, speed: sol.speed, from }], (now) => ({ fig: dodger(-FIELD.laneMiddle, now > 400 ? 0.25 : 0), judge: "drawn" }));
    expect(events.some((e) => e.kind === "hit")).toBe(false);
    const close = events.find((e) => e.kind === "close");
    expect(close).toBeTruthy();
  });

  it("rule D: a touch the real body had already left slides off; one it was still in counts", () => {
    const from = shooter(52);
    const sol = solveLaunch(from, dodger().head.c, "fast")!;
    const still: Target = { fig: dodger(), judge: "rule-d", cap: 0, later: () => dodger() };
    expect(runArena([{ angle: sol.angle, speed: sol.speed, from }], still).events.some((e) => e.kind === "hit")).toBe(true);
    // The drawn figure is still there, but the body 80 ms later has ducked away.
    const gone: Target = { fig: dodger(), judge: "rule-d", cap: 0, later: () => dodger(-FIELD.laneMiddle, 0.3) };
    const ev = runArena([{ angle: sol.angle, speed: sol.speed, from }], gone).events;
    expect(ev.some((e) => e.kind === "hit")).toBe(false);
    expect(ev.some((e) => e.kind === "slide")).toBe(true);
  });

  it("rule D waits for the later pose, then gives up and lets the drawn touch stand", () => {
    const pending = { ball: 1, zone: "head" as const, at: dodger().head.c, cap: 0, drawnAt: 1000 };
    expect(judge(pending, null, 1100).kind).toBe("wait");
    expect(judge(pending, null, 1300).kind).toBe("hit");
  });

  it("a dark ball is hidden from its receiver until it clears the wall, never from its thrower", () => {
    const arena = createArena();
    const b = arena.launch(1, launch(shooter(52), -1, 56, 3.2, 0), { dark: true });
    arena.step(100, [null, null]);
    expect(arena.visibleTo(b, 0)).toBe(false);
    expect(arena.visibleTo(b, 1)).toBe(true);
    for (let now = 100; now < 900; now += 16) arena.step(now, [null, null]);
    expect(arena.visibleTo(b, 0)).toBe(true);
  });

  it("a ball into the wall goes to the one it was thrown at; a landed ball can be picked up", () => {
    const { arena, events } = runArena([{ angle: SLING.angleMin, speed: SLING.speedMin }], { fig: dodger(), judge: "drawn" });
    const down = events.find((e) => e.kind === "down");
    expect(down && down.kind === "down" && down.inLane).toBe(false);
    expect(arena.pickups(5000, 0, null)).toHaveLength(1);
    expect(arena.pickups(5000, 1, null)).toHaveLength(0);
  });

  it("lane spans lose their back edge in the squeeze", () => {
    expect(laneSpan(0)).toEqual([-FIELD.laneMiddle - 0.5, -FIELD.laneMiddle + 0.5]);
    const [x0, x1] = laneSpan(0, 0.3);
    expect(x0).toBeCloseTo(-FIELD.laneMiddle - 0.2);
    expect(x1).toBeCloseTo(-FIELD.laneMiddle + 0.5);
    const [r0, r1] = laneSpan(1, 0.3);
    expect(r0).toBeCloseTo(FIELD.laneMiddle - 0.5);
    expect(r1).toBeCloseTo(FIELD.laneMiddle + 0.2);
  });
});

export type { Figure };
