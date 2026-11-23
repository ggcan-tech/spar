import { describe, expect, it } from "vitest";
import { p2 } from "./body";
import { flatAt, slingHands, slingShotAt, SHOT } from "./scripted";
import { armHeldOut, createSlingReader, createSlingSetup, defaultSetup, type SlingRead } from "./sling";
import { SLING } from "./tune";

const STEP = 1000 / 30;

/** Run a reader over a scripted motion; return every read. */
function run(
  motion: (s: number) => { left: { x: number; y: number }; right: { x: number; y: number }; root?: { x: number; y: number }; duck?: number },
  seconds: number,
  reader = createSlingReader(defaultSetup("left")),
  noise = 0,
) {
  const reads: SlingRead[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647 - 0.5) * 2 * noise;
  };
  for (let t = 0; t <= seconds * 1000; t += STEP) {
    const m = motion(t / 1000);
    const pose = flatAt({ t, left: p2(m.left.x + rnd(), m.left.y + rnd()), right: p2(m.right.x + rnd(), m.right.y + rnd()), root: m.root, duck: m.duck });
    reads.push(reader.update(pose));
  }
  return reads;
}
const shots = (reads: SlingRead[]) => reads.filter((r) => r.shot).map((r) => r.shot!);
const refusals = (reads: SlingRead[]) => reads.filter((r) => r.refused).map((r) => r.refused!);

