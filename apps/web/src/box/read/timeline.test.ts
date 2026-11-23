import { describe, expect, it } from "vitest";
import { stance } from "../scriptedBoxer";
import { M, f1, runBoxer } from "./rig";
import { createTimeline, lineTime, type PoseLike } from "./timeline";

const at = (x: number, y = 0, more: Partial<PoseLike> = {}): PoseLike => ({
  valid: true,
  head: { x, y, z: 0 },
  root: { x: x / 2, y: 0, z: 0 },
  leftHand: { x: x - 0.2, y: 1.2, z: 0.1 },
  rightHand: { x: x + 0.2, y: 1.2, z: 0.1 },
  leftHandTracked: true,
  rightHandTracked: true,
  joints: [
    { x, y: 0, z: 0 },
    { x: x + 1, y: 2, z: 3 },
  ],
  jointWeights: [1, 0.8],
  ...more,
});

describe("the one line", () => {
  it("works out where the head and hands were between two poses", () => {
    const line = createTimeline();
    line.push(1000, at(0));
    line.push(1033, at(0.066));
    line.push(1066, at(0.2));
    const mid = line.at(1016.5)!;
    expect(mid.between).toBe(true);
    expect(mid.staleMs).toBe(0);
    expect(mid.head.x).toBeCloseTo(0.033, 6);
    expect(mid.leftHand.x).toBeCloseTo(0.033 - 0.2, 6);
    expect(mid.joints![1].x).toBeCloseTo(1.033, 6);
    // A quarter of the way between the second and third.
    expect(line.at(1033 + 33 / 4)!.head.x).toBeCloseTo(0.066 + 0.134 / 4, 6);
    // On a pose exactly: that pose.
    expect(line.at(1033)!.head.x).toBeCloseTo(0.066, 6);
  });

  it("predicts nothing: asked for a time past the newest pose it says where the player was, and how stale that is", () => {
    const line = createTimeline();
    // A head moving steadily: a predictor would carry it on.
    line.push(1000, at(0));
    line.push(1033, at(0.1));
    const late = line.at(1100)!;
    expect(late.head.x).toBe(0.1);
    expect(late.between).toBe(false);
    expect(late.staleMs).toBe(67);
    // And before the oldest: the oldest.
    const early = line.at(900)!;
    expect(early.head.x).toBe(0);
    expect(early.staleMs).toBe(100);
    expect(createTimeline().at(5)).toBeNull();
  });

  it("does not join poses across a gap, a held pose or a lost body", () => {
    const line = createTimeline({ maxGapMs: 150 });
    line.push(1000, at(0));
    line.push(1400, at(1));
    const inGap = line.at(1100)!;
    expect(inGap.between).toBe(false);
    expect(inGap.head.x).toBe(0);
    expect(inGap.staleMs).toBe(100);
    // A pose the tracker only held over a dropout is not a measurement.
    line.push(1433, at(1.1, 0, { held: true }));
    line.push(1466, at(1.2));
    // Between a held pose and a measured one: the measured one, as it was.
    const overHeld = line.at(1440)!;
    expect(overHeld.between).toBe(false);
    expect(overHeld.head.x).toBe(1.2);
    expect(overHeld.staleMs).toBe(26);
    line.push(1500, at(9, 0, { valid: false }));
    expect(line.at(1600)!.valid).toBe(false);
  });

  it("takes a hand seen in only one of two poses from that one, and says so", () => {
    const line = createTimeline();
    line.push(1000, at(0));
    line.push(1033, at(1, 0, { leftHandTracked: false, leftHand: { x: 5, y: 5, z: 5 } }));
    const r = line.at(1010)!;
    expect(r.hands).toEqual([false, true]);
    expect(r.leftHand.x).toBe(-0.2);
    expect(r.rightHand.x).toBeCloseTo(0.2 + 10 / 33, 5);
    // A joint is as sure as the less sure of the two poses.
    expect(r.jointWeights).toEqual([1, 0.8]);
  });

  it("says whether the player was seen from a punch's start to its landing", () => {
    const line = createTimeline();
    for (let i = 0; i < 10; i++) line.push(1000 + i * 33, at(i * 0.01));
    expect(line.seenThrough(1010, 1250)).toBe(true);
    // The newest pose is a little older than the landing: seen so far.
    expect(line.seenThrough(1010, 1320)).toBe(true);
    expect(line.seenThrough(1010, 1600)).toBe(false);
    const gap = createTimeline();
    gap.push(1000, at(0));
    gap.push(1033, at(0));
    gap.push(1300, at(0));
    expect(gap.seenThrough(1010, 1290)).toBe(false);
    const lost = createTimeline();
    for (let i = 0; i < 6; i++) lost.push(1000 + i * 33, at(0, 0, { rightHandTracked: i !== 3 }));
    expect(lost.seenThrough(1000, 1160)).toBe(true);
    expect(lost.seenThrough(1000, 1160, 0)).toBe(true);
    expect(lost.seenThrough(1000, 1160, 1)).toBe(false);
    expect(createTimeline().seenThrough(0, 10)).toBe(false);
  });

  it("draws the opponent ahead by the whole delay it is given, however long, and judges that far behind", () => {
    const line = createTimeline({ delay: { cameraMs: 60, behindMs: 118, leadMs: 152 } });
    expect(line.judged(5000)).toBe(5000 - 118);
    expect(line.drawn(5000)).toBe(5000 - 118 + 152);
    // Not capped at 120 ms: a television may be 250 ms late.
    line.setDelay({ cameraMs: 70, behindMs: 190, leadMs: 310 });
    expect(line.drawn(5000) - line.judged(5000)).toBe(310);
    // The rules' reading is the room as it was `behindMs` ago.
    line.push(4780, at(0));
    line.push(4813, at(0.33));
    expect(line.me(5000)!.head.x).toBeCloseTo(0.33 * (30 / 33), 5);
    expect(line.me(5000)!.between).toBe(true);
  });

  it("puts a pose where the camera took it, not where the page got it", () => {
    expect(lineTime({ t: 1000, capturedAt: 940 }, { cameraMs: 50 })).toBe(940);
    // No capture time from the browser: the even clock less the measured camera delay.
    expect(lineTime({ t: 1000, motionT: 998 }, { cameraMs: 50 })).toBe(948);
    expect(lineTime({ t: 1000 }, { cameraMs: 50 })).toBe(950);
    // A capture time after the page's own stamp is not believed.
    expect(lineTime({ t: 1000, capturedAt: 1010 }, { cameraMs: 50 })).toBe(950);
  });

  it("tells a head that has stopped from one still moving", () => {
    const line = createTimeline();
    for (let i = 0; i <= 6; i++) line.push(1000 + i * 33, at(Math.min(i, 3) * 0.05));
    // Moving 5 cm a pose until the fourth, then still.
    expect(line.headMoved(1099, 99)).toBeCloseTo(0.15, 5);
    expect(line.headMoved(1198, 99)).toBeCloseTo(0, 5);
    expect(createTimeline().headMoved(10)).toBe(Infinity);
  });

  it("keeps a second or so and drops poses that come out of order", () => {
    const line = createTimeline({ keepMs: 500 });
    for (let i = 0; i < 60; i++) line.push(1000 + i * 33, at(i));
    expect(line.size()).toBeLessThanOrEqual(17);
    expect(line.newest()).toBe(1000 + 59 * 33);
    line.push(1500, at(-1));
    line.push(NaN, at(-1));
    expect(line.newest()).toBe(1000 + 59 * 33);
    line.reset();
    expect(line.size()).toBe(0);
  });

  it("on the scripted person: a slipping head read between poses is where it was; the newest pose alone is centimetres behind", () => {
    // A slip of 17 cm in 200 ms, through the real tracker. Truth: the same at 240 poses a second.
    const slip = (s: number) => {
      const k = Math.max(0, Math.min(1, (s - 0.5) / 0.2));
      return stance({ lean: 0.12 * k * k * k * (10 - 15 * k + 6 * k * k) });
    };
    const truth: { t: number; x: number }[] = [];
    runBoxer(slip, 1, { fps: 240, noGuard: true }, (p) => {
      if (p.result.valid) truth.push({ t: p.s * 1000, x: p.result.head.x });
    });
    const truly = (t: number) => {
      let i = 0;
      while (i < truth.length - 2 && truth[i + 1].t <= t) i++;
      const a = truth[i],
        b = truth[i + 1];
      return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
    };
    const line = createTimeline();
    const seen: number[] = [];
    runBoxer(slip, 1, { fps: 30, noGuard: true, phase: 0.4 }, (p) => {
      if (!p.result.valid) return;
      line.push(p.s * 1000, p.result);
      seen.push(p.s * 1000);
    });
    let between = 0,
      held = 0,
      n = 0;
    for (let t = 520; t <= 690; t += 4) {
      // Read between two poses, against the pose before alone.
      const r = line.at(t)!;
      const before = Math.max(...seen.filter((s) => s <= t));
      between = Math.max(between, Math.abs(r.head.x - truly(t)) * M * 100);
      held = Math.max(held, Math.abs(line.at(before)!.head.x - truly(t)) * M * 100);
      if (r.between) n++;
    }
    console.log(
      `timeline, scripted slip of 17 cm in 200 ms at 30 poses a second: read between poses is at most ${f1(between)} cm from where the head was; the newest pose alone, ${f1(held)} cm`,
    );
    expect(n).toBeGreaterThan(30);
    // The tracker's own smoothing is in both; what is left between poses is the curve of the movement.
    expect(between).toBeLessThan(1.5);
    expect(held).toBeGreaterThan(3);
  });
});
