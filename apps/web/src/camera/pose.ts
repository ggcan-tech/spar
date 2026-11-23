import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '@spar/protocol';
import { createWorkerDetector, type DetectorOptions, type PoseDetector } from './workerDetector';
import { createCaptureClock } from './captureClock';

/** Must match the installed JS bundle; the WASM loader and JS API are versioned together. */
export const MEDIAPIPE_VERSION = '0.10.35';
export const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const WORKER_RUNTIME_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;

export type PoseDelegate = 'GPU' | 'CPU';
export interface PoseSourceStats {
  /** Successful detector responses, including empty and subsequently stale results. */
  frames: number;
  /** Fresh frames where a pose was found. */
  detected: number;
  errors: number;
  lastPoseAt: number;
  driver: 'rvfc' | 'raf' | null;
  /** Optional for compatibility with existing consumers and alternate sources. */
  execution?: 'worker' | 'main-thread';
  skippedFrames?: number;
  staleFrames?: number;
  /** Rolling last 120 completed frames, including stale/warmup results; transfer + inference + delivery. */
  pipelineP95Ms?: number;
  /**
   * Camera delay the browser reports: capture to the moment the frame reached
   * this page, smoothed, in ms. Null when the browser does not report capture time.
   */
  cameraDelayMs?: number | null;
}
export interface PoseSource {
  onFrame(cb: (f: PoseFrame) => void): () => void;
  /** Completed detector throughput (EMA), zero when stopped or idle for >1s. */
  fps(): number;
  /** Detector duration, excluding bitmap transfer and result delivery. */
  inferenceMs(): number;
  stop(): void;
  delegate(): PoseDelegate;
  stats(): PoseSourceStats;
}
export interface PoseSourceOptions {
  /** Upper bound only; skips busy frames rather than queuing them. */
  maxFps?: number;
  wasmBaseUrl?: string;
  modelUrl?: string;
  delegate?: PoseDelegate;
  minPoseDetectionConfidence?: number;
  minPosePresenceConfidence?: number;
  minTrackingConfidence?: number;
  /** Prefer worker inference; unsupported browsers fall back to the main thread. */
  execution?: 'auto' | 'main-thread';
  signal?: AbortSignal;
}
const EMA_ALPHA = 0.1;
const RVFC_STALL_MS = 120;
const MIN_INTERVAL_MS = 24;
const MAX_RESULT_AGE_MS = 250;
const cancelled = () => new DOMException('Pose detector stopped.', 'AbortError');
const mapLandmark = (point: NormalizedLandmark): Landmark => ({
  x: point.x, y: point.y, z: point.z,
  v: Number.isFinite(point.visibility) ? point.visibility : 0,
});

/** Fresh workers tried after a failure before giving up on worker inference. */
const MAX_WORKER_RESTARTS = 1;
async function createMainDetector(options: DetectorOptions, signal?: AbortSignal): Promise<PoseDetector> {
  if (signal?.aborted) throw cancelled();
  const fileset = await FilesetResolver.forVisionTasks(options.wasmBaseUrl);
  if (signal?.aborted) throw cancelled();
  let delegate = options.delegate;
  let closed = false;
  let gpuRetries = 0;
  const create = async () => {
    const next = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: options.modelUrl, delegate },
      runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: false,
      minPoseDetectionConfidence: options.minPoseDetectionConfidence,
      minPosePresenceConfidence: options.minPosePresenceConfidence,
      minTrackingConfidence: options.minTrackingConfidence,
    });
    if (closed || signal?.aborted) { next.close(); throw cancelled(); }
    return next;
  };
  let detector: PoseLandmarker | null = null;
  const closeDetector = () => {
    const current = detector; detector = null;
    current?.close();
  };
  try { detector = await create(); }
  catch (error) {
    if (delegate === 'CPU' || signal?.aborted) throw error;
    delegate = 'CPU'; detector = await create();
  }
  return {
    execution: 'main-thread', delegate: () => delegate,
    async detect(video, timestamp) {
      if (closed || signal?.aborted) throw cancelled();
      const before = performance.now();
      let result;
      try { result = detector!.detectForVideo(video, timestamp); }
      catch (error) {
        if (delegate === 'CPU') throw error;
        closeDetector();
        // One fresh GPU detector before the session is moved to the CPU.
        if (gpuRetries < 1) {
          gpuRetries++;
          try { detector = await create(); result = detector.detectForVideo(video, timestamp); }
          catch { closeDetector(); result = undefined; }
        }
        if (!detector || !result) {
          delegate = 'CPU'; detector = await create();
          result = detector.detectForVideo(video, timestamp);
        }
      }
      const inferenceMs = performance.now() - before;
      const lm = result.landmarks[0];
      const world = result.worldLandmarks[0];
      return {
        inferenceMs, delegate,
        frame: lm?.length ? {
          t: timestamp, lm: lm.map(mapLandmark),
          world: world?.length === lm.length ? world.map(mapLandmark) : [],
          imageAspect: video.videoHeight / video.videoWidth,
        } : null,
      };
    },
    close() { if (closed) return; closed = true; closeDetector(); },
  };
}

