import { BIT, PUNCH_MASK, type ActionEvent, type ActionType, type InputBits, type Stance } from '@spar/protocol';
import type { InputSource } from './InputSource';
import { KEY_BY_CODE, bindingFor, type KeyBinding } from './keymap';

export interface KeyboardInputOptions {
  /** Where to listen. Defaults to `window` (a bare EventTarget works for tests). */
  target?: EventTarget;
  stance?: Stance;
  /** Clock for event timestamps; defaults to performance.now(). */
  now?: () => number;
}

const MAX_BUFFERED_EVENTS = 256;

function isTextTarget(t: EventTarget | null): boolean {
  if (!t || typeof t !== 'object') return false;
  const el = t as { tagName?: unknown; isContentEditable?: unknown };
  if (typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * Keyboard fallback per DESIGN.md. Impulse keys fire once per keydown (auto-repeat ignored),
 * held keys map to held bits, B held = BODY modifier applied to the punch fired while held.
 */
export function createKeyboardInput(opts: KeyboardInputOptions = {}): InputSource {
  const target: EventTarget = opts.target ?? (typeof window !== 'undefined' ? window : new EventTarget());
  const stance: Stance = opts.stance ?? 'orthodox';
  const now = opts.now ?? (() => performance.now());

  const held = new Set<string>(); // codes currently down
  let pendingImpulses: InputBits = 0;
  let events: ActionEvent[] = [];

  const pushEvent = (ev: ActionEvent) => {
    events.push(ev);
    if (events.length > MAX_BUFFERED_EVENTS) events.splice(0, events.length - MAX_BUFFERED_EVENTS);
  };

  const heldBits = (): InputBits => {
    let bits = 0;
    for (const code of held) {
      const b = KEY_BY_CODE.get(code);
      if (b && b.mode === 'held') bits |= b.bit;
    }
    return bits;
  };

  const groupStillHeld = (group: KeyBinding['group'], except: string): boolean => {
    for (const code of held) {
      if (code === except) continue;
      const b = KEY_BY_CODE.get(code);
      if (b && b.mode === 'held' && b.group === group) return true;
    }
    return false;
  };

  const onKeyDown = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.metaKey || ke.ctrlKey || ke.altKey) return;
    const binding = bindingFor(ke);
    if (!binding) return;
    if (isTextTarget(ke.target)) return;
    if (typeof ke.preventDefault === 'function') ke.preventDefault();
    const id = binding.code; // held-set identity is the binding, not whatever the event carried
    if (ke.repeat || held.has(id)) return; // no auto-repeat, no double-fire
    held.add(id);
    const t = now();
    switch (binding.mode) {
      case 'impulse': {
        let bits = binding.bit;
        const isPunch = (bits & PUNCH_MASK) !== 0;
        const body = isPunch && held.has('KeyB');
        if (body) bits |= BIT.BODY;
        pendingImpulses |= bits;
        const ev: ActionEvent = { t, type: binding.action as ActionType, confidence: 1 };
        if (isPunch) ev.body = body;
        pushEvent(ev);
        break;
      }
      case 'held':
        pushEvent({ t, type: binding.action as ActionType, confidence: 1 });
        break;
      case 'modifier':
        break;
    }
  };

  const onKeyUp = (e: Event) => {
    const ke = e as KeyboardEvent;
    const binding = bindingFor(ke);
    if (!binding) return;
    const id = binding.code;
    if (!held.has(id)) return;
    held.delete(id);
    if (binding.mode === 'held' && binding.release && !groupStillHeld(binding.group, id)) {
      pushEvent({ t: now(), type: binding.release, confidence: 1 });
    }
  };

  /** Losing focus must never leave a key "stuck" down. */
  const onBlur = () => {
    if (held.size === 0) return;
    const t = now();
    const hadHead = groupStillHeld('head', '');
    const hadGuard = groupStillHeld('guard', '');
    held.clear();
    if (hadHead) pushEvent({ t, type: 'HEAD_CENTER', confidence: 1 });
    if (hadGuard) pushEvent({ t, type: 'GUARD_LOW', confidence: 1 });
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return {
    kind: 'keyboard',
    sample: () => {
      const bits = heldBits() | pendingImpulses;
      pendingImpulses = 0;
      return bits;
    },
    events: () => {
      const out = events;
      events = [];
      return out;
    },
    latestPose: () => null,
    stance: () => stance,
    dispose: () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      held.clear();
      pendingImpulses = 0;
      events = [];
    },
  };
}
