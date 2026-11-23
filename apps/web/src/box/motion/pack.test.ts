import { describe, expect, it } from "vitest";
import { SPINE } from "../opponentPose";
import { RAW_PACK, TEST_PACK } from "./fixture";
import { fromRig, gloveOf, sampleClip, toRig } from "./sampler";
import { CLIP_TIMES, KIND_TIMES, PUNCH_TIMES, TELLS, rulesTimes } from "./times";
import { SIZE, type Clip, type PunchMark } from "./types";
import { distance } from "./vec";

/**
 * The recorded clips themselves: the body rebuilt at the game's sizes keeps
 * its lengths, and each punch's events are where the motion says they are.
 */
const pack = TEST_PACK;
const punchClips = pack.clips.filter((c) => c.punches.length > 0);
const singles = pack.clips.filter((c) => c.punches.length === 1 && c.kind !== "combo");
const ms = (clip: Clip, frames: number) => (frames / clip.fps) * 1000;
/** How far out a punch is at a frame: for a straight punch the glove's distance toward the player; for the others how near it is to where the boxer was throwing. */
function reach(clip: Clip, mark: PunchMark, frame: number): number {
  const hand = mark.hand === "lead" ? 0 : 1;
  const b = sampleClip(clip, frame);
  const glove = gloveOf(b.shoulders[hand], b.wrists[hand]);
  return mark.shape === "straight" ? glove.z : -distance(glove, mark.contact.aim);
}

describe("the clip pack", () => {
  it("is small, and holds what the game needs", () => {
    const bytes = RAW_PACK.clips.reduce((n, c) => n + c.data.length, 0);
    expect(bytes).toBeLessThan(1_000_000);
    expect(pack.fps).toBe(60);
    expect(pack.guards.length).toBeGreaterThanOrEqual(2);
    for (const id of ["jab_a", "cross_a", "hook_lead_a", "hook_rear_a", "upper_lead_a", "upper_rear_a"]) expect(pack.byId.has(id), id).toBe(true);
    expect(pack.clips.some((c) => c.step?.dir === "in")).toBe(true);
    expect(pack.clips.some((c) => c.step?.dir === "out")).toBe(true);
    expect(pack.clips.some((c) => c.kind === "combo" && c.punches.length >= 2)).toBe(true);
    // A punch to the body from each hand.
    expect(singles.some((c) => c.punches[0].level === "body" && c.punches[0].hand === "lead")).toBe(true);
    expect(singles.some((c) => c.punches[0].level === "body" && c.punches[0].hand === "rear")).toBe(true);
  });

  it("keeps spine and arm lengths within 2% in every frame of every clip", () => {
    // The game's own lengths are the ones opponentPose.ts holds its spine to.
    expect(SIZE.chest).toBe(SPINE.chest);
    expect(SIZE.head).toBe(SPINE.head);
    let worst = 0;
    for (const clip of pack.clips)
      for (let f = 0; f < clip.frames; f++) {
        const b = sampleClip(clip, f);
        const off = [
          distance(b.hips, b.chest) / SIZE.chest,
          distance(b.chest, b.head) / SIZE.head,
          distance(b.shoulders[0], b.elbows[0]) / SIZE.upperArm,
          distance(b.shoulders[1], b.elbows[1]) / SIZE.upperArm,
          distance(b.elbows[0], b.wrists[0]) / SIZE.forearm,
          distance(b.elbows[1], b.wrists[1]) / SIZE.forearm,
          distance(b.shoulders[0], b.shoulders[1]) / (2 * SIZE.shoulder),
        ];
        for (const k of off) worst = Math.max(worst, Math.abs(k - 1));
      }
    // Measured: about 0.3%, which is the half-millimetre the pack rounds to.
    expect(worst).toBeLessThan(0.02);
  });

  it("gives exact lengths between frames once it has been through the bones", () => {
    for (const clip of pack.clips)
      for (let f = 0.37; f < clip.frames - 1; f += 3.21) {
        const b = fromRig(toRig(sampleClip(clip, f)));
        expect(distance(b.hips, b.chest)).toBeCloseTo(SIZE.chest, 9);
        expect(distance(b.chest, b.head)).toBeCloseTo(SIZE.head, 9);
        for (const i of [0, 1]) {
          expect(distance(b.shoulders[i], b.elbows[i])).toBeCloseTo(SIZE.upperArm, 9);
          expect(distance(b.elbows[i], b.wrists[i])).toBeCloseTo(SIZE.forearm, 9);
        }
      }
  });

  it("stays above the floor and in front of its own feet", () => {
    for (const clip of pack.clips)
      for (let f = 0; f < clip.frames; f++) {
        const b = sampleClip(clip, f);
        expect(b.feet[0].y).toBeGreaterThan(0.03);
        expect(b.feet[1].y).toBeGreaterThan(0.03);
        // The origin is between the feet.
        expect(Math.abs(b.feet[0].x + b.feet[1].x)).toBeLessThan(0.01);
        expect(Math.abs(b.feet[0].z + b.feet[1].z)).toBeLessThan(0.01);
        expect(b.hips.y).toBeGreaterThan(0.55);
        expect(b.head.y).toBeLessThan(1.95);
      }
  });

  it("is orthodox throughout: the left foot leads when a punch starts", () => {
    for (const clip of singles) {
      const b = sampleClip(clip, clip.punches[0].events.launch);
      expect(b.feet[0].z - b.feet[1].z, clip.id).toBeGreaterThan(0.09);
    }
  });
});

