import { describe, expect, it } from "vitest";
import {
  BODY,
  JOINT,
  armChain,
  createArmRuler,
  length,
  solveBody,
  sub,
} from "./body";
import { neutralPose, type PlayerPose } from "./duel";
import { createFootPlanter, STEP as FOOT } from "./footPlant";
import { createHeadTurn, earsFor, headAngles } from "./headTurn";
/** The avatar's own head: ear to ear over nose ahead of the ear line. */
const RIG_HEAD = (2 * 0.075) / 0.08;
import { createInertialBlend } from "./inertial";
import { softLimit, trackedAvatar } from "./input";
import {
  PERSON,
  demoMotion,
  syntheticFrame,
  throwDuration,
  throwMotion,
  type SyntheticMotion,
} from "./syntheticBody";
import { createPovTracker } from "./tracking";

const K = 0.4 / (2 * PERSON.shoulderHalf);
const TRUE = { upperArm: PERSON.upperArm * K, foreArm: PERSON.foreArm * K };
const dist = (a: { x: number; y: number; z: number }, b: typeof a) =>
  length(sub(a, b));
function session(depthGain = 1, smoothingMs = 0) {
  const tracker = createPovTracker({
    automatic: true,
    scaleMode: "body-relative",
    smoothingMs,
  });
  let t = 1000;
  const feed = (motion: SyntheticMotion = {}, frames = 1) => {
    let result = tracker.sample(t);
    for (let i = 0; i < frames; i++) {
      t += 33;
      result = tracker.update(syntheticFrame(t, motion, depthGain), t);
    }
    return result;
  };
  expect(feed({}, 30).calibrated).toBe(true);
  return { tracker, feed, now: () => t };
}

describe("a limit with a soft knee", () => {
  it("leaves small values alone, never crosses the limit and never turns back", () => {
    expect(softLimit(0.3, 0.6)).toBe(0.3);
    expect(softLimit(-0.45, 0.6)).toBe(-0.45);
    let before = 0;
    for (let v = 0; v <= 3; v += 0.01) {
      const out = softLimit(v, 0.6);
      expect(out).toBeLessThanOrEqual(0.6);
      expect(out).toBeGreaterThanOrEqual(before);
      // No step where the easing begins.
      expect(out - before).toBeLessThanOrEqual(0.0101);
      before = out;
    }
    expect(softLimit(-9, 0.6)).toBeCloseTo(-0.6, 5);
    expect(softLimit(Number.NaN, 0.6)).toBeNaN();
  });
});

