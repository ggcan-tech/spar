import type { Landmark, PoseFrame } from "@spar/protocol";
import type { PoseSource } from "../camera/pose";
import { add, scale, sub, twoBone, withinReach, length } from "./body";
import type { Vec3 } from "./physics";

/**
 * A scripted person for tests and the `?mocap=demo` check. It produces the same
 * PoseFrame a camera model would for a known body, so the tracker, retargeting
 * and avatar can be exercised end to end without a camera. Synthetic input says
 * nothing about real tracking accuracy.
 *
 * Person space, metres: +x the person's right, +y up, +z toward the camera.
 */
export interface SyntheticMotion {
  /** Whole body sideways, feet included. */
  step?: number;
  /** Hips sideways with the feet planted. */
  sway?: number;
  /** Shoulders sideways relative to the hips. */
  lean?: number;
  /** Hips down; knees bend and the torso tips forward. */
  crouch?: number;
  /** Whole body up, feet off the floor. */
  jump?: number;
  /** Wrist relative to that shoulder. Default: arms relaxed at the sides. */
  leftHand?: Vec3;
  rightHand?: Vec3;
  leftFootLift?: number;
  rightFootLift?: number;
  /** Head roll in radians; positive tips the head toward the person's right. */
  headTilt?: number;
  /** Knees, ankles and feet reported as not visible (framed out). */
  hideLegs?: boolean;
  /** Shoulders turned about the vertical axis, radians; positive brings the right shoulder toward the camera. */
  twist?: number;
}
export const PERSON = {
  hipHeight: 0.93,
  hipHalf: 0.1,
  torso: 0.48,
  shoulderHalf: 0.185,
  nose: 0.17,
  earHalf: 0.07,
  upperArm: 0.29,
  foreArm: 0.26,
  hand: 0.08,
  thigh: 0.43,
  shin: 0.42,
  ankle: 0.08,
  stance: 0.12,
} as const;
const CAMERA = {
  distance: 2.6,
  height: 1,
  tanHalfFov: Math.tan(0.436),
  aspect: 16 / 9,
};
const p3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** The person's joints in metres, keyed by MediaPipe pose landmark index. */
export function syntheticSkeleton(m: SyntheticMotion = {}): Map<number, Vec3> {
  const step = m.step ?? 0,
    crouch = m.crouch ?? 0,
    jump = m.jump ?? 0,
    lean = m.lean ?? 0;
  const hips = p3(step + (m.sway ?? 0), PERSON.hipHeight - crouch + jump, 0);
  const chest = add(
    hips,
    p3(
      lean,
      Math.sqrt(PERSON.torso ** 2 - lean ** 2) - crouch * 0.15,
      crouch * 0.4,
    ),
  );
  const tilt = m.headTilt ?? 0;
  const nose = add(chest, p3(Math.sin(tilt) * PERSON.nose, PERSON.nose, 0.09));
  const out = new Map<number, Vec3>();
  out.set(0, nose);
  for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) out.set(i, nose);
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1; // i = 0 is the person's left
    out.set(
      7 + i,
      add(
        nose,
        p3(
          side * PERSON.earHalf * Math.cos(tilt),
          -side * PERSON.earHalf * Math.sin(tilt) + 0.01,
          -0.09,
        ),
      ),
    );
    const twist = m.twist ?? 0;
    const shoulder = add(
      chest,
      p3(
        side * PERSON.shoulderHalf * Math.cos(twist),
        0,
        side * PERSON.shoulderHalf * Math.sin(twist),
      ),
    );
    const wrist = withinReach(
      shoulder,
      add(
        shoulder,
        (i ? m.rightHand : m.leftHand) ?? p3(side * 0.05, -0.5, 0.08),
      ),
      PERSON.upperArm + PERSON.foreArm - 0.005,
    );
    const elbow = twoBone(
      shoulder,
      wrist,
      PERSON.upperArm,
      PERSON.foreArm,
      p3(side * 0.3, -1, -0.5),
    );
    const forearm = sub(wrist, elbow);
    const knuckle = add(
      wrist,
      scale(forearm, PERSON.hand / Math.max(length(forearm), 1e-6)),
    );
    out.set(11 + i, shoulder);
    out.set(13 + i, elbow);
    out.set(15 + i, wrist);
    for (const k of [17, 19, 21]) out.set(k + i, knuckle);
    const hip = add(hips, p3(side * PERSON.hipHalf, 0, 0));
    const ankle = withinReach(
      hip,
      p3(
        step + side * PERSON.stance,
        PERSON.ankle + jump + ((i ? m.rightFootLift : m.leftFootLift) ?? 0),
        0,
      ),
      PERSON.thigh + PERSON.shin - 0.001,
    );
    out.set(23 + i, hip);
    out.set(
      25 + i,
      twoBone(hip, ankle, PERSON.thigh, PERSON.shin, p3(side * 0.15, 0, 1)),
    );
    out.set(27 + i, ankle);
    out.set(29 + i, add(ankle, p3(0, -0.06, -0.05)));
    out.set(31 + i, add(ankle, p3(side * 0.03, -0.06, 0.15)));
  }
  return out;
}

