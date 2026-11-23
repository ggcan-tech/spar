import { describe, expect, it } from "vitest";
import {
  createBannerLatch,
  framingOf,
  outcomeWord,
  selectBanner,
  type Banner,
  type BannerFacts,
} from "./banner";

const facts = (over: Partial<BannerFacts> = {}): BannerFacts => ({
  camera: "live",
  bodySeen: true,
  missing: [],
  calibrating: false,
  calibrated: true,
  progress: 1,
  running: true,
  valid: true,
  gate: "live",
  result: null,
  ownsBall: false,
  aiming: false,
  handLost: false,
  nearEdge: false,
  ...over,
});
const text = (over: Partial<BannerFacts>) => selectBanner(facts(over))?.text;

describe("which words fill the stage", () => {
  it("walks a new player from the screen to the first ball", () => {
    expect(text({ camera: "off" })).toBeUndefined();
    expect(text({ camera: "starting" })).toBe("LOADING");
    const far = selectBanner(
      facts({ calibrated: false, bodySeen: true, missing: ["hips"] }),
    )!;
    expect(far.text).toBe("STEP BACK");
    expect(far.sub).toBe("Show your hips");
    expect(text({ calibrated: false, bodySeen: false })).toBe("STEP BACK");
    const setup = selectBanner(
      facts({ calibrated: false, calibrating: true, progress: 0.47 }),
    )!;
    expect([setup.text, setup.sub]).toEqual(["HOLD STILL", "47%"]);
    expect(text({ running: false, gate: "idle" })).toBe("RAISE A HAND");
    expect(text({ gate: "get-in-place" })).toBe("FIND YOUR SPOT");
    // The count is a large number of its own.
    expect(text({ gate: "counting" })).toBeUndefined();
    // A ball in the air: nothing in the way.
    expect(text({})).toBeUndefined();
  });

  it("tells the player the ball is theirs and how to throw it, then steps aside", () => {
    expect(text({ ownsBall: true })).toBe("YOUR BALL");
    expect(text({ ownsBall: true, handLost: true })).toBe("SHOW YOUR HAND");
    const aiming = selectBanner(facts({ ownsBall: true, aiming: true }))!;
    expect(aiming.text).toBe("THROW");
    expect(aiming.ttlMs).toBeLessThan(1500);
  });

  it("puts blocking states above everything else", () => {
    expect(text({ valid: false, ownsBall: true })).toBe("PAUSED");
    expect(text({ result: "won", valid: false })).toBe("YOU WIN");
    expect(text({ result: "lost" })).toBe("YOU LOSE");
    expect(text({ nearEdge: true })).toBe("BACK TO MIDDLE");
    expect(text({ nearEdge: true, ownsBall: true })).toBe("YOUR BALL");
    expect(text({ network: "Waiting for the other player" })).toBe("WAITING");
  });

  it("tells the player why a throw did not register", () => {
    expect(text({ ownsBall: true, aiming: true, hint: "too-soft" })).toBe(
      "THROW HARDER",
    );
    expect(text({ ownsBall: true, hint: "hand-low" })).toBe("HAND HIGHER");
    // Only while the ball is theirs.
    expect(text({ hint: "too-soft" })).toBeUndefined();
  });

  it("counts down the last three seconds of the shot clock", () => {
    expect(text({ ownsBall: true, clock: 8 })).toBe("YOUR BALL");
    const late = selectBanner(
      facts({ ownsBall: true, aiming: true, clock: 2.4 }),
    )!;
    expect([late.text, late.sub]).toEqual(["THROW NOW", "3"]);
    expect(selectBanner(facts({ ownsBall: true, clock: 0.2 }))!.sub).toBe("1");
    // Not the player's ball: no clock.
    expect(text({ clock: 1 })).toBeUndefined();
  });

  it("sums up the round with its result", () => {
    const won = selectBanner(
      facts({ result: "won", summary: "Dodged 3 of 7 · landed 5 of 6" }),
    )!;
    expect(won.sub).toBe(
      "Dodged 3 of 7 · landed 5 of 6 · Raise a hand to play again",
    );
    expect(selectBanner(facts({ result: "lost", calibrated: true }))!.sub).toBe(
      "Raise a hand to play again",
    );
  });

  it("says why the camera did not start, where the player can read it", () => {
    expect(text({ camera: "off", problem: "denied" })).toBe("CAMERA BLOCKED");
    expect(text({ camera: "off", problem: "in-use" })).toBe("CAMERA BUSY");
    expect(text({ camera: "off", problem: "not-found" })).toBe("NO CAMERA");
    expect(
      selectBanner(facts({ camera: "off", problem: "unknown" }))!.sub,
    ).toMatch(/try again/);
    expect(text({ camera: "off", problem: null })).toBeUndefined();
  });

  it("guides the player to the middle of the picture before setup settles", () => {
    // The picture is not mirrored: its left is the player's right.
    expect(framingOf(0.2, 0.15)).toBe("move-left");
    expect(framingOf(0.8, 0.15)).toBe("move-right");
    expect(framingOf(0.5, 0.05)).toBe("come-closer");
    expect(framingOf(0.5, 0.15)).toBe("ok");
    expect(framingOf(null, null)).toBe("no-body");
    expect(
      text({ calibrated: false, calibrating: true, framing: "move-left" }),
    ).toBe("MOVE LEFT");
    expect(text({ calibrated: false, framing: "come-closer" })).toBe(
      "COME CLOSER",
    );
    expect(text({ calibrated: false, calibrating: true, framing: "ok" })).toBe(
      "HOLD STILL",
    );
    // Once set up, framing advice gives way to play.
    expect(text({ framing: "move-left" })).toBeUndefined();
  });

  it("never uses more than three words", () => {
    const every: Partial<BannerFacts>[] = [
      { camera: "starting" },
      { calibrated: false },
      { calibrated: false, calibrating: true },
      { running: false },
      { valid: false },
      { gate: "get-in-place" },
      { ownsBall: true },
      { ownsBall: true, handLost: true },
      { ownsBall: true, aiming: true },
      { nearEdge: true },
      { result: "won" },
      { result: "lost" },
      { network: "x" },
    ];
    for (const over of every)
      expect(text(over)!.split(" ").length).toBeLessThanOrEqual(3);
  });
});

