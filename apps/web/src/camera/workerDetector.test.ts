import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerDetector, type DetectorOptions, type WorkerResponse } from './workerDetector';

const options: DetectorOptions = {
  wasmBaseUrl: '/wasm', modelUrl: '/pose.task', delegate: 'GPU',
  minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
};
const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((message: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  emit(data: WorkerResponse) { this.onmessage?.({ data }); }
}
beforeEach(() => {
  vi.useFakeTimers(); FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function boot(signal?: AbortSignal) {
  const promise = createWorkerDetector(options, '/runtime.mjs', signal);
  const worker = FakeWorker.instances.at(-1)!;
  worker.emit({ type: 'ready', delegate: 'GPU' });
  return { detector: await promise, worker };
}

describe('worker detector ownership and backpressure', () => {
  it('transfers a single bitmap, refuses queued work, and permits the next frame after a result', async () => {
    const { detector, worker } = await boot();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValueOnce(bitmap);
    const first = detector.detect(video, 100);
    await expect(detector.detect(video, 101)).rejects.toThrow('in flight');
    await flush();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'frame', id: 1, timestamp: 100, imageAspect: 720 / 1280, bitmap }, [bitmap]);
    worker.emit({ type: 'result', id: 1, result: { frame: null, inferenceMs: 12, delegate: 'CPU' } });
    expect(await first).toMatchObject({ inferenceMs: 12 });
    expect(detector.delegate()).toBe('CPU');
    const next = detector.detect(video, 200);
    await flush();
    worker.emit({ type: 'result', id: 2, result: { frame: null, inferenceMs: 10, delegate: 'CPU' } });
    await next;
    detector.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('closes a late bitmap after cancellation instead of posting into a dead worker', async () => {
    const capture = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockReturnValueOnce(capture.promise);
    const { detector, worker } = await boot();
    const pending = detector.detect(video, 100);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush(); detector.close();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    capture.resolve(bitmap); await flush(); await rejected;
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1); // initialization only
    detector.close(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates a hung initialization and rejects without leaking its timer', async () => {
    const pending = createWorkerDetector(options, '/runtime.mjs');
    const rejected = expect(pending).rejects.toThrow('initialization timed out');
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates hung inference and ignores a later response', async () => {
    const { detector, worker } = await boot();
    const pending = detector.detect(video, 100);
    const rejected = expect(pending).rejects.toThrow('inference timed out');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.emit({ type: 'result', id: 1, result: { frame: null, inferenceMs: 1, delegate: 'CPU' } });
    await expect(detector.detect(video, 200)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the shorter steady-state deadline after the warmup frame completes', async () => {
    const { detector, worker } = await boot();
    const warmup = detector.detect(video, 100);
    await flush();
    worker.emit({ type: 'result', id: 1, result: { frame: null, inferenceMs: 1, delegate: 'GPU' } });
    await warmup;
    const pending = detector.detect(video, 200);
    const rejected = expect(pending).rejects.toThrow('inference timed out');
    await vi.advanceTimersByTimeAsync(2000); await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('aborts model initialization promptly and never starts when already aborted', async () => {
    const controller = new AbortController();
    const pending = createWorkerDetector(options, '/runtime.mjs', controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    await expect(createWorkerDetector(options, '/runtime.mjs', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('closes an untransferred bitmap when postMessage fails', async () => {
    const { detector, worker } = await boot();
    worker.postMessage.mockImplementationOnce(() => { throw new Error('Transfer failed'); });
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValueOnce(bitmap);
    await expect(detector.detect(video, 100)).rejects.toThrow('Transfer failed');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated result identifiers without releasing the in-flight slot', async () => {
    const { detector, worker } = await boot();
    const pending = detector.detect(video, 100);
    worker.emit({ type: 'result', id: 999, result: { frame: null, inferenceMs: 1, delegate: 'CPU' } });
    await expect(detector.detect(video, 200)).rejects.toThrow('in flight');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    detector.close(); await rejected;
  });

  it('rejects unavailable browser capabilities before creating a worker', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    await expect(createWorkerDetector(options, '/runtime.mjs')).rejects.toThrow('unavailable');
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