describe("the body sling", () => {
  it("fires once on a held draw and a flick, from the hold, not the flick", () => {
    const reads = run((s) => slingShotAt("left", s), 3);
    const fired = shots(reads);
    expect(fired).toHaveLength(1);
    const shot = fired[0];
    // Read soon after the flick began.
    expect(shot.t / 1000).toBeGreaterThan(SHOT.hold);
    expect(shot.t / 1000).toBeLessThan(SHOT.flick + 0.12);
    expect(shot.readMs).toBeLessThan(200);
    // A natural level point gives the flattest legal ball, and a full draw full power.
    expect(shot.angle).toBeGreaterThanOrEqual(SLING.angleMin);
    expect(shot.angle).toBeLessThan(SLING.angleMin + 4);
    expect(shot.power).toBeGreaterThan(0.95);
    expect(refusals(reads)).toHaveLength(0);
  });

  it("needs no nock: going straight into the draw pose, holding and flicking fires", () => {
    const draw = slingHands("left", "draw"),
      flicked = slingHands("left", "flicked"),
      rest = slingHands("left", "rest");
    const reads = run((s) => {
      const lerp = (a: typeof rest, b: typeof rest, k: number) => ({
        left: p2(a.left.x + (b.left.x - a.left.x) * k, a.left.y + (b.left.y - a.left.y) * k),
        right: p2(a.right.x + (b.right.x - a.right.x) * k, a.right.y + (b.right.y - a.right.y) * k),
      });
      // Arms rise from the sides straight to the draw, hold, flick.
      if (s < 0.6) return lerp(rest, draw, s / 0.6);
      if (s < 1.4) return draw;
      if (s < 1.48) return lerp(draw, flicked, (s - 1.4) / 0.08);
      return flicked;
    }, 2.5);
    expect(shots(reads)).toHaveLength(1);
    // The checklist saw each part.
    expect(reads.some((r) => r.armOut && r.pulled && r.holdK >= 1)).toBe(true);
  });

  it("aims higher when the sling arm is tilted up", () => {
    const flat = shots(run((s) => slingShotAt("left", s, 0), 3))[0];
    const high = shots(run((s) => slingShotAt("left", s, 0.25), 3))[0];
    expect(high.angle).toBeGreaterThan(flat.angle + 15);
  });

  it("works for a right-arm sling too", () => {
    const fired = shots(run((s) => slingShotAt("right", s), 3, createSlingReader(defaultSetup("right"))));
    expect(fired).toHaveLength(1);
  });

  it("still fires with a few millimetres of camera noise, and only once", () => {
    const fired = shots(run((s) => slingShotAt("left", s), 3, undefined, 0.004));
    expect(fired).toHaveLength(1);
  });

  it("never fires while a full draw is held through steps and fast ducks", () => {
    const draw = slingHands("left", "draw");
    const reads = run(
      (s) => {
        if (s < 1.2) return slingShotAt("left", Math.min(s, SHOT.hold - 0.01));
        // Hands go with the body: hips move, the shape stays.
        const duck = 0.28 * Math.abs(Math.sin(s * 3.2));
        const root = p2(0.35 * Math.sin(s * 2.4), 0);
        return { ...draw, root, duck };
      },
      62,
    );
    expect(shots(reads)).toHaveLength(0);
  });

  it("a flick without a held draw is a fake: no ball, and it says settle", () => {
    const rest = slingHands("left", "rest"),
      nock = slingHands("left", "nock"),
      draw = slingHands("left", "draw"),
      flicked = slingHands("left", "flicked");
    // Straight from nock through draw into the flick with no hold.
    const reads = run((s) => {
      const lerp = (a: typeof rest, b: typeof rest, k: number) => ({
        left: p2(a.left.x + (b.left.x - a.left.x) * k, a.left.y + (b.left.y - a.left.y) * k),
        right: p2(a.right.x + (b.right.x - a.right.x) * k, a.right.y + (b.right.y - a.right.y) * k),
      });
      if (s < 0.4) return lerp(rest, nock, s / 0.4);
      if (s < 0.6) return nock;
      if (s < 0.85) return lerp(nock, draw, (s - 0.6) / 0.25);
      if (s < 0.95) return lerp(draw, flicked, (s - 0.85) / 0.1);
      return flicked;
    }, 1.5);
    expect(shots(reads)).toHaveLength(0);
    expect(refusals(reads).map((r) => r.reason)).toContain("settle");
  });

  it("refuses a flick that throws the sling arm too, and says why", () => {
    const reads = run((s) => {
      const h = slingShotAt("left", s);
      // The sling hand swings out and down 15 cm during the flick.
      if (s >= SHOT.hold) {
        const k = Math.min(1, (s - SHOT.hold) / (SHOT.flick - SHOT.hold));
        return { left: p2(h.left.x - 0.1 * k, h.left.y - 0.12 * k), right: h.right };
      }
      return h;
    }, 3);
    expect(shots(reads)).toHaveLength(0);
    expect(refusals(reads)[0]?.reason).toBe("sling moved");
  });

  it("an arm pointed at the screen looks short: no shot, 'point to your side'", () => {
    const reader = createSlingReader({ ...defaultSetup("left"), armLen: 0.6 });
    const reads = run((s) => {
      const h = slingShotAt("left", s);
      // Pointing at the screen: the wrist is only 25 cm out from its shoulder in the picture.
      return { left: p2(h.left.x * 0.55, h.left.y), right: h.right };
    }, 3, reader);
    expect(shots(reads)).toHaveLength(0);
    expect(reads.some((r) => r.hint === "point to your side")).toBe(true);
  });

  it("the fallback aim by height fires even when the arm looks short", () => {
    const reader = createSlingReader({ ...defaultSetup("left"), armLen: 0.6 }, { aim: "height" });
    const reads = run((s) => {
      const h = slingShotAt("left", s, 0.15);
      return { left: p2(h.left.x * 0.55, h.left.y), right: h.right };
    }, 3, reader);
    expect(shots(reads)).toHaveLength(1);
  });

  it("hands brought together cancel the draw", () => {
    const reads = run((s) => (s < 1.3 ? slingShotAt("left", s) : slingHands("left", "nock")), 2.5);
    expect(shots(reads)).toHaveLength(0);
    expect(reads.some((r) => r.cancelled === "hands together")).toBe(true);
  });

  it("the stillness release fires a full draw held still, only when chosen", () => {
    const hold = (s: number) => slingShotAt("left", Math.min(s, SHOT.hold - 0.01));
    expect(shots(run(hold, 3))).toHaveLength(0);
    expect(shots(run(hold, 3, createSlingReader(defaultSetup("left"), { release: "still" })))).toHaveLength(1);
  });

  it("a sling wrist the camera loses cancels; it never fires", () => {
    const reader = createSlingReader(defaultSetup("left"));
    const reads: SlingRead[] = [];
    for (let t = 0; t <= 3000; t += STEP) {
      const h = slingShotAt("left", t / 1000);
      reads.push(reader.update(flatAt({ t, left: h.left, right: h.right, seen: t > 1300 ? [0.1, 1] : [1, 1] })));
    }
    expect(shots(reads)).toHaveLength(0);
    expect(reads.some((r) => r.cancelled === "lost")).toBe(true);
  });

  it("knows which arm is held out", () => {
    const l = slingHands("left", "draw"),
      r = slingHands("right", "draw");
    expect(armHeldOut(flatAt({ t: 0, ...l }))).toBe("left");
    expect(armHeldOut(flatAt({ t: 0, ...r }))).toBe("right");
    expect(armHeldOut(flatAt({ t: 0, ...slingHands("left", "rest") }))).toBeNull();
  });

  it("set-up measures level, full draw and arm length from three held draws", () => {
    const setup = createSlingSetup("left");
    let got = null;
    for (let t = 0; t <= 9000 && !got; t += STEP) {
      const k = (t / 1000) % 3;
      const h = k < 1.6 ? slingHands("left", "draw", 0.03) : slingHands("left", "nock");
      got = setup.update(flatAt({ t, ...h }));
    }
    expect(got).not.toBeNull();
    expect(got!.armLen).toBeGreaterThan(0.5);
    expect(got!.fullDraw).toBeGreaterThan(0.6);
    expect(Math.abs(got!.level - -4)).toBeLessThan(6);
  });
});
