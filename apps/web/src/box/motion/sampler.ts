import type { Vec3 } from "../../pov/physics";
import { twoBone } from "../../pov/body";
import type { FoePose } from "../opponentPose";
import { JOINT, JOINT_COUNT, SIZE, type Body, type Clip, type Rig } from "./types";
import { add, anySquareTo, cross, dot, length, mix, scale, sub, unit, v3 } from "./vec";

/**
 * A clip at a time gives a body. Also here: the body as bones and back (so
 * that nothing changes length), the mirror for a left-handed stance, and
 * the body as the `FoePose` the drawing takes.
 */

/** The body at `frame` of a clip (fractions are blended from the two frames either side). A loop wraps; anything else holds its ends. */
export function sampleClip(clip: Clip, frame: number): Body {
  const last = clip.frames - 1;
  let f = frame;
  if (clip.loop) f = ((f % clip.frames) + clip.frames) % clip.frames;
  else f = Math.max(0, Math.min(last, f));
  const a = Math.floor(f);
  const b = clip.loop ? (a + 1) % clip.frames : Math.min(last, a + 1);
  const k = f - a;
  const stride = JOINT_COUNT * 3;
  const at = (joint: number): Vec3 => {
    const i = a * stride + joint * 3,
      j = b * stride + joint * 3;
    const d = clip.data;
    return v3(d[i] + (d[j] - d[i]) * k, d[i + 1] + (d[j + 1] - d[i + 1]) * k, d[i + 2] + (d[j + 2] - d[i + 2]) * k);
  };
  return {
    hips: at(JOINT.hips),
    chest: at(JOINT.chest),
    head: at(JOINT.head),
    shoulders: [at(JOINT.shoulderL), at(JOINT.shoulderR)],
    elbows: [at(JOINT.elbowL), at(JOINT.elbowR)],
    wrists: [at(JOINT.wristL), at(JOINT.wristR)],
    feet: [at(JOINT.footL), at(JOINT.footR)],
  };
}

/** The clip at a time in seconds from its first frame. */
export const sampleAt = (clip: Clip, seconds: number): Body => sampleClip(clip, seconds * clip.fps);

const flip = (p: Vec3): Vec3 => v3(-p.x, p.y, p.z);
/** The body mirrored left to right: for a left-handed stance. Sideways changes sign and the two sides swap. */
export function mirrorBody(b: Body): Body {
  return {
    hips: flip(b.hips),
    chest: flip(b.chest),
    head: flip(b.head),
    shoulders: [flip(b.shoulders[1]), flip(b.shoulders[0])],
    elbows: [flip(b.elbows[1]), flip(b.elbows[0])],
    wrists: [flip(b.wrists[1]), flip(b.wrists[0])],
    feet: [flip(b.feet[1]), flip(b.feet[0])],
  };
}
/** A point mirrored the same way. */
export const mirrorPoint = flip;

/** The chest's own axes: x across (its right), y up the spine, z out of the chest. */
export function chestAxes(spine: Vec3, across: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const y = unit(spine);
  // Square to the spine: a shrugged shoulder tilts the line but not the axes much.
  const x = unit(sub(across, scale(y, dot(across, y))), anySquareTo(y));
  return { x, y, z: cross(x, y) };
}
const toLocal = (p: Vec3, a: { x: Vec3; y: Vec3; z: Vec3 }): Vec3 => v3(dot(p, a.x), dot(p, a.y), dot(p, a.z));
const toWorld = (p: Vec3, a: { x: Vec3; y: Vec3; z: Vec3 }): Vec3 =>
  add(add(scale(a.x, p.x), scale(a.y, p.y)), scale(a.z, p.z));

/** The body as bones. */
export function toRig(b: Body): Rig {
  const spine = unit(sub(b.chest, b.hips));
  const across = unit(sub(b.shoulders[1], b.shoulders[0]), v3(1, 0, 0));
  const axes = chestAxes(spine, across);
  const arm = (i: 0 | 1) => ({
    upper: toLocal(unit(sub(b.elbows[i], b.shoulders[i]), v3(0, -1, 0)), axes),
    fore: toLocal(unit(sub(b.wrists[i], b.elbows[i]), v3(0, 0, 1)), axes),
  });
  const left = arm(0),
    right = arm(1);
  return {
    hips: b.hips,
    spine,
    neck: unit(sub(b.head, b.chest)),
    across,
    upper: [left.upper, right.upper],
    fore: [left.fore, right.fore],
    feet: [b.feet[0], b.feet[1]],
  };
}

