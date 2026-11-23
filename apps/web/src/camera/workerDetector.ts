import type { PoseFrame } from '@spar/protocol';

export interface DetectorOptions {
  wasmBaseUrl: string;
  modelUrl: string;
  delegate: 'GPU' | 'CPU';
  minPoseDetectionConfidence: number;
  minPosePresenceConfidence: number;
  minTrackingConfidence: number;
}
export interface DetectorResult {
  frame: PoseFrame | null;
  inferenceMs: number;
  delegate: 'GPU' | 'CPU';
}
export interface PoseDetector {
  execution: 'worker' | 'main-thread';
  delegate(): 'GPU' | 'CPU';
  detect(video: HTMLVideoElement, timestamp: number): Promise<DetectorResult>;
  close(): void;
}
export type WorkerRequest =
  | { type: 'init'; options: DetectorOptions; runtimeUrl: string }
  | { type: 'frame'; id: number; bitmap: ImageBitmap; timestamp: number; imageAspect: number };
export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'result'; id: number; result: DetectorResult }
  | { type: 'error'; id?: number; message: string };

function abortError(): Error { return new DOMException('Pose detector stopped.', 'AbortError'); }

/** Single in-flight bitmap, no frame queue. A hung worker is terminated, never kept alive beside a fallback. */
export function createWorkerDetector(
  options: DetectorOptions,
  runtimeUrl: string,
  signal?: AbortSignal,
): Promise<PoseDetector> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return Promise.reject(new Error('Worker pose inference is unavailable in this browser.'));
  }
  return new Promise((resolve, reject) => {
    // Classic worker required: MediaPipe's WASM bootstrap uses importScripts().
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { name: 'spar-pose' });
    let stopped = false;
    let ready = false;
    let delegate = options.delegate;
    let nextId = 0;
    let pending: { id: number; resolve: (result: DetectorResult) => void; reject: (error: Error) => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { clearTimeout(timer); timer = undefined; };
    const fail = (error: Error) => {
      if (stopped) return;
      stopped = true;
      clearTimer();
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      pending?.reject(error); pending = null;
      if (!ready) reject(error);
    };
    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => { event.preventDefault(); fail(new Error(event.message || 'Pose worker failed.')); };
    worker.onmessageerror = () => fail(new Error('Pose worker returned an unreadable message.'));
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (stopped) return;
      if (data.type === 'error') { fail(new Error(data.message)); return; }
      if (data.type === 'ready' && !ready) {
        clearTimer(); ready = true; delegate = data.delegate;
        resolve({
          execution: 'worker',
          delegate: () => delegate,
          close: () => fail(abortError()),
          detect(video, timestamp) {
            if (stopped) return Promise.reject(abortError());
            if (pending) return Promise.reject(new Error('Pose worker already has a frame in flight.'));
            const id = ++nextId;
            return new Promise<DetectorResult>((yes, no) => {
              pending = { id, resolve: yes, reject: no };
              // Includes bitmap capture; late bitmaps are explicitly closed after stop/timeout.
              // First inference can compile shaders/WASM on low-power devices. It is still
              // discarded by the source if stale, but gets a longer one-time warmup deadline.
              timer = setTimeout(() => fail(new Error('Pose worker inference timed out.')), id === 1 ? 10_000 : 2000);
              const imageAspect = video.videoHeight / video.videoWidth;
              Promise.resolve().then(() => createImageBitmap(video)).then((bitmap) => {
                if (stopped || pending?.id !== id) { bitmap.close(); return; }
                try {
                  const request: WorkerRequest = { type: 'frame', id, bitmap, timestamp, imageAspect };
                  worker.postMessage(request, [bitmap]);
                } catch (error) {
                  bitmap.close();
                  fail(error instanceof Error ? error : new Error(String(error)));
                }
              }).catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
            });
          },
        });
      } else if (data.type === 'result' && pending?.id === data.id) {
        clearTimer();
        delegate = data.result.delegate;
        const request = pending; pending = null;
        request.resolve(data.result);
      }
    };
    timer = setTimeout(() => fail(new Error('Pose worker initialization timed out.')), 20_000);
    try {
      const request: WorkerRequest = { type: 'init', options, runtimeUrl };
      worker.postMessage(request);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}