/**
 * Video frames → one worker inference in flight → fresh PoseFrame stream. Busy frames are skipped,
 * never queued. rAF covers browsers that stall rVFC. A failed worker is terminated before using
 * the compatible main-thread detector; GPU failure also has a CPU fallback in either execution mode.
 */
export async function createPoseSource(video: HTMLVideoElement, opts: PoseSourceOptions = {}): Promise<PoseSource> {
  if (opts.maxFps !== undefined && (!Number.isFinite(opts.maxFps) || opts.maxFps < 1 || opts.maxFps > 60))
    throw new RangeError('maxFps must be between 1 and 60');
  // Small callback jitter must not turn a requested 60 Hz stream into 30 Hz.
  const minIntervalMs = opts.maxFps ? 1000 / opts.maxFps - 1 : MIN_INTERVAL_MS;
  const options: DetectorOptions = {
    wasmBaseUrl: opts.wasmBaseUrl ?? WASM_BASE_URL, modelUrl: opts.modelUrl ?? POSE_MODEL_URL,
    delegate: opts.delegate ?? 'GPU',
    minPoseDetectionConfidence: opts.minPoseDetectionConfidence ?? 0.5,
    minPosePresenceConfidence: opts.minPosePresenceConfidence ?? 0.5,
    minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
  };
  let detector: PoseDetector;
  if (opts.execution === 'main-thread') detector = await createMainDetector(options, opts.signal);
  else {
    try { detector = await createWorkerDetector(options, WORKER_RUNTIME_URL, opts.signal); }
    catch (error) {
      if (opts.signal?.aborted) throw cancelled();
      console.warn('[spar/pose] Worker unavailable; using main-thread inference.', error);
      detector = await createMainDetector(options, opts.signal);
    }
  }
  if (opts.signal?.aborted) { detector.close(); throw cancelled(); }
  const listeners = new Set<(frame: PoseFrame) => void>();
  const stats: PoseSourceStats = {
    frames: 0, detected: 0, errors: 0, lastPoseAt: 0, driver: null,
    execution: detector.execution, skippedFrames: 0, staleFrames: 0,
  };
  const pipelineSamples: number[] = [];
  let stopped = false;
  let busy = false;
  let fpsEma = 0;
  let inferEma = 0;
  let lastTs = -1;
  let lastProcessedAt = -Infinity;
  let lastCompletedAt = -Infinity;
  let lastRvfcAt = -Infinity;
  let lastVideoTime = -1;
  let rafId = 0;
  let rvfcId = 0;
  const hasRvfc = typeof video.requestVideoFrameCallback === 'function';

  let cameraDelay: number | null = null;
  let workerRestarts = 0;
  type FrameMeta = { captureTime?: number; presentationTime?: number; mediaTime?: number };
  let waiting: { driver: 'rvfc' | 'raf'; metadata?: FrameMeta } | null = null;
  const motionClock = createCaptureClock();
  const process = async (driver: 'rvfc' | 'raf', metadata?: FrameMeta) => {
    if (stopped || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.paused || video.ended) return;
    // The model is still on an earlier frame. Remember the newest one (only
    // the newest: this is not a queue) so it can start the moment the model
    // is free, instead of waiting for the camera's next callback. A pipeline
    // a little slower than the camera otherwise runs at half the camera's rate.
    if (busy) { stats.skippedFrames!++; waiting = { driver, metadata }; return; }
    const at = performance.now();
    if (at - lastProcessedAt < minIntervalMs || video.currentTime === lastVideoTime) return;
    busy = true;
    lastProcessedAt = at; lastVideoTime = video.currentTime;
    const timestamp = Math.max(at, lastTs + 0.05); lastTs = timestamp;
    // Only a genuine camera capture time counts; presentationTime is when the
    // browser composited the frame, which already includes the camera's delay.
    const reported = metadata?.captureTime;
    const capturedAt = typeof reported === 'number' && Number.isFinite(reported) && reported > 0 && reported <= timestamp && timestamp - reported < 1000
      ? reported : undefined;
    if (capturedAt !== undefined) {
      const delay = timestamp - capturedAt;
      cameraDelay = cameraDelay === null ? delay : cameraDelay + EMA_ALPHA * (delay - cameraDelay);
    }
    // An evenly spaced time for this frame: the camera's own clock when the
    // browser gives one, else the frame's place in the stream.
    const media = metadata?.mediaTime;
    const motionT = motionClock.stamp(
      timestamp,
      capturedAt ?? (typeof media === 'number' && Number.isFinite(media) && media > 0 ? media * 1000 : undefined),
    );
    try {
      const result = await detector.detect(video, timestamp);
      if (stopped) return;
      const completedAt = performance.now();
      pipelineSamples.push(Math.max(0, completedAt - at));
      if (pipelineSamples.length > 120) pipelineSamples.shift();
      inferEma = inferEma === 0 ? result.inferenceMs : inferEma + EMA_ALPHA * (result.inferenceMs - inferEma);
      if (Number.isFinite(lastCompletedAt) && completedAt > lastCompletedAt) {
        const instant = 1000 / (completedAt - lastCompletedAt);
        fpsEma = fpsEma === 0 ? instant : fpsEma + EMA_ALPHA * (instant - fpsEma);
      }
      lastCompletedAt = completedAt;
      stats.frames++; stats.driver = driver;
      if (completedAt - at > MAX_RESULT_AGE_MS) { stats.staleFrames!++; return; }
      if (!result.frame) return;
      if (capturedAt !== undefined) result.frame.capturedAt = capturedAt;
      result.frame.motionT = motionT;
      stats.detected++; stats.lastPoseAt = timestamp;
      for (const cb of listeners) {
        try { cb(result.frame); } catch (error) { console.error('[spar/pose] Listener threw.', error); }
      }
    } catch (error) {
      if (stopped || opts.signal?.aborted) return;
      stats.errors++;
      if (detector.execution === 'worker') {
        detector.close();
        // One failure (a lost GL context, an app switch) used to move inference
        // onto the page's own thread for the rest of the session, which makes
        // everything sluggish. Start a fresh worker first; only a second
        // failure falls back.
        if (workerRestarts < MAX_WORKER_RESTARTS) {
          workerRestarts++;
          try {
            const fresh = await createWorkerDetector(options, WORKER_RUNTIME_URL, opts.signal);
            if (stopped) { fresh.close(); return; }
            detector = fresh; stats.execution = fresh.execution;
            console.warn('[spar/pose] Worker failed; restarted it.', error);
            return;
          } catch (restartError) {
            if (stopped || opts.signal?.aborted) return;
            console.warn('[spar/pose] Worker restart failed.', restartError);
          }
        }
        try {
          const next = await createMainDetector(options, opts.signal);
          if (stopped) { next.close(); return; }
          detector = next; stats.execution = next.execution;
          console.warn('[spar/pose] Worker failed; using main-thread inference.', error);
        } catch (fallbackError) {
          console.error('[spar/pose] Inference fallback failed.', fallbackError);
          stop();
        }
      }
    } finally {
      busy = false;
      if (waiting && !stopped) {
        const next = waiting; waiting = null;
        void process(next.driver, next.metadata);
      }
    }
  };
  const rvfcLoop = () => {
    if (stopped) return;
    rvfcId = video.requestVideoFrameCallback((_now, metadata) => {
      lastRvfcAt = performance.now(); void process('rvfc', metadata); rvfcLoop();
    });
  };
  const rafLoop = () => {
    if (stopped) return;
    rafId = requestAnimationFrame(() => {
      if (!hasRvfc || performance.now() - lastRvfcAt > RVFC_STALL_MS) void process('raf');
      rafLoop();
    });
  };
  function stop() {
    if (stopped) return;
    stopped = true; listeners.clear();
    opts.signal?.removeEventListener('abort', stop);
    if (rafId) cancelAnimationFrame(rafId);
    if (rvfcId && hasRvfc) {
      try { video.cancelVideoFrameCallback(rvfcId); } catch { /* Browser teardown. */ }
    }
    detector.close();
  }
  opts.signal?.addEventListener('abort', stop, { once: true });
  if (hasRvfc) rvfcLoop();
  rafLoop();
  return {
    onFrame(cb) {
      if (!stopped) listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    fps: () => stopped || performance.now() - lastCompletedAt > 1000 ? 0 : fpsEma,
    inferenceMs: () => inferEma,
    delegate: () => detector.delegate(),
    stats: () => {
      const sorted = [...pipelineSamples].sort((a, b) => a - b);
      return { ...stats, pipelineP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : 0, cameraDelayMs: cameraDelay };
    },
    stop,
  };
}
