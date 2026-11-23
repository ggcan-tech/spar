/**
 * @spar/sim — deterministic 60 Hz shadow-boxing sim.
 *
 * Rules: pure functions, integer math only, immutable state (step returns a new state and never
 * touches its arguments). Every number here comes from docs/DESIGN.md "Sim numbers".
 *
 * Frame model: `step(state, inputs)` simulates frame `state.frame` and returns `frame + 1`.
 * Phase timers tick at the START of a step (a punch pressed on step k enters STARTUP with
 * `phaseFrames = startup`; it becomes ACTIVE — and resolves — on step k + startup).
 * counterWindow / lateral / stepCooldown tick at the END of a step, so a window granted on step k
 * is usable on steps k+1 .. k+N inclusive.
 */
import {
  BIT,
  INTRO_FRAMES,
  PUNCH_MASK,
  REST_SECONDS,
  ROUNDS,
  ROUND_SECONDS,
  SIM_HZ,
  type FighterView,
  type HeadState,
  type InputBits,
  type MatchState,
  type MatchView,
  type Phase,
  type PunchKind,
  type ReplayResult,
  type SimEvent,
  type SimLike,
} from '@spar/protocol';

// ───────────────────────── Enums (integers in state) ─────────────────────────
export const MS = { INTRO: 0, FIGHTING: 1, REST: 2, OVER: 3 } as const;
export const PH = { IDLE: 0, STARTUP: 1, ACTIVE: 2, RECOVERY: 3, STUNNED: 4, KNOCKDOWN: 5 } as const;
export const HD = { CENTER: 0, SLIP_L: 1, SLIP_R: 2, DUCK: 3 } as const;
export const PK = { JAB: 0, CROSS: 1, LEAD_HOOK: 2, REAR_HOOK: 3, LEAD_UPPER: 4, REAR_UPPER: 5 } as const;
/** winner field: -1 none, 0/1 player, 2 draw. method field: 0 none, 1 KO, 2 TKO, 3 DECISION. */
export const WIN_NONE = -1;
export const WIN_DRAW = 2;
export const METHOD = { NONE: 0, KO: 1, TKO: 2, DECISION: 3 } as const;

const MATCH_STATE_NAMES: readonly MatchState[] = ['INTRO', 'FIGHTING', 'REST', 'OVER'];
const PHASE_NAMES: readonly Phase[] = ['IDLE', 'STARTUP', 'ACTIVE', 'RECOVERY', 'STUNNED', 'KNOCKDOWN'];
const HEAD_NAMES: readonly HeadState[] = ['CENTER', 'SLIP_L', 'SLIP_R', 'DUCK'];
const METHOD_NAMES: readonly (MatchView['method'])[] = [null, 'KO', 'TKO', 'DECISION'];

// ───────────────────────── Numbers ─────────────────────────
export const ROUND_FRAMES = ROUND_SECONDS * SIM_HZ; // 3600
export const REST_FRAMES = REST_SECONDS * SIM_HZ; // 1200

export interface PunchSpec {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  stamina: number;
  maxRange: number;
  /** % of damage absorbed by a HIGH guard (head punches). */
  blockPct: number;
}

/** Punch kinds in priority order (JAB first); index == PK.* == FighterState.punch. */
export const PUNCH_KINDS: readonly PunchKind[] = [
  'JAB', 'CROSS', 'LEAD_HOOK', 'REAR_HOOK', 'LEAD_UPPER', 'REAR_UPPER',
];

export const PUNCH_TABLE: Readonly<Record<PunchKind, Readonly<PunchSpec>>> = {
  JAB:        { startup: 3, active: 2, recovery: 6,  damage: 40,  stamina: 25, maxRange: 700, blockPct: 85 },
  CROSS:      { startup: 5, active: 2, recovery: 9,  damage: 80,  stamina: 45, maxRange: 650, blockPct: 85 },
  LEAD_HOOK:  { startup: 6, active: 3, recovery: 10, damage: 90,  stamina: 50, maxRange: 500, blockPct: 50 },
  REAR_HOOK:  { startup: 7, active: 3, recovery: 12, damage: 110, stamina: 60, maxRange: 500, blockPct: 50 },
  LEAD_UPPER: { startup: 7, active: 3, recovery: 12, damage: 100, stamina: 55, maxRange: 400, blockPct: 40 },
  REAR_UPPER: { startup: 7, active: 3, recovery: 12, damage: 120, stamina: 60, maxRange: 400, blockPct: 40 },
};

