import { describe, expect, it, vi } from "vitest";
import { BODY, JOINT, length, solveBody, sub } from "./body";
import { validPose } from "./duel";
import { trackedAvatar } from "./input";
import {
  PERSON,
  demoMotion,
  syntheticFrame,
  syntheticSkeleton,
  type SyntheticMotion,
} from "./syntheticBody";
import { createPovTracker } from "./tracking";

/** Game units per metre for the scripted person: canonical 0.4 over their shoulder width. */
const K = 0.4 / (2 * PERSON.shoulderHalf);
const STEP = 33;

/** A calibrated tracker fed the scripted person, with filtering off so values are exact. */
function session(smoothingMs = 0) {
  const tracker = createPovTracker({
    automatic: true,
    scaleMode: "body-relative",
    smoothingMs,
  });
  let t = 1000;
  const feed = (motion: SyntheticMotion = {}, frames = 1) => {
    let result = tracker.sample(t);
    for (let i = 0; i < frames; i++) {
      t += STEP;
      result = tracker.update(syntheticFrame(t, motion), t);
    }
    return result;
  };
  const still = feed({}, 30);
  expect(still.calibrated).toBe(true);
  expect(still.valid).toBe(true);
  return { tracker, feed };
}
const dist = (a: { x: number; y: number; z: number }, b: typeof a) =>
  length(sub(a, b));

