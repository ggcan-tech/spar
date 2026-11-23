import { describe, expect, it } from "vitest";
import { createSessionLog, parseSession } from "../pov/sessionLog";
import { syntheticFrame } from "../pov/syntheticBody";
import { replaySession } from "./replay";
import { boxDemoMotion } from "./scriptedBoxer";

describe("playing a saved boxing session back", () => {
  it("reads the same punches from the saved landmarks as were thrown, and counts what the game noted", () => {
    const log = createSessionLog(240_000);
    // The scripted boxer's demo, saved as a real session would be.
    for (let t = 1000; t < 1000 + 20_000; t += 1000 / 30) {
      log.frame(syntheticFrame(t, boxDemoMotion((t - 1000) / 1000)), t + 60);
    }
    log.note(5000, { n: 1, ev: "punch", hand: "left", shape: "straight", target: "head" });
    log.note(5400, { n: 2, ev: "punch", hand: "left", shape: "straight", target: "head" });
    log.note(6000, { n: 3, ev: "landed" });
    // Through the file format and back.
    const session = parseSession(JSON.stringify(log.save()));
    const replay = replaySession(session);
    expect(replay.tracked).toBeGreaterThan(0.85);
    // One loop of the routine: eleven punches, each started before it was confirmed.
    expect(replay.punches.map((p) => `${p.hand[0]}${p.shape[0]}`).join(" ")).toBe(
      "ls ls rs lh ru ls rs ls rs lh rh",
    );
    expect(replay.starts.length).toBeGreaterThanOrEqual(replay.punches.length);
    // The opening cover-up, and the blocks near the end of the loop.
    expect(replay.covered).toBeGreaterThan(1);
    expect(replay.low).toBeGreaterThan(0.2);
    expect(replay.noted).toEqual({ punch: 2, landed: 1 });
    expect(replay.seconds).toBeCloseTo(20, 0);
  });
});
