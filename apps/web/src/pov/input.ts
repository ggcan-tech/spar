import type { HandFrame } from "./hands";
import type { TrackingResult } from "./tracking";
import { COURT, type PlayerPose } from "./duel";
import { LM, type Landmark } from "@spar/protocol";
import type { FingerVisual } from "./scene";
import type { Vec3 } from "./physics";
import {
  BODY,
  JOINT,
  JOINT_COUNT,
  add,
  armChain,
  dot,
  length,
  mixVec,
  scale,
  solveBody,
  sub,
  twoBone,
  validBody,
  withinReach,
  type ArmLengths,
} from "./body";
import { earsFor, type HeadAngles } from "./headTurn";

export const DODGE_SENSITIVITY = { default: 1.8, min: 1, max: 2.5 } as const;
const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/**
 * The dodge gain that fits the picture. `shoulderX` is the middle of the
 * shoulders across the image (0 to 1), `span` the shoulder width in image
 * heights, `widthOverHeight` the picture's shape.
 *
 * The court is 0.6 wide each side. If the player would have to step out of the
 * picture to reach its edge (a phone held upright, or standing off-centre),
 * the gain is raised so that 80% of the room they have is enough. It is never
 * lowered below the default: small movements covering the court is the chosen
 * feel, and how much floor the player really has is not something a camera sees.
 */
export function fitSensitivity(
  shoulderX: number,
  span: number,
  widthOverHeight: number,
): number {
  if (
    ![shoulderX, span, widthOverHeight].every(Number.isFinite) ||
    span <= 0 ||
    widthOverHeight <= 0
  )
    return DODGE_SENSITIVITY.default;
  // Room to the nearer side, keeping a tenth of the picture's width as margin
  // and the whole shoulder inside it, in image heights and then in game units.
  const side = Math.min(shoulderX, 1 - shoulderX) - 0.1;
  const room = ((side * widthOverHeight - span / 2) * 0.4) / span;
  if (!(room > 0)) return DODGE_SENSITIVITY.max;
  return (
    Math.round(
      clamp(
        COURT.halfWidth / (0.8 * room),
        DODGE_SENSITIVITY.default,
        DODGE_SENSITIVITY.max,
      ) * 10,
    ) / 10
  );
}

/**
 * A limit with a soft knee: unchanged up to `knee` of the limit, then eased so
 * the limit is approached and never crossed. A hard clamp stopped the avatar
 * dead at the court's edge while the player was still moving.
 */
export function softLimit(value: number, limit: number, knee = 0.75): number {
  const size = Math.abs(value),
    start = limit * knee,
    room = limit - start;
  if (!(size > start) || !(room > 0)) return clamp(value, -limit, limit);
  return Math.sign(value) * (start + room * Math.tanh((size - start) / room));
}

/**
 * Movement scale (CORE.md 2.5). "classic" is the dodgeball's gain on its
 * narrow court. "A" is that same 1.8 gain on the wide lane; "B" is the curve:
 * exact near the middle (1.8, as the dodgeball), rising to 3.2 near the edge,
 * stopped softly at the lane wall. In A and B the body's shape and lean are
 * 1:1; only where you stand is scaled, the whole body moved as one piece.
 */
export const MOVE: { mode: "classic" | "A" | "B" } = { mode: "classic" };
/** Body units (2.5 shoulder widths) of sideways offset → game metres, on the wide lane. */
export function laneOf(x: number): number {
  return softLimit(1.8 * x + 1.1667 * x * Math.abs(x), 1.6, 0.85);
}
export const laneLinear = (x: number) => softLimit(1.8 * x, 1.6, 0.85);

/** What the avatar is fitted with beyond the tracker's joints. */
export interface Rig {
  /** The player's own arm bone lengths (see createArmRuler); arms are left as seen when absent. */
  arms?: ArmLengths;
  /** Head turn read across the picture; the ears as the model reports them when absent. */
  head?: HeadAngles;
}