describe("camera skeleton to avatar", () => {
  it("places the head and wrists exactly on the gameplay points", () => {
    const { feed } = session();
    const pose = trackedAvatar(
      feed({ lean: 0.1, rightHand: { x: 0.2, y: 0.3, z: 0.2 } }, 4),
      1.8,
    );
    const body = pose.body!;
    expect(validPose(pose)).toBe(true);
    expect(body[JOINT.NOSE].x).toBeCloseTo(pose.head.x, 3);
    expect(body[JOINT.NOSE].y).toBeCloseTo(pose.head.y, 3);
    for (const [joint, hand] of [
      [JOINT.L_WRIST, pose.leftHand],
      [JOINT.R_WRIST, pose.rightHand],
    ] as const) {
      expect(body[joint].x).toBeCloseTo(hand.x, 3);
      expect(body[joint].y).toBeCloseTo(hand.y, 3);
      expect(body[joint].z).toBeCloseTo(hand.z, 3);
    }
  });
  it("copies an arm movement joint for joint and leaves the other arm alone", () => {
    const { feed } = session();
    const rest = trackedAvatar(feed({}, 2), 1).body!;
    const motion: SyntheticMotion = {
      rightHand: { x: 0.25, y: 0.35, z: 0.15 },
    };
    const raised = trackedAvatar(feed(motion, 4), 1).body!;
    const person = syntheticSkeleton(motion),
      before = syntheticSkeleton();
    // Elbow and wrist move by the person's own displacement, in avatar units.
    // Tolerance is 7 cm, not zero: a single camera reads a hand held 15 cm
    // toward the lens about 6% further from the lens axis. That perspective
    // error is not corrected yet.
    for (const [joint, landmark] of [
      [JOINT.R_ELBOW, 14],
      [JOINT.R_WRIST, 16],
    ] as const) {
      const moved = sub(person.get(landmark)!, before.get(landmark)!);
      for (const axis of ["x", "y", "z"] as const)
        expect(
          Math.abs(raised[joint][axis] - rest[joint][axis] - moved[axis] * K),
        ).toBeLessThan(0.07);
    }
    expect(raised[JOINT.R_WRIST].y).toBeGreaterThan(raised[JOINT.R_SHOULDER].y);
    for (const joint of [JOINT.L_ELBOW, JOINT.L_WRIST, JOINT.L_KNEE])
      expect(dist(raised[joint], rest[joint])).toBeLessThan(0.01);
  });
  it("keeps limb shape 1:1 when the dodge boost amplifies a lean", () => {
    const { feed } = session();
    const t = feed({ lean: 0.12, sway: 0.08 }, 4);
    const plain = trackedAvatar(t, 1),
      boosted = trackedAvatar(t, 1.8);
    expect(boosted.root.x).toBeCloseTo(plain.root.x * 1.8, 3);
    expect(boosted.body![JOINT.NOSE].x).toBeCloseTo(boosted.head.x, 3);
    // The whole upper arm translates with its shoulder; it is not rescaled.
    for (const [a, b] of [
      [JOINT.L_SHOULDER, JOINT.R_SHOULDER],
      [JOINT.L_HIP, JOINT.R_HIP],
    ] as const) {
      expect(dist(boosted.body![a], boosted.body![b])).toBeCloseTo(
        dist(plain.body![a], plain.body![b]),
        3,
      );
    }
    expect(
      dist(boosted.body![JOINT.L_SHOULDER], boosted.body![JOINT.R_SHOULDER]),
    ).toBeCloseTo(0.4, 1);
  });
  it("bends the knees and keeps both feet on the floor in a boosted crouch", () => {
    const { feed } = session();
    const pose = trackedAvatar(feed({ crouch: 0.3 }, 4), 1.8);
    const body = pose.body!;
    expect(pose.root.y).toBeCloseTo(1 - 0.3 * K * 1.4, 1);
    for (const i of [0, 1]) {
      const hip = body[JOINT.L_HIP + i],
        knee = body[JOINT.L_KNEE + i],
        ankle = body[JOINT.L_ANKLE + i];
      expect(ankle.y).toBeCloseTo(BODY.ankle, 2);
      expect(knee.z).toBeGreaterThan(hip.z + 0.2);
      expect(dist(hip, knee)).toBeCloseTo(BODY.thigh, 3);
      expect(dist(knee, ankle)).toBeCloseTo(BODY.shin, 3);
      expect(body[JOINT.L_TOE + i].y).toBeGreaterThanOrEqual(0.03);
    }
  });
  it("lifts only the foot the player lifts, and both feet in a jump", () => {
    const { feed } = session();
    const lifted = trackedAvatar(feed({ leftFootLift: 0.3 }, 4), 1).body!;
    expect(lifted[JOINT.L_ANKLE].y).toBeCloseTo(BODY.ankle + 0.3 * K, 1);
    expect(lifted[JOINT.R_ANKLE].y).toBeCloseTo(BODY.ankle, 2);
    expect(lifted[JOINT.L_KNEE].y).toBeGreaterThan(
      lifted[JOINT.R_KNEE].y + 0.1,
    );
    const jumped = trackedAvatar(feed({ jump: 0.2 }, 4), 1).body!;
    for (const joint of [JOINT.L_ANKLE, JOINT.R_ANKLE])
      expect(jumped[joint].y).toBeCloseTo(BODY.ankle + 0.2 * K, 1);
  });
  it("keeps planted feet planted while the hips sway", () => {
    const { feed } = session();
    const rest = trackedAvatar(feed({}, 2), 1).body!;
    const swayed = trackedAvatar(feed({ sway: 0.15 }, 4), 1);
    expect(swayed.root.x).toBeCloseTo(0.15 * K, 1);
    for (const joint of [JOINT.L_ANKLE, JOINT.R_ANKLE])
      expect(swayed.body![joint].x).toBeCloseTo(rest[joint].x, 1);
  });
  it("tilts the head with the player", () => {
    const { feed } = session();
    const level = trackedAvatar(feed({}, 2), 1).body!;
    expect(level[JOINT.L_EAR].y).toBeCloseTo(level[JOINT.R_EAR].y, 2);
    const tilted = trackedAvatar(feed({ headTilt: 0.35 }, 4), 1).body!;
    // Tipping toward the player's right lowers the right ear.
    expect(tilted[JOINT.R_EAR].y).toBeLessThan(tilted[JOINT.L_EAR].y - 0.03);
  });
  it("cross-fades framed-out legs to solved legs and back without a jump", () => {
    const { feed } = session();
    const seen = feed({ leftFootLift: 0.3 }, 4);
    expect(seen.jointWeights![JOINT.L_KNEE]).toBe(1);
    const fading = feed({ leftFootLift: 0.3, hideLegs: true }, 2);
    expect(fading.jointWeights![JOINT.L_KNEE]).toBeGreaterThan(0);
    expect(fading.jointWeights![JOINT.L_KNEE]).toBeLessThan(1);
    const gone = feed({ leftFootLift: 0.3, hideLegs: true }, 8);
    expect(gone.jointWeights![JOINT.L_ANKLE]).toBe(0);
    const pose = trackedAvatar(gone, 1);
    const solved = solveBody(pose);
    expect(validPose(pose)).toBe(true);
    // With no leg observation the avatar stands on solved legs, not a frozen lift.
    expect(pose.body![JOINT.L_ANKLE].y).toBeCloseTo(solved[JOINT.L_ANKLE].y, 3);
    expect(pose.body![JOINT.L_ANKLE].x).toBeCloseTo(solved[JOINT.L_ANKLE].x, 3);
    // Arms are still observed while the legs are out of frame.
    expect(gone.jointWeights![JOINT.R_ELBOW]).toBe(1);
    const back = feed({ leftFootLift: 0.3 }, 10);
    expect(back.jointWeights![JOINT.L_ANKLE]).toBe(1);
    expect(trackedAvatar(back, 1).body![JOINT.L_ANKLE].y).toBeCloseTo(
      BODY.ankle + 0.3 * K,
      1,
    );
  });
  it("draws a moving body ahead of its measured pose and leaves a still one alone", () => {
    const { tracker } = session(35);
    let t = 3000;
    const step = (motion: SyntheticMotion, capturedAgo?: number) => {
      t += STEP;
      const frame = syntheticFrame(t, motion);
      if (capturedAgo !== undefined) frame.capturedAt = t - capturedAgo;
      return tracker.update(frame, t);
    };
    for (let i = 0; i < 20; i++) step({});
    // Still: the drawn pose is exactly the measured pose.
    const still = tracker.predict(t + 20);
    expect(still.root).toEqual(tracker.sample(t + 20).root);
    expect(still.joints).toEqual(tracker.sample(t + 20).joints);
    // Steady sideways walk at about 1 m/s with the right hand swinging up.
    for (let i = 1; i <= 12; i++)
      step({
        step: 0.033 * i,
        rightHand: { x: 0.05, y: -0.5 + 0.03 * i, z: 0.08 },
      });
    const measured = tracker.sample(t + 20),
      drawn = tracker.predict(t + 20);
    expect(drawn.valid).toBe(true);
    expect(drawn.root.x).toBeGreaterThan(measured.root.x + 0.005);
    expect(drawn.root.x - measured.root.x).toBeLessThanOrEqual(0.12);
    // The hand leads in its own hip-relative motion; depth is never extrapolated.
    expect(drawn.joints![JOINT.R_WRIST].y).toBeGreaterThan(
      measured.joints![JOINT.R_WRIST].y,
    );
    expect(drawn.joints![JOINT.R_WRIST].z).toBe(
      measured.joints![JOINT.R_WRIST].z,
    );
    expect(drawn.root.z).toBe(measured.root.z);
    // A joint that is not moving relative to the hips gets no lead of its own.
    expect(drawn.joints![JOINT.L_KNEE].y).toBeCloseTo(
      measured.joints![JOINT.L_KNEE].y,
      3,
    );
    // The measured pose is untouched: prediction is a copy for display.
    expect(tracker.sample(t + 20).root).toEqual(measured.root);
    expect(validPose(trackedAvatar(drawn, 1.8))).toBe(true);
    // A pose known to be older is led further, up to the cap.
    const near = tracker.predict(t + 5).root.x - tracker.sample(t + 5).root.x;
    step({ step: 0.033 * 13, rightHand: { x: 0.05, y: -0.11, z: 0.08 } }, 90);
    expect(tracker.poseAge(t + 5)).toBeCloseTo(95);
    const far = tracker.predict(t + 5).root.x - tracker.sample(t + 5).root.x;
    expect(far).toBeGreaterThan(near * 2);
    // Tracking loss: nothing is extrapolated from a stale pose.
    expect(tracker.predict(t + 400).valid).toBe(false);
  });
  it("falls back to the solved body when the tracker reports no joints", () => {
    const { feed } = session();
    const t = feed({}, 2);
    delete t.joints;
    const pose = trackedAvatar(t, 1.8);
    expect(pose.body).toEqual(solveBody(pose));
  });
  it("stays valid, finite and rigid through the whole scripted routine with filtering on", () => {
    const { tracker } = session(35);
    let t = 5000,
      worstKnee = 0;
    for (let s = 0; s < 26; s += STEP / 1000) {
      t += STEP;
      const result = tracker.update(syntheticFrame(t, demoMotion(s)), t);
      expect(result.valid).toBe(true);
      const pose = trackedAvatar(result, 1.8);
      expect(validPose(pose)).toBe(true);
      const body = pose.body!;
      for (const p of body) {
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
        expect(p.y).toBeGreaterThanOrEqual(0);
      }
      for (const i of [0, 1]) {
        expect(dist(body[JOINT.L_HIP + i], body[JOINT.L_KNEE + i])).toBeCloseTo(
          BODY.thigh,
          2,
        );
        worstKnee = Math.max(
          worstKnee,
          Math.abs(
            dist(body[JOINT.L_KNEE + i], body[JOINT.L_ANKLE + i]) - BODY.shin,
          ),
        );
      }
    }
    expect(worstKnee).toBeLessThan(0.01);
  });
  it("keeps both arms their own length when the dodge gain moves the head", () => {
    const arm = (body: { x: number; y: number; z: number }[], side: 0 | 1) =>
      dist(body[JOINT.L_SHOULDER + side], body[JOINT.L_ELBOW + side]) +
      dist(body[JOINT.L_ELBOW + side], body[JOINT.L_WRIST + side]);
    // Arms out to the sides, where a lean used to stretch one and shorten the other.
    const out = {
      leftHand: { x: -0.5, y: 0, z: 0.05 },
      rightHand: { x: 0.5, y: 0, z: 0.05 },
    };
    const { feed: straightFeed } = session();
    const straight = trackedAvatar(straightFeed(out, 4), 1).body!;
    for (const lean of [0, 0.1, 0.2])
      for (const gain of [1, 1.8, 2.5]) {
        const { feed } = session();
        const pose = trackedAvatar(feed({ ...out, lean }, 4), gain);
        for (const side of [0, 1] as const)
          expect(
            Math.abs(arm(pose.body!, side) / arm(straight, side) - 1),
          ).toBeLessThan(0.02);
        // The gameplay hands are the drawn wrists.
        expect(dist(pose.body![JOINT.R_WRIST], pose.rightHand)).toBeLessThan(
          1e-3,
        );
      }
  });
  it("keeps standing knees pointing forward and steady when their depth is noisy", () => {
    const { tracker } = session();
    let state = 9;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const gauss = () => {
      let sum = 0;
      for (let i = 0; i < 6; i++) sum += random();
      return (sum - 3) * Math.SQRT2;
    };
    let t = 5000,
      behind = 0,
      worst = 0,
      last: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 600; i++) {
      t += STEP;
      const frame = syntheticFrame(t, {});
      // 3 cm of depth noise on both knees, as a pose model gives on a straight leg.
      for (const k of [25, 26]) {
        const dz = gauss() * 0.03;
        frame.world![k] = { ...frame.world![k], z: frame.world![k].z + dz };
        frame.lm[k] = { ...frame.lm[k], z: frame.lm[k].z + dz / 4.3 };
      }
      const body = trackedAvatar(tracker.update(frame, t), 1.8).body!;
      const knee = body[JOINT.R_KNEE];
      if (knee.z < body[JOINT.R_HIP].z) behind++;
      if (last) worst = Math.max(worst, dist(knee, last));
      last = knee;
    }
    // Before: the knee was behind the hip in about a sixth of the frames and
    // jumped up to 13 cm between poses.
    expect(behind).toBe(0);
    expect(worst).toBeLessThan(0.02);
  });
  it("still follows a knee that is really bent", () => {
    const { feed } = session();
    const body = trackedAvatar(feed({ crouch: 0.3 }, 4), 1).body!;
    for (const side of [0, 1] as const) {
      const hip = body[JOINT.L_HIP + side],
        knee = body[JOINT.L_KNEE + side],
        ankle = body[JOINT.L_ANKLE + side];
      // Bent forward: the knee is ahead of the line from hip to ankle.
      expect(knee.z).toBeGreaterThan((hip.z + ankle.z) / 2 + 0.1);
    }
  });
});