/** BODY modifier row of the punch table. */
export const BODY_MOD = {
  startup: 0,
  active: 0,
  recovery: 1,
  damagePct: 80,
  maxRange: -50,
  /** body punches vs LOW guard (wrists down) are blocked this much */
  lowGuardBlockPct: 70,
  /** target stamina drained = damage dealt × this */
  staminaDrainMul: 2,
} as const;

export const SIM_NUMBERS = {
  HP_MAX: 1000,
  STAMINA_MAX: 1000,
  RANGE_MIN: 200,
  RANGE_MAX: 1000,
  RANGE_START: 600,
  INSIDE_RANGE: 300,
  INSIDE_STRAIGHT_PCT: 50,
  FATIGUE_STAMINA: 300,
  FATIGUE_DAMAGE_PCT: 70,
  FATIGUE_STARTUP: 2,
  STUN_WINDOW: 120,
  STUN_DAMAGE: 250,
  STUN_FRAMES: 30,
  STUN_HIT_PCT: 150,
  KNOCKDOWN_COUNT: 600,
  GETUP_HP: 300,
  GETUP_STAMINA: 400,
  KNOCKDOWNS_FOR_TKO: 3,
  COUNTER_WINDOW: 12,
  COUNTER_PCT: 150,
  SLIP_HOOK_PCT: 150,
  DUCK_UPPER_PCT: 200,
  KNOCKBACK: 40,
  STEP_DIST: 150,
  STEP_COOLDOWN: 20,
  LATERAL_FRAMES: 10,
  DUCK_COST: 30,
  CANCEL_WINDOW: 2,
  /** judging weights ×10 */
  W_STRAIGHT: 10,
  W_HOOK: 14,
  W_UPPER: 15,
  W_BODY: 12,
  W_COUNTER_PCT: 150,
  W_EVADE: 5,
  W_KNOCKDOWN: 100,
} as const;
const N = SIM_NUMBERS;

// Array form of the table for hot-path indexing by punch id.
const TBL: readonly Readonly<PunchSpec>[] = PUNCH_KINDS.map((k) => PUNCH_TABLE[k]);
const PUNCH_BIT_OF: readonly number[] = [
  BIT.JAB, BIT.CROSS, BIT.LEAD_HOOK, BIT.REAR_HOOK, BIT.LEAD_UPPER, BIT.REAR_UPPER,
];

// ───────────────────────── State ─────────────────────────
export interface FighterState {
  hp: number;
  stamina: number;
  /** effective guard this frame (0/1) — already has "forced LOW" applied */
  guardHigh: number;
  /** HD.* — effective head state this frame */
  head: number;
  /** PH.* */
  phase: number;
  /** frames remaining in the current phase (KNOCKDOWN: count remaining) */
  phaseFrames: number;
  /** PK.* or -1 */
  punch: number;
  /** 0/1: current punch targets the body */
  body: number;
  counterWindow: number;
  /** STEP_L/STEP_R half-slip frames remaining */
  lateral: number;
  stepCooldown: number;
  /** knockdowns suffered this round */
  knockdowns: number;
  /** 0 orthodox, 1 southpaw */
  stance: number;
  landed: number;
  thrown: number;
  /** judging points this round (×10), landed weights + evades; opponent knockdowns added at round end */
  roundPts: number;
  /** rolling stun window: flat [frame, damage, frame, damage, ...] — only changes when damage is taken */
  dmgLog: number[];
}

export interface SimState {
  seed: number;
  frame: number;
  /** MS.* */
  state: number;
  /** 1-based */
  round: number;
  /** frames elapsed in the current round */
  roundFrame: number;
  /** frames remaining in INTRO / REST */
  stateFrames: number;
  range: number;
  /** -1 none, 0, 1, 2 = draw */
  winner: number;
  /** METHOD.* */
  method: number;
  scores: [number[], number[]];
  f: [FighterState, FighterState];
}

