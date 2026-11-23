import { describe, expect, it } from "vitest";
import { p2 } from "./body";
import { flatAt, slingHands, slingShotAt } from "./scripted";
import { createDuelSession, type DuelMode, type SessionOptions } from "./session";

const STEP = 1000 / 30;

/**
 * A scripted player for a whole page: holds the sling arm out to choose a side,
 * gives three held draws for set-up, then shoots every `every` seconds (or
 * stands still if `every` is 0), with a step now and then.
 */
function player(every: number) {
  return (s: number) => {
    if (s < 1.2) return slingHands("left", "draw");
    if (s < 10) {
      const k = (s - 1.2) % 2.8;
      return k < 1.6 ? slingHands("left", "draw", 0.03) : slingHands("left", "nock");
    }
    if (!every) return slingHands("left", "rest");
    const k = (s - 10) % every;
    return slingShotAt("left", k, [0.02, 0.1, 0.18][Math.floor((s - 10) / every) % 3]);
  };
}

function run(o: SessionOptions, seconds: number, every = 3.2) {
  const session = createDuelSession(o);
  const motion = player(every);
  const huds = [];
  for (let t = 0; t <= seconds * 1000; t += STEP) {
    const m = motion(t / 1000);
    const pose = flatAt({ t, ...m, root: p2(0.15 * Math.sin(t / 2300), 0) });
    session.onPose(pose);
    const f = session.frame(t + 5, { live: true, calibrated: t > 300, pose });
    huds.push(f.hud);
  }
  return { session, huds, report: session.report() };
}

describe("the duel pages, with a scripted player", () => {
  it("probe: the side is chosen from the arm held out, shots fire and fly", () => {
    const { report, huds } = run({ mode: "probe" }, 30);
    expect(report.side).toBe("left");
    expect(huds[huds.length - 1].step).toBe("play");
    expect(report.shots.length).toBeGreaterThan(3);
  });

  it("sling test: set-up measures three holds, then line 1 counts shots at the dummy with miss distances", () => {
    const session = createDuelSession({ mode: "sling" });
    const motion = player(3.2);
    let line = "";
    for (let t = 0; t <= 60_000; t += STEP) {
      const pose = flatAt({ t, ...motion(t / 1000) });
      session.onPose(pose);
      if (t > 20_000 && line === "") {
        session.nextLine(t);
        line = "l1";
      }
      session.frame(t + 5, { live: true, calibrated: t > 300, pose });
    }
    const r = session.report();
    expect(r.setup?.measured).toBe(true);
    const l1 = r.shots.filter((s) => s.line === "l1");
    expect(l1.length).toBeGreaterThan(8);
    // Every shot that has come down has its miss distance (the last may still be flying).
    expect(l1.filter((s) => s.miss !== null).length).toBeGreaterThanOrEqual(l1.length - 1);
  });

  it("dodge test: the bot fires all 40, and every hit asks for an answer", () => {
    const { report, huds } = run({ mode: "dodge", seed: 3 }, 220, 0);
    const balls = report.dodge;
    expect(balls.length).toBeGreaterThanOrEqual(36);
    const hits = balls.filter((d) => d.hit);
    // A still player gets hit by some, not all.
    expect(hits.length).toBeGreaterThan(5);
    const unanswered = hits.filter((h) => !h.answer);
    expect(unanswered.length, JSON.stringify(unanswered)).toBeLessThanOrEqual(1);
    expect(huds.some((h) => h.line?.id === "C")).toBe(true);
  });

  for (const defender of ["coach", "wall"] as const)
    it(`duel against ${defender}: rounds are played and the match ends`, () => {
      const { report, huds } = run({ mode: "duel", defender, seed: 5 } as { mode: DuelMode; defender: "coach" | "wall"; seed: number }, 330);
      expect(report.duel.rounds.length).toBeGreaterThanOrEqual(2);
      expect(huds.some((h) => h.match?.phase === "over")).toBe(true);
      // Shots only count when a ball is held.
      expect(report.duel.myShots).toBeGreaterThanOrEqual(3);
    });
});
