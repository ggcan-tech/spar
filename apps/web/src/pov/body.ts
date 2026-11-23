import type { PlayerPose } from "./duel";
import type { Vec3 } from "./physics";

/**
 * Full-body skeleton carried by PlayerPose.body. Joint order is the wire format:
 * append only. Coordinates are player-local, like PlayerPose (+x the player's
 * right, +y up, +z toward the opponent), in the same game units as head/root.
 */
export const JOINT = {
  NOSE: 0,
  L_EAR: 1,
  R_EAR: 2,
  L_SHOULDER: 3,
  R_SHOULDER: 4,
  L_ELBOW: 5,
  R_ELBOW: 6,
  L_WRIST: 7,
  R_WRIST: 8,
  L_HIP: 9,
  R_HIP: 10,
  L_KNEE: 11,
  R_KNEE: 12,
  L_ANKLE: 13,
  R_ANKLE: 14,
  L_TOE: 15,
  R_TOE: 16,
  L_KNUCKLE: 17,
  R_KNUCKLE: 18,
} as const;
export const JOINT_COUNT = 19;
/** MediaPipe pose landmark feeding each joint (ears 7/8, index knuckles 19/20, toes 31/32). */
export const JOINT_LANDMARK = [
  0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32, 19, 20,
] as const;

/**
 * Canonical avatar proportions in game units (shoulder width 0.4, standing hip
 * height 1). Design constants for the rig, not measurements of the player.
 * The leg is 1 cm longer than the standing hip-to-ankle distance so a standing
 * knee keeps a small bend instead of snapping at full extension.
 */