function newFighter(): FighterState {
  return {
    hp: N.HP_MAX,
    stamina: N.STAMINA_MAX,
    guardHigh: 0,
    head: HD.CENTER,
    phase: PH.IDLE,
    phaseFrames: 0,
    punch: -1,
    body: 0,
    counterWindow: 0,
    lateral: 0,
    stepCooldown: 0,
    knockdowns: 0,
    stance: 0,
    landed: 0,
    thrown: 0,
    roundPts: 0,
    dmgLog: [],
  };
}

function init(seed: number): SimState {
  return {
    seed: seed >>> 0,
    frame: 0,
    state: MS.INTRO,
    round: 1,
    roundFrame: 0,
    stateFrames: INTRO_FRAMES,
    range: N.RANGE_START,
    winner: WIN_NONE,
    method: METHOD.NONE,
    scores: [[], []],
    f: [newFighter(), newFighter()],
  };
}

// ───────────────────────── Helpers ─────────────────────────
const isStraight = (p: number): boolean => p === PK.JAB || p === PK.CROSS;
const isHook = (p: number): boolean => p === PK.LEAD_HOOK || p === PK.REAR_HOOK;
const pct = (v: number, p: number): number => Math.trunc((v * p) / 100);

/** Highest-priority punch bit → punch id (JAB > CROSS > LEAD_HOOK > REAR_HOOK > LEAD_UPPER > REAR_UPPER). */
function pickPunch(bits: InputBits): number {
  for (let i = 0; i < 6; i++) if (bits & PUNCH_BIT_OF[i]) return i;
  return -1;
}

/** Head/guard from held bits, with the forced rules. `chargeDuck` = whether DUCK entry costs stamina. */
function applyHeld(f: FighterState, inp: InputBits, chargeDuck: boolean): void {
  const forced = f.phase === PH.STUNNED || f.phase === PH.KNOCKDOWN;
  let head: number = HD.CENTER;
  if (!forced) {
    if (inp & BIT.SLIP_L) head = HD.SLIP_L;
    else if (inp & BIT.SLIP_R) head = HD.SLIP_R;
    else if (inp & BIT.DUCK) head = HD.DUCK;
  }
  if (chargeDuck && head === HD.DUCK && f.head !== HD.DUCK) {
    f.stamina = Math.max(0, f.stamina - N.DUCK_COST);
  }
  f.head = head;
  f.guardHigh = !forced && (inp & BIT.GUARD_HIGH) !== 0 && f.stamina >= N.FATIGUE_STAMINA ? 1 : 0;
}

/** Stamina regen: +1/frame IDLE+LOW guard, +1 every other frame IDLE+HIGH guard, else 0. */
function regen(f: FighterState, frame: number): void {
  if (f.phase !== PH.IDLE) return;
  if (f.guardHigh === 0 || (frame & 1) === 0) {
    if (f.stamina < N.STAMINA_MAX) f.stamina++;
  }
}

/** Cancel whatever the fighter was doing (used by STUN / KNOCKDOWN / round end). */
function interrupt(f: FighterState): void {
  f.punch = -1;
  f.body = 0;
  f.counterWindow = 0;
  f.lateral = 0;
  f.head = HD.CENTER;
  f.guardHigh = 0;
}

function resetForRound(f: FighterState): void {
  f.phase = PH.IDLE;
  f.phaseFrames = 0;
  f.punch = -1;
  f.body = 0;
  f.counterWindow = 0;
  f.lateral = 0;
  f.stepCooldown = 0;
  f.dmgLog = [];
}

type Outcome = 'HIT' | 'BLOCK' | 'MISS' | 'EVADE' | 'IGNORE';
interface Resolution {
  kind: Outcome;
  damage: number;
  counter: boolean;
  /** EVADE with a real slip/duck grants the target a counter window */
  grantCounter: boolean;
}

/**
 * Resolve attacker `atk`'s punch on its first ACTIVE frame against the snapshot `pre`
 * (both fighters' states as of this frame, before any damage from this frame is applied).
 */