/** Gameplay gain, after tracking/filtering. No new delay or inferred movement. */
export function trackedPose(t: TrackingResult, sensitivity = 1): PlayerPose {
  const lateral = clamp(
    Number.isFinite(sensitivity) ? sensitivity : 1,
    DODGE_SENSITIVITY.min,
    DODGE_SENSITIVITY.max,
  );
  // Gentler vertical gain keeps a small duck useful without a large eye-height jump.
  const vertical = 1 + (lateral - 1) * 0.5;
  // Court limits constrain the avatar, not the game clock. A deep crouch can
  // reach the floor without turning an otherwise observed body into a pause.
  const rootY = clamp(1 + t.root.y * vertical, 0.1, 2.2);
  const wide = MOVE.mode !== "classic";
  const rootX = wide ? (MOVE.mode === "B" ? laneOf(t.root.x) : laneLinear(t.root.x)) : softLimit(t.root.x * lateral, COURT.halfWidth);
  const head = {
    // On the wide lane the head keeps its real offset from the hips: a lean is a lean.
    x: wide ? softLimit(rootX + (t.head.x - t.root.x), COURT.headHalfWidth) : softLimit(t.head.x * lateral, COURT.headHalfWidth),
    y: clamp(1.65 + t.head.y * vertical, 0.2, 3.1),
    z: t.head.z,
  };
  // The dodge gain moves the head further than the body really leaned. The
  // arms ride the chest, so the hands shift by the chest's share of that
  // extra: otherwise a lean with the hand up stretches one arm and shortens
  // the other, and the hand slides the wrong amount against the eye.
  const nose =
    (t.jointWeights?.[JOINT.NOSE] ?? 0) > 0
      ? t.joints?.[JOINT.NOSE]
      : undefined;
  const ride = nose
    ? {
        x: (head.x - (rootX + nose.x)) * BODY.spine,
        y: (head.y - (rootY + nose.y)) * BODY.spine,
      }
    : { x: 0, y: 0 };
  const hand = (p: typeof t.head) => ({
    x: rootX + p.x + ride.x,
    y: rootY + p.y + ride.y,
    z: t.root.z + p.z,
  });
  return {
    head,
    root: { x: rootX, y: rootY, z: t.root.z },
    leftHand: hand(t.leftHand),
    rightHand: hand(t.rightHand),
  };
}

/**
 * Retarget the observed skeleton onto the avatar. Limbs keep the player's own
 * shape 1:1; the dodge gain already applied to pose.root/pose.head is absorbed
 * by a shear up the spine, so the drawn head lands on the head the game tests
 * for hits and the drawn wrists land on the hands that throw. Legs are solved
 * from the observed feet so they stay on the floor at any gain. Joints the camera
 * cannot see cross-fade to the solved body.
 */