export const BODY = {
  shoulderHalf: 0.2,
  hipHalf: 0.11,
  /** Shoulder line sits at this fraction of the hip-to-head distance. */
  spine: 0.72,
  upperArm: 0.3,
  foreArm: 0.27,
  hand: 0.09,
  thigh: 0.475,
  shin: 0.455,
  ankle: 0.08,
  foot: 0.17,
  stance: 0.13,
  earHalf: 0.075,
  /** The ear line sits this far behind the nose point. */
  earBack: 0.08,
} as const;

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const mixVec = (a: Vec3, b: Vec3, k: number): Vec3 =>
  v(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const unit = (a: Vec3, fallback: Vec3): Vec3 => {
  const n = length(a);
  return n > 1e-6 ? scale(a, 1 / n) : fallback;
};
const finiteVec = (p: Vec3 | undefined): p is Vec3 =>
  !!p && [p.x, p.y, p.z].every(Number.isFinite);

/**
 * Middle joint of a two-bone chain from `a` to `c`, bent toward `pole`.
 * A target beyond reach returns a straight, proportionally stretched chain; the
 * caller decides whether that is acceptable or pulls the target in first.
 */
export function twoBone(
  a: Vec3,
  c: Vec3,
  l1: number,
  l2: number,
  pole: Vec3,
): Vec3 {
  const d = sub(c, a);
  const dist = length(d);
  if (dist >= l1 + l2) return add(a, scale(d, l1 / (l1 + l2)));
  const dir = unit(d, v(0, -1, 0));
  const reach = Math.max(dist, Math.abs(l1 - l2) + 1e-4);
  const along = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  // Any perpendicular works when the pole is parallel to the chain.
  let side = sub(pole, scale(dir, dot(pole, dir)));
  if (length(side) < 1e-6)
    side = cross(dir, Math.abs(dir.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0));
  return add(add(a, scale(dir, along)), scale(unit(side, v(0, 0, 1)), out));
}

/**
 * One bone of a fixed length from `a` toward `b`. A single camera sees where a
 * joint is across the picture well and how far away it is badly, so the bone
 * keeps the sideways and vertical offset it was seen with and its depth is
 * solved from how much shorter than its true length it looks.
 *
 * The model's depth only says which way the bone points. A foreshortened arm
 * bone nearly always points at the camera, so that is assumed unless the model
 * clearly says otherwise; between the two the bone passes through the
 * picture's plane instead of flipping, and is drawn short there rather than
 * moved off the spot it was seen at.
 */
function fixedBone(a: Vec3, b: Vec3, bone: number): Vec3 {
  const d = sub(b, a);
  const seen = Math.hypot(d.x, d.y);
  if (seen >= bone) {
    // Seen a little longer than the bone: believed, so the joint stays where
    // the picture has it (the length is a percentile, and a lens stretches
    // things near the picture's edge). Past 8% it is pulled in.
    const k = Math.min(1, (bone * 1.08) / seen);
    return add(a, v(d.x * k, d.y * k, 0));
  }
  const deep = Math.sqrt(bone * bone - seen * seen);
  const band = Math.max(0.03, 0.25 * deep);
  const way = Math.max(-1, Math.min(1, d.z / band + 1));
  return add(a, v(d.x, d.y, way * deep));
}
/**
 * An arm on fixed-length bones: the elbow from the shoulder, the wrist from
 * the elbow. Without it the arm shrank whenever depth was under-reported and
 * nearly doubled when each joint was predicted separately mid-throw.
 */
export function armChain(
  shoulder: Vec3,
  elbow: Vec3,
  wrist: Vec3,
  upperArm: number = BODY.upperArm,
  foreArm: number = BODY.foreArm,
): { elbow: Vec3; wrist: Vec3 } {
  const e = fixedBone(shoulder, elbow, upperArm);
  // The forearm's direction is the one seen, from the seen elbow.
  const w = add(e, sub(fixedBone(elbow, wrist, foreArm), elbow));
  return { elbow: e, wrist: w };
}
export interface ArmLengths {
  upperArm: number;
  foreArm: number;
}
/**
 * The player's own arm bone lengths, in game units. A bone never looks longer
 * than it is, and looks its full length whenever it lies across the picture
 * (hanging arms, a hand out to the side), so the high end of what was seen
 * (the 90th percentile, to stay clear of noise) is the bone, kept within 0.85–1.25 of the rig's proportions.
 */
export function createArmRuler() {
  const seen: [number[], number[]] = [[], []];
  let lastAt = -Infinity;
  const estimate = (values: number[], rig: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    const high = sorted[Math.floor((sorted.length - 1) * 0.9)];
    return Math.max(rig * 0.85, Math.min(rig * 1.25, high));
  };
  return {
    /** Hip-relative joints with their weights (see TrackingResult), at time `t` in ms. */
    measure(joints: readonly Vec3[], weights: readonly number[], t: number) {
      if (!(t - lastAt >= 100) && t >= lastAt) return;
      lastAt = t;
      for (let i = 0; i < 2; i++) {
        const [s, e, w] = [
          JOINT.L_SHOULDER + i,
          JOINT.L_ELBOW + i,
          JOINT.L_WRIST + i,
        ];
        if (!(weights[s] >= 1 && weights[e] >= 1 && weights[w] >= 1)) continue;
        const flat = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y);
        seen[0].push(flat(joints[s], joints[e]));
        seen[1].push(flat(joints[e], joints[w]));
      }
      for (const values of seen) while (values.length > 240) values.shift();
    },
    /** Null until both arms have been seen for a couple of seconds. */
    lengths: (): ArmLengths | null =>
      seen[0].length < 20
        ? null
        : {
            upperArm: estimate(seen[0], BODY.upperArm),
            foreArm: estimate(seen[1], BODY.foreArm),
          },
    reset() {
      seen[0].length = seen[1].length = 0;
      lastAt = -Infinity;
    },
  };
}

/** Pull a chain target back to the chain's full length. */
export function withinReach(a: Vec3, c: Vec3, max: number): Vec3 {
  const d = sub(c, a);
  const dist = length(d);
  return dist > max ? add(a, scale(d, max / dist)) : c;
}

/**
 * Complete body generated from the four gameplay points alone. It drives the
 * training bot and fills any joint the camera cannot currently see. The head and
 * wrists land exactly on pose.head and the pose hands.
 */