function resolve(pre: readonly [FighterState, FighterState], atk: 0 | 1, range: number): Resolution {
  const a = pre[atk];
  const t = pre[1 - atk];
  const p = a.punch;
  const body = a.body === 1;
  const spec = TBL[p];
  const none: Resolution = { kind: 'IGNORE', damage: 0, counter: false, grantCounter: false };

  if (t.phase === PH.KNOCKDOWN) return none; // punch ignored, no damage

  const maxRange = spec.maxRange + (body ? BODY_MOD.maxRange : 0);
  if (range > maxRange) return { ...none, kind: 'MISS' };

  // Base damage with attacker-side modifiers (fixed order, truncating at each step).
  let dmg = spec.damage;
  if (body) dmg = pct(dmg, BODY_MOD.damagePct);
  if (range < N.INSIDE_RANGE && isStraight(p)) dmg = pct(dmg, N.INSIDE_STRAIGHT_PCT);
  if (a.stamina < N.FATIGUE_STAMINA) dmg = pct(dmg, N.FATIGUE_DAMAGE_PCT);

  let kind: Outcome = 'HIT';
  let mult = 100;
  let grantCounter = false;

  if (t.phase === PH.STUNNED) {
    mult = N.STUN_HIT_PCT; // head forced CENTER, guard forced LOW while stunned
  } else if (!body) {
    const head = t.head;
    if (head === HD.SLIP_L || head === HD.SLIP_R) {
      if (isStraight(p)) {
        kind = 'EVADE';
        grantCounter = true;
      } else if (isHook(p)) {
        // LEAD_HOOK punishes SLIP_R, REAR_HOOK punishes SLIP_L (attacker travels across).
        if ((p === PK.LEAD_HOOK && head === HD.SLIP_R) || (p === PK.REAR_HOOK && head === HD.SLIP_L)) {
          mult = N.SLIP_HOOK_PCT;
        }
      }
      // uppers vs slip: plain hit
    } else if (head === HD.DUCK) {
      if (isStraight(p) || isHook(p)) {
        kind = 'EVADE';
        grantCounter = true;
      } else {
        mult = N.DUCK_UPPER_PCT; // ducked into the uppercut
      }
    } else {
      // head CENTER
      if (isStraight(p) && t.lateral > 0) {
        kind = 'EVADE'; // half-slip from a lateral step: straights only, no counter window
      } else if (t.guardHigh === 1) {
        kind = 'BLOCK';
        dmg = pct(dmg, 100 - spec.blockPct); // chip
      }
    }
  } else {
    // body punch: ignores HIGH guard; LOW guard (wrists down) blocks 70%
    if (t.guardHigh === 0) {
      kind = 'BLOCK';
      dmg = pct(dmg, 100 - BODY_MOD.lowGuardBlockPct);
    }
  }

  if (kind === 'EVADE') return { kind, damage: 0, counter: false, grantCounter };
  if (kind === 'BLOCK') return { kind, damage: dmg, counter: false, grantCounter: false };

  // HIT
  dmg = pct(dmg, mult);
  let counter = false;
  if (a.counterWindow > 0) {
    dmg = pct(dmg, N.COUNTER_PCT);
    counter = true;
  }
  return { kind: 'HIT', damage: dmg, counter, grantCounter: false };
}

/** Judging weight (×10) of a landed punch. */
function landedWeight(p: number, body: boolean, counter: boolean): number {
  let w: number;
  if (body) w = N.W_BODY;
  else if (isStraight(p)) w = N.W_STRAIGHT;
  else if (isHook(p)) w = N.W_HOOK;
  else w = N.W_UPPER;
  if (counter) w = pct(w, N.W_COUNTER_PCT);
  return w;
}

/**
 * Apply `damage` to fighter `t` (index `ti`) on `frame`. Handles knockdown and the rolling stun window.
 * Returns true if the fighter was knocked down.
 */
function takeDamage(t: FighterState, ti: 0 | 1, damage: number, frame: number, events: SimEvent[]): boolean {
  t.hp = Math.max(0, t.hp - damage);
  if (t.hp <= 0) {
    t.phase = PH.KNOCKDOWN;
    t.phaseFrames = N.KNOCKDOWN_COUNT;
    interrupt(t);
    t.dmgLog = [];
    t.knockdowns++;
    events.push({ frame, kind: 'KNOCKDOWN', who: ti });
    return true;
  }
  if (t.phase === PH.STUNNED) return false; // damage while already stunned does not feed the window
  // rolling window: keep entries with entryFrame > frame - STUN_WINDOW (i.e. the last 120 frames incl. now)
  const cutoff = frame - N.STUN_WINDOW;
  const old = t.dmgLog;
  const log: number[] = [];
  let sum = 0;
  for (let i = 0; i < old.length; i += 2) {
    if (old[i] > cutoff) {
      log.push(old[i], old[i + 1]);
      sum += old[i + 1];
    }
  }
  log.push(frame, damage);
  sum += damage;
  if (sum >= N.STUN_DAMAGE) {
    t.phase = PH.STUNNED;
    t.phaseFrames = N.STUN_FRAMES;
    interrupt(t);
    t.dmgLog = [];
    events.push({ frame, kind: 'STUN', who: ti });
  } else {
    t.dmgLog = log;
  }
  return false;
}

