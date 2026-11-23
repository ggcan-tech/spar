// Turns a recorded trial into the game's opponent.
//
// The recording is a person walking about a room. The game's opponent stands
// on one spot facing the player, with its own bone lengths. So, for every
// frame:
//  - the floor travel is taken out: everything is measured from the midpoint
//    of the two ankles, which keeps how far the hips are ahead of the feet
//    (the lunge) and loses where in the room it happened;
//  - the boxer is turned to face +z, by a heading that changes slowly (so a
//    punch's own twist of hips and shoulders is kept);
//  - the body is rebuilt bone by bone: each bone points the way it did in the
//    recording and has the game's length. Spine and arms never change length.
//
// Frames stay at the recording's 120 a second here, so events can be timed to
// 8 ms. The pack is written at 60.

/** The game's sizes, metres. They match opponentPose.ts and scene.ts. */
export const GAME = {
  /** Hips to chest, chest to head. */
  chest: 0.42,
  head: 0.27,
  /** Each shoulder from the chest, across; and how far above it. */
  shoulder: 0.19,
  shoulderUp: 0.02,
  upperArm: 0.3,
  forearm: 0.28,
  /** scene.ts draws the wrist a tenth of the way back from the glove to the shoulder. */
  wristShare: 0.9,
  /** Thigh and shin as drawn, the ankle's height, and how far the hip joints sit under the hips. */
  thigh: 0.5,
  shin: 0.48,
  ankle: 0.05,
  hipDrop: 0.04,
};
export const ARM = GAME.upperArm + GAME.forearm;

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => len(sub(a, b));
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a) => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** A running mean of ±w frames, applied twice: smooth, and no delay. */
function smooth(series, w) {
  const once = (s) => {
    const n = s.length;
    const sums = [0];
    for (const v of s) sums.push(sums[sums.length - 1] + v);
    return s.map((_, i) => {
      const lo = Math.max(0, i - w), hi = Math.min(n - 1, i + w);
      return (sums[hi + 1] - sums[lo]) / (hi - lo + 1);
    });
  };
  return once(once(series));
}

/** The joints of the recording that the game's figure is built from. */
const pick = (f) => ({
  root: f.root,
  shoulders: [f.lclavicle, f.rclavicle],
  elbows: [f.lhumerus, f.rhumerus],
  wrists: [f.lwrist, f.rwrist],
  // The middle of the head: between the base of the skull and its top.
  head: mid(f.upperneck, f.head),
  ankles: [f.ltibia, f.rtibia],
  hipJoints: [f.lhipjoint, f.rhipjoint],
  facing: f.headFacing,
});

/** Every point of a picked frame through `fn` (a, b, c are the frames before, at and after). */
const blend3 = (a, b, c) => {
  const p = (x, y, z) => [0, 1, 2].map((k) => 0.25 * x[k] + 0.5 * y[k] + 0.25 * z[k]);
  const out = {};
  for (const key of Object.keys(b))
    out[key] = Array.isArray(b[key][0]) ? b[key].map((_, i) => p(a[key][i], b[key][i], c[key][i])) : p(a[key], b[key], c[key]);
  return out;
};

/**
 * Which way the boxer faces in each frame, radians about the vertical
 * (0 is the recording's +z, positive toward its +x). Taken from the head,
 * which a boxer keeps on the opponent, and smoothed over about a second so
 * the quick turns of a punch are not in it.
 */
function headingOf(frames) {
  const raw = frames.map((f) => Math.atan2(f.facing[0], f.facing[2]));
  const unwrapped = [raw[0]];
  for (let i = 1; i < raw.length; i++) unwrapped.push(unwrapped[i - 1] + wrap(raw[i] - unwrapped[i - 1]));
  return smooth(unwrapped, 60);
}

/**
 * A trial made ready to convert: the joints that matter, lightly smoothed
 * (a quarter, a half, a quarter over neighbouring frames, so that halving
 * the frame rate later does not alias), the slow heading, and the scale.
 */
