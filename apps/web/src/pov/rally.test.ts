import { describe, expect, it } from "vitest";
import {
  createRally,
  canRelease,
  ownsBall,
  launchBall,
  stepDuel,
  botThrow,
} from "./duel";
import { parseNetworkState } from "./networkState";

describe("one-ball rally possession", () => {
  it("waits for the opener, blocks simultaneous throws, then automatically gives the receiver the ball", () => {
    let s = createRally();
    expect(ownsBall(s, 1)).toBe(true);
    expect(canRelease(s, 1)).toBe(false);
    expect(ownsBall(s, 0)).toBe(false);
    for (let i = 0; i < 265; i++) s = stepDuel(s, s.poses);
    const shot = botThrow(s, "duel");
    s = launchBall(s, 1, shot);
    expect(s.rally?.phase).toBe("flight");
    expect(ownsBall(s, 1)).toBe(false);
    const blocked = launchBall(s, 0, { ...shot, origin: s.poses[0].rightHand });
    expect(blocked).toBe(s);
    for (let i = 0; i < 180; i++) s = stepDuel(s, s.poses);
    expect(s.hp).toEqual([4, 5]);
    expect(ownsBall(s, 0)).toBe(true);
    expect(canRelease(s, 0)).toBe(true);
    expect(ownsBall(s, 1)).toBe(false);
    expect(parseNetworkState(s)).toEqual(s);
  });
  it("hands possession over after a miss too, and never equips a ball after the final hit", () => {
    for (const finalHit of [false, true]) {
      let s = createRally(1, 0);
      if (finalHit) s.hp[0] = 1;
      const shot = botThrow(s, "duel");
      s = launchBall(s, 1, shot);
      if (!finalHit) {
        for (const key of ["head", "root", "leftHand", "rightHand"] as const)
          s.poses[0][key].x += 0.6;
      }
      for (let i = 0; i < 300; i++) s = stepDuel(s, s.poses);
      expect(ownsBall(s, 0)).toBe(!finalHit);
      expect(ownsBall(s, 1)).toBe(false);
    }
  });
  it("decodes possession as detached state and rejects impossible turn/ball combinations", () => {
    const s = createRally();
    const parsed = parseNetworkState(s)!;
    s.rally!.turn = 0;
    expect(parsed.rally!.turn).toBe(1);
    expect(
      parseNetworkState({
        ...s,
        rally: { turn: 2, phase: "ready", readyAt: 0 },
      }),
    ).toBeNull();
    expect(
      parseNetworkState({
        ...s,
        rally: { turn: 0, phase: "flight", readyAt: 0 },
      }),
    ).toBeNull();
    expect(
      parseNetworkState({
        ...s,
        rally: { turn: 0, phase: "ready", readyAt: Infinity },
      }),
    ).toBeNull();
  });
});