function endMatch(s: SimState, events: SimEvent[], frame: number, winner: number, method: number): void {
  s.state = MS.OVER;
  s.winner = winner;
  s.method = method;
  const detail = winner === WIN_DRAW ? 'DRAW' : (METHOD_NAMES[method] as string);
  events.push({ frame, kind: 'MATCH_END', who: winner === 0 || winner === 1 ? winner : 0, detail });
}

/** 10-point-must for the round that just ended. */
function judgeRound(s: SimState): [number, number] {
  const f0 = s.f[0];
  const f1 = s.f[1];
  const pts0 = f0.roundPts + f1.knockdowns * N.W_KNOCKDOWN;
  const pts1 = f1.roundPts + f0.knockdowns * N.W_KNOCKDOWN;
  if (pts0 > pts1) return [10, f1.knockdowns > 0 ? 8 : 9];
  if (pts1 > pts0) return [f0.knockdowns > 0 ? 8 : 9, 10];
  return [10, 10];
}

function endRound(s: SimState, events: SimEvent[], frame: number): void {
  const [s0, s1] = judgeRound(s);
  s.scores = [[...s.scores[0], s0], [...s.scores[1], s1]];
  events.push({ frame, kind: 'BELL', who: 0, detail: 'END' });
  events.push({ frame, kind: 'ROUND_END', who: s1 > s0 ? 1 : 0, detail: `${s0}-${s1}` });
  resetForRound(s.f[0]);
  resetForRound(s.f[1]);
  if (s.round < ROUNDS) {
    s.state = MS.REST;
    s.stateFrames = REST_FRAMES;
    return;
  }
  let t0 = 0;
  let t1 = 0;
  for (let i = 0; i < s.scores[0].length; i++) {
    t0 += s.scores[0][i];
    t1 += s.scores[1][i];
  }
  endMatch(s, events, frame, t0 > t1 ? 0 : t1 > t0 ? 1 : WIN_DRAW, METHOD.DECISION);
}

