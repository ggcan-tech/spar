import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoseFrame } from '@spar/protocol';
import type { DetectorResult, PoseDetector } from './workerDetector';
vi.mock('./workerDetector', () => ({ createWorkerDetector: vi.fn() }));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) },
  PoseLandmarker: { createFromOptions: vi.fn() },
}));
import { createWorkerDetector } from './workerDetector';
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createPoseSource } from './pose';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
let now: number;
let rvfc: () => void;
let raf: () => void;
let video: HTMLVideoElement;
let detector: PoseDetector;
const result = (t: number): DetectorResult => ({ frame: { t, lm: [], world: [] }, inferenceMs: 12, delegate: 'GPU' });
const tick = async (at: number) => { now = at; video.currentTime = at / 1000; rvfc(); await flush(); };
const mainDetector = () => ({ detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [] })), close: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks(); now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb) => { raf = cb; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  video = {
    readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0, paused: false, ended: false,
    requestVideoFrameCallback: vi.fn((cb) => { rvfc = cb; return 1; }), cancelVideoFrameCallback: vi.fn(),
  } as unknown as HTMLVideoElement;
  detector = { execution: 'worker', detect: vi.fn(async (_v, t) => result(t)), close: vi.fn(), delegate: () => 'GPU' };
  vi.mocked(createWorkerDetector).mockResolvedValue(detector);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('pose inference scheduling', () => {
  it('processes consecutive 60 Hz frames when requested and the worker can keep up', async () => {
    const source = await createPoseSource(video, { maxFps: 60 });
    await tick(100); await tick(116.7); await tick(133.4);
    expect(detector.detect).toHaveBeenCalledTimes(3);
    source.stop();
  });
  it('skips busy camera frames without building a queue', async () => {
    const pending = deferred<DetectorResult>();
    vi.mocked(detector.detect).mockReturnValueOnce(pending.promise);
    const source = await createPoseSource(video); const frames: PoseFrame[] = [];
    source.onFrame((frame) => frames.push(frame));
    await tick(100); await tick(140); await tick(180);
    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(source.stats().skippedFrames).toBe(2);
    pending.resolve(result(100)); await flush();
    // The newest frame that arrived meanwhile starts at once; the older one is gone.
    expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(2);
    await tick(220); expect(detector.detect).toHaveBeenCalledTimes(3);
    source.stop();
  });
  it('runs at the pipeline\'s own pace when it is a little slower than the camera, not at half the camera rate', async () => {
    // Camera at 30 fps; each pose takes 40 ms, 1.2 camera intervals.
    const waiting: Array<{ at: number; done: () => void }> = [];
    vi.mocked(detector.detect).mockImplementation((_v, t) => new Promise<DetectorResult>((resolve) => {
      waiting.push({ at: now + 40, done: () => resolve(result(t)) });
    }));
    const source = await createPoseSource(video, { maxFps: 60 });
    let nextFrame = 100;
    for (let at = 100; at <= 1100; at += 1) {
      now = at;
      const due = waiting.findIndex((w) => w.at <= at);
      if (due >= 0) { waiting.splice(due, 1)[0].done(); await flush(); }
      if (at >= nextFrame) { video.currentTime = at / 1000; rvfc(); await flush(); nextFrame += 1000 / 30; }
    }
    // About 1000 / 40 = 25 poses in the second; frame-skipping gave 15.
    const poses = vi.mocked(detector.detect).mock.calls.length;
    expect(poses).toBeGreaterThanOrEqual(20);
    expect(poses).toBeLessThanOrEqual(26);
    source.stop();
  });

  it('discards delayed results so they cannot revive stale tracking', async () => {
    const pending = deferred<DetectorResult>();
    vi.mocked(detector.detect).mockReturnValueOnce(pending.promise);
    const source = await createPoseSource(video); const listener = vi.fn(); source.onFrame(listener);
    await tick(100); now = 351; pending.resolve(result(100)); await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(source.stats()).toMatchObject({ frames: 1, detected: 0, staleFrames: 1, lastPoseAt: 0, pipelineP95Ms: 251 });
    source.stop();
  });

  it('does not deliver or reschedule after stop, including pending responses', async () => {
    const pending = deferred<DetectorResult>();
    vi.mocked(detector.detect).mockReturnValueOnce(pending.promise);
    const source = await createPoseSource(video); const listener = vi.fn(); source.onFrame(listener);
    await tick(100); source.stop(); source.stop(); pending.resolve(result(100)); await flush();
    const requested = vi.mocked(video.requestVideoFrameCallback).mock.calls.length;
    rvfc(); raf(); await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(detector.close).toHaveBeenCalledTimes(1);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(requested);
    expect(source.fps()).toBe(0);
  });

  it('uses rAF on stalled rVFC and never redetects an unchanged video frame', async () => {
    const source = await createPoseSource(video);
    await tick(100); now = 250; video.currentTime = 0.25; raf(); await flush();
    expect(detector.detect).toHaveBeenCalledTimes(2);
    now = 300; raf(); await flush();
    expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(source.stats().driver).toBe('raf'); source.stop();
  });

  it('falls back after worker startup failure and exposes actual execution mode', async () => {
    vi.mocked(createWorkerDetector).mockRejectedValueOnce(new Error('Unsupported worker'));
    const main = mainDetector(); vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce(main as never);
    const source = await createPoseSource(video); await tick(100);
    expect(source.stats().execution).toBe('main-thread');
    expect(main.detectForVideo).toHaveBeenCalledTimes(1);
    source.stop(); expect(main.close).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh worker after one failure instead of leaving worker inference for good', async () => {
    vi.mocked(detector.detect).mockRejectedValueOnce(new Error('Worker crash'));
    const source = await createPoseSource(video);
    expect(createWorkerDetector).toHaveBeenCalledTimes(1);
    await tick(100);
    expect(detector.close).toHaveBeenCalledTimes(1);
    expect(createWorkerDetector).toHaveBeenCalledTimes(2);
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled();
    await tick(140);
    expect(source.stats()).toMatchObject({ execution: 'worker', errors: 1 });
    expect(detector.detect).toHaveBeenCalledTimes(2); source.stop();
  });

  it('terminates a failed worker before switching to main-thread inference when a fresh worker fails too', async () => {
    vi.mocked(detector.detect).mockRejectedValueOnce(new Error('Worker crash')).mockRejectedValueOnce(new Error('Worker crash again'));
    const main = mainDetector();
    vi.mocked(PoseLandmarker.createFromOptions).mockImplementationOnce(async () => {
      expect(detector.close).toHaveBeenCalledTimes(2); return main as never;
    });
    const source = await createPoseSource(video); await tick(100); await tick(140); await tick(180);
    expect(source.stats()).toMatchObject({ execution: 'main-thread', errors: 2 });
    expect(main.detectForVideo).toHaveBeenCalledTimes(1); source.stop();
  });

  it('releases a fallback detector that finishes creating after stop', async () => {
    vi.mocked(detector.detect).mockRejectedValueOnce(new Error('Worker crash'));
    // No fresh worker to be had: straight to the main-thread fallback.
    vi.mocked(createWorkerDetector).mockResolvedValueOnce(detector).mockRejectedValueOnce(new Error('no worker'));
    const pending = deferred<Awaited<ReturnType<typeof PoseLandmarker.createFromOptions>>>();
    vi.mocked(PoseLandmarker.createFromOptions).mockReturnValueOnce(pending.promise);
    const source = await createPoseSource(video); await tick(100); source.stop();
    const main = mainDetector(); pending.resolve(main as never); await flush();
    expect(main.close).toHaveBeenCalledTimes(1);
    expect(main.detectForVideo).not.toHaveBeenCalled();
  });

  it('closes CPU initialization completed after stop without closing the retired GPU twice', async () => {
    const gpu = mainDetector(); gpu.detectForVideo.mockImplementationOnce(() => { throw new Error('GPU lost'); });
    const pending = deferred<Awaited<ReturnType<typeof PoseLandmarker.createFromOptions>>>();
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce(gpu as never).mockReturnValueOnce(pending.promise);
    const source = await createPoseSource(video, { execution: 'main-thread' }); await tick(100); source.stop();
    const cpu = mainDetector(); pending.resolve(cpu as never); await flush();
    expect(gpu.close).toHaveBeenCalledTimes(1);
    expect(cpu.close).toHaveBeenCalledTimes(1);
    expect(cpu.detectForVideo).not.toHaveBeenCalled();
  });

  it('honors abort without starting a fallback', async () => {
    const controller = new AbortController(); controller.abort();
    vi.mocked(createWorkerDetector).mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(createPoseSource(video, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled();
  });

  it('stamps frames with the camera capture time only when the browser reports a real one', async () => {
    const source = await createPoseSource(video, { maxFps: 60 }); const frames: PoseFrame[] = [];
    source.onFrame((frame) => frames.push(frame));
    const frameAt = async (at: number, metadata?: object) => {
      now = at; video.currentTime = at / 1000;
      (rvfc as unknown as (t: number, m?: object) => void)(at, metadata); await flush();
    };
    await frameAt(100);
    expect(frames[0].capturedAt).toBeUndefined();
    expect(source.stats().cameraDelayMs).toBeNull();
    // Compositing time is not capture time: it already contains the camera's delay.
    await frameAt(140, { presentationTime: 135 });
    expect(frames[1].capturedAt).toBeUndefined();
    await frameAt(180, { captureTime: 110, presentationTime: 175 });
    expect(frames[2].capturedAt).toBe(110);
    expect(frames[2].t).toBe(180);
    expect(source.stats().cameraDelayMs).toBe(70);
    // A capture time from the future or absurdly old is ignored, not trusted.
    await frameAt(220, { captureTime: 400 });
    await frameAt(260, { captureTime: -5000 });
    expect(frames[3].capturedAt).toBeUndefined();
    expect(frames[4].capturedAt).toBeUndefined();
    expect(source.stats().cameraDelayMs).toBe(70);
    source.stop();
  });

  it('gives the GPU one more try after a failure, and stays on it when that works', async () => {
    const gpu = mainDetector(); gpu.detectForVideo.mockImplementationOnce(() => { throw new Error('GPU lost'); });
    const again = mainDetector();
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce(gpu as never).mockResolvedValueOnce(again as never);
    const source = await createPoseSource(video, { execution: 'main-thread' }); await tick(100);
    expect(source.delegate()).toBe('GPU'); expect(gpu.close).toHaveBeenCalledTimes(1);
    expect(again.detectForVideo).toHaveBeenCalledTimes(1); source.stop(); expect(again.close).toHaveBeenCalledTimes(1);
  });

  it('switches main-thread inference to CPU when the GPU fails twice, and closes every detector', async () => {
    const gpu = mainDetector(); gpu.detectForVideo.mockImplementationOnce(() => { throw new Error('GPU lost'); });
    const again = mainDetector(); again.detectForVideo.mockImplementationOnce(() => { throw new Error('GPU lost again'); });
    const cpu = mainDetector();
    vi.mocked(PoseLandmarker.createFromOptions)
      .mockResolvedValueOnce(gpu as never).mockResolvedValueOnce(again as never).mockResolvedValueOnce(cpu as never);
    const source = await createPoseSource(video, { execution: 'main-thread' }); await tick(100);
    expect(source.delegate()).toBe('CPU'); expect(gpu.close).toHaveBeenCalledTimes(1); expect(again.close).toHaveBeenCalledTimes(1);
    expect(cpu.detectForVideo).toHaveBeenCalledTimes(1); source.stop(); expect(cpu.close).toHaveBeenCalledTimes(1);
  });

  it('gives each frame an evenly spaced time for motion, close to its own stamp', async () => {
    const source = await createPoseSource(video, { maxFps: 60 }); const frames: PoseFrame[] = [];
    source.onFrame((frame) => frames.push(frame));
    // The camera captures every 33 ms; the page notices each frame unevenly.
    const noticed = [100, 141, 166, 207, 232, 271, 299, 338];
    for (let i = 0; i < noticed.length; i++) {
      now = noticed[i]; video.currentTime = noticed[i] / 1000;
      (rvfc as unknown as (t: number, m?: object) => void)(noticed[i], { mediaTime: 5 + i * 0.033 }); await flush();
    }
    expect(frames).toHaveLength(noticed.length);
    const gaps = frames.slice(1).map((frame, i) => frame.motionT! - frames[i].motionT!);
    // The page's own gaps run from 25 to 41 ms; the even clock's stay near 33.
    for (const gap of gaps.slice(2)) expect(Math.abs(gap - 33)).toBeLessThan(3);
    for (const frame of frames) expect(Math.abs(frame.motionT! - frame.t)).toBeLessThan(15);
    source.stop();
  });
});
