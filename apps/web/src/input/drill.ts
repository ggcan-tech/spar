import { BIT, type ActionEvent, type ActionType, type InputBits } from '@spar/protocol';

/**
 * "Call & response" drill state machine. Pure logic (no DOM) so it can be unit-tested and driven
 * by either the camera or the keyboard.
 *
 * Punch/step prompts are satisfied by a matching ActionEvent. Head/guard prompts are satisfied by
 * a matching event OR by observing the held bit turn on (after being off) — a guard that was
 * already up when the prompt appeared has to drop and come back, otherwise the engine (rightly)
 * never emits a new transition.
 */
export type PromptClass = 'punch' | 'head' | 'guard' | 'step';

export interface DrillPrompt {
  type: ActionType;
  label: string;
  cls: PromptClass;
  /** Plain-language movement, before boxing terminology. */
  instruction?: string;
  /** A practical cue, not a claim that the camera validates technique. */
  cue?: string;
  /** Held bit for head/guard prompts. */
  bit?: InputBits;
}

export const DRILL_PROMPTS: readonly DrillPrompt[] = [
  { type: 'JAB', label: 'Jab', cls: 'punch', instruction: 'Punch straight ahead with your front hand, then bring it back.', cue: 'Use one clear motion. Keep your other hand near your cheek.' },
  { type: 'CROSS', label: 'Cross', cls: 'punch', instruction: 'Reach straight ahead with your back hand, then bring it back.', cue: 'Turn your back shoulder forward a little. Keep the motion comfortable.' },
  { type: 'LEAD_HOOK', label: 'Lead hook', cls: 'punch', instruction: 'Sweep your front hand across in a short arc, with your elbow bent.', cue: 'Imagine moving around the side of a target. Return your hand to your cheek.' },
  { type: 'REAR_HOOK', label: 'Rear hook', cls: 'punch', instruction: 'Sweep your back hand across in a short arc, with your elbow bent.', cue: 'Use a small, controlled arc. Keep your other hand up.' },
  { type: 'LEAD_UPPER', label: 'Lead uppercut', cls: 'punch', instruction: 'Lift your front fist in a short upward arc, then return to guard.', cue: 'Keep your elbow bent. You do not need a big swing.' },
  { type: 'REAR_UPPER', label: 'Rear uppercut', cls: 'punch', instruction: 'Lift your back fist in a short upward arc, then return to guard.', cue: 'Start near your ribs and finish in front of you.' },
  { type: 'SLIP_L', label: 'Slip left', cls: 'head', bit: BIT.SLIP_L, instruction: 'Move your head a little to your left, then return to the middle.', cue: 'Keep your feet planted. This is a head movement, not a sideways step.' },
  { type: 'SLIP_R', label: 'Slip right', cls: 'head', bit: BIT.SLIP_R, instruction: 'Move your head a little to your right, then return to the middle.', cue: 'Keep your feet planted. Use a small, comfortable movement.' },
  { type: 'DUCK', label: 'Duck', cls: 'head', bit: BIT.DUCK, instruction: 'Bend your knees a little to lower your head, then stand back up.', cue: 'Keep looking forward. A small dip is enough.' },
  { type: 'GUARD_HIGH', label: 'Guard up', cls: 'guard', bit: BIT.GUARD_HIGH, instruction: 'Bring both hands beside your cheeks.', cue: 'If your hands are already up, lower them briefly and bring them back up.' },
  { type: 'STEP_IN', label: 'Step in', cls: 'step', instruction: 'Take one small step toward the camera.', cue: 'Move your whole body forward. Stay far enough away to remain in view.' },
  { type: 'STEP_OUT', label: 'Step out', cls: 'step', instruction: 'Take one small step away from the camera.', cue: 'Move your whole body back. Keep both feet in view.' },
  { type: 'STEP_L', label: 'Step left', cls: 'step', instruction: 'Take one small sideways step to your left.', cue: 'Move your feet and body together, rather than leaning your head.' },
  { type: 'STEP_R', label: 'Step right', cls: 'step', instruction: 'Take one small sideways step to your right.', cue: 'Move your feet and body together. Stay inside the camera view.' },
];

export interface DrillTally {
  hits: number;
  misses: number;
  skips: number;
  /** ms between prompt and the matching event, per hit. */
  latencies: number[];
}

export interface DrillResult {
  type: ActionType;
  ok: boolean;
  latencyMs: number | null;
  /** What the player actually did on a miss. */
  got?: ActionType;
}

export interface DrillState {
  status: 'idle' | 'running' | 'done';
  /** Index of the current prompt when running. */
  index: number;
  /** When the current prompt appeared (ms, same clock as ActionEvent.t). */
  promptedAt: number;
  /** After a hit the prompt "holds" until this time before advancing. */
  holdUntil: number | null;
  tallies: DrillTally[];
  lastResult: DrillResult | null;
  /** Monotonic counter bumped on every change so React can memo cheaply. */
  rev: number;
}

export interface Drill {
  state(): DrillState;
  start(now: number): void;
  reset(): void;
  /** Count the current prompt as skipped and advance. */
  skip(now: number): void;
  /**
   * Feed the events drained this tick plus the current held bits. Returns true when the visible
   * state changed.
   */
  feed(events: ActionEvent[], heldBits: InputBits, now: number): boolean;
}

