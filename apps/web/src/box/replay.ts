import { createArmRuler } from "../pov/body";
import { playbackFrame, type RecordedSession } from "../pov/sessionLog";
import { createPovTracker } from "../pov/tracking";
import { readGuard } from "./defence";
import { createPunchReader, type Punch, type PunchStart } from "./punch";

/**
 * Plays a saved session's landmarks back through the tracker and the punch
 * reader, as the game ran them live, and says what would be read now. With
 * the notes the game saved beside them (what it read at the time, what the
 * player was doing), a recording from a real camera is something thresholds
 * can be tuned against, instead of guessed.
 */
export interface Replay {
  /** Seconds from the first frame. */
  starts: (PunchStart & { at: number })[];
  punches: (Punch & { at: number })[];
  /** Share of frames in which the body was tracked. */
  tracked: number;
  /** Seconds with both gloves covering, and with any glove at the ribs. */
  covered: number;
  low: number;
  /** What the game noted at the time, by kind of event. */
  noted: Record<string, number>;
  seconds: number;
}
export function replaySession(session: RecordedSession): Replay {
  const tracker = createPovTracker({
    automatic: true,
    scaleMode: "body-relative",
    hiddenHeadFromShoulders: true,
  });
  const reader = createPunchReader();
  const ruler = createArmRuler();
  const out: Replay = {
    starts: [],
    punches: [],
    tracked: 0,
    covered: 0,
    low: 0,
    noted: {},
    seconds: 0,
  };
  const first = session.frames[0]?.t ?? 0;
  let last = first,
    valid = 0;
  for (const recorded of session.frames) {
    const frame = playbackFrame(recorded);
    const result = tracker.update(frame, recorded.at);
    const t = frame.motionT ?? frame.t;
    const dt = Math.max(0, Math.min(0.1, (frame.t - last) / 1000));
    last = frame.t;
    if (!result.valid) continue;
    valid++;
    if (result.joints && result.jointWeights)
      ruler.measure(result.joints, result.jointWeights, frame.t);
    const read = reader.update(result, t, ruler.lengths());
    const at = (frame.t - first) / 1000;
    for (const s of read.starts) out.starts.push({ ...s, at });
    for (const p of read.punches) out.punches.push({ ...p, at });
    const guard = readGuard(result, reader.busy(t));
    if (guard.high >= 2) out.covered += dt;
    if (guard.low >= 1) out.low += dt;
  }
  out.tracked = session.frames.length ? valid / session.frames.length : 0;
  out.seconds = (last - first) / 1000;
  for (const note of session.notes)
    if (typeof note.ev === "string") out.noted[note.ev] = (out.noted[note.ev] ?? 0) + 1;
  return out;
}
