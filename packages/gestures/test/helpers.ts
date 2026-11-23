import type { ActionEvent, PoseFrame, PunchKind } from '@spar/protocol';
import { PUNCH_MASK } from '@spar/protocol';
import { calibrate, createGestureEngine, synth, type Calibration, type GestureEngine, type GestureOptions } from '../src/index';

export const FPS = 30;
export const SIGMA = 0.004; // ≈ 2.5 px at 640 wide — MediaPipe-like jitter
export const PUNCH_KINDS: PunchKind[] = ['JAB', 'CROSS', 'LEAD_HOOK', 'REAR_HOOK', 'LEAD_UPPER', 'REAR_UPPER'];

export function isPunch(e: ActionEvent): boolean {
  return (PUNCH_KINDS as string[]).includes(e.type);
}

export function noisyCalibration(opts?: GestureOptions, seed = 7): Calibration {
  return calibrate(synth.withNoise(synth.calibrationClip({ fps: FPS }), SIGMA, seed), undefined, opts);
}

export interface Run { events: ActionEvent[]; held: number[]; inputs: number[]; engine: GestureEngine; frames: PoseFrame[] }

/** Push every frame; record events, held() after each frame, and sampleInput() after each frame. */
export function run(frames: PoseFrame[], cal: Calibration, opts?: GestureOptions): Run {
  const engine = createGestureEngine(cal, opts);
  const events: ActionEvent[] = [];
  const held: number[] = [];
  const inputs: number[] = [];
  for (const f of frames) {
    events.push(...engine.push(f));
    held.push(engine.held());
    inputs.push(engine.sampleInput());
  }
  return { events, held, inputs, engine, frames };
}

export const count = (events: ActionEvent[], type: string): number => events.filter((e) => e.type === type).length;
export const punchTicks = (inputs: number[]): number => inputs.filter((b) => (b & PUNCH_MASK) !== 0).length;