/**
 * One camera observation of the scripted person: image landmarks plus hip-centred world landmarks.
 * `depthGain` is the share of true depth the pose model reports (1 = exact). Where
 * things appear in the image is unaffected; only the reported depth changes.
 */
export function syntheticFrame(
  t: number,
  m: SyntheticMotion = {},
  depthGain = 1,
  /**
   * Where the camera sits: metres from the person and metres above the floor.
   * `aim` is the height it points at: a laptop on a desk is low and tipped up
   * at the player. Without it the camera is level, as it always was.
   */
  view: { distance?: number; height?: number; aim?: number } = {},
): PoseFrame {
  const distance = view.distance ?? CAMERA.distance,
    cameraHeight = view.height ?? CAMERA.height;
  const tilt =
    view.aim === undefined ? 0 : Math.atan2(view.aim - cameraHeight, distance);
  const cos = Math.cos(tilt),
    sin = Math.sin(tilt);
  const joints = syntheticSkeleton(m);
  /** A point as the camera has it: across, up, and how far along its line of sight. */
  const seen = (p: Vec3) => {
    const y = p.y - cameraHeight,
      z = p.z - distance;
    return { x: p.x, y: y * cos + z * sin, depth: y * sin - z * cos };
  };
  const hips = seen(scale(add(joints.get(23)!, joints.get(24)!), 0.5));
  const lm: Landmark[] = [],
    world: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    const p = seen(joints.get(i)!);
    const hidden = m.hideLegs === true && i >= 25;
    const v = hidden ? 0.1 : 0.95;
    // Pinhole camera. The image is not mirrored: the person's right appears
    // on the image's left.
    const height = 2 * p.depth * CAMERA.tanHalfFov;
    const width = height * CAMERA.aspect;
    lm.push({
      x: 0.5 - p.x / width,
      y: 0.5 - p.y / height,
      z: ((p.depth - hips.depth) / width) * depthGain,
      v,
    });
    world.push({
      x: -(p.x - hips.x),
      y: -(p.y - hips.y),
      z: (p.depth - hips.depth) * depthGain,
      v,
    });
  }
  return { t, lm, world, imageAspect: 1 / CAMERA.aspect };
}

