import type { Landmark, PoseFrame } from "@spar/protocol";
import { createArmRuler, type ArmLengths } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import { syntheticSkeleton, type SyntheticMotion } from "../../pov/syntheticBody";
import { createPovTracker, type TrackingResult } from "../../pov/tracking";
import { createPunchReader, type Punch, type PunchStart, type PunchTuning } from "../punch";
import { AT_REST, punchMotion, stance, type Hand, type PunchShape, type PunchStyle } from "../scriptedBoxer";
import { calibrateAim, type AimMarks, type AimSetup, type AimSource } from "./aim";
import { createContactReader, type ContactEvent, type ContactInput, type ContactReader } from "./contact";
import { createRangeReader, type RangeReading } from "./range";

/**
 * For tests only: the scripted person, seen by a camera at any height and
 * tilt, with noise set in centimetres at the player, through the real tracker
 * and the real punch reader. Taken from the perception study's harness
 * (docs/production/reviews/2026-11-13-real-scratch/perception).
 *
 * A scripted person is not a camera. Every number made with this says what
 * the arithmetic does, not what a room does.
 */

/** The tracker calls the shoulders 0.4 wide; the scripted person's are 0.37 m. */
export const M = 0.37 / 0.4;
export const TAN = Math.tan(0.436),
  ASPECT = 16 / 9;
