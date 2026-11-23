import type { Vec3 } from "../../pov/physics";
import type { FoePose } from "../opponentPose";

/**
 * The opponent's body played from a real boxer's recorded motion.
 *
 * Everything is in the opponent's own frame, as in opponentPose.ts: the
 * origin between its feet where it stands at the edge of range, +x its right,
 * +y up, +z toward the player, metres. Times are seconds on the fight's clock
 * unless a name says frames.
 */

// ── The pack ────────────────────────────────────────────────────────────────
/** The kinds of punch the rules know. */
export type MotionKind = "jab" | "cross" | "hook" | "uppercut" | "body";
export type MotionShape = "straight" | "hook" | "uppercut";
/** Which hand of the stance: every clip in the pack is orthodox, so the lead hand is the left. */
export type StanceHand = "lead" | "rear";
export type MotionLevel = "head" | "body";

/** A punch's events, in frames of its clip (halves happen: they were timed at twice the clip's rate). */
export interface PunchEvents {
  /** First movement of the body. */
  first: number;
  /** Where that movement first stands out from the boxer's own bounce. */
  seen: number;
  /** The fist leaves. */
  launch: number;
  /** Contact. */
  contact: number;
  /** The hand is back in the guard. */
  guard: number;
}
/** One punch inside a clip. */
export interface PunchMark {
  kind: MotionKind;
  hand: StanceHand;
  level: MotionLevel;
  shape: MotionShape;
  events: PunchEvents;
  /** The glove at contact, and the point the boxer was throwing at. */
  contact: { hand: Vec3; aim: Vec3 };
}
/** A step's part of a clip. */
export interface StepMark {
  dir: "in" | "out";
  /** Frames the step starts and ends on. */
  start: number;
  end: number;
  /** Metres it carried the boxer along the way he faces (negative is back). */
  travel: number;
  /** For each frame, how much of the step is done, 0 to 1. */
  curve: number[];
}
export interface Clip {
  id: string;
  /** Where it came from: the trial, and its frames there at 120 a second. */
  source: string;
  from: number;
  to: number;
  /** The boxer stood southpaw and was mirrored. */
  mirrored: boolean;
  fps: number;
  frames: number;
  kind: "guard" | "step" | "combo" | MotionKind;
  /** None for a guard loop or a step, one for a single punch, more for a combination. */
  punches: PunchMark[];
  step: StepMark | null;
  /** Goes round: the frame after the last is the first. */
  loop: boolean;
  /** How far the hips rise and fall in a guard loop, metres. */
  bounce: number;
  /** Frames where a hit or a new order may cut in. */
  interrupt: [number, number][];
  /** Frames where the next punch of a combination may begin, and which kinds followed it in the recordings. */
  chain: { from: number; to: number; next: string[] } | null;
  /** How far each part may be slowed or hurried. */
  rate: { load: [number, number]; strike: [number, number] };
  /** "busy": the hand that does not punch is not in its guard in this take, so take that arm from the idle. */
  other: "guard" | "busy";
  /** Every point of every frame: `frames` × 11 points × 3, metres. See JOINT. */
  data: Float32Array;
}
export interface Pack {
  fps: number;
  clips: Clip[];
  byId: Map<string, Clip>;
  /** The guard loops, for standing ready. */
  guards: Clip[];
}
/** Where each point sits in a frame of `Clip.data` (times three). */
export const JOINT = {
  hips: 0,
  chest: 1,
  head: 2,
  shoulderL: 3,
  shoulderR: 4,
  elbowL: 5,
  elbowR: 6,
  wristL: 7,
  wristR: 8,
  footL: 9,
  footR: 10,
} as const;
export const JOINT_COUNT = 11;

// ── The body ────────────────────────────────────────────────────────────────
/** The game's own lengths, metres: the same as opponentPose.ts and scene.ts. */
export const SIZE = {
  chest: 0.42,
  head: 0.27,
  shoulder: 0.19,
  shoulderUp: 0.02,
  upperArm: 0.3,
  forearm: 0.28,
  /** scene.ts draws the wrist a tenth of the way back from the glove to the shoulder. */
  wristShare: 0.9,
} as const;

/** Where the body is: points. [its left, its right] wherever there are two. */
export interface Body {
  hips: Vec3;
  chest: Vec3;
  head: Vec3;
  shoulders: [Vec3, Vec3];
  elbows: [Vec3, Vec3];
  wrists: [Vec3, Vec3];
  /** The ankles. */
  feet: [Vec3, Vec3];
}
/**
 * The same body as bones: where the hips are and which way each bone points.
 * Blending is done on these, so no bone ever changes length. The arms are
 * kept in the chest's own axes, so an arm can be taken from one clip and the
 * trunk from another.
 */