// ───────────────────────── Step ─────────────────────────
function step(prev: SimState, inputs: [InputBits, InputBits]): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  const frame = prev.frame;
  if (prev.state === MS.OVER) return { state: { ...prev, frame: frame + 1 }, events };

  const s: SimState = { ...prev, frame: frame + 1 };
  const f0: FighterState = { ...prev.f[0] };
  const f1: FighterState = { ...prev.f[1] };
  const fs: [FighterState, FighterState] = [f0, f1];
  s.f = fs;
  const ins: [InputBits, InputBits] = [inputs[0] & 0xffff, inputs[1] & 0xffff];

  // ── INTRO / REST: inputs ignored except cosmetic head/guard; stamina regens; countdown.
  if (prev.state !== MS.FIGHTING) {
    for (let i = 0; i < 2; i++) {
      applyHeld(fs[i], ins[i], false);
      regen(fs[i], frame);
    }
    s.stateFrames = prev.stateFrames - 1;
    if (s.stateFrames <= 0) {
      s.stateFrames = 0;
      if (prev.state === MS.INTRO) {
        s.state = MS.FIGHTING;
        s.roundFrame = 0;
        events.push({ frame, kind: 'BELL', who: 0, detail: 'START' });
      } else {
        // REST → INTRO of the next round
        s.state = MS.INTRO;
        s.round = prev.round + 1;
        s.stateFrames = INTRO_FRAMES;
        s.roundFrame = 0;
        s.range = N.RANGE_START;
        for (let i = 0; i < 2; i++) {
          resetForRound(fs[i]);
          fs[i].knockdowns = 0;
          fs[i].roundPts = 0;
        }
      }
    }
    return { state: s, events };
  }

  // ── FIGHTING ──
  // (a) phase timers (+ GET_UP / KO handling for a downed fighter)
  let resolve0 = false;
  let resolve1 = false;
  let ko0 = false;
  let ko1 = false;
  for (let i = 0; i < 2; i++) {
    const f = fs[i];
    if (f.phase === PH.KNOCKDOWN) {
      if (ins[i] & BIT.GET_UP) {
        f.phase = PH.IDLE;
        f.phaseFrames = 0;
        f.hp = N.GETUP_HP;
        f.stamina = Math.max(f.stamina, N.GETUP_STAMINA);
        events.push({ frame, kind: 'GET_UP', who: i as 0 | 1 });
      } else {
        f.phaseFrames--;
        if (f.phaseFrames <= 0) {
          f.phaseFrames = 0;
          if (i === 0) ko0 = true;
          else ko1 = true;
        }
      }
    } else if (f.phase !== PH.IDLE) {
      f.phaseFrames--;
      if (f.phaseFrames <= 0) {
        switch (f.phase) {
          case PH.STARTUP:
            f.phase = PH.ACTIVE;
            f.phaseFrames = TBL[f.punch].active + (f.body ? BODY_MOD.active : 0);
            if (i === 0) resolve0 = true;
            else resolve1 = true;
            break;
          case PH.ACTIVE:
            f.phase = PH.RECOVERY;
            f.phaseFrames = TBL[f.punch].recovery + (f.body ? BODY_MOD.recovery : 0);
            break;
          case PH.RECOVERY:
            f.phase = PH.IDLE;
            f.phaseFrames = 0;
            f.punch = -1;
            f.body = 0;
            break;
          default: // STUNNED
            f.phase = PH.IDLE;
            f.phaseFrames = 0;
            break;
        }
      }
    }
  }
  if (ko0 || ko1) {
    endMatch(s, events, frame, ko0 && ko1 ? WIN_DRAW : ko0 ? 1 : 0, METHOD.KO);
    return { state: s, events };
  }

  // (b) range drift toward 600
  if (s.range > N.RANGE_START) s.range--;
  else if (s.range < N.RANGE_START) s.range++;

  // (c) held head / guard for this frame
  applyHeld(f0, ins[0], true);
  applyHeld(f1, ins[1], true);

  // (d) steps (one per fighter per frame; IN > OUT > L > R)
  for (let i = 0; i < 2; i++) {
    const f = fs[i];
    if (f.phase === PH.STUNNED || f.phase === PH.KNOCKDOWN || f.stepCooldown > 0) continue;
    const inp = ins[i];
    let detail: string | null = null;
    if (inp & BIT.STEP_IN) {
      s.range = Math.max(N.RANGE_MIN, s.range - N.STEP_DIST);
      detail = 'IN';
    } else if (inp & BIT.STEP_OUT) {
      s.range = Math.min(N.RANGE_MAX, s.range + N.STEP_DIST);
      detail = 'OUT';
    } else if (inp & BIT.STEP_L) {
      f.lateral = N.LATERAL_FRAMES;
      detail = 'L';
    } else if (inp & BIT.STEP_R) {
      f.lateral = N.LATERAL_FRAMES;
      detail = 'R';
    }
    if (detail !== null) {
      f.stepCooldown = N.STEP_COOLDOWN;
      events.push({ frame, kind: 'STEP', who: i as 0 | 1, detail });
    }
  }

  // (e) punch acceptance
  for (let i = 0; i < 2; i++) {
    const f = fs[i];
    const bits = ins[i] & PUNCH_MASK;
    if (bits === 0) continue;
    const can = f.phase === PH.IDLE || (f.phase === PH.RECOVERY && f.phaseFrames <= N.CANCEL_WINDOW);
    if (!can) continue;
    const p = pickPunch(bits);
    const spec = TBL[p];
    f.stamina = Math.max(0, f.stamina - spec.stamina);
    let startup = spec.startup + BODY_MOD.startup;
    if (f.stamina < N.FATIGUE_STAMINA) startup += N.FATIGUE_STARTUP;
    f.phase = PH.STARTUP;
    f.phaseFrames = startup;
    f.punch = p;
    f.body = ins[i] & BIT.BODY ? 1 : 0;
    f.thrown++;
  }

  // (f) resolution of punches that became ACTIVE this frame (simultaneous: both see the same snapshot)
  let grant0 = false;
  let grant1 = false;
  if (resolve0 || resolve1) {
    const pre: [FighterState, FighterState] = [{ ...f0 }, { ...f1 }];
    const range = s.range;
    const r0 = resolve0 ? resolve(pre, 0, range) : null;
    const r1 = resolve1 ? resolve(pre, 1, range) : null;
    for (let i = 0; i < 2; i++) {
      const r = i === 0 ? r0 : r1;
      if (r === null || r.kind === 'IGNORE') continue;
      const atk = i as 0 | 1;
      const tgt = (1 - i) as 0 | 1;
      const a = fs[atk];
      const t = fs[tgt];
      // Earlier simultaneous damage may have interrupted this fighter. The impact
      // was already resolved from pre, so its identity and scoring must use pre too.
      const punchIndex = pre[atk].punch;
      const punch = PUNCH_KINDS[punchIndex];
      const body = pre[atk].body === 1;
      switch (r.kind) {
        case 'MISS':
          events.push({ frame, kind: 'MISS', who: atk, punch, body });
          break;
        case 'EVADE':
          events.push({ frame, kind: 'EVADE', who: tgt, punch, body });
          t.roundPts += N.W_EVADE;
          if (r.grantCounter) {
            if (tgt === 0) grant0 = true;
            else grant1 = true;
          }
          break;
        case 'BLOCK':
          events.push({ frame, kind: 'BLOCK', who: atk, punch, body, damage: r.damage });
          if (body) t.stamina = Math.max(0, t.stamina - r.damage * BODY_MOD.staminaDrainMul);
          takeDamage(t, tgt, r.damage, frame, events);
          break;
        case 'HIT':
          events.push({ frame, kind: 'HIT', who: atk, punch, body, damage: r.damage });
          if (r.counter) {
            events.push({ frame, kind: 'COUNTER', who: atk, punch, body, damage: r.damage });
            a.counterWindow = 0;
          }
          a.landed++;
          a.roundPts += landedWeight(punchIndex, body, r.counter);
          s.range = Math.min(N.RANGE_MAX, s.range + N.KNOCKBACK);
          if (body) t.stamina = Math.max(0, t.stamina - r.damage * BODY_MOD.staminaDrainMul);
          takeDamage(t, tgt, r.damage, frame, events);
          break;
      }
    }
    // TKO check (after both resolutions so a double third-knockdown is a draw)
    const tko0 = f0.knockdowns >= N.KNOCKDOWNS_FOR_TKO && f0.phase === PH.KNOCKDOWN;
    const tko1 = f1.knockdowns >= N.KNOCKDOWNS_FOR_TKO && f1.phase === PH.KNOCKDOWN;
    if (tko0 || tko1) {
      endMatch(s, events, frame, tko0 && tko1 ? WIN_DRAW : tko0 ? 1 : 0, METHOD.TKO);
      return { state: s, events };
    }
  }

  // (g) stamina regen
  regen(f0, frame);
  regen(f1, frame);

  // (h) end-of-step counters
  for (let i = 0; i < 2; i++) {
    const f = fs[i];
    const granted = i === 0 ? grant0 : grant1;
    f.counterWindow = granted ? N.COUNTER_WINDOW : f.counterWindow > 0 ? f.counterWindow - 1 : 0;
    if (f.lateral > 0) f.lateral--;
    if (f.stepCooldown > 0) f.stepCooldown--;
  }

  // (i) round clock — the round cannot end while a fighter is down (the count continues after the bell)
  s.roundFrame = prev.roundFrame + 1;
  if (s.roundFrame >= ROUND_FRAMES && f0.phase !== PH.KNOCKDOWN && f1.phase !== PH.KNOCKDOWN) {
    endRound(s, events, frame);
  }
  return { state: s, events };
}

