import { describe, expect, it, vi } from 'vitest';
import { BIT, LM, type ActionEvent, type PoseFrame } from '@spar/protocol';
import type { PoseSource } from '../camera/pose';
import { createCameraInput } from './cameraInput';

function frame(t: number): PoseFrame {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, v: 1 }));
  return { t, lm, world: lm.map((p) => ({ ...p })) };
}

function setup(resettable = true) {
  let time = 0;
  let receive!: (f: PoseFrame) => void;
  let held = 0;
  let pending = 0;
  const off = vi.fn();
  const reset = vi.fn(() => { held = 0; pending = 0; });
  const engine = {
    push: vi.fn((f: PoseFrame): ActionEvent[] => {
      held = BIT.GUARD_HIGH;
      pending |= BIT.JAB;
      return [{ t: f.t, type: 'JAB', confidence: 1 }];
    }),
    held: () => held,
    drainImpulses: () => { const result = pending; pending = 0; return result; },
    sampleInput: () => held | engine.drainImpulses(),
    stance: () => 'orthodox' as const,
    ...(resettable ? { reset } : {}),
  };
  const source: PoseSource = {
    onFrame: (cb) => { receive = cb; return off; },
    fps: () => 30, inferenceMs: () => 1, stop: vi.fn(), delegate: () => 'CPU',
    stats: () => ({ frames: 0, detected: 0, errors: 0, lastPoseAt: 0, driver: null }),
  };
  const input = createCameraInput(engine, source, { now: () => time });
  return { input, engine, reset, off, emit: (f: PoseFrame) => receive(f), at: (t: number) => { time = t; } };
}

describe('camera input freshness', () => {
  it('starts neutral and passes fresh held controls and subsequent impulses/events', () => {
    const s = setup();
    expect(s.input.sample()).toBe(0);
    expect(s.input.latestPose()).toBeNull();
    s.emit(frame(100000));
    expect(s.input.sample()).toBe(BIT.GUARD_HIGH);
    expect(s.input.events()).toEqual([]);
    s.at(20); s.emit(frame(100020));
    expect(s.input.sample()).toBe(BIT.GUARD_HIGH | BIT.JAB);
    expect(s.input.sample()).toBe(BIT.GUARD_HIGH);
    expect(s.input.events()).toHaveLength(1);
    expect(s.input.events()).toEqual([]);
  });

  it('releases held controls and discards queued actions on silence, resetting only once', () => {
    const s = setup();
    s.emit(frame(1)); s.at(20); s.emit(frame(21));
    s.at(269); expect(s.input.latestPose()).not.toBeNull();
    s.at(270);
    expect(s.input.sample()).toBe(0);
    expect(s.input.events()).toEqual([]);
    expect(s.input.latestPose()).toBeNull();
    expect(s.input.sample()).toBe(0);
    expect(s.reset).toHaveBeenCalledTimes(1);
  });

  it('resets a gap before the next push even without intervening reads, suppressing reacquisition impulses', () => {
    const s = setup();
    s.emit(frame(1)); s.at(20); s.emit(frame(21));
    s.at(1000); s.emit(frame(1001));
    expect(s.reset).toHaveBeenCalledTimes(1);
    expect(s.input.events()).toEqual([]);
    expect(s.input.sample()).toBe(BIT.GUARD_HIGH);
    s.at(1020); s.emit(frame(1021));
    expect(s.input.sample()).toBe(BIT.GUARD_HIGH | BIT.JAB);
  });

  it.each(['invisible', 'nan', 'short', 'timestamp'] as const)('rejects %s poses and clears previous controls', (kind) => {
    const s = setup(); s.emit(frame(1));
    const bad = frame(2);
    if (kind === 'invisible') bad.lm[LM.R_SHOULDER].v = 0.1;
    if (kind === 'nan') bad.lm[LM.L_SHOULDER].x = NaN;
    if (kind === 'short') bad.lm = [];
    if (kind === 'timestamp') bad.t = NaN;
    s.emit(bad);
    expect(s.engine.push).toHaveBeenCalledTimes(1);
    expect(s.input.sample()).toBe(0);
    expect(s.input.latestPose()).toBeNull();
    expect(s.reset).toHaveBeenCalledTimes(1);
  });

  it('invalidates duplicate frame timestamps instead of keeping controls alive', () => {
    const s = setup(); s.emit(frame(10)); s.at(100); s.emit(frame(10)); s.at(200); s.emit(frame(10));
    expect(s.input.latestPose()).toBeNull();
    expect(s.input.sample()).toBe(0);
  });

  it('gates engines without reset and drains stale impulses', () => {
    const s = setup(false); s.emit(frame(1)); s.emit(frame(2)); s.at(300);
    expect(s.input.sample()).toBe(0);
    expect(s.engine.drainImpulses()).toBe(0);
    expect(s.input.events()).toEqual([]);
  });

  it('unsubscribes once and ignores late callbacks after disposal', () => {
    const s = setup(); s.emit(frame(1)); s.input.dispose(); s.input.dispose(); s.emit(frame(2));
    expect(s.off).toHaveBeenCalledTimes(1);
    expect(s.engine.push).toHaveBeenCalledTimes(1);
    expect(s.input.sample()).toBe(0);
    expect(s.input.events()).toEqual([]);
    expect(s.input.latestPose()).toBeNull();
  });
});