export interface Rig {
  hips: Vec3;
  /** Hips to chest, chest to head, left shoulder to right: unit directions. */
  spine: Vec3;
  neck: Vec3;
  across: Vec3;
  /** Upper arms and forearms, unit directions in the chest's axes. */
  upper: [Vec3, Vec3];
  fore: [Vec3, Vec3];
  feet: [Vec3, Vec3];
}

// ── What the game tells the player each frame ───────────────────────────────
export type Hand = "left" | "right";
/** Where a glove of the guard is: by the chin, lifted to cover the brow or temple, elbow down by the ribs, or hanging. */
export type GuardPlace = "chin" | "cover" | "low" | "down";
/** Where its feet are: at the edge of range, or stepped in. */
export type RangeSpot = "edge" | "pocket";

/** One punch, from its first movement until its hand is home. */
export interface MotionPunch {
  /** Changes with every new punch. */
  id: number;
  kind: MotionKind;
  hand: Hand;
  level: MotionLevel;
  /** Only needed to tell a hook to the body from a straight one; otherwise the kind says it. */
  shape?: MotionShape;
  /** First movement, the fist leaving (the aim is fixed from then), contact, the hand home. */
  start: number;
  commit: number;
  impact: number;
  home: number;
  /** Shown and taken back at `commit`: nothing lands. */
  feint: boolean;
  /**
   * Where the glove should be at contact. Followed until `commit`, then
   * held: a head that moves afterwards is missed. `gloveTarget` works it
   * out from the player's eye.
   */
  target: Vec3;
  /** It will land on the player's glove: where that glove is. Null when it will not be blocked. */
  block: Vec3 | null;
  /**
   * The rules have fixed the aim. When this is given the target is followed
   * until it is true instead of until `commit`: the rules run a little
   * behind what is drawn, and the picture must miss what the rules miss.
   */
  fixed?: boolean;
}

/** Everything the player object needs to know about this frame. Plain data, no functions. */
export interface MotionDrive {
  /** The time to draw. Hold it still for a hit-stop: nothing moves. */
  time: number;
  /** Standing ready with nothing planned: it bounces. False while it is set to work: the bounce calms. */
  idle: boolean;
  /**
   * The newest punch that is not yet home, or null. Give it every frame until
   * its hand is home. An earlier punch whose hand is still out keeps playing
   * on its own. A punch that disappears before its impact was called off.
   */
  punch: MotionPunch | null;
  /** Its feet: on the way from one spot to the other between `start` and `end`. Null: where it last was. */
  step: { from: RangeSpot; to: RangeSpot; start: number; end: number } | null;
  /** Where each glove of the guard is, [left, right]. A hand that is punching ignores this until it is home. */
  guard: [GuardPlace, GuardPlace];
  /** Seconds a guard glove takes to change place, when this boxer's is not the player object's own setting. */
  guardMove?: number;
  /** 0 fresh to 1 spent: hands lower, less bounce. */
  tired: number;
  /** 0 fine to 1 badly hurt: it sags and sways. */
  hurt: number;
  /** Being hit: how far the head and chest are knocked, as reaction.ts gives it. Null when nothing has landed. */
  hit: { head: Vec3; chest: Vec3 } | null;
  /** The player's eye now. Not aimed at: it is what the glove is kept clear of. */
  eye: Vec3;
  /** On the canvas or getting up: the fall is handed to the hook given to `createMotionPlayer`. */
  down: MotionDown | null;
}
export interface MotionDown {
  /** When it went down, and when it is back on its feet (Infinity if it is out). */
  since: number;
  until: number;
  out: boolean;
  /** Which of the player's hands put it there, and with what: it falls the way the punch was going. */
  by?: { hand: Hand; shape: MotionShape };
}
/** The fall and the get-up, supplied from outside: the recordings have nobody falling. */
export type FallHook = (down: MotionDown, time: number) => FoePose;

// ── What comes back ─────────────────────────────────────────────────────────
/** A FoePose, plus what the recording also knows. */
export interface MotionPose extends FoePose {
  /** The elbows themselves; `poles` are derived from them. */
  elbows: [Vec3, Vec3];
  /** The ankles, [left, right]. scene.ts places the feet by formula today; these are where the boxer's really were. */
  feet: [Vec3, Vec3];
  /** How far it stands in from the edge of range, metres. Already added to every point; `lunge` repeats it. */
  advance: number;
  /** How far the aim carried the hips toward the player to make the glove reach, metres. */
  carried: number;
  /** What is playing, for the viewer and for tests. */
  playing: { clip: string; frame: number; blending: boolean };
  /** The aim of the punch in flight, if any. `refused`: the bend was too great, and it plays its own line. */
  aim: { hand: 0 | 1; weight: number; bend: number; refused: boolean; target: Vec3 } | null;
}
