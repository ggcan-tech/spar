/**
 * Deterministic bot policy. Sees only `MatchView` (what a human on the other side would see) and
 * keeps its own small memory inside the closure — none of it is sim state.
 * RNG: xorshift32 seeded from `seed`. Same seed + same view sequence → same output sequence.
 */
import { BIT, type InputBits, type MatchView, type PunchKind } from '@spar/protocol';
import { PUNCH_TABLE } from './sim';

const STRAIGHTS: ReadonlySet<PunchKind> = new Set<PunchKind>(['JAB', 'CROSS']);
const HOOKS: ReadonlySet<PunchKind> = new Set<PunchKind>(['LEAD_HOOK', 'REAR_HOOK']);
const PUNCH_BIT: Readonly<Record<PunchKind, InputBits>> = {
  JAB: BIT.JAB,
  CROSS: BIT.CROSS,
  LEAD_HOOK: BIT.LEAD_HOOK,
  REAR_HOOK: BIT.REAR_HOOK,
  LEAD_UPPER: BIT.LEAD_UPPER,
  REAR_UPPER: BIT.REAR_UPPER,
};

const GUARD_HIGH_PCT = 70;
const STEP_IN_RANGE = 650;
const JAB_RANGE = 700;
const BACK_OFF_STAMINA = 350;
const RESUME_STAMINA = 550;
const STEP_COOLDOWN = 20;
const ATTACK_PCT = 8; // per idle frame in range
const BODY_PCT = 20;

/**
 * @param seed any integer
 * @param difficulty 0..1 (default 0.5) — scales reaction chance: 15% at 0, 30% at 0.5, 45% at 1.
 */
export function createBot(seed: number, difficulty = 0.5): (view: MatchView, player: 0 | 1) => InputBits {
  let x = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  if (x === 0) x = 0x2545f491;
  const rng = (n: number): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % n;
  };
  const chance = (p: number): boolean => rng(100) < p;

  const diff = Math.max(0, Math.min(100, Math.trunc(difficulty * 100)));
  const reactPct = Math.trunc((30 * (50 + diff)) / 100);

  // bot memory
  let guardHigh = true;
  let guardUntil = -1;
  let combo: InputBits[] = [];
  let lastStepFrame = -1000;
  let evadeBit: InputBits = 0;
  let evadeUntil = -1;
  let lastOppPhase = '';
  let resting = false;
  let getUpAt = -1;

  const inRange = (kind: PunchKind, range: number, body: boolean): boolean =>
    range <= PUNCH_TABLE[kind].maxRange - (body ? 50 : 0);

  const buildCombo = (range: number): InputBits[] => {
    const len = 2 + rng(2); // 2..3
    const out: InputBits[] = [];
    for (let i = 0; i < len; i++) {
      let kind: PunchKind;
      if (i === 0) kind = 'JAB';
      else if (range <= 400 && chance(35)) kind = rng(2) === 0 ? 'LEAD_UPPER' : 'REAR_UPPER';
      else if (range <= 500 && chance(50)) kind = rng(2) === 0 ? 'LEAD_HOOK' : 'REAR_HOOK';
      else if (range <= 650) kind = 'CROSS';
      else kind = 'JAB';
      let bits = PUNCH_BIT[kind];
      if (chance(BODY_PCT) && inRange(kind, range, true)) bits |= BIT.BODY;
      out.push(bits);
    }
    return out;
  };

  return (view: MatchView, player: 0 | 1): InputBits => {
    const me = view.fighters[player];
    const opp = view.fighters[player === 0 ? 1 : 0];
    const frame = view.frame;
    const range = view.range;

    if (view.state !== 'FIGHTING') {
      combo = [];
      evadeBit = 0;
      evadeUntil = -1;
      getUpAt = -1;
      lastOppPhase = '';
      return view.state === 'OVER' ? 0 : BIT.GUARD_HIGH;
    }

    // Knocked down: get up after a short pause.
    if (me.phase === 'KNOCKDOWN') {
      if (getUpAt < 0) getUpAt = frame + 30 + rng(150);
      return frame >= getUpAt ? BIT.GET_UP : 0;
    }
    getUpAt = -1;
    if (me.phase === 'STUNNED') {
      combo = [];
      return 0;
    }

    let bits: InputBits = 0;

    // Guard: re-roll every 10..30 frames, high ~70% of the time.
    if (frame >= guardUntil) {
      guardHigh = chance(GUARD_HIGH_PCT);
      guardUntil = frame + 10 + rng(20);
    }

    // Stamina management with hysteresis.
    if (me.stamina < BACK_OFF_STAMINA) resting = true;
    else if (me.stamina > RESUME_STAMINA) resting = false;

    // Reactions: roll once per incoming head punch, on the first frame we see its STARTUP.
    if (opp.phase === 'STARTUP' && lastOppPhase !== 'STARTUP' && opp.punch !== null && !opp.body) {
      const hold = frame + opp.phaseFrames + 2;
      if (STRAIGHTS.has(opp.punch) && chance(reactPct)) {
        evadeBit = rng(2) === 0 ? BIT.SLIP_L : BIT.SLIP_R;
        evadeUntil = hold;
      } else if (HOOKS.has(opp.punch) && chance(reactPct)) {
        evadeBit = BIT.DUCK;
        evadeUntil = hold;
      }
    }
    lastOppPhase = opp.phase;
    if (frame < evadeUntil) bits |= evadeBit;
    else evadeBit = 0;

    // Footwork.
    if (frame - lastStepFrame >= STEP_COOLDOWN) {
      let stepped = false;
      if (resting) {
        if (range < 800 && chance(15)) {
          bits |= BIT.STEP_OUT;
          stepped = true;
        }
      } else if (range > STEP_IN_RANGE && chance(25)) {
        bits |= BIT.STEP_IN;
        stepped = true;
      } else if (chance(2)) {
        bits |= rng(2) === 0 ? BIT.STEP_L : BIT.STEP_R;
        stepped = true;
      }
      if (stepped) lastStepFrame = frame;
    }

    // Offense: combos of 2–3, jab-led, range-aware; counter-punch after an evade.
    const canPunch = me.phase === 'IDLE' || (me.phase === 'RECOVERY' && me.phaseFrames <= 2);
    if (canPunch && !resting) {
      if (combo.length === 0 && range <= JAB_RANGE && (me.counterWindow > 0 || chance(ATTACK_PCT))) {
        combo = buildCombo(range);
      }
      if (combo.length > 0) {
        let next = combo.shift() as InputBits;
        const body = (next & BIT.BODY) !== 0;
        const kind = PUNCH_KEYS.find((k) => (next & PUNCH_BIT[k]) !== 0) as PunchKind;
        if (!inRange(kind, range, body)) {
          // fall back to a jab if that reaches, else abandon the combo
          if (range <= JAB_RANGE) next = BIT.JAB;
          else {
            combo = [];
            next = 0;
          }
        }
        bits |= next;
      }
    } else if (resting) {
      combo = [];
    }

    if (guardHigh) bits |= BIT.GUARD_HIGH;
    return bits;
  };
}

const PUNCH_KEYS: readonly PunchKind[] = ['JAB', 'CROSS', 'LEAD_HOOK', 'REAR_HOOK', 'LEAD_UPPER', 'REAR_UPPER'];
