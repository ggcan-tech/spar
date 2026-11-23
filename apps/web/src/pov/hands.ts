import { MEDIAPIPE_VERSION, WASM_BASE_URL } from "../camera/pose";
import { fromCrop, type HandFocus } from "./handCrop";

export type HandPoint = { x: number; y: number; z: number };
export type HandFrame = {
  /** Monotonic capture-request time, not sensor exposure time. Coordinates are unmirrored. */
  t: number;
  /** confidence is handedness-classification score, not per-joint tracking certainty. */
  hands: Array<{
    side: "Left" | "Right";
    landmarks: HandPoint[];
    world: HandPoint[];
    confidence: number;
  }>;
};
export type HandResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; id: number; frame: HandFrame; inferenceMs: number };
export type HandRequest =
  | { type: "init"; runtimeUrl: string; wasmBaseUrl: string; modelUrl: string }
  | { type: "frame"; id: number; timestamp: number; bitmap: ImageBitmap };
export const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
export const HAND_MAX_AGE_MS = 200;
/** Fingers are a visual extra: about 20 results a second leaves the device to the body model. */
const HAND_MIN_INTERVAL_MS = 45;
export type HandSource = {
  latest(): HandFrame | null;
  stats(): {
    fps: number;
    inferenceMs: number;
    ageMs: number;
    execution: "worker" | "unavailable";
    pipelineP95Ms?: number;
    error?: string;
  };
  /** Pause or resume inference. It starts active. */
  setActive?(active: boolean): void;
  /**
   * Look for one hand in a square cut from the full-size picture (see
   * handCrop.ts), or in the whole picture when null. The hand found there is
   * the one asked for, whatever the model calls it.
   */
  setFocus?(focus: HandFocus | null): void;
  stop(): void;
};