// ───────────────────────── Hash ─────────────────────────
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvInt(h: number, v: number): number {
  v = v | 0;
  h ^= v & 0xff;
  h = Math.imul(h, FNV_PRIME);
  h ^= (v >>> 8) & 0xff;
  h = Math.imul(h, FNV_PRIME);
  h ^= (v >>> 16) & 0xff;
  h = Math.imul(h, FNV_PRIME);
  h ^= (v >>> 24) & 0xff;
  h = Math.imul(h, FNV_PRIME);
  return h;
}

function fnvFighter(h: number, f: FighterState): number {
  h = fnvInt(h, f.hp);
  h = fnvInt(h, f.stamina);
  h = fnvInt(h, f.guardHigh);
  h = fnvInt(h, f.head);
  h = fnvInt(h, f.phase);
  h = fnvInt(h, f.phaseFrames);
  h = fnvInt(h, f.punch);
  h = fnvInt(h, f.body);
  h = fnvInt(h, f.counterWindow);
  h = fnvInt(h, f.lateral);
  h = fnvInt(h, f.stepCooldown);
  h = fnvInt(h, f.knockdowns);
  h = fnvInt(h, f.stance);
  h = fnvInt(h, f.landed);
  h = fnvInt(h, f.thrown);
  h = fnvInt(h, f.roundPts);
  h = fnvInt(h, f.dmgLog.length);
  for (let i = 0; i < f.dmgLog.length; i++) h = fnvInt(h, f.dmgLog[i]);
  return h;
}

