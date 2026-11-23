import { useSyncExternalStore } from 'react';
import type { GestureEngineLike } from '@spar/protocol';
import type { Calibration } from '@spar/gestures';
import type { InputSource } from './InputSource';
import { createKeyboardInput } from './keyboard';

/**
 * Module-level store for the active InputSource (+ the calibration/engine behind it, when the
 * source is the camera). Default is the keyboard. Fight/Online screens read `inputStore.get()`;
 * the Dojo writes via `inputStore.set(...)`.
 */
export interface InputStoreState {
  input: InputSource;
  calibration: Calibration | null;
  /** The gesture engine driving `input` when kind === 'camera' (for debug views). */
  engine: GestureEngineLike | null;
}

export interface SetInputExtras {
  calibration?: Calibration | null;
  engine?: GestureEngineLike | null;
  /** Default true: the previous InputSource is disposed when replaced. */
  disposePrevious?: boolean;
}

type Listener = () => void;

let state: InputStoreState | null = null;
const listeners = new Set<Listener>();

function ensure(): InputStoreState {
  if (!state) state = { input: createKeyboardInput(), calibration: null, engine: null };
  return state;
}

function emit() {
  for (const l of listeners) l();
}

export const inputStore = {
  /** Active InputSource (keyboard until the Dojo calibrates a camera). */
  get(): InputSource {
    return ensure().input;
  },
  /** Full snapshot (stable identity until the next `set`). */
  state(): InputStoreState {
    return ensure();
  },
  calibration(): Calibration | null {
    return ensure().calibration;
  },
  set(input: InputSource, extras: SetInputExtras = {}): void {
    const prev = ensure();
    if (prev.input !== input && extras.disposePrevious !== false) prev.input.dispose();
    state = {
      input,
      calibration: extras.calibration !== undefined ? extras.calibration : input.kind === 'camera' ? prev.calibration : null,
      engine: extras.engine !== undefined ? extras.engine : input.kind === 'camera' ? prev.engine : null,
    };
    emit();
  },
  /** Back to the keyboard (disposes the camera input; does not stop the camera session). */
  resetToKeyboard(): void {
    inputStore.set(createKeyboardInput(), { calibration: null, engine: null });
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** React hook: re-renders when the active input source changes. */
export function useInputStore(): InputStoreState {
  return useSyncExternalStore(inputStore.subscribe, inputStore.state, inputStore.state);
}
