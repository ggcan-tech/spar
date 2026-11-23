import { BIT, type ActionType, type InputBits } from '@spar/protocol';

/**
 * Keyboard map from docs/DESIGN.md ("Web app screens"):
 * J=JAB, K=CROSS, U=LEAD_HOOK, I=REAR_HOOK, N=LEAD_UPPER, M=REAR_UPPER, B (hold)=BODY,
 * A/D (hold)=SLIP_L/R, S (hold)=DUCK, Space (hold)=GUARD_HIGH, W=STEP_IN, X=STEP_OUT, Q/E=STEP_L/R, G=GET_UP.
 *
 * Bindings are keyed by `KeyboardEvent.code` (physical key), so caps lock / shift / layout
 * quirks don't matter.
 */
export type KeyMode = 'impulse' | 'held' | 'modifier';

export interface KeyBinding {
  code: string;
  /** Human label for the help panel. */
  label: string;
  bit: InputBits;
  mode: KeyMode;
  /** Action reported in `events()` on keydown (or "BODY" for the modifier). */
  action: ActionType | 'BODY';
  /** Held keys: action reported on keyup once no other key of the same group is held. */
  release?: ActionType;
  /** Held keys sharing a release action (head keys all release to HEAD_CENTER). */
  group?: 'head' | 'guard';
  description: string;
}

export const KEYMAP: readonly KeyBinding[] = [
  { code: 'KeyJ', label: 'J', bit: BIT.JAB, mode: 'impulse', action: 'JAB', description: 'Jab' },
  { code: 'KeyK', label: 'K', bit: BIT.CROSS, mode: 'impulse', action: 'CROSS', description: 'Cross' },
  { code: 'KeyU', label: 'U', bit: BIT.LEAD_HOOK, mode: 'impulse', action: 'LEAD_HOOK', description: 'Lead hook' },
  { code: 'KeyI', label: 'I', bit: BIT.REAR_HOOK, mode: 'impulse', action: 'REAR_HOOK', description: 'Rear hook' },
  { code: 'KeyN', label: 'N', bit: BIT.LEAD_UPPER, mode: 'impulse', action: 'LEAD_UPPER', description: 'Lead uppercut' },
  { code: 'KeyM', label: 'M', bit: BIT.REAR_UPPER, mode: 'impulse', action: 'REAR_UPPER', description: 'Rear uppercut' },
  { code: 'KeyB', label: 'B', bit: BIT.BODY, mode: 'modifier', action: 'BODY', description: 'Hold: punch goes to the body' },
  { code: 'KeyA', label: 'A', bit: BIT.SLIP_L, mode: 'held', action: 'SLIP_L', release: 'HEAD_CENTER', group: 'head', description: 'Hold: slip left' },
  { code: 'KeyD', label: 'D', bit: BIT.SLIP_R, mode: 'held', action: 'SLIP_R', release: 'HEAD_CENTER', group: 'head', description: 'Hold: slip right' },
  { code: 'KeyS', label: 'S', bit: BIT.DUCK, mode: 'held', action: 'DUCK', release: 'HEAD_CENTER', group: 'head', description: 'Hold: duck' },
  { code: 'Space', label: 'Space', bit: BIT.GUARD_HIGH, mode: 'held', action: 'GUARD_HIGH', release: 'GUARD_LOW', group: 'guard', description: 'Hold: guard high' },
  { code: 'KeyW', label: 'W', bit: BIT.STEP_IN, mode: 'impulse', action: 'STEP_IN', description: 'Step in' },
  { code: 'KeyX', label: 'X', bit: BIT.STEP_OUT, mode: 'impulse', action: 'STEP_OUT', description: 'Step out' },
  { code: 'KeyQ', label: 'Q', bit: BIT.STEP_L, mode: 'impulse', action: 'STEP_L', description: 'Step left' },
  { code: 'KeyE', label: 'E', bit: BIT.STEP_R, mode: 'impulse', action: 'STEP_R', description: 'Step right' },
  { code: 'KeyG', label: 'G', bit: BIT.GET_UP, mode: 'impulse', action: 'GET_UP', description: 'Get up (after a knockdown)' },
];

export const KEY_BY_CODE: ReadonlyMap<string, KeyBinding> = new Map(KEYMAP.map((b) => [b.code, b]));

/** Fallback lookup by `KeyboardEvent.key` (lower-cased) for environments that send an empty `code`. */
export const KEY_BY_KEY: ReadonlyMap<string, KeyBinding> = new Map(
  KEYMAP.map((b) => [b.code === 'Space' ? ' ' : b.code.replace(/^Key/, '').toLowerCase(), b]),
);

/** Resolve a binding from a keyboard event: physical `code` first, then `key`. */
export function bindingFor(e: { code?: string; key?: string }): KeyBinding | undefined {
  if (e.code) {
    const b = KEY_BY_CODE.get(e.code);
    if (b) return b;
  }
  if (typeof e.key === 'string' && e.key.length > 0) return KEY_BY_KEY.get(e.key.toLowerCase());
  return undefined;
}

/** Display order for the 16 input bits (used by the Dojo "live bits" chips). */
export const BIT_NAMES: ReadonlyArray<{ name: string; bit: InputBits; kind: 'punch' | 'held' | 'impulse' | 'mod' }> = [
  { name: 'JAB', bit: BIT.JAB, kind: 'punch' },
  { name: 'CROSS', bit: BIT.CROSS, kind: 'punch' },
  { name: 'L.HOOK', bit: BIT.LEAD_HOOK, kind: 'punch' },
  { name: 'R.HOOK', bit: BIT.REAR_HOOK, kind: 'punch' },
  { name: 'L.UPPER', bit: BIT.LEAD_UPPER, kind: 'punch' },
  { name: 'R.UPPER', bit: BIT.REAR_UPPER, kind: 'punch' },
  { name: 'BODY', bit: BIT.BODY, kind: 'mod' },
  { name: 'SLIP_L', bit: BIT.SLIP_L, kind: 'held' },
  { name: 'SLIP_R', bit: BIT.SLIP_R, kind: 'held' },
  { name: 'DUCK', bit: BIT.DUCK, kind: 'held' },
  { name: 'GUARD', bit: BIT.GUARD_HIGH, kind: 'held' },
  { name: 'STEP_IN', bit: BIT.STEP_IN, kind: 'impulse' },
  { name: 'STEP_OUT', bit: BIT.STEP_OUT, kind: 'impulse' },
  { name: 'STEP_L', bit: BIT.STEP_L, kind: 'impulse' },
  { name: 'STEP_R', bit: BIT.STEP_R, kind: 'impulse' },
  { name: 'GET_UP', bit: BIT.GET_UP, kind: 'impulse' },
];