/** Optional worker-only source. Never requests camera permission or runs inference on the render thread. */
export async function createHandSource(
  video: HTMLVideoElement,
  options: { signal?: AbortSignal; modelUrl?: string } = {},
): Promise<HandSource> {
  if (options.signal?.aborted)
    throw new DOMException("Hand tracking aborted", "AbortError");
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    throw new Error(
      "Hand tracking unavailable: worker image processing is unsupported",
    );
  }
  const worker = new Worker(new URL("./hands.worker.ts", import.meta.url));
  let stopped = false;
  let frame: HandFrame | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let active = true;
  let focus: HandFocus | null = null;
  /** What the request in flight was cut from. */
  let sent: { focus: HandFocus; width: number; height: number } | null = null;
  /** The last hand found on each side while looking at one hand at a time. */
  const found: Partial<
    Record<"Left" | "Right", { hand: HandFrame["hands"][number]; t: number }>
  > = {};
  let startedAt = -Infinity;
  let id = 0;
  let previousTime = -1;
  let fps = 0;
  let inferenceMs = 0;
  let lastResultAt = 0;
  let error = "";
  const pipeline: number[] = [];
  let rejectInit: ((reason: Error) => void) | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    frame = null;
    clearTimeout(timer);
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
    worker.terminate();
    rejectInit?.(new DOMException("Hand tracking stopped", "AbortError"));
    rejectInit = null;
  };
  const abort = () => stop();
  const fail = (message: string) => {
    error = message;
    const reject = rejectInit;
    rejectInit = null;
    stop();
    reject?.(new Error(message));
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  worker.onerror = (event) => {
    event.preventDefault();
    fail("Hand tracking worker failed");
  };
  worker.onmessageerror = () => fail("Hand tracking worker message failed");
  const schedule = (delay = 16) => {
    if (!stopped) timer = setTimeout(tick, delay);
  };
  const tick = async () => {
    if (stopped) return;
    schedule();
    if (
      !active ||
      busy ||
      performance.now() - startedAt < HAND_MIN_INTERVAL_MS ||
      video.readyState < 2 ||
      !video.videoWidth ||
      !video.videoHeight ||
      video.currentTime === previousTime
    )
      return;
    previousTime = video.currentTime;
    busy = true;
    const timestamp = performance.now();
    startedAt = timestamp;
    const requestId = ++id;
    // Bound both bitmap acquisition and inference, with no work queued behind an old frame.
    deadline = setTimeout(
      () => fail("Hand tracking frame timed out"),
      requestId === 1 ? 10_000 : 1000,
    );
    let bitmap: ImageBitmap | undefined;
    try {
      const cut = focus;
      sent = cut
        ? { focus: cut, width: video.videoWidth, height: video.videoHeight }
        : null;
      bitmap = cut
        ? await createImageBitmap(video, cut.sx, cut.sy, cut.size, cut.size)
        : await createImageBitmap(video);
      if (stopped) {
        bitmap.close();
        return;
      }
      worker.postMessage(
        {
          type: "frame",
          id: requestId,
          timestamp,
          bitmap,
        } satisfies HandRequest,
        [bitmap],
      );
    } catch {
      bitmap?.close();
      fail("Hand tracking capture failed");
    }
  };
  await new Promise<void>((resolve, reject) => {
    rejectInit = reject;
    deadline = setTimeout(
      () => fail("Hand tracking initialization timed out"),
      20_000,
    );
    worker.onmessage = ({ data }: MessageEvent<HandResponse>) => {
      if (stopped) return;
      if (data.type === "error") {
        fail(data.message);
        return;
      }
      if (data.type === "ready") {
        if (!rejectInit) return;
        clearTimeout(deadline);
        rejectInit = null;
        schedule();
        resolve();
        return;
      }
      if (rejectInit || !busy || data.id !== id) return;
      clearTimeout(deadline);
      busy = false;
      const now = performance.now();
      pipeline.push(Math.max(0, now - data.frame.t));
      if (pipeline.length > 120) pipeline.shift();
      inferenceMs = data.inferenceMs;
      if (lastResultAt > 0 && now > lastResultAt)
        fps = fps
          ? fps * 0.8 + (1000 / (now - lastResultAt)) * 0.2
          : 1000 / (now - lastResultAt);
      lastResultAt = now;
      if (sent) {
        // One hand was looked for: the best one found in the square is it.
        const { focus: cut, width, height } = sent;
        const best = [...data.frame.hands].sort(
          (a, b) => b.confidence - a.confidence,
        )[0];
        if (best)
          found[cut.side] = {
            t: data.frame.t,
            hand: {
              ...best,
              side: cut.side,
              landmarks: best.landmarks.map((p) =>
                fromCrop(p, cut, width, height),
              ),
            },
          };
        else delete found[cut.side];
        // The other hand, looked at a moment ago, is still good for a while.
        const hands = (["Left", "Right"] as const).flatMap((side) => {
          const kept = found[side];
          return kept && data.frame.t - kept.t <= HAND_MAX_AGE_MS
            ? [kept.hand]
            : [];
        });
        frame =
          now - data.frame.t <= HAND_MAX_AGE_MS
            ? { t: data.frame.t, hands }
            : null;
      } else {
        delete found.Left;
        delete found.Right;
        frame = now - data.frame.t <= HAND_MAX_AGE_MS ? data.frame : null;
      }
      // Start from the freshest available video frame as soon as the worker is
      // free. No second 33 ms wait and no inference backlog.
      clearTimeout(timer);
      schedule(0);
    };
    try {
      worker.postMessage({
        type: "init",
        runtimeUrl: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
        wasmBaseUrl: WASM_BASE_URL,
        modelUrl: options.modelUrl ?? HAND_MODEL_URL,
      } satisfies HandRequest);
    } catch {
      fail("Hand tracking worker initialization failed");
    }
  });
  return {
    latest: () =>
      !stopped && frame && performance.now() - frame.t <= HAND_MAX_AGE_MS
        ? frame
        : null,
    stats: () => ({
      fps: stopped || performance.now() - lastResultAt > 1000 ? 0 : fps,
      inferenceMs,
      ageMs: frame ? performance.now() - frame.t : Infinity,
      execution: stopped ? "unavailable" : "worker",
      pipelineP95Ms: pipeline.length
        ? [...pipeline].sort((a, b) => a - b)[
            Math.ceil(pipeline.length * 0.95) - 1
          ]
        : 0,
      error,
    }),
    setActive(on) {
      active = on;
    },
    setFocus(next) {
      focus = next;
    },
    stop,
  };
}