const REST_HAND = p3(0.05, -0.5, 0.08);
/** Minimum-jerk ease, the usual shape of a point-to-point human reach. */
const ease = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * c * (10 - 15 * c + 6 * c * c);
};
const blend = (a: Vec3, b: Vec3, k: number) => add(a, scale(sub(b, a), k));
export interface ThrowStyle {
  /** Seconds from the cocked hand to full extension. A quick real throw is about 0.15. */
  drive?: number;
  /** Seconds the hand rests by the shoulder before the drive. */
  hold?: number;
  /** Turn the shoulders through the throw, as people do. */
  twist?: boolean;
  /** Where the hand is held before the throw, as an offset in metres from the usual spot. */
  aim?: { x: number; y: number };
}
export const THROW_RAISE = 0.35;
/** Where the scripted person holds the hand before a throw, relative to the right shoulder. */
export const THROW_COCK = { x: 0.14, y: 0.12 };
const THROW_RECOVER = 0.35;
/** Seconds a whole throwMotion takes, from the hand at rest back to rest. */
export const throwDuration = (style: ThrowStyle = {}) =>
  THROW_RAISE +
  (style.hold ?? 0.1) +
  (style.drive ?? 0.15) +
  0.25 +
  THROW_RECOVER;
/** Seconds into throwMotion at which the hand reaches full extension. */
export const throwReleaseAt = (style: ThrowStyle = {}) =>
  THROW_RAISE + (style.hold ?? 0.1) + (style.drive ?? 0.15);
/**
 * A right-handed overhand throw at the camera: raise the hand beside the head,
 * pause, drive it forward, follow through down and across. Wrist positions are
 * relative to the right shoulder. A script of a throw, not a recording of one.
 */
export function throwMotion(
  s: number,
  style: ThrowStyle = {},
): SyntheticMotion {
  const hold = style.hold ?? 0.1,
    drive = style.drive ?? 0.15,
    follow = 0.25;
  const cock = p3(
      THROW_COCK.x + (style.aim?.x ?? 0),
      THROW_COCK.y + (style.aim?.y ?? 0),
      -0.18,
    ),
    release = p3(0.03, 0.12, 0.5),
    end = p3(-0.12, -0.3, 0.3);
  const cocked = THROW_RAISE,
    driving = cocked + hold,
    released = driving + drive;
  let rightHand: Vec3, twist: number;
  if (s <= 0) [rightHand, twist] = [REST_HAND, 0];
  else if (s <= cocked) {
    const k = ease(s / THROW_RAISE);
    [rightHand, twist] = [blend(REST_HAND, cock, k), -0.44 * k];
  } else if (s <= driving) [rightHand, twist] = [cock, -0.44];
  else if (s <= released) {
    const k = ease((s - driving) / drive);
    [rightHand, twist] = [blend(cock, release, k), -0.44 + 0.79 * k];
  } else if (s <= released + follow) {
    const k = ease((s - released) / follow);
    [rightHand, twist] = [blend(release, end, k), 0.35 * (1 - k)];
  } else {
    const k = ease((s - released - follow) / THROW_RECOVER);
    [rightHand, twist] = [blend(end, REST_HAND, k), 0];
  }
  return { rightHand, twist: style.twist ? twist : 0 };
}

const pulse = (s: number, start: number, duration: number) => {
  const k = (s - start) / duration;
  return k <= 0 || k >= 1 ? 0 : Math.sin(Math.PI * k) ** 2;
};
/** The hand is held for a moment before each throw so the aim marker can be seen. */
const DEMO_THROW: ThrowStyle = { drive: 0.15, twist: true, hold: 0.6 };
/** Moments in the routine, between the arm movements, at which the person throws, and where each throw is aimed. */
const DEMO_THROWS = [
  { at: 3.3, aim: { x: 0, y: 0 } },
  { at: 12.2, aim: { x: -0.12, y: 0 } },
  { at: 14.6, aim: { x: 0.12, y: 0.05 } },
  { at: 18.4, aim: { x: 0, y: 0.1 } },
  { at: 21.9, aim: { x: -0.08, y: -0.06 } },
];
/** Looping routine that exercises every limb. Starts still so setup can finish. */
export function demoMotion(seconds: number, throws = true): SyntheticMotion {
  const s = seconds < 2 ? 0 : 2 + ((seconds - 2) % 22);
  const wave = pulse(s, 5, 4),
    arms = pulse(s, 9, 3);
  const active = throws
    ? DEMO_THROWS.find(
        ({ at }) => s >= at && s < at + throwDuration(DEMO_THROW),
      )
    : undefined;
  const thrown = active
    ? throwMotion(s - active.at, { ...DEMO_THROW, aim: active.aim })
    : undefined;
  return {
    ...(thrown ? { twist: thrown.twist } : {}),
    sway: 0.16 * pulse(s, 2, 1.5) - 0.16 * pulse(s, 3.5, 1.5),
    lean: 0.12 * pulse(s, 2, 1.5) - 0.12 * pulse(s, 3.5, 1.5),
    rightHand:
      thrown?.rightHand ??
      p3(
        0.05 + 0.2 * wave + 0.1 * wave * Math.sin(s * 9) + 0.42 * arms,
        -0.5 + 0.95 * wave + 0.5 * arms,
        0.08 + 0.1 * arms * Math.sin(s * 5),
      ),
    leftHand: p3(
      -0.05 - 0.42 * arms,
      -0.5 + 0.5 * arms + 0.25 * pulse(s, 10, 1.4),
      0.08,
    ),
    crouch: 0.32 * pulse(s, 12, 2.4),
    leftFootLift: 0.34 * pulse(s, 14.6, 1.8),
    jump: 0.22 * pulse(s, 16.6, 0.7),
    step: 0.2 * pulse(s, 17.6, 2.2),
    headTilt: 0.35 * pulse(s, 20, 1.6) - 0.35 * pulse(s, 21.6, 1.6),
  };
}

