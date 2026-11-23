import { describe, expect, it } from "vitest";
import type { AttackKind } from "./boxer";
import { RULES, createFight, type Foe } from "./fight";
import { SPINE, foePose, headForFoe } from "./opponentPose";

const target = headForFoe({ x: 0, y: 1.65, z: 0 });
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const base = (): Foe => createFight("contender").foe;
const attack = (kind: AttackKind, startAt: number, windup: number) => ({
  kind,
  hand: (kind === "cross" ? "right" : "left") as "left" | "right",
  windup,
  feint: false,
  follow: null,
  counterWindow: 1,
  recover: 0.4,
  teaching: false,
  aimAfter: 0.2,
  id: 1,
  startAt,
  impactAt: startAt + windup + RULES.strike,
  aim: { x: 0, y: 1.65 },
  shownAt: { x: 0, y: 1.65 },
  lateAt: null,
});
/** Every pose of a state over a stretch of time, a frame apart. */
function poses(foe: Foe, from: number, to: number) {
  const out = [];
  for (let t = from; t <= to; t += 1 / 60) out.push(foePose(foe, t, t, target));
  return out;
}

describe("the opponent's spine", () => {
  it("keeps its two lengths in every phase: guard, showing, throwing, recovering, stunned", () => {
    const states: [Foe, number, number][] = [
      [base(), 0, 3],
      [{ ...base(), tired: 1 }, 0, 3],
      [{ ...base(), phase: "stagger", since: 1, until: 2, struck: { at: 1, hand: "left", shape: "hook", target: "body", power: 1, damage: 9 } }, 1, 2],
    ];
    for (const kind of ["jab", "cross", "hook", "body"] as const) {
      const a = attack(kind, 1, 0.6);
      states.push([{ ...base(), phase: "windup", since: 1, until: 1.6, attack: a }, 1, 1.6]);
      states.push([{ ...base(), phase: "strike", since: 1.6, until: a.impactAt, attack: a }, 1.6, a.impactAt]);
      // Hit, and made to miss.
      states.push([{ ...base(), phase: "recover", since: a.impactAt, until: a.impactAt + 0.4, attack: a }, a.impactAt, a.impactAt + 0.4]);
      states.push([{ ...base(), phase: "recover", since: a.impactAt, until: a.impactAt + 1, counterUntil: a.impactAt + 1, attack: a }, a.impactAt, a.impactAt + 1]);
    }
    for (const [foe, from, to] of states)
      for (const pose of poses(foe, from, to)) {
        expect(Math.abs(dist(pose.hips, pose.chest) / SPINE.chest - 1)).toBeLessThan(0.02);
        expect(Math.abs(dist(pose.chest, pose.head) / SPINE.head - 1)).toBeLessThan(0.02);
      }
  });
});

describe("a knockdown", () => {
  const struck = { at: 5, hand: "right" as const, shape: "hook" as const, target: "head" as const, power: 1.1, damage: 12 };
  const down: Foe = { ...base(), phase: "down", since: 5, until: 5 + RULES.count, hp: 0, downs: 1, struck };
  it("falls and gets up as a body: nothing stretches, nothing jumps", () => {
    const all = poses(down, 5, 5 + RULES.count);
    let worst = 0;
    for (let i = 0; i < all.length; i++) {
      const pose = all[i];
      // The chest is lifted clear of the canvas as it lies, so allow a little.
      expect(Math.abs(dist(pose.hips, pose.chest) / SPINE.chest - 1)).toBeLessThan(0.04);
      expect(Math.abs(dist(pose.chest, pose.head) / SPINE.head - 1)).toBeLessThan(0.02);
      // Never through the floor.
      for (const p of [pose.hips, pose.chest, pose.head, ...pose.gloves]) expect(p.y).toBeGreaterThan(0.05);
      if (i) worst = Math.max(worst, dist(pose.head, all[i - 1].head));
    }
    // The head never moves more than a hand's width in a frame.
    expect(worst).toBeLessThan(0.13);
  });
  it("starts from where it stood, lies near enough to be looked down at, and ends standing", () => {
    const standing = foePose(base(), 5, 5, target);
    const first = foePose(down, 5, 5, target);
    expect(dist(first.head, standing.head)).toBeLessThan(0.08);
    const lying = foePose(down, 6.2, 6.2, target);
    expect(lying.fallen).toBeGreaterThan(0.99);
    expect(lying.head.y).toBeLessThan(0.3);
    // Its head lies behind where it stood, by less than its own height: inside a view tipped down at it.
    expect(lying.head.z).toBeLessThan(-0.5);
    expect(lying.head.z).toBeGreaterThan(-0.9);
    // Tipped the way the hook was going: the player's right hand travels to its right.
    expect(lying.head.x).toBeGreaterThan(0.05);
    const up = foePose(down, 5 + RULES.count, 5 + RULES.count, target);
    expect(up.fallen).toBe(0);
    expect(up.head.y).toBeGreaterThan(1.55);
    expect(dist(up.gloves[0], standing.gloves[0])).toBeLessThan(0.15);
  });
  it("stays down when it is out", () => {
    const out: Foe = { ...down, phase: "out", until: Infinity };
    expect(foePose(out, 30, 30, target).fallen).toBe(1);
  });
});
