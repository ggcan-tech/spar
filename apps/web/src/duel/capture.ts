import type { PoseFrame } from "@spar/protocol";
import { CameraError, startCamera, stopCamera } from "../camera/camera";
import { createPoseSource, type PoseSource } from "../camera/pose";
import { framingOf, type Framing } from "../pov/banner";
import { createLightMeter } from "../pov/lightMeter";
import { poseModelUrl, type ModelTier } from "../pov/quality";
import { createSessionLog, type RecordedSession } from "../pov/sessionLog";
import { createSyntheticPoseSource, type SyntheticSourceOptions } from "../pov/syntheticBody";
import { createPovTracker, missingBodyParts, type TrackingResult } from "../pov/tracking";
import { createWakeLock } from "../pov/wakeLock";
import { createBodyScale } from "../box/real/body3d";
import { createRecordedPoseSource } from "../box/replaySource";
import { flatPose, type FlatPose } from "./body";

/**
 * The camera, the body model and the tracker for the duel: start it, and get
 * every pose as it arrives (the sling is read on every pose, never on drawn
 * frames). Lighter than the boxing capture: no punch readers.
 *
 * The tracker's room is wide (DUEL.md 9.1): about a metre each way sideways,
 * and depth is not limited (the boxing's depth limit flagged 31% of the
 * founder's frames).
 */
export const DUEL_BOUNDS = { x: 1.0, y: 1.2, z: 5 };

export type CaptureState = "off" | "starting" | "live";
export interface CaptureStatus {
  state: CaptureState;
  message: string;
  problem: string | null;
}
export interface DuelSample {
  /** The newest pose, if it is fresh. */
  pose: FlatPose | null;
  tracking: TrackingResult;
  calibrated: boolean;
  progress: number;
  bodySeen: boolean;
  framing: Framing;
  missing: string[];
  dim: boolean;
  poseFps: number;
  reason: string | null;
}

export function createDuelCapture(
  video: HTMLVideoElement,
  options: {
    scripted?: SyntheticSourceOptions | null;
    recorded?: { session: RecordedSession; fromS?: number } | null;
    model?: ModelTier;
    onStatus(status: CaptureStatus): void;
  },
) {
  const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative", bounds: DUEL_BOUNDS });
  const size = createBodyScale();
  const log = createSessionLog(300_000);
  const light = createLightMeter();
  const wake = createWakeLock();
  const listeners = new Set<(pose: FlatPose, result: TrackingResult) => void>();
  let source: PoseSource | null = null;
  let stream: MediaStream | null = null;
  let abort: AbortController | null = null;
  let last: PoseFrame | null = null;
  let latest: FlatPose | null = null;
  let state: CaptureState = "off";
  let cameraSays = options.scripted ? "scripted person" : options.recorded ? "recording" : "unknown";
  const say = (next: CaptureState, message: string, problem: string | null = null) => {
    state = next;
    options.onStatus({ state: next, message, problem });
  };
  const take = (frame: PoseFrame) => {
    const arrived = performance.now();
    last = frame;
    log.frame(frame, arrived);
    const result = tracker.update(frame, arrived);
    const aspect = frame.imageAspect || 9 / 16;
    size.update(result, frame.world, { lm: frame.lm, aspect });
    const pose = flatPose(result, frame.motionT ?? frame.t, frame.capturedAt ?? frame.t, size.metres(), {
      lm: frame.lm,
      aspect,
      metresHigh: size.metresHigh(),
    });
    if (!pose) return;
    latest = pose;
    for (const cb of listeners) cb(pose, result);
  };
  function stop() {
    wake.release();
    abort?.abort();
    abort = null;
    source?.stop();
    source = null;
    stopCamera(stream);
    stream = null;
    if (video.srcObject) {
      stopCamera(video.srcObject as MediaStream);
      video.srcObject = null;
    }
    last = null;
    latest = null;
    tracker.reset();
    size.reset();
    state = "off";
  }
  async function start(): Promise<void> {
    stop();
    const mine = (abort = new AbortController());
    say("starting", "Opening camera…");
    try {
      if (options.scripted) source = createSyntheticPoseSource(options.scripted);
      else if (options.recorded) source = createRecordedPoseSource(options.recorded.session, { fromS: options.recorded.fromS });
      else {
        const loading = createPoseSource(video, { signal: mine.signal, maxFps: 60, modelUrl: poseModelUrl(options.model ?? "lite") });
        loading.catch(() => {});
        try {
          stream = await startCamera(video, { width: 1280, height: 720, frameRate: 60, preferFrameRate: true, signal: mine.signal });
        } catch (e) {
          void loading.then((s) => s.stop()).catch(() => {});
          throw e;
        }
        if (abort !== mine) return;
        const given = stream.getVideoTracks?.()[0]?.getSettings?.();
        cameraSays = given ? `${given.width ?? "?"}×${given.height ?? "?"} at ${given.frameRate ? Math.round(given.frameRate) : "?"} fps` : "unknown";
        log.describe({ camera: cameraSays, model: options.model ?? "lite", game: "duel" });
        say("starting", "Loading body tracking…");
        source = await loading;
      }
      if (abort !== mine) {
        source?.stop();
        return;
      }
      source.onFrame(take);
      wake.acquire();
      say("live", options.scripted ? "Scripted person — no camera in use." : options.recorded ? "A saved recording — no camera in use." : "Stand back so the camera sees you from head to hips.");
    } catch (e) {
      if (abort !== mine) return;
      stop();
      say("off", e instanceof Error ? e.message : String(e), e instanceof CameraError ? e.code : "unknown");
    }
  }
  return {
    start,
    stop,
    state: () => state,
    camera: () => cameraSays,
    /** Every pose, as it arrives. Returns a function that stops listening. */
    onPose(cb: (pose: FlatPose, result: TrackingResult) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** The last few minutes of what the camera reported, for playing back. */
    recording: () => log.save(),
    note: (now: number, facts: Record<string, string | number | boolean | null>) => log.note(now, facts),
    /** Take a new home spot where the player stands now. */
    recenter: () => tracker.recenter(),
    sample(now: number): DuelSample {
      const tracking = tracker.sample(now);
      const frame = last;
      const bodySeen = !!frame && now - frame.t < 250;
      const lm = bodySeen ? frame!.lm : [];
      const l = lm[11],
        r = lm[12];
      const framing =
        l && r && l.v >= 0.5 && r.v >= 0.5
          ? framingOf((l.x + r.x) / 2, Math.hypot((l.x - r.x) / (frame!.imageAspect || 9 / 16), l.y - r.y))
          : "no-body";
      return {
        pose: latest && frame && now - frame.t < 300 ? latest : null,
        tracking,
        calibrated: tracking.calibrated,
        progress: tracking.calibrationProgress ?? 0,
        bodySeen,
        framing,
        missing: missingBodyParts(lm),
        dim: options.scripted || options.recorded ? false : light.read(video, now).dim,
        poseFps: source?.fps() ?? 0,
        reason: tracking.reason,
      };
    },
  };
}
export type DuelCapture = ReturnType<typeof createDuelCapture>;