describe("arms on fixed-length bones", () => {
  it("keeps where the joints are across the picture and solves their depth", () => {
    const shoulder = { x: 0.2, y: 1.45, z: 0 };
    // Seen foreshortened: the upper arm points 60° toward the camera.
    const elbow = { x: 0.2, y: 1.45 - 0.15, z: 0.02 };
    const wrist = { x: 0.2, y: 1.45 - 0.15 - 0.27, z: 0.03 };
    const chain = armChain(shoulder, elbow, wrist, 0.3, 0.27);
    expect(dist(shoulder, chain.elbow)).toBeCloseTo(0.3, 5);
    expect(dist(chain.elbow, chain.wrist)).toBeCloseTo(0.27, 5);
    expect(chain.elbow.x).toBeCloseTo(elbow.x, 5);
    expect(chain.elbow.y).toBeCloseTo(elbow.y, 2);
    // The depth the model under-reported is recovered, on the side it said.
    expect(chain.elbow.z).toBeGreaterThan(0.2);
    expect(
      armChain(shoulder, { ...elbow, z: -0.2 }, wrist, 0.3, 0.27).elbow.z,
    ).toBeLessThan(-0.2);
  });
  it("does not flip a bone seen side-on when its depth is noise", () => {
    const shoulder = { x: 0.2, y: 1.45, z: 0 };
    const at = (z: number) =>
      armChain(
        shoulder,
        { x: 0.2, y: 1.45 - 0.294, z },
        { x: 0.2, y: 1.45 - 0.294 - 0.265, z },
        0.3,
        0.27,
      );
    // ±1.5 cm of depth noise on an arm hanging in the picture's plane.
    // No worse than the depth noise itself.
    expect(dist(at(0.015).elbow, at(-0.015).elbow)).toBeLessThan(0.04);
    expect(dist(at(0.015).wrist, at(-0.015).wrist)).toBeLessThan(0.07);
  });
  it("measures the player's own bones from what it sees", () => {
    const { tracker, feed, now } = session();
    const ruler = createArmRuler();
    expect(ruler.lengths()).toBeNull();
    for (let i = 0; i < 400; i++) {
      const t = feed(demoMotion(i * 0.033), 1);
      if (t.joints && t.jointWeights) ruler.measure(t.joints, t.jointWeights, now());
    }
    void tracker;
    const got = ruler.lengths()!;
    expect(Math.abs(got.upperArm / TRUE.upperArm - 1)).toBeLessThan(0.06);
    expect(Math.abs(got.foreArm / TRUE.foreArm - 1)).toBeLessThan(0.06);
  });
  it("keeps the arm its length through the routine, with depth at full, half and none", () => {
    for (const depthGain of [1, 0.5, 0]) {
      const { feed } = session(depthGain);
      let worst = 0,
        off = 0;
      for (let i = 0; i < 300; i++) {
        const pose = trackedAvatar(feed(demoMotion(i * 0.033), 1), 1.8, {
          arms: TRUE,
        });
        const body = pose.body!;
        for (const side of [0, 1]) {
          const arm =
            dist(body[JOINT.L_SHOULDER + side], body[JOINT.L_ELBOW + side]) +
            dist(body[JOINT.L_ELBOW + side], body[JOINT.L_WRIST + side]);
          worst = Math.max(
            worst,
            Math.abs(arm / (TRUE.upperArm + TRUE.foreArm) - 1),
          );
          const hand = side ? pose.rightHand : pose.leftHand;
          off = Math.max(
            off,
            Math.hypot(
              body[JOINT.L_WRIST + side].x - hand.x,
              body[JOINT.L_WRIST + side].y - hand.y,
            ),
          );
        }
      }
      console.log(
        `arm chain at depth ×${depthGain}: length off by at most ${(worst * 100).toFixed(1)}%, wrist off the hand across the picture by at most ${(off * 100).toFixed(1)} cm`,
      );
      expect(worst).toBeLessThan(0.085);
      expect(off).toBeLessThan(0.06);
    }
  });
  it("does not stretch the forearm when a throw is predicted ahead", () => {
    const { tracker, feed, now } = session(1, 60);
    let worst = 0;
    const frames = Math.ceil((throwDuration() + 0.3) / 0.033);
    for (let i = 0; i < frames; i++) {
      feed(throwMotion(i * 0.033), 1);
      const body = trackedAvatar(tracker.predict(now() + 60), 1.8, {
        arms: TRUE,
      }).body!;
      worst = Math.max(
        worst,
        Math.abs(
          dist(body[JOINT.R_ELBOW], body[JOINT.R_WRIST]) / TRUE.foreArm - 1,
        ),
      );
    }
    expect(worst).toBeLessThan(0.085);
  });
});

