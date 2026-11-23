import { describe, expect, it } from "vitest";
import { BODY } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import type { FoePose } from "../opponentPose";
import type { Me3D } from "./body3d";
import { SIZE, coverOf, foeShape, sweep } from "./space";

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
/** An opponent standing square with its gloves by its chin, in its own frame. */
const standing = (over: Partial<FoePose> = {}): FoePose => ({
  head: v(0, 1.65, 0.05),
  chest: v(0, 1.4, 0.03),
  hips: v(0, 0.98, 0),
  shoulders: [v(-0.19, 1.42, 0.03), v(0.19, 1.42, 0.03)],
  gloves: [v(-0.11, 1.5, 0.28), v(0.11, 1.5, 0.28)],
  poles: [v(-0.15, -1, -0.1), v(0.15, -1, -0.1)],
  fallen: 0,
  loading: null,
  open: 0,
  turn: 0,
  lunge: 0,
  ...over,
});
const DOWN: Partial<FoePose> = { gloves: [v(-0.25, 1.0, 0.1), v(0.25, 1.0, 0.1)] };
/** The player's body with the gloves at the given places in the room. */
const me = (left: Vec3, right: Vec3, head = v(0, 1.65, 0.08)): Me3D => {
  const shoulders: [Vec3, Vec3] = [v(head.x - 0.19, head.y - 0.27, 0), v(head.x + 0.19, head.y - 0.27, 0)];
  const elbow = (g: Vec3, s: Vec3) => v((g.x + s.x) / 2, Math.min(g.y, s.y) - 0.15, (g.z + s.z) / 2);
  return {
    t: 0,
    head,
    hips: v(head.x * 0.3, 1, 0),
    shoulders,
    elbows: [elbow(left, shoulders[0]), elbow(right, shoulders[1])],
    wrists: [left, right],
    gloves: [left, right],
    seen: [true, true],
    solved: true,
    bones: { upperArm: BODY.upperArm, foreArm: BODY.foreArm },
    pointing: [0, 0],
  };
};

describe("real contact: the player's glove and the opponent", () => {
  it("lands on the head when the glove reaches it with its hands down, and says which side it caught", () => {
    const shape = foeShape(standing(DOWN), 0.95);
    // Straight down the middle from the guard to full reach.
    const hit = sweep(v(0.05, 1.5, 0.3), v(0.02, 1.62, 0.75), shape)!;
    expect(hit.what).toBe("head");
    expect(hit.grazed).toBe(0);
    // It stopped at the face, not past it: the head's middle is 0.90 away and the glove's middle is a head and a glove short of that.
    expect(hit.at.z).toBeGreaterThan(0.6);
    expect(hit.at.z).toBeLessThan(0.75);
    // Coming round to the player's left of the head lands on that side of it.
    const hook = sweep(v(-0.45, 1.6, 0.75), v(0.1, 1.62, 0.88), shape)!;
    expect(hook.what).toBe("head");
    expect(hook.off.x).toBeLessThan(-0.03);
  });
  it("does not reach from too far, and does from a step nearer: reach is the arm's, not a table's", () => {
    const from = v(0.05, 1.5, 0.3),
      to = v(0.02, 1.62, 0.75);
    expect(sweep(from, to, foeShape(standing(DOWN), 1.3))).toBeNull();
    expect(sweep(from, to, foeShape(standing(DOWN), 0.95))).not.toBeNull();
    // The same arm from a step in.
    expect(sweep(v(0.05, 1.5, 0.6), v(0.02, 1.62, 1.05), foeShape(standing(DOWN), 1.3))?.what).toBe("head");
  });
  it("meets its glove first when the glove is on the line, and comes round a guard to the head or under it to the body", () => {
    const shape = foeShape(standing(), 0.95);
    // Straight at its left glove (on the player's right).
    expect(sweep(v(0.11, 1.45, 0.3), v(0.11, 1.5, 0.75), shape)!.what).toBe("glove");
    // Round the outside, at ear height: the head.
    expect(sweep(v(-0.5, 1.66, 0.8), v(-0.05, 1.66, 0.9), shape)!.what).toBe("head");
    // At rib height an elbow is in the way; lower and down the middle is the body.
    expect(sweep(v(0.05, 1.2, 0.3), v(0.02, 1.15, 0.85), shape)!.what).toBe("arm");
    expect(sweep(v(0, 1.1, 0.3), v(0, 1.05, 0.85), shape)!.what).toBe("body");
    // Between the gloves, brushing one: it gets through, partly.
    const split = sweep(v(0, 1.5, 0.3), v(0, 1.6, 0.8), foeShape(standing({ gloves: [v(-0.2, 1.5, 0.28), v(0.2, 1.5, 0.28)] }), 0.95))!;
    expect(split.what).toBe("head");
    expect(split.grazed).toBeGreaterThan(0);
    expect(split.grazed).toBeLessThan(1);
  });
  it("does not meet again what the glove is already resting against", () => {
    const shape = foeShape(standing(DOWN), 0.95);
    const first = sweep(v(0.02, 1.6, 0.4), v(0.02, 1.62, 0.75), shape)!;
    expect(sweep(first.at, v(first.at.x, first.at.y, first.at.z + 0.02), shape)).toBeNull();
  });
});

describe("real contact: its glove and the player's guard", () => {
  const chin = { x: 0.03, y: 1.54 };
  it("is kept out by a glove that is on the line, partly by one beside it, and not at all by hands that are down", () => {
    // A glove right where its glove arrives.
    expect(coverOf(me(v(-0.1, 1.5, 0.3), v(0.03, 1.54, 0.3)), chin, null, [false, false])).toBeGreaterThan(0.9);
    // Gloves by the chin, a hand's width either side: some of it.
    const beside = coverOf(me(v(-0.11, 1.46, 0.3), v(0.11, 1.46, 0.3)), chin, null, [false, false]);
    expect(beside).toBeGreaterThan(0.2);
    expect(beside).toBeLessThan(0.8);
    // Hands at the hips: nothing.
    expect(coverOf(me(v(-0.2, 1.0, 0.1), v(0.2, 1.0, 0.1)), chin, null, [false, false])).toBe(0);
    // The same glove on the line, but out punching: it keeps out nothing, and what is left is the other glove beside the line.
    const other = coverOf(me(v(-0.1, 1.5, 0.3), v(0.03, 1.54, 0.3)), chin, null, [false, true]);
    expect(other).toBeGreaterThan(0.2);
    expect(other).toBeLessThan(0.6);
  });
  it("stops a hook with the glove on that side of the head, and not with the other", () => {
    // Its left hook comes round from the player's right.
    const from = { x: chin.x + 0.32, y: chin.y };
    expect(coverOf(me(v(-0.11, 1.46, 0.3), v(0.16, 1.56, 0.25)), chin, from, [false, false])).toBeGreaterThan(0.9);
    expect(coverOf(me(v(-0.16, 1.56, 0.25), v(0.3, 1.1, 0.2)), chin, from, [false, false])).toBeLessThan(0.3);
  });
  it("uses sizes a glove really has", () => {
    expect(SIZE.glove + SIZE.mine).toBeCloseTo(0.19, 2);
  });
});
