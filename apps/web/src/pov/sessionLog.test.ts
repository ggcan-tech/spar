import { describe, expect, it } from "vitest";
import { createSessionLog, parseSession, playbackFrame } from "./sessionLog";
import { demoMotion, syntheticFrame } from "./syntheticBody";
import { createPovTracker } from "./tracking";

describe("saving a tracking session", () => {
  it("keeps only the last minute of frames and the state at its start", () => {
    const log = createSessionLog(60_000);
    for (let t = 0; t <= 100_000; t += 1000) {
      log.frame(syntheticFrame(t), t + 40);
      if (t % 20_000 === 0) log.note(t, { phase: `p${t / 20_000}` });
    }
    const saved = log.save();
    expect(saved.frames[0].at).toBeGreaterThanOrEqual(40_040);
    expect(saved.frames.at(-1)!.t).toBe(100_000);
    // The note in force when the window opens is kept, then the later ones.
    expect(saved.notes.map((n) => n.phase)).toEqual(["p2", "p3", "p4", "p5"]);
  });

  it("writes a note only when the game's state changes", () => {
    const log = createSessionLog();
    for (let now = 0; now < 1000; now += 16)
      log.note(now, {
        calibrated: now >= 500,
        reason: now < 500 ? "calibrating" : null,
      });
    expect(log.size().notes).toBe(2);
  });

  it("plays back through the tracker to the same result the game had live", () => {
    const live = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    const log = createSessionLog();
    const liveResults: {
      x: number;
      y: number;
      valid: boolean;
      hand: number;
    }[] = [];
    for (let i = 0; i < 300; i++) {
      const t = 1000 + i * 33;
      const frame = syntheticFrame(t, demoMotion(i * 0.033));
      log.frame(frame, t + 45);
      const r = live.update(frame, t + 45);
      liveResults.push({
        x: r.root.x,
        y: r.head.y,
        valid: r.valid,
        hand: r.rightHand.z,
      });
    }
    const saved = parseSession(JSON.stringify(log.save()));
    expect(saved.frames).toHaveLength(300);
    const replay = createPovTracker({
      automatic: true,
      scaleMode: "body-relative",
    });
    saved.frames.forEach((recorded, i) => {
      const r = replay.update(playbackFrame(recorded), recorded.at);
      expect(r.valid).toBe(liveResults[i].valid);
      // Positions are saved to a tenth of a millimetre of image; the tracker's
      // output agrees to well under a centimetre.
      expect(Math.abs(r.root.x - liveResults[i].x)).toBeLessThan(0.005);
      expect(Math.abs(r.head.y - liveResults[i].y)).toBeLessThan(0.005);
      expect(Math.abs(r.rightHand.z - liveResults[i].hand)).toBeLessThan(0.005);
    });
  });

  it("carries device facts and refuses a file that is not a session", () => {
    const log = createSessionLog();
    log.describe({ camera: "1280x720@30", model: "lite" });
    log.frame(syntheticFrame(10), 20);
    expect(log.save().meta).toEqual({ camera: "1280x720@30", model: "lite" });
    expect(() => parseSession("{}")).toThrow();
    expect(() =>
      parseSession(
        JSON.stringify({
          version: 1,
          frames: [{ t: 1, at: 2, lm: [1], w: [] }],
          notes: [],
        }),
      ),
    ).toThrow();
    log.clear();
    expect(log.size()).toEqual({ frames: 0, notes: 0 });
  });
});
