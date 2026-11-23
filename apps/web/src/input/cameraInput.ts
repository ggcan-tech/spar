import { LANDMARK_COUNT, LM, type ActionEvent, type GestureEngineLike, type PoseFrame } from '@spar/protocol';
import type { PoseSource } from '../camera/pose';
import type { InputSource } from './InputSource';

const MAX_BUFFERED_EVENTS = 256;

export interface CameraInputOptions {
  /** Monotonic arrival clock, independent of detector frame timestamps. */
  now?: () => number;
  /** Maximum silence before controls are released. */
  staleAfterMs?: number;
}

function usable(frame: PoseFrame): boolean {
  return Number.isFinite(frame.t) && frame.lm.length === LANDMARK_COUNT &&
    [LM.L_SHOULDER, LM.R_SHOULDER].every((i) => {
      const p = frame.lm[i];
      return p && [p.x, p.y, p.z, p.v].every(Number.isFinite) && p.v >= 0.5;
    });
}

/** Camera ownership stays with the session; this adapter owns recognition freshness. */
export function createCameraInput(
  engine: GestureEngineLike & { reset?: () => void },
  pose: PoseSource,
  options: CameraInputOptions = {},
): InputSource {
  const now = options.now ?? (() => performance.now());
  const staleAfterMs = options.staleAfterMs ?? 250;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError('staleAfterMs must be a positive finite duration');
  }
  let latest: PoseFrame | null = null;
  let arrivedAt = -Infinity;
  let lastFrameT = -Infinity;
  let events: ActionEvent[] = [];
  let disposed = false;

  const loseTracking = () => {
    const wasTracking = latest !== null;
    latest = null;
    events = [];
    if (wasTracking) {
      engine.reset?.();
      engine.drainImpulses();
    }
  };
  const fresh = (at = now()) => {
    if (latest && (!Number.isFinite(at) || at - arrivedAt >= staleAfterMs || at < arrivedAt)) loseTracking();
    return !disposed && latest !== null;
  };

  const off = pose.onFrame((frame) => {
    if (disposed) return;
    const at = now();
    fresh(at); // A gap must reset history even if nobody sampled during it.
    if (!Number.isFinite(at) || !usable(frame) || frame.t <= lastFrameT) {
      loseTracking();
      return;
    }
    const reacquiring = latest === null;
    latest = frame;
    lastFrameT = frame.t;
    arrivedAt = at;
    const evs = engine.push(frame);
    if (reacquiring) {
      // Establish the new body position without turning the jump into an attack or step.
      engine.drainImpulses();
      return;
    }
    for (const ev of evs) events.push(ev);
    if (events.length > MAX_BUFFERED_EVENTS) events.splice(0, events.length - MAX_BUFFERED_EVENTS);
  });

  return {
    kind: 'camera',
    sample: () => fresh() ? engine.sampleInput() : 0,
    events: () => {
      fresh();
      const out = events;
      events = [];
      return out;
    },
    latestPose: () => fresh() ? latest : null,
    stance: () => engine.stance(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      off();
      loseTracking();
    },
  };
}
