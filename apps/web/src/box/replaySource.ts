import type { PoseFrame } from "@spar/protocol";
import type { PoseSource } from "../camera/pose";
import { playbackFrame, type RecordedSession } from "../pov/sessionLog";

/**
 * A saved recording played back as if it were the camera: the same poses, at
 * the same pace, with their times moved to now. What a real person did in
 * front of a real camera can then be put through the game again and again,
 * and looked at, without them.
 */
export function createRecordedPoseSource(session: RecordedSession, o: { fromS?: number } = {}): PoseSource {
  const all = session.frames;
  const listeners = new Set<(frame: PoseFrame) => void>();
  const first = all.length ? all[0].at : 0;
  let next = Math.max(0, all.findIndex((f) => (f.at - first) / 1000 >= (o.fromS ?? 0)));
  const started = performance.now();
  // Every time in the recording is moved by this much.
  const shift = started - (all[next]?.at ?? 0);
  let delivered = 0,
    lastPoseAt = 0,
    stopped = false,
    rate = 0,
    lastAt = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    while (next < all.length && all[next].at + shift <= now) {
      const rec = all[next++];
      const frame = playbackFrame(rec);
      frame.t = rec.t + shift;
      if (typeof rec.m === "number") frame.motionT = rec.m + shift;
      if (typeof rec.c === "number") frame.capturedAt = rec.c + shift;
      delivered++;
      if (lastAt) rate = rate ? rate * 0.9 + (1000 / Math.max(1, frame.t - lastAt)) * 0.1 : 1000 / Math.max(1, frame.t - lastAt);
      lastAt = frame.t;
      lastPoseAt = frame.t;
      for (const cb of listeners) cb(frame);
    }
  }, 4);
  return {
    onFrame(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    fps: () => (next >= all.length ? 0 : rate),
    inferenceMs: () => 0,
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
    delegate: () => "CPU",
    stats: () => ({ frames: delivered, detected: delivered, errors: 0, lastPoseAt, driver: null }),
  };
}