/** What the scripted person's camera and pipeline are like. */
export interface SyntheticSourceOptions {
  /** Poses a second (5–60). Default 30. */
  fps?: number;
  /** How long each pose takes to arrive after its own time, ms (0–200). Default 0. */
  delayMs?: number;
  /**
   * Things a real camera does: every 9 s the right wrist is not seen for a
   * quarter of a second, and every 14 s the whole body is lost for 0.3 s.
   */
  occlude?: boolean;
  /** What the person does at each moment. Default: the dodgeball routine. */
  motion?: (seconds: number) => SyntheticMotion;
}
/** The scripted frame at `seconds` into the routine, with its dropouts applied. */
export function demoFrame(
  t: number,
  seconds: number,
  occlude = false,
  motion: (seconds: number) => SyntheticMotion = demoMotion,
): PoseFrame {
  const frame = syntheticFrame(t, motion(seconds));
  if (!occlude) return frame;
  const wristGone = seconds % 9 >= 4 && seconds % 9 < 4.25;
  const bodyGone = seconds % 14 >= 11 && seconds % 14 < 11.3;
  if (wristGone || bodyGone)
    frame.lm = frame.lm.map((p, i) =>
      bodyGone || i === 16 || i === 18 || i === 20 || i === 22
        ? { ...p, v: 0.05 }
        : p,
    );
  return frame;
}

/** A PoseSource that plays demoMotion, throws included, at about 30 frames a second. */
export function createSyntheticPoseSource(
  options: SyntheticSourceOptions = {},
): PoseSource {
  const fps = Math.max(5, Math.min(60, options.fps || 30));
  const delay = Math.max(0, Math.min(200, options.delayMs || 0));
  const listeners = new Set<(frame: PoseFrame) => void>();
  const started = performance.now();
  let frames = 0,
    lastPoseAt = 0,
    stopped = false;
  const deliver = (frame: PoseFrame) => {
    if (stopped) return;
    frames++;
    lastPoseAt = frame.t;
    for (const cb of listeners) cb(frame);
  };
  const timer = setInterval(() => {
    const now = performance.now();
    const frame = demoFrame(
      now,
      (now - started) / 1000,
      options.occlude,
      options.motion,
    );
    if (delay) setTimeout(() => deliver(frame), delay);
    else deliver(frame);
  }, 1000 / fps);
  return {
    onFrame(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    fps: () => fps,
    inferenceMs: () => 0,
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
    delegate: () => "CPU",
    stats: () => ({
      frames,
      detected: frames,
      errors: 0,
      lastPoseAt,
      driver: null,
      pipelineP95Ms: delay,
    }),
  };
}