export interface Cam {
  height: number;
  distance: number;
  /** Radians; positive looks up. */
  tilt: number;
}
export const cam = (height: number, distance: number, aim = 1.2): Cam => ({
  height,
  distance,
  tilt: Math.atan2(aim - height, distance),
});
/** The study's six camera places: [name, metres above the floor / metres away]. */
export const CAMS: [string, Cam][] = [
  ["low table 0.5/1.8", cam(0.5, 1.8)],
  ["desk laptop 0.75/2.0", cam(0.75, 2.0)],
  ["chest 1.0/2.6", cam(1.0, 2.6)],
  ["monitor 1.3/2.2", cam(1.3, 2.2)],
  ["tv top 1.6/2.4", cam(1.6, 2.4)],
  ["shelf 2.0/2.4", cam(2.0, 2.4)],
];
export interface Extra {
  /** Whole body toward the camera, metres (negative: a step back). */
  forward?: number;
  /** Shoulders and head back with the hips where they were, metres at shoulder height. */
  leanBack?: number;
  /** Person size: 1 is 1.75 m tall. */
  size?: number;
}
export function skeleton(m: SyntheticMotion, extra: Extra = {}): Map<number, Vec3> {
  const j = syntheticSkeleton(m);
  const k = extra.size ?? 1;
  const hipY = (j.get(23)!.y + j.get(24)!.y) / 2;
  const out = new Map<number, Vec3>();
  for (const [i, p] of j) {
    let z = p.z;
    if (extra.leanBack && p.y > hipY) z -= extra.leanBack * Math.min(1.4, (p.y - hipY) / 0.48);
    out.set(i, { x: p.x * k, y: p.y * k, z: z * k + (extra.forward ?? 0) });
  }
  return out;
}
/** The same pinhole camera as syntheticFrame, with the tilt given outright. */
export function frameOf(t: number, joints: Map<number, Vec3>, c: Cam, depthGain = 1): PoseFrame {
  const cos = Math.cos(c.tilt),
    sin = Math.sin(c.tilt);
  const seen = (p: Vec3) => {
    const y = p.y - c.height,
      z = p.z - c.distance;
    return { x: p.x, y: y * cos + z * sin, depth: y * sin - z * cos };
  };
  const a = joints.get(23)!,
    b = joints.get(24)!;
  const hips = seen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const lm: Landmark[] = [],
    world: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    const p = seen(joints.get(i)!);
    const height = 2 * p.depth * TAN,
      width = height * ASPECT;
    lm.push({ x: 0.5 - p.x / width, y: 0.5 - p.y / height, z: ((p.depth - hips.depth) / width) * depthGain, v: 0.95 });
    world.push({ x: -(p.x - hips.x), y: -(p.y - hips.y), z: (p.depth - hips.depth) * depthGain, v: 0.95 });
  }
  return { t, lm, world, imageAspect: 1 / ASPECT };
}
export function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
export interface Noise {
  seed: number;
  /** Metres, in the picture, at the player. */
  sigma: number;
  /** Metres of reported depth. */
  depth: number;
  /** How much of one pose's error carries to the next (0 = fresh each pose). */
  rho?: number;
  /** Apply `sigma` and `depth` to every landmark. Default: only elbows, wrists and hands; the trunk, face and legs get 4 mm and 3 cm. */
  all?: boolean;
}
const LIMB = new Set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
export function noiseMaker(n: Noise) {
  const random = seeded(n.seed);
  const gauss = () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += random();
    return (sum - 3) * Math.SQRT2;
  };
  const rho = n.rho ?? 0;
  const state = new Map<string, number>();
  const ar = (key: string, s: number) => {
    const next = rho * (state.get(key) ?? 0) + Math.sqrt(1 - rho * rho) * gauss() * s;
    state.set(key, next);
    return next;
  };
  return (frame: PoseFrame, c: Cam): PoseFrame => {
    const h = 2 * c.distance * TAN,
      w = h * ASPECT;
    const sg = (i: number) => (n.all || LIMB.has(i) ? n.sigma : Math.min(n.sigma, 0.004));
    const dp = (i: number) => (n.all || LIMB.has(i) ? n.depth : Math.min(n.depth, 0.03));
    return {
      ...frame,
      lm: frame.lm.map((p, i) => ({
        ...p,
        x: p.x + ar(`x${i}`, sg(i) / w),
        y: p.y + ar(`y${i}`, sg(i) / h),
        z: p.z + ar(`z${i}`, dp(i) / w),
      })),
      world: frame.world!.map((p, i) => ({
        ...p,
        x: p.x + ar(`wx${i}`, sg(i)),
        y: p.y + ar(`wy${i}`, sg(i)),
        z: p.z + ar(`wz${i}`, dp(i)),
      })),
    };
  };
}
export interface RunOptions {
  fps?: number;
  cam?: Cam;
  depthGain?: number;
  noise?: Noise;
  /** Share of one frame by which the frames are shifted against the motion. */
  phase?: number;
  tuning?: Partial<PunchTuning>;
  extra?: (s: number) => Extra;
  size?: number;
  /** Do not raise the guard before the motion (range and head tests stand as they are). */
  noGuard?: boolean;
  /** Called for the poses before the motion too, with `s` below zero. */
  early?: boolean;
  /** Change a frame before the tracker has it: hide a landmark, say. */
  fault?: (frame: PoseFrame, s: number) => PoseFrame;
}
export interface PoseSeen {
  /** Seconds into the motion. */
  s: number;
  /** The pose's own time, ms: when the camera took it. */
  t: number;
  result: TrackingResult;
  frame: PoseFrame;
  clean: PoseFrame;
  arms: ArmLengths | null;
  /** What the punch reader made of this pose. */
  read: { starts: PunchStart[]; punches: Punch[]; busy: [boolean, boolean] };
  /** The reader's own measure of each hand's jitter. */
  jitter: [number, number];
}
/** The scripted person through the real tracker and punch reader. `s` is seconds into `motion`. */
export function runBoxer(
  motion: (s: number) => SyntheticMotion,
  seconds: number,
  o: RunOptions = {},
  onPose?: (p: PoseSeen) => void,
) {
  const step = 1000 / (o.fps ?? 30);
  const c = o.cam ?? cam(1.0, 2.6, 1.0);
  const noise = o.noise ? noiseMaker(o.noise) : null;
  const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative", hiddenHeadFromShoulders: true });
  const reader = createPunchReader(o.tuning);
  const ruler = createArmRuler();
  const starts: { s: number; hand: string; shape: string; target: string }[] = [];
  const punches: { s: number; hand: string; shape: string; target: string; power: number }[] = [];
  let t = 1000;
  const size = o.size ?? 1;
  const feed = (m: SyntheticMotion, s: number | null, extra: Extra = {}, before = 0) => {
    t += step;
    const clean = frameOf(t, skeleton(m, { size, ...extra }), c, o.depthGain ?? 1);
    let frame = noise ? noise(clean, c) : clean;
    if (o.fault && s !== null) frame = o.fault(frame, s);
    const result = tracker.update(frame, t);
    if (result.valid && result.joints && result.jointWeights) ruler.measure(result.joints, result.jointWeights, t);
    const arms = ruler.lengths();
    const read = reader.update(result, t, arms);
    if (s !== null) {
      for (const p of read.starts) starts.push({ s, hand: p.hand, shape: p.shape, target: p.target });
      for (const p of read.punches) punches.push({ s, hand: p.hand, shape: p.shape, target: p.target, power: p.power });
    }
    if (s !== null || o.early)
      onPose?.({
        s: s ?? before,
        t,
        result,
        frame,
        clean,
        arms,
        read: { ...read, busy: reader.busy(t) },
        jitter: reader.jitter(),
      });
    return result;
  };
  const frames = Math.round(1500 / step);
  for (let i = 0; i < frames; i++) feed(AT_REST, null, {}, -3 + (i * step) / 1000);
  if (!o.noGuard)
    for (let s = 0; s < 1.4; s += step / 1000) {
      const cc = Math.min(1, s / 0.35);
      const k = cc * cc * cc * (10 - 15 * cc + 6 * cc * cc);
      const up = stance();
      const rest = { x: 0.05, y: -0.5, z: 0.08 };
      const blend = (hand: "leftHand" | "rightHand", side: number) => ({
        x: side * rest.x + (up[hand]!.x - side * rest.x) * k,
        y: rest.y + (up[hand]!.y - rest.y) * k,
        z: rest.z + (up[hand]!.z - rest.z) * k,
      });
      feed({ leftHand: blend("leftHand", -1), rightHand: blend("rightHand", 1) }, null, {}, -1.4 + s);
    }
  const phase = (o.phase ?? 0) * (step / 1000);
  for (let i = 0; i * (step / 1000) < seconds; i++) {
    const s = i * (step / 1000) + phase;
    feed(motion(s), s, o.extra?.(s) ?? {});
  }
  return { starts, punches };
}
export const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
export const rms = (v: number[]) => (v.length ? Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) : NaN);
/** The spread of values about their own mean. */
export const spread = (v: number[]) => {
  const m = mean(v);
  return rms(v.map((x) => x - m));
};
export const pct = (v: number[], q: number) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
export const ease = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * c * (10 - 15 * c + 6 * c * c);
};
export const f0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : "–");
export const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "–");