describe("keeping the words steady", () => {
  const turn: Banner = { text: "YOUR BALL", tone: "turn", tier: 2 };
  const warn: Banner = { text: "BACK TO MIDDLE", tone: "warn", tier: 1 };
  const block: Banner = { text: "PAUSED", tone: "paused", tier: 4 };

  it("shows a more urgent message at once", () => {
    const latch = createBannerLatch();
    expect(latch.update(warn, 0)?.text).toBe("BACK TO MIDDLE");
    expect(latch.update(block, 16)?.text).toBe("PAUSED");
  });

  it("does not flicker between two messages that alternate frame to frame", () => {
    const latch = createBannerLatch();
    latch.update(turn, 0);
    const seen = new Set<string | undefined>();
    for (let now = 16; now < 2000; now += 16)
      seen.add(latch.update((now / 16) % 2 ? warn : turn, now)?.text);
    expect([...seen]).toEqual(["YOUR BALL"]);
  });

  it("lets a lesser message in only after the current one has had its time and the new one has settled", () => {
    const latch = createBannerLatch();
    latch.update(block, 0);
    expect(latch.update(turn, 100)?.text).toBe("PAUSED");
    expect(latch.update(turn, 800)?.text).toBe("PAUSED");
    expect(latch.update(turn, 950)?.text).toBe("YOUR BALL");
  });

  it("clears a message whose cause went away, after the same wait", () => {
    const latch = createBannerLatch();
    latch.update(turn, 0);
    expect(latch.update(null, 100)?.text).toBe("YOUR BALL");
    expect(latch.update(null, 1000)).toBeNull();
  });

  it("shows a timed message once and keeps it away while its cause lasts", () => {
    const latch = createBannerLatch();
    const go: Banner = { text: "THROW", tone: "turn", tier: 2, ttlMs: 900 };
    expect(latch.update(go, 0)?.text).toBe("THROW");
    expect(latch.update(go, 800)?.text).toBe("THROW");
    expect(latch.update(go, 950)).toBeNull();
    expect(latch.update(go, 5000)).toBeNull();
    // The cause changes and comes back: it may be said again.
    latch.update(turn, 5016);
    latch.update(turn, 6200);
    latch.update(go, 7200);
    expect(latch.update(go, 7500)?.text).toBe("THROW");
  });
});

describe("the word for how a ball ended", () => {
  it("names the player's success and failure differently", () => {
    expect(outcomeWord("hit", true)).toBe("BODY HIT");
    expect(outcomeWord("hit", false)).toBe("GOT THEM");
    expect(outcomeWord("hit", false, true)).toBe("HEADSHOT");
    expect(outcomeWord("hit", true, true)).toBe("HEAD HIT");
    expect(outcomeWord("floor", true)).toBe("DODGED");
    expect(outcomeWord("out", true)).toBe("DODGED");
    expect(outcomeWord("floor", false)).toBe("MISSED");
  });
});

describe("what the stage says when the cause is not the player's place", () => {
  it("asks for light when the picture is dark, instead of telling the player to move", () => {
    const dark = selectBanner(
      facts({ calibrated: false, bodySeen: false, dim: true }),
    )!;
    expect(dark.text).toBe("MORE LIGHT");
    expect(dark.tone).toBe("warn");
    // Setup that is getting somewhere is left alone.
    expect(text({ calibrated: false, calibrating: true, dim: true })).toBe(
      "HOLD STILL",
    );
    // Where to stand still comes first: it is the quicker fix.
    expect(text({ calibrated: false, framing: "move-left", dim: true })).toBe(
      "MOVE LEFT",
    );
    expect(selectBanner(facts({ valid: false, dim: true }))!.sub).toContain(
      "dark",
    );
    // In a round that is going fine, nothing is said.
    expect(text({ dim: true })).toBeUndefined();
  });
  it("says what is loading, when too close, and when tracking did not load", () => {
    expect(
      selectBanner(facts({ camera: "starting", loading: "Opening camera…" }))!
        .sub,
    ).toBe("Opening camera…");
    expect(text({ calibrated: false, framing: "step-back" })).toBe("STEP BACK");
    expect(framingOf(0.5, 0.5)).toBe("step-back");
    const failed = selectBanner(facts({ camera: "off", problem: "model" }))!;
    expect(failed.text).toBe("TRACKING DID NOT LOAD");
  });
});