const HOLD_MS = 650;

const classOf = (type: ActionType): PromptClass | null => {
  switch (type) {
    case 'JAB':
    case 'CROSS':
    case 'LEAD_HOOK':
    case 'REAR_HOOK':
    case 'LEAD_UPPER':
    case 'REAR_UPPER':
      return 'punch';
    case 'SLIP_L':
    case 'SLIP_R':
    case 'DUCK':
      return 'head';
    case 'GUARD_HIGH':
      return 'guard';
    case 'STEP_IN':
    case 'STEP_OUT':
    case 'STEP_L':
    case 'STEP_R':
      return 'step';
    default:
      return null; // HEAD_CENTER, GUARD_LOW, GET_UP never count as misses
  }
};

export function createDrill(prompts: readonly DrillPrompt[] = DRILL_PROMPTS): Drill {
  const freshTallies = () => prompts.map<DrillTally>(() => ({ hits: 0, misses: 0, skips: 0, latencies: [] }));
  let s: DrillState = { status: 'idle', index: 0, promptedAt: 0, holdUntil: null, tallies: freshTallies(), lastResult: null, rev: 0 };
  /** For held prompts: have we seen the bit OFF since the prompt appeared? */
  let armed = false;
  /** Last held bits seen by feed(); used when a prompt is shown from skip(). */
  let lastHeld: InputBits = 0;

  const bump = (patch: Partial<DrillState>) => {
    s = { ...s, ...patch, rev: s.rev + 1 };
  };

  const showPrompt = (index: number, now: number, heldBits: InputBits) => {
    const p = prompts[index];
    armed = p.bit === undefined ? true : (heldBits & p.bit) === 0;
    bump({ index, promptedAt: now, holdUntil: null, lastResult: null });
  };

  const advance = (now: number, heldBits: InputBits) => {
    if (s.index + 1 >= prompts.length) bump({ status: 'done', holdUntil: null });
    else showPrompt(s.index + 1, now, heldBits);
  };

  const settle = (result: DrillResult, now: number) => {
    const tallies = s.tallies.map((t, i) => {
      if (i !== s.index) return t;
      const c = { ...t, latencies: t.latencies.slice() };
      if (result.ok) {
        c.hits++;
        if (result.latencyMs !== null) c.latencies.push(result.latencyMs);
      } else {
        c.misses++;
      }
      return c;
    });
    bump({ tallies, lastResult: result, holdUntil: result.ok ? now + HOLD_MS : null });
  };

  return {
    state: () => s,
    start(now) {
      s = { status: 'running', index: 0, promptedAt: now, holdUntil: null, tallies: freshTallies(), lastResult: null, rev: s.rev + 1 };
      armed = true;
      showPrompt(0, now, lastHeld);
    },
    reset() {
      s = { status: 'idle', index: 0, promptedAt: 0, holdUntil: null, tallies: freshTallies(), lastResult: null, rev: s.rev + 1 };
    },
    skip(now) {
      if (s.status !== 'running') return;
      const tallies = s.tallies.map((t, i) => (i === s.index ? { ...t, skips: t.skips + 1 } : t));
      bump({ tallies, lastResult: { type: prompts[s.index].type, ok: false, latencyMs: null } });
      advance(now, lastHeld);
    },
    feed(events, heldBits, now) {
      if (s.status !== 'running') return false;
      lastHeld = heldBits;
      const rev0 = s.rev;
      if (s.holdUntil !== null) {
        if (now >= s.holdUntil) advance(now, heldBits);
        return s.rev !== rev0;
      }
      const p = prompts[s.index];
      // A matching action in this batch wins over competing classifications.
      const match = events.find((ev) => ev.t >= s.promptedAt && ev.type === p.type);
      if (match) {
        settle({ type: p.type, ok: true, latencyMs: match.t - s.promptedAt }, now);
        return true;
      }
      // 1) events
      for (const ev of events) {
        if (ev.t < s.promptedAt) continue; // stale (fired before the prompt)
        const cls = classOf(ev.type);
        if (cls !== null && cls === p.cls) {
          settle({ type: p.type, ok: false, latencyMs: null, got: ev.type }, now);
          return true;
        }
      }
      // 2) held-bit transition for head/guard prompts
      if (p.bit !== undefined) {
        const on = (heldBits & p.bit) !== 0;
        if (!on) armed = true;
        else if (armed) {
          settle({ type: p.type, ok: true, latencyMs: Math.max(0, now - s.promptedAt) }, now);
          return true;
        }
      }
      return s.rev !== rev0;
    },
  };
}

export function drillSummary(state: DrillState): { hits: number; misses: number; skips: number; meanLatencyMs: number | null } {
  let hits = 0;
  let misses = 0;
  let skips = 0;
  let sum = 0;
  let n = 0;
  for (const t of state.tallies) {
    hits += t.hits;
    misses += t.misses;
    skips += t.skips;
    for (const l of t.latencies) {
      sum += l;
      n++;
    }
  }
  return { hits, misses, skips, meanLatencyMs: n ? sum / n : null };
}