/** FNV-1a 32-bit over every integer field in a fixed order. Unsigned result. */
function hash(s: SimState): number {
  let h = FNV_OFFSET;
  h = fnvInt(h, s.seed);
  h = fnvInt(h, s.frame);
  h = fnvInt(h, s.state);
  h = fnvInt(h, s.round);
  h = fnvInt(h, s.roundFrame);
  h = fnvInt(h, s.stateFrames);
  h = fnvInt(h, s.range);
  h = fnvInt(h, s.winner);
  h = fnvInt(h, s.method);
  for (let p = 0; p < 2; p++) {
    const sc = s.scores[p];
    h = fnvInt(h, sc.length);
    for (let i = 0; i < sc.length; i++) h = fnvInt(h, sc[i]);
  }
  h = fnvFighter(h, s.f[0]);
  h = fnvFighter(h, s.f[1]);
  return h >>> 0;
}

// ───────────────────────── View ─────────────────────────
const ceilDiv = (a: number, b: number): number => Math.trunc((a + b - 1) / b);

function fighterView(f: FighterState): FighterView {
  return {
    hp: f.hp,
    stamina: f.stamina,
    guardHigh: f.guardHigh === 1,
    head: HEAD_NAMES[f.head],
    phase: PHASE_NAMES[f.phase],
    punch: f.punch >= 0 ? PUNCH_KINDS[f.punch] : null,
    body: f.body === 1,
    phaseFrames: f.phaseFrames,
    counterWindow: f.counterWindow,
    knockdowns: f.knockdowns,
    stance: f.stance === 1 ? 'southpaw' : 'orthodox',
    landed: f.landed,
    thrown: f.thrown,
  };
}

function view(s: SimState): MatchView {
  let clockSec: number;
  switch (s.state) {
    case MS.INTRO:
      clockSec = ROUND_SECONDS;
      break;
    case MS.REST:
      clockSec = ceilDiv(s.stateFrames, SIM_HZ);
      break;
    default: // FIGHTING / OVER
      clockSec = ceilDiv(Math.max(0, ROUND_FRAMES - s.roundFrame), SIM_HZ);
      break;
  }
  return {
    frame: s.frame,
    state: MATCH_STATE_NAMES[s.state],
    round: s.round,
    roundFrame: s.roundFrame,
    clockSec,
    range: s.range,
    fighters: [fighterView(s.f[0]), fighterView(s.f[1])],
    scores: [s.scores[0].slice(), s.scores[1].slice()],
    winner: s.winner === WIN_DRAW ? 'DRAW' : s.winner === 0 || s.winner === 1 ? s.winner : null,
    method: METHOD_NAMES[s.method],
  };
}

export const sim: SimLike<SimState> = { init, step, hash, view };

/** Run a full input log from `seed`. A shorter side is padded with 0 (no input). */
export function replay(seed: number, log: [InputBits[], InputBits[]]): ReplayResult {
  const n = Math.max(log[0].length, log[1].length);
  let s = init(seed);
  for (let i = 0; i < n; i++) {
    s = step(s, [log[0][i] ?? 0, log[1][i] ?? 0]).state;
  }
  return { hash: hash(s), view: view(s), frames: n };
}
