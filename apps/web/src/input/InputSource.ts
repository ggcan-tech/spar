import type { ActionEvent, InputBits, PoseFrame, Stance } from '@spar/protocol';

/**
 * The one thing Fight/Online screens read from. Whatever the Dojo set up (camera + gesture
 * engine, or the keyboard fallback) is exposed through this and stored in `inputStore`.
 */
export interface InputSource {
  kind: 'camera' | 'keyboard';
  /** Call once per 60 Hz sim tick: held bits | impulse bits fired since the last call (drained). */
  sample(): InputBits;
  /** Recognized ActionEvents since the last call (drained). For tickers / drills, not for the sim. */
  events(): ActionEvent[];
  /** Most recent pose frame (camera) or null (keyboard). */
  latestPose(): PoseFrame | null;
  stance(): Stance;
  /** Detach listeners. Does not stop the camera itself (see camera/session.ts). */
  dispose(): void;
}

/**
 * OR two sources together (e.g. camera + keyboard so keys keep working as a fallback while the
 * camera is live). `kind`, `latestPose` and `stance` come from `primary`.
 */
export function createCombinedInput(primary: InputSource, secondary: InputSource): InputSource {
  return {
    kind: primary.kind,
    sample: () => primary.sample() | secondary.sample(),
    events: () => {
      const a = primary.events();
      const b = secondary.events();
      if (b.length === 0) return a;
      if (a.length === 0) return b;
      return a.concat(b).sort((x, y) => x.t - y.t);
    },
    latestPose: () => primary.latestPose() ?? secondary.latestPose(),
    stance: () => primary.stance(),
    dispose: () => {
      primary.dispose();
      secondary.dispose();
    },
  };
}

export { createKeyboardInput } from './keyboard';
export { createCameraInput } from './cameraInput';
