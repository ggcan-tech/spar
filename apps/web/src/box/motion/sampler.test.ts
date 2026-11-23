import { describe, expect, it } from "vitest";
import { twoBone } from "../../pov/body";
import { TEST_PACK } from "./fixture";
import { bodyOfPose, fromRig, gloveOf, mirrorBody, poseOf, sampleAt, sampleClip, toRig, wristFor } from "./sampler";
import { SIZE, type Body } from "./types";
import { distance } from "./vec";

/** A clip at a time gives a body; the mirror; and the way to and from the pose the drawing takes. */
const jab = TEST_PACK.byId.get("jab_a")!;
const guard = TEST_PACK.byId.get("guard_a")!;
const points = (b: Body) => [b.hips, b.chest, b.head, ...b.shoulders, ...b.elbows, ...b.wrists, ...b.feet];

describe("sampling a clip", () => {
  it("gives the stored frame on a whole frame, and something between its neighbours between them", () => {
    const a = sampleClip(jab, 10),
      b = sampleClip(jab, 11),
      mid = sampleClip(jab, 10.5);
    points(mid).forEach((p, i) => {
      expect(p.x).toBeCloseTo((points(a)[i].x + points(b)[i].x) / 2, 9);
      expect(p.y).toBeCloseTo((points(a)[i].y + points(b)[i].y) / 2, 9);
    });
    expect(distance(sampleAt(jab, 10 / 60).head, a.head)).toBeLessThan(1e-9);
  });
  it("holds the ends of a punch clip and goes round a loop", () => {
    expect(distance(sampleClip(jab, -5).head, sampleClip(jab, 0).head)).toBe(0);
    expect(distance(sampleClip(jab, 9999).head, sampleClip(jab, jab.frames - 1).head)).toBe(0);
    expect(guard.loop).toBe(true);
    expect(distance(sampleClip(guard, guard.frames + 3).head, sampleClip(guard, 3).head)).toBe(0);
    // Between the last frame and the first it blends the two: the join is a frame like any other.
    const join = sampleClip(guard, guard.frames - 0.5);
    expect(join.head.y).toBeCloseTo((sampleClip(guard, guard.frames - 1).head.y + sampleClip(guard, 0).head.y) / 2, 9);
  });
});

describe("the mirror, for a left-handed stance", () => {
  const b = sampleClip(jab, jab.punches[0].events.contact);
  const m = mirrorBody(b);
  it("changes the sign of sideways and swaps the two sides", () => {
    expect(m.head.x).toBeCloseTo(-b.head.x, 12);
    expect(m.head.y).toBe(b.head.y);
    expect(m.head.z).toBe(b.head.z);
    // The left wrist was out (the jab); now the right one is, in the same place mirrored.
    expect(m.wrists[1].x).toBeCloseTo(-b.wrists[0].x, 12);
    expect(m.wrists[1].z).toBe(b.wrists[0].z);
    expect(m.wrists[0].z).toBe(b.wrists[1].z);
    expect(m.feet[1].z).toBe(b.feet[0].z);
    // The lead foot is now the right.
    expect(m.feet[1].z).toBeGreaterThan(m.feet[0].z);
  });
  it("done twice, gives back the body", () => {
    points(mirrorBody(m)).forEach((p, i) => expect(distance(p, points(b)[i])).toBeLessThan(1e-12));
  });
  it("keeps every length, and its left shoulder on its left", () => {
    expect(distance(m.shoulders[0], m.elbows[0])).toBeCloseTo(distance(b.shoulders[1], b.elbows[1]), 12);
    expect(distance(m.hips, m.chest)).toBeCloseTo(distance(b.hips, b.chest), 12);
    expect(m.shoulders[0].x).toBeLessThan(m.shoulders[1].x);
    expect(b.shoulders[0].x).toBeLessThan(b.shoulders[1].x);
  });
  it("commutes with going through the bones", () => {
    const viaRig = fromRig(toRig(m));
    const other = mirrorBody(fromRig(toRig(b)));
    points(viaRig).forEach((p, i) => expect(distance(p, points(other)[i])).toBeLessThan(1e-9));
  });
});

describe("the body as the pose the drawing takes", () => {
  it("gives a glove and an elbow direction from which scene.ts draws the same arm", () => {
    for (const clip of TEST_PACK.clips)
      for (let f = 0; f < clip.frames; f += 7) {
        const b = fromRig(toRig(sampleClip(clip, f)));
        const pose = poseOf(b);
        for (const i of [0, 1]) {
          // scene.ts: the wrist a tenth of the way back from the glove, the elbow by twoBone with the pole.
          const wrist = wristFor(pose.shoulders[i], pose.gloves[i]);
          expect(distance(wrist, b.wrists[i])).toBeLessThan(1e-9);
          const elbow = twoBone(pose.shoulders[i], wrist, SIZE.upperArm, SIZE.forearm, pose.poles[i]);
          expect(distance(elbow, b.elbows[i]), `${clip.id} frame ${f}`).toBeLessThan(1e-6);
          expect(distance(gloveOf(b.shoulders[i], b.wrists[i]), pose.gloves[i])).toBe(0);
        }
        // The turn of the shoulders, as opponentPose.ts measures it.
        const line = { x: b.shoulders[1].x - b.shoulders[0].x, z: b.shoulders[1].z - b.shoulders[0].z };
        expect(pose.turn).toBeCloseTo(Math.atan2(-line.z, line.x), 12);
      }
  });
  it("comes back from a pose as the same body", () => {
    const b = fromRig(toRig(sampleClip(jab, 20)));
    const back = bodyOfPose({ ...poseOf(b), fallen: 0, loading: null, open: 0, lunge: 0 });
    for (const i of [0, 1]) {
      expect(distance(back.elbows[i], b.elbows[i])).toBeLessThan(1e-6);
      expect(distance(back.wrists[i], b.wrists[i])).toBeLessThan(1e-9);
    }
    expect(distance(back.head, b.head)).toBe(0);
  });
});
