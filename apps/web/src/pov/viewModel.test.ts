import { describe, expect, it } from "vitest";
import { VIEW_MODEL, keepInView, palm } from "./viewModel";

const TAN = Math.tan((58 * Math.PI) / 360),
  ASPECT = 1.1;
const inFrame = (p: { x: number; y: number; depth: number }) =>
  p.depth > 0 &&
  Math.abs(p.x) <= p.depth * TAN * ASPECT &&
  Math.abs(p.y) <= p.depth * TAN;

describe("keeping the player's own hand on screen", () => {
  it("leaves a hand that is already in front and in frame exactly where it is", () => {
    const hand = { x: 0.1, y: -0.2, depth: 1 };
    expect(keepInView(hand, TAN, ASPECT)).toEqual(hand);
  });

  it("brings a hand cocked beside or behind the head into the picture", () => {
    // Beside the right ear, 20 cm behind the eye: where a throw is aimed from.
    for (const hand of [
      { x: 0.3, y: 0.05, depth: -0.2 },
      { x: 0.35, y: 0.25, depth: 0 },
      { x: 0.15, y: 0.4, depth: 0.1 },
      { x: -0.4, y: 0.1, depth: -0.3 },
    ]) {
      expect(inFrame(hand)).toBe(false);
      const shown = keepInView(hand, TAN, ASPECT);
      expect(inFrame(shown)).toBe(true);
      expect(shown.depth).toBeGreaterThanOrEqual(VIEW_MODEL.near);
      // Still on the side it is really on.
      expect(Math.sign(shown.x)).toBe(Math.sign(hand.x));
    }
  });

  it("moves the drawn hand the same way the real hand moves", () => {
    let last = -Infinity;
    for (let x = -0.5; x <= 0.5; x += 0.05) {
      const shown = keepInView({ x, y: 0.1, depth: -0.1 }, TAN, ASPECT);
      expect(shown.x).toBeGreaterThanOrEqual(last);
      last = shown.x;
    }
  });

  it("puts the ball beyond the wrist along the forearm", () => {
    const at = palm({ x: 0, y: 0, z: 0 }, { x: 0, y: 0.25, z: 0 });
    expect(at.x).toBeCloseTo(0);
    expect(at.y).toBeCloseTo(0.38);
    // A degenerate forearm leaves the ball on the wrist.
    expect(palm({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })).toEqual({
      x: 1,
      y: 1,
      z: 1,
    });
  });
});