/** Both arms straight out at the screen at shoulder height. */
export const ARMS_OUT: SyntheticMotion = { leftHand: { x: 0, y: 0, z: 0.6 }, rightHand: { x: 0, y: 0, z: 0.6 } };
/** Between two motions, hand for hand. */
export function blend(a: SyntheticMotion, b: SyntheticMotion, k: number): SyntheticMotion {
  const mix = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, z: p.z + (q.z - p.z) * k });
  return { leftHand: mix(a.leftHand!, b.leftHand!), rightHand: mix(a.rightHand!, b.rightHand!) };
}
/** How long the set-up script takes before the motion begins, seconds. */
export const SETUP_S = 1.6;
export interface ReadPose extends PoseSeen {
  /** Seconds into the motion that follows the set-up; negative during it. */
  s: number;
  range: RangeReading;
  /** The aim set-up, once the second with the arms out is over. */
  setup: AimSetup | null;
}
/**
 * The scripted person does the game's set-up, then `motion`: from the guard
 * the arms go straight out at the screen for a second, come back, and the
 * motion starts. The range reader takes home during the guard before it, and
 * the aim set-up is made from the second with the arms out, as the game would.
 * `lensTan` is what the game believes of the lens; the rig's own is `TAN`.
 */
export function runWithSetup(
  motion: (s: number) => SyntheticMotion,
  seconds: number,
  o: RunOptions & { lensTan?: number; setupRange?: number } = {},
  onPose?: (p: ReadPose) => void,
): { setup: AimSetup | null; starts: { s: number; hand: string }[] } {
  const guard = stance();
  const script = (s: number): SyntheticMotion => {
    if (s < 0.3) return blend(guard, ARMS_OUT, ease(s / 0.3));
    if (s < 1.1) return ARMS_OUT;
    if (s < 1.4) return blend(ARMS_OUT, guard, ease((s - 1.1) / 0.3));
    return s < SETUP_S ? guard : motion(s - SETUP_S);
  };
  const range = createRangeReader({ lensTan: o.lensTan ?? TAN });
  const held: AimSource[] = [];
  let setup: AimSetup | null = null;
  const run = runBoxer(script, SETUP_S + seconds, { ...o, early: true, extra: o.extra ? (s) => o.extra!(s - SETUP_S) : undefined }, (p) => {
    const r = range.update(p.frame, p.t);
    if (p.s < 0) return;
    if (p.s >= 0.45 && p.s <= 1.05) held.push(p.result);
    if (p.s > 1.1 && !setup) setup = calibrateAim(held, r.units * (o.setupRange ?? 1), p.arms);
    onPose?.({ ...p, s: p.s - SETUP_S, range: r, setup });
  });
  return { setup, starts: run.starts.map((q) => ({ s: q.s - SETUP_S, hand: q.hand })) };
}