export function solveBody(pose: PlayerPose): Vec3[] {
  const { root, head } = pose;
  const spine = sub(head, root);
  const right = unit(v(spine.y, -spine.x, 0), v(1, 0, 0));
  let chest = add(root, scale(spine, BODY.spine));
  const hands = [pose.leftHand, pose.rightHand];
  const reach = BODY.upperArm + BODY.foreArm;
  // A hand beyond arm's length leans the shoulders into it before anything stretches.
  for (let i = 0; i < 2; i++) {
    const shoulder = add(chest, scale(right, (i ? 1 : -1) * BODY.shoulderHalf));
    const d = sub(hands[i], shoulder);
    const excess = length(d) - reach;
    if (excess > 0)
      chest = add(chest, scale(unit(d, v()), Math.min(excess, 0.25) * 0.6));
  }
  // The shoulders turn toward the hand that is further forward: a throwing
  // arm brings its shoulder through with it. They used to stay square to the
  // court whatever the arms did.
  const turn = Math.max(
    -0.6,
    Math.min(0.6, (pose.rightHand.z - pose.leftHand.z) * 0.7),
  );
  const across = add(scale(right, Math.cos(turn)), v(0, 0, Math.sin(turn)));
  const out: Vec3[] = Array.from({ length: JOINT_COUNT }, () => v());
  out[JOINT.NOSE] = { ...head };
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    // Level with the nose point: 2 cm higher pitched the drawn head 14° down.
    out[JOINT.L_EAR + i] = add(
      add(head, scale(right, side * BODY.earHalf)),
      v(0, 0, -BODY.earBack),
    );
    const shoulder = add(chest, scale(across, side * BODY.shoulderHalf));
    const wrist = { ...hands[i] };
    const elbow = twoBone(
      shoulder,
      wrist,
      BODY.upperArm,
      BODY.foreArm,
      v(side * 0.35, -1, -0.5),
    );
    out[JOINT.L_SHOULDER + i] = shoulder;
    out[JOINT.L_ELBOW + i] = elbow;
    out[JOINT.L_WRIST + i] = wrist;
    out[JOINT.L_KNUCKLE + i] = add(
      wrist,
      scale(unit(sub(wrist, elbow), v(0, 0, 1)), BODY.hand),
    );
    const hip = add(root, v(side * BODY.hipHalf, 0, 0));
    const ankle = withinReach(
      hip,
      v(
        root.x + side * BODY.stance,
        BODY.ankle + Math.max(0, root.y - 1),
        root.z,
      ),
      BODY.thigh + BODY.shin,
    );
    out[JOINT.L_HIP + i] = hip;
    out[JOINT.L_KNEE + i] = twoBone(
      hip,
      ankle,
      BODY.thigh,
      BODY.shin,
      v(side * 0.2, 0, 1),
    );
    out[JOINT.L_ANKLE + i] = ankle;
    out[JOINT.L_TOE + i] = add(ankle, v(side * 0.03, -0.05, BODY.foot - 0.01));
  }
  return out;
}

/** Shape and envelope only. A valid body is not a claim of tracking accuracy. */
export function validBody(body: unknown, root: Vec3): body is Vec3[] {
  return (
    Array.isArray(body) &&
    body.length === JOINT_COUNT &&
    body.every(
      (p) =>
        finiteVec(p) &&
        p.y >= -0.5 &&
        p.y <= 4 &&
        Math.hypot(p.x - root.x, p.y - root.y, p.z - root.z) <= 2.5,
    )
  );
}

export function blendBody(
  a: Vec3[] | undefined,
  b: Vec3[] | undefined,
  t: number,
): Vec3[] | undefined {
  if (!b) return a?.map((p) => ({ ...p }));
  if (!a || a.length !== b.length) return b.map((p) => ({ ...p }));
  return b.map((p, i) => mixVec(a[i], p, t));
}

/** The body to draw: the tracked skeleton when present, otherwise the solved one. */
export const bodyOf = (pose: PlayerPose): Vec3[] =>
  pose.body && pose.body.length === JOINT_COUNT ? pose.body : solveBody(pose);
