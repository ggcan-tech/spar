import { describe, expect, it } from "vitest";
import type { SyntheticMotion } from "../../pov/syntheticBody";
import { readGuard } from "../defence";
import { GUARD, HIGH_BLOCK, LOW_BLOCK, stance } from "../scriptedBoxer";
import { solveArm } from "./aim";
import { GUARD_SHAPE, coverOf, createGuardShapes, guardFromShapes, guardShare, type GuardShapes } from "./guardShape";
import { CAMS, M, blend, ease, f0, f1, mean, runWithSetup, skeleton, type Noise } from "./rig";

const both = (r: { in: number; up: number; fwd: number }): SyntheticMotion => ({
  leftHand: { x: r.in, y: r.up, z: r.fwd },
  rightHand: { x: -r.in, y: r.up, z: r.fwd },
});
/** The study's guards (finding 5), and a low block. */
const GUARDS: [string, SyntheticMotion][] = [
  ["gloves by the chin", both(GUARD)],
  ["tight at the cheeks", both({ in: 0.12, up: 0.15, fwd: 0.12 })],
  ["cover in front of the eyes", both(HIGH_BLOCK)],
  ["elbows down at the body", both(LOW_BLOCK)],
  ["long guard, lead hand out 35 cm", { leftHand: { x: 0.14, y: 0.12, z: 0.35 }, rightHand: { x: -0.1, y: 0.1, z: 0.2 } }],
];
const CM = 1 / 55;
interface Seen {
  /** Share of punches kept out across the head and across the body. */
  head: number;
  body: number;
  /** How far from its true place the left glove was read, cm. */
  off: number;
  /** Share at the left glove's middle, at its edge and 12 cm out. */
  middle: number;
  edge: number;
  outside: number;
  guard: string;
  old: string;
}
/** One guard, held, seen by one camera through the real tracker. */
function hold(pose: SyntheticMotion, cameraIndex: number, noise?: Noise): Seen {
  const c = CAMS[cameraIndex][1];
  const motion = (s: number) => (s < 0.3 ? stance() : s < 0.6 ? blend(stance(), pose, ease((s - 0.3) / 0.3)) : pose);
  const head: number[] = [],
    body: number[] = [],
    off: number[] = [],
    middle: number[] = [],
    edge: number[] = [],
    outside: number[] = [];
  let reader: ReturnType<typeof createGuardShapes> | null = null;
  let held: [boolean, boolean] = [false, false];
  let guard = "",
    old = "";
  runWithSetup(motion, 1.6, { cam: c, noise }, (p) => {
    if (!p.setup) return;
    reader ??= createGuardShapes(p.setup);
    const shapes = reader.update(p.result, p.range.units, p.t);
    if (!shapes || p.s < 1.0) return;
    // The truth, in metres from the middle of the shoulders, in the plane facing the opponent.
    const sk = skeleton(pose);
    const mid = { x: (sk.get(11)!.x + sk.get(12)!.x) / 2, y: (sk.get(11)!.y + sk.get(12)!.y) / 2 };
    const w = sk.get(15)!,
      e = sk.get(13)!;
    const fore = Math.hypot(w.x - e.x, w.y - e.y, w.z - e.z);
    const glove = { x: w.x + ((w.x - e.x) / fore) * 0.08 - mid.x, y: w.y + ((w.y - e.y) / fore) * 0.08 - mid.y };
    const nose = { x: sk.get(0)!.x - mid.x, y: sk.get(0)!.y - mid.y };
    const arm = p.setup.reach[0] * M;
    const at = (x: number, y: number) => ({ x: shapes.shoulders.x + x / arm, y: shapes.shoulders.y + y / arm });
    const read = shapes.hands[0];
    if (read) off.push(Math.hypot((read.glove.x - shapes.shoulders.x) * arm - glove.x, (read.glove.y - shapes.shoulders.y) * arm - glove.y) * 100);
    // Protection of the head: punches arriving all over the true head, 18 cm wide and 22 cm high about the nose.
    let sum = 0,
      n = 0;
    for (let gx = -2; gx <= 2; gx++)
      for (let gy = -2; gy <= 2; gy++) {
        sum += guardShare(shapes, at(nose.x + gx * 0.045, nose.y + gy * 0.055)).share;
        n++;
      }
    head.push(sum / n);
    // And of the body: all over the chest and belly.
    sum = n = 0;
    for (let gx = -2; gx <= 2; gx++)
      for (let gy = 0; gy <= 3; gy++) {
        sum += guardShare(shapes, at(gx * 0.06, -0.1 - gy * 0.08)).share;
        n++;
      }
    body.push(sum / n);
    // One punch at the true middle of the left glove, one at its edge, one well outside: outward and a little up.
    middle.push(guardShare(shapes, at(glove.x, glove.y)).share);
    edge.push(guardShare(shapes, at(glove.x - 0.075 * 0.8, glove.y + 0.075 * 0.6)).share);
    outside.push(guardShare(shapes, at(glove.x - 0.13 * 0.8, glove.y + 0.13 * 0.6)).share);
    const g = guardFromShapes(shapes, [false, false], held);
    held = [g.sides!.high[0], g.sides!.high[1]];
    guard = `up ${g.up} high ${g.high} low ${g.low}${g.known ? "" : " unknown"}`;
    const o = readGuard(p.result);
    old = `up ${o.up} high ${o.high} low ${o.low}`;
  });
  return { head: mean(head), body: mean(body), off: mean(off), middle: mean(middle), edge: mean(edge), outside: mean(outside), guard, old };
}