/** One scripted punch: when it starts (seconds into the motion), which hand, which shape, how. */
export interface Thrown {
  at: number;
  hand: Hand;
  shape: PunchShape;
  style?: PunchStyle;
}
/** How long a scripted punch takes from its first movement to the hand back in the guard, seconds. */
export const lasts = (p: Thrown) => (p.style?.extend ?? 0.18) + (p.style?.hold ?? 0.04) + (p.style?.back ?? 0.22);
/** A motion that throws the listed punches from the guard, one at a time. */
export const throwsOf =
  (list: readonly Thrown[], idle: () => SyntheticMotion = () => stance()) =>
  (s: number): SyntheticMotion => {
    for (const p of list) {
      const q = s - p.at;
      if (q >= 0 && q < lasts(p)) return { ...idle(), ...punchMotion(p.hand, p.shape, q, p.style) };
    }
    return idle();
  };
/**
 * The scripted person does the set-up and then `motion`, through the tracker,
 * the punch reader and the contact reader, as the game would wire them. `aim`
 * hands the contact reader the set-up and the range for zones in real
 * distances. `tamper` may change what the contact reader is given: withhold a
 * confirmation, say.
 */
export function runContact(
  motion: (s: number) => SyntheticMotion,
  seconds: number,
  o: RunOptions & { aim?: boolean; marks?: AimMarks; tamper?: (input: ContactInput, p: ReadPose) => ContactInput } = {},
  onPose?: (p: ReadPose, events: ContactEvent[]) => void,
): { events: (ContactEvent & { s: number })[]; contact: ContactReader; setup: AimSetup | null } {
  const contact = createContactReader();
  const events: (ContactEvent & { s: number })[] = [];
  const run = runWithSetup(motion, seconds, o, (p) => {
    let input: ContactInput = {
      t: p.t,
      tracking: p.result,
      arms: p.arms,
      starts: p.read.starts,
      punches: p.read.punches,
      busy: p.read.busy,
      jitter: p.jitter,
      aim: o.aim && p.setup ? { setup: p.setup, range: p.range.units, marks: o.marks } : null,
    };
    // The contact reader comes in when the set-up is over: arms held out at the screen are not punches.
    if (p.s < -0.2) return onPose?.(p, []);
    if (o.tamper) input = o.tamper(input, p);
    const now = contact.update(input);
    for (const e of now) events.push({ ...e, s: p.s });
    onPose?.(p, now);
  });
  return { events, contact, setup: run.setup };
}