/** Bones back to a body, every bone at the game's own length. */
export function fromRig(r: Rig): Body {
  const spine = unit(r.spine);
  const across = unit(r.across, v3(1, 0, 0));
  const axes = chestAxes(spine, across);
  const chest = add(r.hips, scale(spine, SIZE.chest));
  const head = add(chest, scale(unit(r.neck), SIZE.head));
  const lift = scale(spine, SIZE.shoulderUp);
  const shoulders: [Vec3, Vec3] = [
    add(add(chest, scale(across, -SIZE.shoulder)), lift),
    add(add(chest, scale(across, SIZE.shoulder)), lift),
  ];
  const elbows = [0, 1].map((i) => add(shoulders[i], scale(unit(toWorld(r.upper[i], axes)), SIZE.upperArm))) as [Vec3, Vec3];
  const wrists = [0, 1].map((i) => add(elbows[i], scale(unit(toWorld(r.fore[i], axes)), SIZE.forearm))) as [Vec3, Vec3];
  return { hips: r.hips, chest, head, shoulders, elbows, wrists, feet: [r.feet[0], r.feet[1]] };
}

/** The glove as scene.ts draws it: on the line from shoulder to wrist, a little past the wrist. */
export const gloveOf = (shoulder: Vec3, wrist: Vec3): Vec3 =>
  add(shoulder, scale(sub(wrist, shoulder), 1 / SIZE.wristShare));
/** And back: the wrist for a glove. */
export const wristFor = (shoulder: Vec3, glove: Vec3): Vec3 => mix(glove, shoulder, 1 - SIZE.wristShare);

/** Which way the elbow bends: from the line shoulder-to-wrist out to the elbow. What `twoBone` takes as its pole. */
export function poleOf(shoulder: Vec3, elbow: Vec3, wrist: Vec3): Vec3 {
  const line = unit(sub(wrist, shoulder), v3(0, 0, 1));
  const out = sub(elbow, shoulder);
  const side = sub(out, scale(line, dot(out, line)));
  // A straight arm bends nowhere: say down, as a hanging elbow would.
  return length(side) > 1e-4 ? unit(side) : v3(0, -1, 0);
}

/** The every-frame part of a `FoePose` from a body: points, gloves, elbow directions, the turn of the shoulders. */
export function poseOf(b: Body): Pick<FoePose, "head" | "chest" | "hips" | "shoulders" | "gloves" | "poles" | "turn"> {
  const line = sub(b.shoulders[1], b.shoulders[0]);
  return {
    head: b.head,
    chest: b.chest,
    hips: b.hips,
    shoulders: [b.shoulders[0], b.shoulders[1]],
    gloves: [gloveOf(b.shoulders[0], b.wrists[0]), gloveOf(b.shoulders[1], b.wrists[1])],
    poles: [poleOf(b.shoulders[0], b.elbows[0], b.wrists[0]), poleOf(b.shoulders[1], b.elbows[1], b.wrists[1])],
    // As opponentPose.ts has it: positive takes its right shoulder back.
    turn: Math.atan2(-line.z, line.x),
  };
}

/**
 * A `FoePose` from elsewhere (the formula fall) as a body: the elbows are
 * solved the way scene.ts solves them, and the feet are put where scene.ts
 * draws them.
 */
export function bodyOfPose(p: FoePose): Body {
  const wrists = [0, 1].map((i) => wristFor(p.shoulders[i], p.gloves[i])) as [Vec3, Vec3];
  const elbows = [0, 1].map((i) => twoBone(p.shoulders[i], wrists[i], SIZE.upperArm, SIZE.forearm, p.poles[i])) as [Vec3, Vec3];
  const foot = (side: number, i: number): Vec3 => {
    const standing = v3(side * 0.15, 0.05, 0.02 + (i ? 0.08 : -0.08));
    return mix(standing, v3(side * 0.2, 0.06, 0.42), p.fallen);
  };
  return { hips: p.hips, chest: p.chest, head: p.head, shoulders: [p.shoulders[0], p.shoulders[1]], elbows, wrists, feet: [foot(-1, 0), foot(1, 1)] };
}

/** A body moved bodily by `by`. */
export function shiftBody(b: Body, by: Vec3): Body {
  const m = (p: Vec3) => add(p, by);
  return {
    hips: m(b.hips),
    chest: m(b.chest),
    head: m(b.head),
    shoulders: [m(b.shoulders[0]), m(b.shoulders[1])],
    elbows: [m(b.elbows[0]), m(b.elbows[1])],
    wrists: [m(b.wrists[0]), m(b.wrists[1])],
    feet: [m(b.feet[0]), m(b.feet[1])],
  };
}