describe("head turn read across the picture", () => {
  const face = (yaw: number, pitch = 0, roll = 0) => {
    const nose = { x: 0.01, y: 0.66, z: 0.1 };
    const [left, right] = earsFor(nose, { yaw, pitch, roll });
    return { nose, left, right };
  };
  it("reads back the turn, nod and tilt it was given", () => {
    for (const yaw of [-0.6, -0.2, 0, 0.3, 0.7])
      for (const roll of [-0.3, 0, 0.25]) {
        const f = face(yaw, 0, roll);
        const got = headAngles(f.nose, f.left, f.right, 0, RIG_HEAD)!;
        expect(got.yaw).toBeCloseTo(yaw, 2);
        expect(got.roll).toBeCloseTo(roll, 2);
        expect(got.pitch).toBeCloseTo(0, 2);
      }
    for (const pitch of [-0.4, 0.3])
      for (const yaw of [-0.4, 0, 0.5]) {
        const f = face(yaw, pitch);
        const got = headAngles(f.nose, f.left, f.right, 0, RIG_HEAD)!;
        expect(got.pitch).toBeCloseTo(pitch, 2);
        expect(got.yaw).toBeCloseTo(yaw, 2);
      }
    const yaws = [-0.6, -0.3, 0, 0.3, 0.6].map((yaw) => {
      const f = face(yaw);
      return headAngles(f.nose, f.left, f.right)!.yaw;
    });
    for (let i = 1; i < yaws.length; i++)
      expect(yaws[i]).toBeGreaterThan(yaws[i - 1]);
    const up = face(0, 0.4),
      down = face(0, -0.4);
    expect(headAngles(up.nose, up.left, up.right)!.pitch).toBeGreaterThan(0.2);
    expect(headAngles(down.nose, down.left, down.right)!.pitch).toBeLessThan(
      -0.2,
    );
  });
  it("is steady on a still head whose depth is noisy", () => {
    let state = 5;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32 - 0.5;
    };
    const turn = createHeadTurn();
    const weights = Array<number>(19).fill(1);
    const yaws: number[] = [];
    for (let i = 0; i < 300; i++) {
      const f = face(0);
      const joints = Array.from({ length: 19 }, () => ({ x: 0, y: 0, z: 0 }));
      // 3 cm of depth noise, 2 mm across the picture.
      const noisy = (p: typeof f.nose) => ({
        x: p.x + random() * 0.004,
        y: p.y + random() * 0.004,
        z: p.z + random() * 0.1,
      });
      joints[JOINT.NOSE] = noisy(f.nose);
      joints[JOINT.L_EAR] = noisy(f.left);
      joints[JOINT.R_EAR] = noisy(f.right);
      yaws.push(turn.update(joints, weights, 1000 + i * 33).yaw);
    }
    const mean = yaws.reduce((a, v) => a + v, 0) / yaws.length;
    const sd = Math.sqrt(
      yaws.reduce((a, v) => a + (v - mean) ** 2, 0) / yaws.length,
    );
    // It was 8.6° from depth; under 1.5° now.
    expect((sd * 180) / Math.PI).toBeLessThan(1.5);
    expect(Math.abs(mean)).toBeLessThan(0.03);
  });
  it("learns where straight ahead is, and eases back when the face is not seen", () => {
    const turn = createHeadTurn();
    const weights = Array<number>(19).fill(1);
    const frame = (pitch: number, yaw = 0) => {
      const f = face(yaw, pitch);
      const joints = Array.from({ length: 19 }, () => ({ x: 0, y: 0, z: 0 }));
      joints[JOINT.NOSE] = f.nose;
      joints[JOINT.L_EAR] = f.left;
      joints[JOINT.R_EAR] = f.right;
      return joints;
    };
    // A camera below the face sees the nose high all the time: that is level.
    let t = 0,
      a = turn.update(frame(0.3), weights, t);
    for (let i = 0; i < 900; i++) a = turn.update(frame(0.3), weights, (t += 33));
    expect(Math.abs(a.pitch)).toBeLessThan(0.03);
    for (let i = 0; i < 20; i++)
      a = turn.update(frame(0.3, 0.6), weights, (t += 33));
    expect(a.yaw).toBeGreaterThan(0.3);
    const unseen = Array<number>(19).fill(0);
    for (let i = 0; i < 60; i++)
      a = turn.update(frame(0.3, 0.6), unseen, (t += 33));
    expect(Math.abs(a.yaw)).toBeLessThan(0.05);
  });
  it("turns the avatar's head with the player's and keeps the ears their distance", () => {
    const { feed } = session();
    const t = feed({ headTilt: 0.3 }, 6);
    const turn = createHeadTurn();
    let angles = turn.update(t.joints, t.jointWeights, 0);
    for (let i = 1; i < 30; i++)
      angles = turn.update(t.joints, t.jointWeights, i * 33);
    expect(Math.abs(angles.roll)).toBeGreaterThan(0.2);
    const body = trackedAvatar(t, 1.8, { head: angles }).body!;
    expect(dist(body[JOINT.L_EAR], body[JOINT.R_EAR])).toBeCloseTo(
      2 * BODY.earHalf,
      3,
    );
    const level = solveBody(neutralPose());
    // The solved body's head is level, not pitched down.
    expect(level[JOINT.L_EAR].y).toBeCloseTo(level[JOINT.NOSE].y, 5);
  });
});

describe("gliding over a break in tracking", () => {
  const at = (x: number): PlayerPose => {
    const p = neutralPose();
    p.root.x = p.head.x = x;
    p.leftHand.x += x;
    p.rightHand.x += x;
    return { ...p, body: solveBody(p) };
  };
  it("turns a jump into a short glide that ends on the new pose", () => {
    const blend = createInertialBlend(180);
    let now = 0;
    for (let i = 0; i < 10; i++) blend.update(at(0), (now += 16));
    // Tracking returns 30 cm to the side.
    const first = blend.update(at(0.3), (now += 16), true);
    expect(first.head.x).toBeCloseTo(0, 5);
    expect(first.body![JOINT.L_ANKLE].x).toBeCloseTo(at(0).body![JOINT.L_ANKLE].x, 5);
    let before = first.head.x,
      biggest = 0;
    for (let i = 0; i < 14; i++) {
      const p = blend.update(at(0.3), (now += 16));
      expect(p.head.x).toBeGreaterThanOrEqual(before);
      biggest = Math.max(biggest, p.head.x - before);
      before = p.head.x;
    }
    // No single frame carries more than a seventh of the jump.
    expect(biggest).toBeLessThan(0.05);
    expect(before).toBeCloseTo(0.3, 5);
  });
  it("leaves ordinary movement alone, even a fast dodge", () => {
    const blend = createInertialBlend();
    let now = 0;
    for (let i = 0; i < 40; i++) {
      // 3 units a second, at 60 frames a second.
      const p = at(Math.min(0.55, i * 0.05));
      expect(blend.update(p, (now += 16.7))).toBe(p);
    }
  });
  it("catches a jump no body could make without being told", () => {
    const blend = createInertialBlend();
    blend.update(at(0), 0);
    blend.update(at(0), 16);
    expect(blend.update(at(0.4), 32).head.x).toBeCloseTo(0, 5);
  });
});