describe("each punch's events", () => {
  it("are in order and inside the clip", () => {
    expect(punchClips.length).toBeGreaterThan(15);
    for (const clip of punchClips)
      for (const m of clip.punches) {
        const e = m.events;
        expect(e.first, clip.id).toBeGreaterThanOrEqual(0);
        expect(e.first, clip.id).toBeLessThanOrEqual(e.seen);
        expect(e.seen, clip.id).toBeLessThanOrEqual(e.launch);
        expect(e.launch, clip.id).toBeLessThan(e.contact);
        expect(e.contact, clip.id).toBeLessThanOrEqual(e.guard);
        expect(e.guard, clip.id).toBeLessThanOrEqual(clip.frames - 1);
      }
  });

  it("have contact within one frame of greatest reach", () => {
    for (const clip of punchClips)
      for (const m of clip.punches) {
        const e = m.events;
        // From the fist leaving until the hand is on its way home (or the next punch of a combination).
        const until = Math.min(clip.frames - 1, e.contact + 0.15 * clip.fps);
        let best = e.launch;
        for (let f = e.launch; f <= until; f += 0.5) if (reach(clip, m, f) > reach(clip, m, best)) best = f;
        expect(Math.abs(best - e.contact), `${clip.id} ${m.kind}`).toBeLessThanOrEqual(1);
      }
  });

  it("have the glove where the record says at contact, out in front and dead ahead for the first punch", () => {
    for (const clip of punchClips) {
      clip.punches.forEach((m, i) => {
        const hand = m.hand === "lead" ? 0 : 1;
        const b = sampleClip(clip, m.events.contact);
        const glove = gloveOf(b.shoulders[hand], b.wrists[hand]);
        // A contact timed on a half frame is read between two frames: allow the fist's travel in that.
        expect(distance(glove, m.contact.hand), clip.id).toBeLessThan(0.015);
        expect(glove.z, clip.id).toBeGreaterThan(0.55);
        // Each single take was turned so that its punch lands on the centre line.
        if (i === 0 && clip.kind !== "combo") expect(Math.abs(glove.x), clip.id).toBeLessThan(0.04);
        // Head punches land about chin height, body punches clearly under that.
        if (m.level === "head") expect(glove.y, clip.id).toBeGreaterThan(1.28);
        else expect(glove.y, clip.id).toBeLessThan(1.32);
      });
    }
  });

  it("take a human time from first movement to contact", () => {
    // What was found, in milliseconds (see docs/production/evidence/real-clips.md):
    //   jabs 316 and 375, crosses 308 and 358, hooks 441 to 691, uppercuts 616 to 775.
    // Published: a jab 357 ± 178 ms from first movement to contact
    // (Piorkowski 2011), 405 ms (Stanley 2018); hooks longer. Nothing is
    // forced here: the ranges are wide enough to hold a real punch and
    // narrow enough to catch a wrong cut.
    const range: Record<string, [number, number]> = { jab: [180, 600], cross: [220, 700], hook: [280, 950] };
    const flight: [number, number] = [100, 400];
    let checked = 0;
    for (const clip of singles) {
      const m = clip.punches[0];
      const whole = ms(clip, m.events.contact - m.events.first);
      const fly = ms(clip, m.events.contact - m.events.launch);
      expect(fly, clip.id).toBeGreaterThanOrEqual(flight[0]);
      expect(fly, clip.id).toBeLessThanOrEqual(flight[1]);
      if (!(m.kind in range)) continue;
      checked++;
      expect(whole, clip.id).toBeGreaterThanOrEqual(range[m.kind][0]);
      expect(whole, clip.id).toBeLessThanOrEqual(range[m.kind][1]);
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});

describe("the punch times handed to the rules", () => {
  it("are the clips' own times", () => {
    for (const clip of singles) {
      const m = clip.punches[0];
      const t = CLIP_TIMES[clip.id as keyof typeof CLIP_TIMES];
      expect(t, clip.id).toBeDefined();
      // Within a frame of the pack: both were timed at 120 a second.
      expect(Math.abs(t.load - (m.events.launch - m.events.first) / clip.fps), clip.id).toBeLessThan(0.012);
      expect(Math.abs(t.strike - (m.events.contact - m.events.launch) / clip.fps), clip.id).toBeLessThan(0.012);
    }
  });
  it("are the mean of the kept takes of each kind, and nothing is faster than a person", () => {
    for (const kind of ["jab", "cross", "hook", "uppercut", "body"] as const) {
      const takes = Object.values(CLIP_TIMES).filter((c) => c.kind === kind);
      expect(takes.length).toBe(KIND_TIMES[kind].takes);
      const mean = takes.reduce((n, c) => n + c.load, 0) / takes.length;
      expect(PUNCH_TIMES[kind].load).toBeCloseTo(mean, 2);
      // The design's floor: nothing under 220 ms from first movement to contact.
      expect(PUNCH_TIMES[kind].load + PUNCH_TIMES[kind].strike).toBeGreaterThan(0.22);
      expect(PUNCH_TIMES[kind].strike).toBeGreaterThan(0.1);
      expect(PUNCH_TIMES[kind].home).toBeGreaterThan(0.15);
      expect(TELLS[kind].kept.clear).toBeLessThanOrEqual(TELLS[kind].kept.body);
    }
    const rules = rulesTimes();
    expect(rules.jab.impact).toBeCloseTo(PUNCH_TIMES.jab.load + PUNCH_TIMES.jab.strike, 3);
    expect(rules.cross.commit).toBeCloseTo(PUNCH_TIMES.cross.load, 3);
    // Slowed for a beginner: only the load stretches, and no further than the clips allow.
    expect(rulesTimes(5).jab.impact).toBeCloseTo(PUNCH_TIMES.jab.load / 0.6 + PUNCH_TIMES.jab.strike, 3);
  });
});
