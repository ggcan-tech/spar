import { describe, expect, it } from "vitest";
import { LM, type Landmark } from "@spar/protocol";
import { createRaiseHand, createStartGate, type GateFacts } from "./startGate";

const facts = (now: number, over: Partial<GateFacts> = {}): GateFacts => ({
  now,
  running: true,
  over: false,
  valid: true,
  inPlace: true,
  ...over,
});
/** Run the gate every 16 ms from `from` to `to`, collecting what it said. */
function run(
  gate: ReturnType<typeof createStartGate>,
  from: number,
  to: number,
  over: Partial<GateFacts> = {},
) {
  const cues: string[] = [],
    counts: number[] = [];
  let state = gate.update(facts(from, over));
  for (let now = from; now <= to; now += 16) {
    state = gate.update(facts(now, over));
    if (state.cue) cues.push(state.cue);
    if (state.count !== null && counts.at(-1) !== state.count)
      counts.push(state.count);
  }
  return { state, cues, counts };
}

describe("when the round clock may run", () => {
  it("stays shut until the player has stood in place, then counts 3-2-1 and opens", () => {
    const gate = createStartGate();
    expect(gate.update(facts(0)).live).toBe(false);
    expect(run(gate, 0, 580).state.phase).toBe("get-in-place");
    const count = run(gate, 596, 2380);
    expect(count.counts).toEqual([3, 2, 1]);
    expect(count.cues).toEqual(["tick", "tick", "tick"]);
    expect(count.state.live).toBe(false);
    const open = run(gate, 2396, 2500);
    expect(open.cues).toEqual(["go"]);
    expect(open.state).toMatchObject({ live: true, phase: "live" });
  });

  it("does not start while the player is still walking to their spot", () => {
    const gate = createStartGate();
    expect(run(gate, 0, 5000, { inPlace: false }).state).toMatchObject({
      live: false,
      phase: "get-in-place",
    });
    // Tracked but not yet in the middle is the same.
    expect(run(gate, 5016, 6000, { valid: true, inPlace: false }).cues).toEqual(
      [],
    );
  });

  it("starts the count again if the player moves away during it", () => {
    const gate = createStartGate();
    run(gate, 0, 1300);
    expect(gate.update(facts(1316, { inPlace: false })).phase).toBe(
      "get-in-place",
    );
    const again = run(gate, 1332, 3800);
    expect(again.counts).toEqual([3, 2, 1]);
    expect(again.state.live).toBe(true);
  });

  it("rides out a short loss of tracking without a count", () => {
    const gate = createStartGate();
    run(gate, 0, 2600);
    expect(
      run(gate, 2616, 2950, { valid: false, inPlace: false }).state.live,
    ).toBe(true);
    const back = run(gate, 2966, 3200);
    expect(back.state.live).toBe(true);
    expect(back.cues).toEqual([]);
  });

  it("comes back from a real interruption with a short count", () => {
    const gate = createStartGate();
    run(gate, 0, 2600);
    expect(
      run(gate, 2616, 3300, { valid: false, inPlace: false }).state.live,
    ).toBe(false);
    const back = run(gate, 3316, 5000);
    expect(back.counts).toEqual([2, 1]);
    expect(back.cues).toEqual(["tick", "tick", "go"]);
    expect(back.state.live).toBe(true);
  });

  it("shuts when the player pauses or the round ends, and starts the next round with a full count", () => {
    const gate = createStartGate();
    run(gate, 0, 2600);
    expect(gate.update(facts(2616, { running: false }))).toMatchObject({
      live: false,
      phase: "idle",
    });
    expect(run(gate, 2632, 5200).counts).toEqual([3, 2, 1]);
    expect(gate.update(facts(5216, { over: true })).live).toBe(false);
  });
});

describe("raised hand as start", () => {
  const body = (wristY: number, visible = 0.95): Landmark[] => {
    const lm = Array.from({ length: 33 }, () => ({
      x: 0.5,
      y: 0.6,
      z: 0,
      v: 0.95,
    }));
    lm[LM.NOSE] = { x: 0.5, y: 0.3, z: 0, v: 0.95 };
    lm[LM.R_WRIST] = { x: 0.4, y: wristY, z: 0, v: visible };
    return lm;
  };
  it("fires once after a wrist is held above the nose, and needs the hand lowered to fire again", () => {
    const raise = createRaiseHand();
    expect(raise.update(body(0.2), 0)).toBe(false);
    expect(raise.update(body(0.2), 700)).toBe(false);
    expect(raise.update(body(0.2), 810)).toBe(true);
    expect(raise.update(body(0.2), 2000)).toBe(false);
    expect(raise.update(body(0.5), 2016)).toBe(false);
    expect(raise.update(body(0.2), 2032)).toBe(false);
    expect(raise.update(body(0.2), 2840)).toBe(true);
  });
  it("ignores a hand at head height, a brief raise and an unseen wrist", () => {
    const raise = createRaiseHand();
    expect(raise.update(body(0.29), 0)).toBe(false);
    expect(raise.update(body(0.29), 2000)).toBe(false);
    expect(raise.update(body(0.2), 2016)).toBe(false);
    expect(raise.update(body(0.5), 2400)).toBe(false);
    expect(raise.update(body(0.2, 0.3), 2416)).toBe(false);
    expect(raise.update(body(0.2, 0.3), 4000)).toBe(false);
    expect(raise.update(undefined, 4016)).toBe(false);
  });
});