describe("feet that stay where they are put", () => {
  const bodyAt = (x: number) => {
    const p = neutralPose();
    p.root.x = p.head.x = x;
    return solveBody(p);
  };
  it("does not slide a foot under a small sway", () => {
    const feet = createFootPlanter();
    const start = feet.update(bodyAt(0), 0);
    for (let i = 1; i <= 60; i++) {
      const x = 0.08 * Math.sin(i / 10);
      const out = feet.update(bodyAt(x), i / 60);
      for (const ankle of [JOINT.L_ANKLE, JOINT.R_ANKLE]) {
        expect(out[ankle].x).toBeCloseTo(start[ankle].x, 5);
        expect(out[ankle].y).toBeCloseTo(BODY.ankle, 5);
      }
      // The hips do move, on legs that keep their length.
      expect(out[JOINT.L_HIP].x).toBeCloseTo(bodyAt(x)[JOINT.L_HIP].x, 5);
      for (const side of [0, 1]) {
        expect(
          dist(out[JOINT.L_HIP + side], out[JOINT.L_KNEE + side]),
        ).toBeCloseTo(BODY.thigh, 3);
        expect(
          dist(out[JOINT.L_KNEE + side], out[JOINT.L_ANKLE + side]),
        ).toBeCloseTo(BODY.shin, 3);
      }
    }
  });
  it("steps, one foot at a time, when the body has moved away", () => {
    const feet = createFootPlanter();
    feet.update(bodyAt(0), 0);
    let lifted = 0,
      both = 0,
      time = 0,
      out = bodyAt(0);
    // The body travels 40 cm to the right over 0.8 s and stops.
    for (let i = 1; i <= 120; i++) {
      time = i / 60;
      const x = Math.min(0.4, time * 0.5);
      out = feet.update(bodyAt(x), time);
      const up = [JOINT.L_ANKLE, JOINT.R_ANKLE].filter(
        (a) => out[a].y > BODY.ankle + 0.005,
      ).length;
      if (up) lifted++;
      if (up === 2) both++;
      // Never further from where it belongs than a step and a bit.
      for (const side of [0, 1])
        expect(
          Math.abs(out[JOINT.L_ANKLE + side].x - bodyAt(x)[JOINT.L_ANKLE + side].x),
        ).toBeLessThan(FOOT.drift + 0.16);
    }
    expect(lifted).toBeGreaterThan(8);
    expect(both).toBe(0);
    // Standing again: both feet under the body, flat on the floor.
    for (const side of [0, 1] as const) {
      expect(out[JOINT.L_ANKLE + side].x).toBeCloseTo(
        bodyAt(0.4)[JOINT.L_ANKLE + side].x,
        1,
      );
      expect(out[JOINT.L_ANKLE + side].y).toBeCloseTo(BODY.ankle, 5);
      expect(feet.planted(side)).toBe(true);
    }
  });
  it("leaves a foot the player lifted to the camera, and starts again after a gap", () => {
    const feet = createFootPlanter();
    feet.update(bodyAt(0), 0);
    const lifted = bodyAt(0);
    lifted[JOINT.R_ANKLE] = { ...lifted[JOINT.R_ANKLE], x: 0.4, y: 0.3 };
    expect(feet.update(lifted, 0.02)[JOINT.R_ANKLE]).toEqual(
      lifted[JOINT.R_ANKLE],
    );
    // A new round (time goes back): feet are where the body is, no step.
    const out = feet.update(bodyAt(0.5), 0);
    expect(out[JOINT.L_ANKLE].x).toBeCloseTo(bodyAt(0.5)[JOINT.L_ANKLE].x, 5);
  });
});