describe("the scripted camera's faults", () => {
  it("drops the wrist and the whole body now and then when asked to", async () => {
    const { demoFrame } = await import("./syntheticBody");
    const seen = (seconds: number, occlude: boolean) => {
      const frame = demoFrame(1000 + seconds * 1000, seconds, occlude);
      return { wrist: frame.lm[16].v, hip: frame.lm[23].v };
    };
    expect(seen(4.1, false)).toEqual({ wrist: 0.95, hip: 0.95 });
    expect(seen(4.1, true)).toEqual({ wrist: 0.05, hip: 0.95 });
    expect(seen(11.1, true)).toEqual({ wrist: 0.05, hip: 0.05 });
    expect(seen(6, true)).toEqual({ wrist: 0.95, hip: 0.95 });
  });
  it("delivers poses late and at the asked rate", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "performance"] });
    try {
      const { createSyntheticPoseSource } = await import("./syntheticBody");
      const source = createSyntheticPoseSource({ fps: 20, delayMs: 90 });
      const ages: number[] = [];
      source.onFrame((frame) => ages.push(performance.now() - frame.t));
      vi.advanceTimersByTime(2000);
      source.stop();
      // 20 a second for two seconds, less the ones still on their way.
      expect(ages.length).toBeGreaterThanOrEqual(36);
      expect(ages.length).toBeLessThanOrEqual(40);
      for (const age of ages) expect(age).toBeCloseTo(90, 0);
      expect(source.fps()).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });
});