describe("a physical guard", () => {
  it("keeps a punch out in full 4 cm inside a shape, not at all 4 cm outside, and smoothly between", () => {
    const edge = GUARD_SHAPE.glove;
    expect(coverOf(edge - 4 * CM, edge)).toBe(1);
    expect(coverOf(0, edge)).toBe(1);
    expect(coverOf(edge + 4 * CM, edge)).toBe(0);
    expect(coverOf(edge + 10 * CM, edge)).toBe(0);
    expect(coverOf(edge, edge)).toBeCloseTo(0.5, 6);
    // No step anywhere: a millimetre never changes the share by more than 2%.
    let last = 1;
    for (let mm = 0; mm <= 160; mm++) {
      const share = coverOf((mm / 10) * CM, edge);
      expect(share).toBeLessThanOrEqual(last + 1e-9);
      expect(last - share).toBeLessThan(0.02);
      last = share;
    }
    // Known to ±3 cm, a hard edge would flip; the soft one moves by about a third over those 3 cm.
    expect(coverOf(edge - 1.5 * CM, edge) - coverOf(edge + 1.5 * CM, edge)).toBeLessThan(0.6);
  });

  it("stops a punch with whichever shape lies on its line", () => {
    const shapes: GuardShapes = {
      t: 0,
      valid: true,
      arm: 0.6,
      head: { x: 0, y: 0.31 },
      headSeen: true,
      shoulders: { x: 0, y: 0 },
      hips: { x: 0, y: -0.8 },
      hands: [
        // Left glove by the chin with its forearm standing under it; right hand low across the body.
        { glove: { x: -0.15, y: 0.33 }, wrist: { x: -0.15, y: 0.18 }, elbow: { x: -0.2, y: -0.3 } },
        { glove: { x: 0.1, y: -0.3 }, wrist: { x: 0.2, y: -0.35 }, elbow: null },
      ],
    };
    // A straight at the glove's middle; one between the gloves; one at the nose, a glove's width from the glove.
    expect(guardShare(shapes, { x: -0.15, y: 0.33 }).share).toBe(1);
    expect(guardShare(shapes, { x: 0.3, y: 0.3 }).share).toBe(0);
    const nose = guardShare(shapes, { x: 0, y: 0.31 });
    expect(nose.share).toBeGreaterThan(0.1);
    expect(nose.share).toBeLessThan(0.6);
    expect(nose.glove[0]).toBe(nose.share);
    // A body punch on the left side meets the forearm, not the glove.
    const ribs = guardShare(shapes, { x: -0.18, y: -0.1 });
    expect(ribs.arm[0]).toBe(1);
    expect(ribs.glove[0]).toBe(0);
    expect(ribs.share).toBe(1);
    // A hook comes in from the side along a line: the forearm on that line stops it though the head itself is bare.
    expect(guardShare(shapes, { x: 0, y: 0.05 }).share).toBeLessThan(0.1);
    expect(guardShare(shapes, { x: 0, y: 0.05 }, { x: -0.5, y: 0.05 }).share).toBe(1);
    // From the other side nothing is in the way.
    expect(guardShare(shapes, { x: 0.05, y: 0.31 }, { x: 0.5, y: 0.31 }).share).toBeLessThan(0.2);
    // A hand that is out punching guards nothing; a hand with no elbow has no strip.
    expect(guardShare(shapes, { x: -0.15, y: 0.33 }, null, [true, false]).share).toBe(0);
    expect(guardShare(shapes, { x: 0.1, y: -0.3 }).glove[1]).toBe(1);
    expect(guardShare(shapes, { x: 0.2, y: -0.55 }).arm[1]).toBe(0);
    expect(guardShare(null, { x: 0, y: 0 }).share).toBe(0);
    expect(guardShare({ ...shapes, valid: false }, { x: -0.15, y: 0.33 }).share).toBe(0);
  });

  it("gives the same protection from six camera heights (the study's test), and the same reading of where the gloves are", () => {
    const rows: string[] = [];
    for (const [name, pose] of GUARDS) {
      const seen = CAMS.map((_, i) => hold(pose, i, { seed: 3, sigma: 0.005, depth: 0.03 }));
      const span = (pick: (s: Seen) => number) => Math.max(...seen.map(pick)) - Math.min(...seen.map(pick));
      rows.push(
        `${name}\n    head kept out ${seen.map((s) => f0(100 * s.head)).join(" / ")}%  (apart by ${f0(100 * span((s) => s.head))})` +
          `\n    body kept out ${seen.map((s) => f0(100 * s.body)).join(" / ")}%  (apart by ${f0(100 * span((s) => s.body))})` +
          `\n    glove read ${seen.map((s) => f1(s.off)).join(" / ")} cm from its true place` +
          `\n    one punch at the glove's middle ${seen.map((s) => f0(100 * s.middle)).join(" / ")}%, at its edge ${seen.map((s) => f0(100 * s.edge)).join(" / ")}%, 5.5 cm outside ${seen.map((s) => f0(100 * s.outside)).join(" / ")}%` +
          `\n    as the rules' guard: ${seen.map((s) => s.guard).join(" | ")}\n    the old reading: ${seen.map((s) => s.old).join(" | ")}`,
      );
      const long = name.startsWith("long guard");
      // The study's test: the same guard, the same protection within 10%, from every camera height.
      // The long guard is the one it does not hold for: its forearm leans at the opponent and is
      // taken to be standing, so the glove reads up to 6 cm high from below. Held to 15%.
      expect(span((s) => s.head)).toBeLessThanOrEqual(long ? 0.15 : 0.1);
      expect(span((s) => s.body)).toBeLessThanOrEqual(0.1);
      // Away from an edge every camera agrees.
      for (const s of seen) {
        expect(s.middle).toBeGreaterThan(long ? 0.6 : 0.85);
        expect(s.outside).toBeLessThan(0.25);
      }
      // The glove's place: within 2.5 cm from a desk laptop upward; the low table (27° up at the
      // shoulders) is the worst the study tried and is held to 7.
      seen.forEach((s, i) => expect(s.off).toBeLessThan(i === 0 ? 7 : long ? 6.5 : 3));
      // The rules' guard reads the same from every height.
      if (name.startsWith("gloves by the chin")) for (const s of seen) expect(s.guard).toBe("up 2 high 0 low 0");
      if (name.startsWith("cover")) for (const s of seen) expect(s.guard).toBe("up 2 high 2 low 0");
      if (name.startsWith("elbows down")) for (const s of seen) expect(s.guard).toBe("up 0 high 0 low 2");
    }
    console.log(
      "guard, scripted person, 0.5 cm of noise; cameras: low table / desk laptop / chest / monitor / television top / shelf\n" + rows.join("\n"),
    );
  });

  it("is moved little by one wild pose: every place is the middle of three", () => {
    const c = CAMS[1][1];
    const places: { s: number; x: number; y: number; rawX: number; rawY: number }[] = [];
    let reader: ReturnType<typeof createGuardShapes> | null = null;
    runWithSetup(
      () => stance(),
      1.2,
      {
        cam: c,
        // One pose in which the model puts the left wrist 25 cm away.
        fault: (frame, s) =>
          Math.abs(s - 2.4) < 0.017 ? { ...frame, lm: frame.lm.map((p, i) => (i === 15 ? { ...p, x: p.x + 0.07, y: p.y + 0.05 } : p)) } : frame,
      },
      (p) => {
        if (!p.setup) return;
        reader ??= createGuardShapes(p.setup);
        const shapes = reader.update(p.result, p.range.units, p.t);
        // The same wrist from this pose alone, as the tracker hands it on.
        const raw = solveArm(p.result, "left", p.setup, p.range.units, { guard: true });
        if (shapes?.hands[0] && raw && p.s > 0.4)
          places.push({ s: p.s, x: shapes.hands[0].wrist.x, y: shapes.hands[0].wrist.y, rawX: raw.point.x, rawY: raw.point.y });
      },
    );
    const calm = places.filter((q) => q.s < 0.7);
    const home = { x: mean(calm.map((q) => q.x)), y: mean(calm.map((q) => q.y)) };
    const worst = Math.max(...places.map((q) => Math.hypot(q.x - home.x, q.y - home.y))) * 55;
    const worstRaw = Math.max(...places.map((q) => Math.hypot(q.rawX - home.x, q.rawY - home.y))) * 55;
    console.log(`guard, one pose with the wrist 25 cm out: the wrist from that pose alone moves ${f1(worstRaw)} cm, the middle of three ${f1(worst)} cm`);
    expect(places.length).toBeGreaterThan(15);
    // The tracker's own smoothing spreads a wild pose over the next one or two, so a little gets through.
    expect(worstRaw).toBeGreaterThan(8);
    expect(worst).toBeLessThan(4);
    expect(worst).toBeLessThan(worstRaw / 2.5);
  });

  it("says a hand it cannot see is unknown, not down; and leaves out a hand that is punching", () => {
    const c = CAMS[2][1];
    const got: { known: boolean | undefined; up: number; left: boolean; busy: number }[] = [];
    let reader: ReturnType<typeof createGuardShapes> | null = null;
    runWithSetup(
      () => stance(),
      1.0,
      { cam: c, fault: (frame, s) => (s > 2.2 ? { ...frame, lm: frame.lm.map((p, i) => (i === 16 || i === 14 ? { ...p, v: 0.05 } : p)) } : frame) },
      (p) => {
        if (!p.setup) return;
        reader ??= createGuardShapes(p.setup);
        const shapes = reader.update(p.result, p.range.units, p.t);
        if (p.s < 0.3) return;
        const g = guardFromShapes(shapes);
        got.push({ known: g.known, up: g.up, left: g.sides!.up![0], busy: guardFromShapes(shapes, [true, false]).up });
      },
    );
    const before = got[2],
      after = got[got.length - 1];
    expect(before).toMatchObject({ known: true, up: 2 });
    // The right hand was lost: one glove is known to be up, and the guard as a whole is not known.
    expect(after.known).toBe(false);
    expect(after.up).toBe(1);
    expect(after.left).toBe(true);
    // The left hand out punching guards nothing, and that is known.
    expect(before.busy).toBe(1);
    expect(guardFromShapes(null).known).toBe(false);
  });
});
