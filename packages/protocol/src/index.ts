/**
 * @spar/protocol — the single contract every package codes against.
 * Pure types + constants. No runtime dependencies. Keep this file small and stable.
 */

// ───────────────────────── Timing ─────────────────────────
export const SIM_HZ = 60;
export const FRAME_MS = 1000 / SIM_HZ;
export const ROUNDS = 3;
export const ROUND_SECONDS = 60;
export const REST_SECONDS = 20;
export const INTRO_FRAMES = 120;        // "READY… FIGHT" before round 1 and after rest

// ───────────────────────── Inputs ─────────────────────────
/** One 16-bit input frame per player per sim tick. */
export const BIT = {
  JAB: 1 << 0,
  CROSS: 1 << 1,
  LEAD_HOOK: 1 << 2,
  REAR_HOOK: 1 << 3,
  LEAD_UPPER: 1 << 4,
  REAR_UPPER: 1 << 5,
  BODY: 1 << 6,        // modifier: the punch in this frame targets the body
  SLIP_L: 1 << 7,      // held: head displaced to fighter's left
  SLIP_R: 1 << 8,      // held: head displaced to fighter's right
  DUCK: 1 << 9,        // held: head dropped
  GUARD_HIGH: 1 << 10, // held: both wrists in chin box
  STEP_IN: 1 << 11,
  STEP_OUT: 1 << 12,
  STEP_L: 1 << 13,
  STEP_R: 1 << 14,
  GET_UP: 1 << 15,     // impulse: both hands raised over head (knockdown recovery)
} as const;
export type InputBits = number;

export const HELD_MASK: InputBits = BIT.SLIP_L | BIT.SLIP_R | BIT.DUCK | BIT.GUARD_HIGH;
export const IMPULSE_MASK: InputBits = 0xffff & ~HELD_MASK;
export const PUNCH_MASK: InputBits =
  BIT.JAB | BIT.CROSS | BIT.LEAD_HOOK | BIT.REAR_HOOK | BIT.LEAD_UPPER | BIT.REAR_UPPER;
export const STEP_MASK: InputBits = BIT.STEP_IN | BIT.STEP_OUT | BIT.STEP_L | BIT.STEP_R;

/** Prediction rule for rollback: held bits repeat, impulse bits do not. */
export function predictInput(last: InputBits): InputBits {
  return last & HELD_MASK;
}

export type PunchKind = 'JAB' | 'CROSS' | 'LEAD_HOOK' | 'REAR_HOOK' | 'LEAD_UPPER' | 'REAR_UPPER';
export const PUNCH_BITS: Record<PunchKind, InputBits> = {
  JAB: BIT.JAB, CROSS: BIT.CROSS, LEAD_HOOK: BIT.LEAD_HOOK, REAR_HOOK: BIT.REAR_HOOK,
  LEAD_UPPER: BIT.LEAD_UPPER, REAR_UPPER: BIT.REAR_UPPER,
};

// ───────────────────────── Pose ─────────────────────────
/** MediaPipe Pose Landmarker indices we use (33-point BlazePose topology). */
export const LM = {
  NOSE: 0, L_EYE: 2, R_EYE: 5, L_EAR: 7, R_EAR: 8, MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
} as const;
export const LANDMARK_COUNT = 33;

export interface Landmark { x: number; y: number; z: number; v: number }
/**
 * One pose sample. `lm` = image-normalized landmarks (x,y in 0..1, origin top-left, NOT mirrored),
 * `world` = metric landmarks (meters, hip-centered) when available, else an empty array.
 * `t` = ms timestamp (performance.now()).
 */
export interface PoseFrame {
  t: number;
  lm: Landmark[];
  world: Landmark[];
  imageAspect?: number;
  /**
   * When the camera captured this image, on the performance.now() clock, if the
   * browser reports it. Always ≤ t. Lets the display estimate how old a pose is.
   */
  capturedAt?: number;
  /**
   * The same moment as `t`, on the same clock, but spaced the way the camera's
   * frames really were (see captureClock.ts). Use it for speeds; `t` jitters.
   */
  motionT?: number;
}

export type Stance = 'orthodox' | 'southpaw';

// ───────────────────────── Gesture engine ─────────────────────────
export type ActionType =
  | PunchKind
  | 'SLIP_L' | 'SLIP_R' | 'DUCK' | 'HEAD_CENTER'
  | 'GUARD_HIGH' | 'GUARD_LOW'
  | 'STEP_IN' | 'STEP_OUT' | 'STEP_L' | 'STEP_R'
  | 'GET_UP';

export interface ActionEvent {
  t: number;              // ms of the pose frame that produced it
  type: ActionType;
  body?: boolean;         // punches only: body target
  confidence: number;     // 0..1
  early?: boolean;        // fired by early-fire rule before peak extension
}

export interface GestureEngineLike {
  /** Feed one pose frame. Returns events detected in this frame (may be empty). */
  push(frame: PoseFrame): ActionEvent[];
  /** Current held-state bits (guard / head). */
  held(): InputBits;
  /** Impulse bits fired since last drain (punches, steps, get-up); cleared on call. */
  drainImpulses(): InputBits;
  /** Convenience: held() | drainImpulses(). Call once per sim tick. */
  sampleInput(): InputBits;
  stance(): Stance;
}

