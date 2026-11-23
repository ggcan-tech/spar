import type { GestureEngineLike, PoseFrame } from '@spar/protocol';
import { createRecorder, createRecordingEngine, makeRecording, parseRecording, replayRecording } from './recorder';
import { defaultCalibration, synth } from '@spar/gestures';

const lm = () => Array.from({ length: 33 }, (_, i) => ({ x: i / 33, y: 0.5, z: 0, v: 1 }));
const frame = (t: number): PoseFrame => ({ t, lm: lm(), world: lm() });

describe('recorder', () => {
  it('buffers frames only while recording and reports duration', () => {
    const r = createRecorder();
    r.push(frame(0));
    expect(r.count()).toBe(0);
    r.start();
    r.push(frame(100));
    r.push(frame(150));
    r.stop();
    r.push(frame(200));
    expect(r.count()).toBe(2);
    expect(r.durationMs()).toBe(50);
    r.clear();
    expect(r.count()).toBe(0);
  });

  it('round-trips through JSON and validates shape', () => {
    const rec = makeRecording([frame(10), frame(20)], 'orthodox', null);
    const parsed = parseRecording(JSON.stringify(rec));
    expect(parsed.version).toBe(1);
    expect(parsed.stance).toBe('orthodox');
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[1].t).toBe(20);
    expect(() => parseRecording('nope')).toThrow(/JSON/);
    expect(() => parseRecording('{"version":2,"frames":[]}')).toThrow(/version/);
    expect(() => parseRecording('{"version":1,"frames":[]}')).toThrow(/no frames/);
    expect(() => parseRecording('{"version":1,"frames":[{"t":1,"lm":[{"x":0}]}]}')).toThrow(/malformed/);
    // missing world data must not be replaced with normalized coordinates
    const noWorld = parseRecording(JSON.stringify({ version: 1, stance: 'weird', frames: [{ t: 1, lm: lm() }] }));
    expect(noWorld.stance).toBe('auto');
    expect(noWorld.frames[0].world).toHaveLength(0);
  });

  it('replays every frame through an engine and tags events with frame index + rel time', () => {
    const pushed: number[] = [];
    const engine: GestureEngineLike = {
      push: (f) => {
        pushed.push(f.t);
        return f.t === 1200 ? [{ t: f.t, type: 'JAB', confidence: 0.9 }] : [];
      },
      held: () => 0,
      drainImpulses: () => 0,
      sampleInput: () => 0,
      stance: () => 'orthodox',
    };
    const rec = makeRecording([frame(1000), frame(1100), frame(1200)], 'auto', null);
    const out = replayRecording(rec, engine);
    expect(pushed).toEqual([1000, 1100, 1200]);
    expect(out.frames).toBe(3);
    expect(out.durationMs).toBe(200);
    expect(out.events).toEqual([{ t: 1200, type: 'JAB', confidence: 0.9, frame: 2, rel: 200 }]);
  });

  it('preserves camera geometry and rejects corrupt joints beyond the first landmark', () => {
    const rec = makeRecording([{ ...frame(10), imageAspect: 0.5625 }], 'orthodox', null, { aspect: 0.5625, width: 1280, height: 720 });
    const parsed = parseRecording(JSON.stringify(rec));
    expect(parsed.meta?.aspect).toBe(0.5625);
    expect(parsed.frames[0].imageAspect).toBe(0.5625);
    rec.frames[0].lm[15].x = NaN;
    expect(() => parseRecording(JSON.stringify(rec))).toThrow(/malformed/);
  });

  it('rejects invalid aspects and body measurements before replay', () => {
    const rec = makeRecording([frame(10)], 'orthodox', null, { aspect: -1 });
    expect(() => parseRecording(JSON.stringify(rec))).toThrow(/aspect/);
    rec.meta = { aspect: 1 };
    expect(() => parseRecording(JSON.stringify({ ...rec, calibration: {} }))).toThrow(/measurements/);
  });

  it('replays automatic setup from earlier observations without fitting later punches', () => {
    const frames = synth.sequence([synth.guard(1200), synth.jab('L'), synth.guard(400)]);
    const rec = makeRecording(frames, 'orthodox', null, { aspect: 1 });
    const result = replayRecording(rec, createRecordingEngine(rec));
    expect(result.events.filter(e => e.type === 'JAB')).toHaveLength(1);
    const tooShort = makeRecording(synth.sequence([synth.guard(200), synth.jab('L')]), 'orthodox', null, { aspect: 1 });
    expect(replayRecording(tooShort, createRecordingEngine(tooShort)).events).toEqual([]);
  });

  it('refuses missing camera geometry and mixed orientation with fixed measurements', () => {
    expect(() => createRecordingEngine(makeRecording([frame(1)], 'orthodox', null))).toThrow(/missing/);
    const rec = makeRecording([{ ...frame(1), imageAspect: 1 }, { ...frame(2), imageAspect: 0.5625 }], 'orthodox', defaultCalibration(), { aspect: 1 });
    expect(() => createRecordingEngine(rec)).toThrow(/orientation/);
  });
});