export function trackedBody(
  t: TrackingResult,
  pose: PlayerPose,
  sensitivity = 1,
  rig: Rig = {},
): Vec3[] {
  const base = solveBody(pose);
  const arms = rig.arms;
  const turned = rig.head ? earsFor : null;
  const rel = t.joints,
    weight = t.jointWeights;
  if (
    !rel ||
    !weight ||
    rel.length !== JOINT_COUNT ||
    weight.length !== JOINT_COUNT
  )
    return base;
  const lateral = clamp(
    Number.isFinite(sensitivity) ? sensitivity : 1,
    DODGE_SENSITIVITY.min,
    DODGE_SENSITIVITY.max,
  );
  const vertical = 1 + (lateral - 1) * 0.5;
  const out = base.map((p) => ({ ...p }));
  const nose = rel[JOINT.NOSE];
  const shear =
    weight[JOINT.NOSE] > 0
      ? {
          x: pose.head.x - (pose.root.x + nose.x),
          y: pose.head.y - (pose.root.y + nose.y),
        }
      : { x: 0, y: 0 };
  /** Hip-relative observation placed on the avatar, sheared by height `k`. */
  const place = (j: number, k: number): Vec3 => ({
    x: pose.root.x + rel[j].x + shear.x * k,
    y: pose.root.y + rel[j].y + shear.y * k,
    z: pose.root.z + rel[j].z,
  });
  const fade = (j: number, observed: Vec3, k = weight[j]) => {
    out[j] = mixVec(out[j], observed, clamp(k, 0, 1));
  };
  // Head: x/y are exactly the gameplay head; depth and tilt come from the camera.
  fade(JOINT.NOSE, { x: pose.head.x, y: pose.head.y, z: pose.root.z + nose.z });
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const ear = JOINT.L_EAR + i,
      shoulder = JOINT.L_SHOULDER + i,
      elbow = JOINT.L_ELBOW + i,
      wrist = JOINT.L_WRIST + i,
      knuckle = JOINT.L_KNUCKLE + i,
      hip = JOINT.L_HIP + i,
      knee = JOINT.L_KNEE + i,
      ankle = JOINT.L_ANKLE + i,
      toe = JOINT.L_TOE + i;
    out[ear] = add(out[JOINT.NOSE], sub(base[ear], base[JOINT.NOSE]));
    // The head's turn comes from where the nose sits between the ears across
    // the picture when that reading is supplied; the ears' own depth is noise.
    if (turned) out[ear] = turned(out[JOINT.NOSE], rig.head!)[i];
    else
      fade(
        ear,
        add(out[JOINT.NOSE], sub(rel[ear], nose)),
        Math.min(weight[ear], weight[JOINT.NOSE]),
      );
    fade(shoulder, place(shoulder, BODY.spine));
    // The wrist is always the gameplay hand. An unseen elbow is solved between
    // the real shoulder and that hand rather than left on the generic body.
    out[elbow] = twoBone(
      out[shoulder],
      out[wrist],
      BODY.upperArm,
      BODY.foreArm,
      { x: side * 0.35, y: -1, z: -0.5 },
    );
    // Elbow and wrist move with the shoulder, so the arm keeps its length.
    fade(elbow, place(elbow, BODY.spine));
    // Once the player's own bone lengths are known, both arm bones keep them.
    // The wrist stays on the gameplay hand across the picture; its depth is
    // the one the bones allow. With the rig's lengths instead, a longer-armed
    // player's reach would be cut short, so nothing is done until measured.
    if (arms) {
      const chain = armChain(
        out[shoulder],
        out[elbow],
        out[wrist],
        arms.upperArm,
        arms.foreArm,
      );
      out[elbow] = chain.elbow;
      out[wrist] = chain.wrist;
    }
    const forearm = sub(out[wrist], out[elbow]);
    out[knuckle] = add(
      out[wrist],
      scale(forearm, BODY.hand / Math.max(length(forearm), 1e-6)),
    );
    fade(
      knuckle,
      add(out[wrist], sub(rel[knuckle], rel[wrist])),
      Math.min(weight[knuckle], weight[wrist]),
    );
    // The hand is a bone too.
    const palm = sub(out[knuckle], out[wrist]);
    if (length(palm) > 1e-6)
      out[knuckle] = add(out[wrist], scale(palm, BODY.hand / length(palm)));
    fade(hip, place(hip, 0));
    // Foot height comes from how far the ankle is above the estimated floor, so
    // a boosted crouch bends the knees instead of pushing feet through the floor.
    let foot = out[ankle];
    if (weight[ankle] > 0 && t.footLift) {
      // The small dead zone keeps landmark noise from lifting a planted foot.
      const lift = Math.max(0, t.footLift[i] - 0.02) * vertical;
      foot = mixVec(
        foot,
        {
          x: pose.root.x + rel[ankle].x,
          y: BODY.ankle + lift,
          z: pose.root.z + rel[ankle].z,
        },
        clamp(weight[ankle], 0, 1),
      );
    }
    out[ankle] = withinReach(out[hip], foot, BODY.thigh + BODY.shin);
    // The observed knee decides which way the leg bends, but only when the
    // leg is visibly bent. On a near-straight leg the sideways part of the
    // hip-to-knee line is a couple of centimetres of depth noise, and trusting
    // it flipped standing knees backward and sideways from pose to pose. A knee
    // also never bends backward. Bone lengths stay fixed.
    const forward = { x: side * 0.2, y: 0, z: 1 };
    const leg = sub(out[ankle], out[hip]);
    const legLength = Math.max(length(leg), 1e-6);
    const seenKnee = sub(rel[knee], rel[hip]);
    const bend = sub(
      seenKnee,
      scale(leg, dot(seenKnee, leg) / (legLength * legLength)),
    );
    const trust =
      clamp((length(bend) - 0.07) / 0.08, 0, 1) * clamp(weight[knee], 0, 1);
    const pole = mixVec(
      forward,
      scale(bend, 1 / Math.max(length(bend), 1e-6)),
      trust,
    );
    out[knee] = twoBone(out[hip], out[ankle], BODY.thigh, BODY.shin, {
      ...pole,
      z: Math.max(pole.z, 0.15),
    });
    out[toe] = add(out[ankle], sub(base[toe], base[ankle]));
    const toes = add(out[ankle], sub(rel[toe], rel[ankle]));
    fade(
      toe,
      { ...toes, y: Math.max(0.03, toes.y) },
      Math.min(weight[toe], weight[ankle]),
    );
    // And the foot: its seen length changed by a fifth with the camera angle.
    const sole = sub(out[toe], out[ankle]);
    if (length(sole) > 1e-6) {
      const toeAt = add(out[ankle], scale(sole, BODY.foot / length(sole)));
      out[toe] = { ...toeAt, y: Math.max(0.03, toeAt.y) };
    }
  }
  // Millimetre precision keeps the network pose compact.
  const rounded = out.map((p) => ({
    x: Math.round(p.x * 1e4) / 1e4,
    y: Math.round(p.y * 1e4) / 1e4,
    z: Math.round(p.z * 1e4) / 1e4,
  }));
  return validBody(rounded, pose.root) ? rounded : base;
}
/** Gameplay pose plus the full skeleton for the avatar. */
export function trackedAvatar(
  t: TrackingResult,
  sensitivity = 1,
  rig: Rig = {},
): PlayerPose {
  const pose = trackedPose(t, sensitivity);
  return { ...pose, body: trackedBody(t, pose, sensitivity, rig) };
}

