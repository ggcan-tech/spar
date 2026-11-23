import type { InputBits, PoseFrame } from '@spar/protocol';
import type { Calibration } from './calibration';
import { createGestureEngine } from './engine';
import type { GestureOptions } from './defaults';

/**
 * Offline helper: run the engine over a recording and sample `sampleInput()` at a fixed tick rate
 * driven by the frame timestamps (tick k is at frames[0].t + k·1000/hz). Every impulse shows up in
 * exactly one tick; held bits repeat.
 */
export function framesToInputs(frames: PoseFrame[], cal: Calibration, hz = 60, opts?: GestureOptions): InputBits[] {
  const out: InputBits[] = [];
  if (frames.length === 0) return out;
  const engine = createGestureEngine(cal, opts);
  const dt = 1000 / hz;
  const t0 = frames[0].t;
  const tEnd = frames[frames.length - 1].t;
  const nTicks = Math.ceil((tEnd - t0) / dt - 1e-9) + 1;
  let k = 0;
  for (const f of frames) {
    while (k < nTicks && t0 + k * dt < f.t) { out.push(engine.sampleInput()); k++; }
    engine.push(f);
  }
  // the last tick is at or after the last frame, so impulses from the final frame are flushed here
  while (k < nTicks) { out.push(engine.sampleInput()); k++; }
  return out;
}