// ───────────────────────── Sim ─────────────────────────
export type Phase = 'IDLE' | 'STARTUP' | 'ACTIVE' | 'RECOVERY' | 'STUNNED' | 'KNOCKDOWN';
export type HeadState = 'CENTER' | 'SLIP_L' | 'SLIP_R' | 'DUCK';
export type MatchState = 'INTRO' | 'FIGHTING' | 'REST' | 'OVER';

export interface FighterView {
  hp: number;              // 0..1000
  stamina: number;         // 0..1000
  guardHigh: boolean;
  head: HeadState;
  phase: Phase;
  punch: PunchKind | null; // current punch when phase is STARTUP/ACTIVE/RECOVERY
  body: boolean;           // current punch targets body
  phaseFrames: number;     // frames remaining in current phase
  counterWindow: number;   // frames remaining of counter bonus
  knockdowns: number;      // this round
  stance: Stance;
  landed: number;          // punches landed this match
  thrown: number;          // punches thrown this match
}

export interface MatchView {
  frame: number;
  state: MatchState;
  round: number;           // 1-based
  roundFrame: number;      // frames elapsed in current round
  clockSec: number;        // seconds remaining in round (or rest)
  range: number;           // 200..1000 shared distance, 600 = mid
  fighters: [FighterView, FighterView];
  scores: [number[], number[]]; // judges' 10-point-must per completed round
  winner: 0 | 1 | 'DRAW' | null;
  method: 'KO' | 'TKO' | 'DECISION' | null;
}

export type SimEventKind =
  | 'HIT' | 'BLOCK' | 'MISS' | 'EVADE' | 'COUNTER'
  | 'STUN' | 'KNOCKDOWN' | 'GET_UP'
  | 'BELL' | 'ROUND_END' | 'MATCH_END' | 'STEP';

export interface SimEvent {
  frame: number;
  kind: SimEventKind;
  who: 0 | 1;              // actor (puncher, stepper, the one knocked down…)
  punch?: PunchKind;
  body?: boolean;
  damage?: number;
  detail?: string;
}

/**
 * Deterministic simulation contract. State is IMMUTABLE: step returns a new state and never
 * mutates its arguments. Integer math only (no Math.random, no float trig) so that browsers and
 * Node produce identical hashes.
 */
export interface SimLike<S> {
  init(seed: number): S;
  step(state: S, inputs: [InputBits, InputBits]): { state: S; events: SimEvent[] };
  hash(state: S): number;   // 32-bit unsigned
  view(state: S): MatchView;
}

export interface ReplayResult { hash: number; view: MatchView; frames: number }

// ───────────────────────── Netcode ─────────────────────────
export interface Transport {
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
}

export interface NetStats {
  rttMs: number;
  rollbackFrames: number;   // rollback depth on the last tick
  rollbacksTotal: number;
  framesAhead: number;      // local frame − last confirmed remote frame
  confirmedFrame: number;
}

export interface TickResult {
  frame: number;            // current (predicted) frame after this tick
  view: MatchView;
  events: SimEvent[];       // events from frames newly executed this tick (confirmed OR predicted)
  stalled: boolean;         // true when the tick was skipped for time sync (render last view)
  stats: NetStats;
}

export interface RollbackSessionLike {
  readonly localPlayer: 0 | 1;
  /** Provide local input for the next frame, then advance one frame. */
  tick(localInput: InputBits): TickResult;
  /** Confirmed input log so far, for server replay verification. */
  inputLog(): [InputBits[], InputBits[]];
  close(): void;
}

// ───────────────────────── Signaling ─────────────────────────
export type ClientMsg =
  | { type: 'hello'; name: string }
  | { type: 'queue' }
  | { type: 'leave' }
  | { type: 'signal'; to: string; data: unknown }
  | { type: 'result'; matchId: string; seed: number; log: [InputBits[], InputBits[]]; hash: number }
  | { type: 'ping'; t: number };

export type ServerMsg =
  | { type: 'welcome'; id: string }
  | { type: 'queued'; size: number }
  | { type: 'match'; matchId: string; peerId: string; role: 'offer' | 'answer'; seed: number; player: 0 | 1; peerName: string }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'verified'; matchId: string; ok: boolean; winner: 0 | 1 | 'DRAW' | null; ratings: [number, number] }
  | { type: 'peer_left' }
  | { type: 'pong'; t: number }
  | { type: 'error'; message: string };

export const SIGNAL_PORT = 8787;
export const WEB_PORT = 5173;

// ───────────────────────── Pose stream (cosmetic, over its own DataChannel) ─────────────────────────
/** 33 landmarks × (x,y,z) int16 (value × 10000) + 4-byte header (uint32 frame). 202 bytes. */
export const LEGACY_POSE_PACKET_BYTES = 4 + LANDMARK_COUNT * 3 * 2;
/** Current cosmetic pose packet: counter + image aspect + 33 × (xyz int16 + visibility uint8). */
export const POSE_PACKET_BYTES = 8 + LANDMARK_COUNT * 7;
export const POSE_STREAM_HZ = 20;