export function prepare(trial) {
  const picked = trial.frames.map(pick);
  const frames = picked.map((f, i) => (i === 0 || i === picked.length - 1 ? f : blend3(picked[i - 1], f, picked[i + 1])));
  const bone = (name) => trial.skeleton.bones.find((b) => b.name === name);
  // The recording's leg, hip joint to ankle; and how far the hip joints sit under the pelvis.
  const leg = (bone("lfemur").length + bone("ltibia").length + bone("rfemur").length + bone("rtibia").length) / 2;
  const drop = -(bone("lhipjoint").offset[1] + bone("rhipjoint").offset[1]) / 2;
  // The lowest an ankle gets is its height with the foot flat.
  let ankle = Infinity;
  for (const f of frames) ankle = Math.min(ankle, f.ankles[0][1], f.ankles[1][1]);
  // Legs set the scale of everything measured from the floor.
  return { name: trial.name, frames, heading: headingOf(frames), size: (GAME.thigh + GAME.shin) / leg, drop, ankle };
}

/**
 * Frames `from` to `to` of a prepared trial as the game's figure, at the
 * recording's rate. Each frame: hips, chest, head, shoulders, elbows, wrists,
 * feet (ankles), all in the opponent's frame (origin between its feet, +x its
 * right, +y up, +z the way it faces), plus `travel`: how far the midpoint of
 * the feet has moved along the way it faces since `from` (for steps).
 *
 * The heading is the slow one plus `offset`, or `fixed` for the whole stretch
 * when given: a punch is thrown at one place, so its clip keeps one heading.
 */
export function convertRange(prep, from, to, { fixed = null, offset = 0 } = {}) {
  const { size, drop, ankle } = prep;
  const out = [];
  let travel = 0;
  let before = null;
  for (let i = from; i <= to; i++) {
    const f = prep.frames[i];
    const h = fixed ?? prep.heading[i] + offset;
    const sin = Math.sin(h), cos = Math.cos(h);
    const origin = mid(f.ankles[0], f.ankles[1]);
    // Into the opponent's frame: forward is the heading, and its right is +x
    // (the recording has the left at +x, so sideways changes sign).
    const turn = (v) => [-(v[0] * cos - v[2] * sin), v[1], v[0] * sin + v[2] * cos];
    const place = (p) => turn(sub(p, origin));
    const hipsRaw = place(f.root);
    // Height: the bent leg scaled to the game's leg, between the game's own ankle and hip joint.
    const hips = [hipsRaw[0] * size, GAME.ankle + GAME.hipDrop + (f.root[1] - ankle - drop) * size, hipsRaw[2] * size];
    // Each bone: the recording's direction, the game's length.
    const shoulderMid = mid(f.shoulders[0], f.shoulders[1]);
    const spine = unit(turn(sub(shoulderMid, f.root)));
    const chest = add(hips, scale(spine, GAME.chest));
    const head = add(chest, scale(unit(turn(sub(f.head, shoulderMid))), GAME.head));
    const across = unit(turn(sub(f.shoulders[1], f.shoulders[0])));
    // The line of the hips, for timing a punch's first movement; not drawn.
    const hipLine = unit(turn(sub(f.hipJoints[1], f.hipJoints[0])));
    const lift = scale(spine, GAME.shoulderUp);
    const shoulders = [add(add(chest, scale(across, -GAME.shoulder)), lift), add(add(chest, scale(across, GAME.shoulder)), lift)];
    const elbows = [0, 1].map((s) => add(shoulders[s], scale(unit(turn(sub(f.elbows[s], f.shoulders[s]))), GAME.upperArm)));
    const wrists = [0, 1].map((s) => add(elbows[s], scale(unit(turn(sub(f.wrists[s], f.elbows[s]))), GAME.forearm)));
    const feet = [0, 1].map((s) => {
      const p = place(f.ankles[s]);
      return [p[0] * size, GAME.ankle + (f.ankles[s][1] - ankle) * size, p[2] * size];
    });
    if (before) travel += ((origin[0] - before[0]) * sin + (origin[2] - before[2]) * cos) * size;
    before = origin;
    out.push({ hips, chest, head, shoulders, elbows, wrists, feet, travel, heading: h, across, hipLine });
  }
  return out;
}

/** The glove as scene.ts draws it: on the line from shoulder to wrist, a little past the wrist. */
export const gloveOf = (shoulder, wrist) => add(shoulder, scale(sub(wrist, shoulder), 1 / GAME.wristShare));

/** A pose mirrored left to right: sideways changes sign and the two sides swap. */
export function mirrorFrame(f) {
  const m = (p) => [-p[0], p[1], p[2]];
  const swap = (pair) => [m(pair[1]), m(pair[0])];
  return {
    ...f,
    hips: m(f.hips),
    chest: m(f.chest),
    head: m(f.head),
    shoulders: swap(f.shoulders),
    elbows: swap(f.elbows),
    wrists: swap(f.wrists),
    feet: swap(f.feet),
  };
}