/** Early framing hint, not a room measurement or permission to use missing points. */
export function nearCameraEdge(landmarks: Landmark[]): boolean {
  return [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP].some(
    (i) => {
      const p = landmarks[i];
      return (
        p &&
        p.v >= 0.45 &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        (p.x < 0.1 ||
          p.x > 0.9 ||
          p.y < (i === LM.NOSE ? 0.14 : 0.08) ||
          p.y > 0.92)
      );
    },
  );
}
export function trackedFingers(
  frame: HandFrame | null,
  pose: PlayerPose,
  bodyTime: number,
): FingerVisual[] {
  if (
    !frame ||
    !Number.isFinite(frame.t) ||
    !Number.isFinite(bodyTime) ||
    Math.abs(frame.t - bodyTime) > 80
  )
    return [];
  return frame.hands.flatMap((h) => {
    if (
      !["Left", "Right"].includes(h.side) ||
      h.world.length !== 21 ||
      h.world.some((p) => ![p.x, p.y, p.z].every(Number.isFinite))
    )
      return [];
    const wrist = h.side === "Left" ? pose.leftHand : pose.rightHand,
      anchor = h.world[0];
    if (![wrist.x, wrist.y, wrist.z].every(Number.isFinite)) return [];
    // Hand-local geometry is estimated independently; anchor to the body's wrist.
    const points = h.world.map((p) => ({
      x: wrist.x - (p.x - anchor.x),
      y: wrist.y - (p.y - anchor.y),
      z: wrist.z - (p.z - anchor.z),
    }));
    if (
      points.some(
        (p) => Math.hypot(p.x - wrist.x, p.y - wrist.y, p.z - wrist.z) > 0.4,
      )
    )
      return [];
    return [{ side: h.side, points }];
  });
}
