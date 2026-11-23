import type { PoseFrame } from "@spar/protocol";
import { CameraError, startCamera, stopCamera } from "../camera/camera";
import { createPoseSource, type PoseSource } from "../camera/pose";
import { createArmRuler, type ArmLengths } from "../pov/body";
import type { PlayerPose } from "../pov/duel";
import { createHeadTurn } from "../pov/headTurn";
import { DODGE_SENSITIVITY, trackedAvatar } from "../pov/input";
import { poseModelUrl, type ModelTier } from "../pov/quality";
import { createSessionLog } from "../pov/sessionLog";
import {
  createSyntheticPoseSource,
  type SyntheticSourceOptions,
} from "../pov/syntheticBody";
import {
  createPovTracker,
  missingBodyParts,
  type TrackingResult,
} from "../pov/tracking";
import { framingOf, type Framing } from "../pov/banner";
import { createLightMeter } from "../pov/lightMeter";
import { createWakeLock } from "../pov/wakeLock";
import { validPose } from "../pov/duel";
import type { Guard } from "./defence";
import { bodyOf, createBodyScale, type Me3D } from "./real/body3d";
import { createPunchReader, type Punch, type PunchStart } from "./punch";
import { createRecordedPoseSource } from "./replaySource";
import type { RecordedSession } from "../pov/sessionLog";
import {
  calibrateAim,
  createContactReader,
  createGuardShapes,
  createRangeReader,
  defaultMarks,
  guardFromShapes,
  learnMarks,
  tooSteep,
  type AimMarks,
  type AimSetup,
  type AimSource,
  type ContactEvent,
  type GuardShapeReader,
  type Point,
  type RangeReading,
} from "./read";

/**
 * How long a hand counts as out punching (guarding nothing) after its punch
 * is confirmed, unless its arm is seen to end sooner: a snapped punch the
 * longest, a doubtful one less, a hand only put out least. Restless hands are
 * read as doubtful punches, and a guard must not be opened by them for long.
 */
export const OUT_MS = (e: { touch: boolean; quality: number }) => (e.touch ? 150 : e.quality >= 0.9 ? 400 : 220);

/**
 * The camera, the body model and the tracker for the ring, in one place and
 * free of the screen: start it, ask it each frame where the player is.
 * Everything here was built and measured for the ball game and is used as is.
 */
export type CaptureState = "off" | "starting" | "live";
export type CaptureProblem =
  | "denied"
  | "not-found"
  | "in-use"
  | "insecure-context"
  | "unsupported"
  | "model"
  | "unknown";
export interface CaptureStatus {
  state: CaptureState;
  message: string;
  problem: CaptureProblem | null;
}
export interface CaptureSample {
  tracking: TrackingResult;
  /** The player in the game's units, with small movements made larger; null when not tracked. */
  pose: PlayerPose | null;
  valid: boolean;
  calibrated: boolean;
  calibrating: boolean;
  progress: number;
  /** A body is in the picture at all. */
  bodySeen: boolean;
  poseT: number;
  poseAge: number;
  arms: ArmLengths | null;
  reason: string | null;
  poseFps: number;
  /** Where the body sits in the camera's picture, for setup's directions. */
  framing: Framing;
  /** Parts setup still needs to see, e.g. ["hips"]. */
  missing: string[];
  /** The picture is too dark to track in. */
  dim: boolean;
  /**
   * Punches read from every pose that arrived since the last sample, and which
   * hands are out punching now. Read where the poses arrive, so none waits for
   * a drawn frame and none is skipped when two arrive between frames.
   */
  read: { punches: Punch[]; starts: PunchStart[]; busy: [boolean, boolean] };
  /**
   * How far the player stands against the spot where set-up finished: pulled
   * back (a step or a lean), or too near the screen. Null until set-up is done.
   */
  range: RangeReading | null;
  /** How large the player looks against how large they looked at their spot: 1 at home, 1.2 a small step nearer. Null when not measured. */
  nearness: number | null;
  /** How far the player's shoulders are from the camera, metres; null when not measured. */
  cameraMetres: number | null;
  /** The player's size as measured from the body: metres to a tracker unit, the camera's pitch (radians), and whether it has been measured yet. */
  size: { metres: number; tilt: number; measured: boolean };
  /**
   * The player's punches as events on the poses' own clock, since the last
   * sample: a start, its confirmation with where it goes, how well it was
   * thrown and when the fist is at full stretch, its measured end, the hand
   * home. See read/contact.ts.
   */
  contacts: ContactEvent[];
  /**
   * The aim set-up: "none" until the player has held both fists straight out
   * at the screen for a moment (asked for with `askAim`); "steep" when the
   * camera looks up or down at them so sharply that aim and guard suffer.
   */
  aim: "none" | "ready" | "steep";
  /** The guard read from the gloves' and forearms' real places, once there is an aim set-up; null before. */
  guard: Guard | null;
  /**
   * The player's body in their own room, one to one, as of the newest pose
   * (real/body3d.ts): where the eyes, shoulders, elbows and gloves really
   * are, a step toward the screen included. Null while the body is not followed.
   */
  body: Me3D | null;
}

export function createCapture(
  video: HTMLVideoElement,
  options: {
    /** A scripted person instead of the camera, for testing. */
    scripted?: SyntheticSourceOptions | null;
    /** A saved recording of a real person instead of the camera, played back from `fromS` seconds in. */
    recorded?: { session: RecordedSession; fromS?: number } | null;
    model?: ModelTier;
    /** Where this player's straight punches at the head were found to end, from an earlier visit. */
    marks?: AimMarks | null;
    onStatus(status: CaptureStatus): void;
  },
) {
  const tracker = createPovTracker({
    automatic: true,
    scaleMode: "body-relative",
    // Covering up puts the gloves in front of the face: that is a block, not a lost player.
    hiddenHeadFromShoulders: true,
  });
  const ruler = createArmRuler(),
    headTurn = createHeadTurn(),
    wake = createWakeLock(),
    // Four minutes: a whole fight, so a round that went wrong can be played back.
    log = createSessionLog(240_000),
    light = createLightMeter();
  // A camera that goes quiet is started again by itself.
  let frames = 0,
    seenFrames = -1,
    framesAt = 0;
  let body: PoseSource | null = null;
  let stream: MediaStream | null = null;
  let abort: AbortController | null = null;
  let last: PoseFrame | null = null;
  let state: CaptureState = "off";
  let cameraSays = options.scripted ? "scripted person, no camera" : "unknown";
  let retries = 0,
    retriedAt = -Infinity;
  /** May the camera be started again by itself? Twice in any minute. */
  const mayRetry = () => {
    const now = performance.now();
    if (now - retriedAt > 60_000) retries = 0;
    if (retries >= 2) return false;
    retries++;
    retriedAt = now;
    return true;
  };
  const reader = createPunchReader();
  // The player's spot is where set-up finished; how far they stand is read against it on every pose.
  const ranger = createRangeReader();
  let range: RangeReading | null = null,
    wasCalibrated = false;
  // The player's punches with their contact scheduled, where they go in real distances, and the guard as shapes.
  const contact = createContactReader();
  let contacts: ContactEvent[] = [];
  let aim: AimSetup | null = null,
    aimAsked = false,
    aimPoses: AimSource[] = [];
  let marks: AimMarks = options.marks ?? defaultMarks();
  let ends: { hand: "left" | "right"; point: Point }[] = [],
    padWork = false;
  /**
   * Hands that are out punching, [left, right]: from a punch being confirmed
   * until its arm has ended, or `OUT_MS`. Not
   * the punch reader's own "busy", which is true from the first sign of a
   * start: a hand that only drifted is still guarding.
   */
  let flyingUntil: [number, number] = [-Infinity, -Infinity];
  let bodyNow: Me3D | null = null;
  // How large this player is in metres, and how the camera is pitched: from the body itself, no set-up asked.
  const size = createBodyScale();
  let shapes: GuardShapeReader | null = null,
    shaped: Guard | null = null,
    shapedAt = -Infinity,
    covering: [boolean, boolean] = [false, false];
  let punches: Punch[] = [],
    starts: PunchStart[] = [],
    busy: [boolean, boolean] = [false, false];
  const say = (next: CaptureState, message: string, problem: CaptureProblem | null = null) => {
    state = next;
    options.onStatus({ state: next, message, problem });
  };
  const take = (frame: PoseFrame) => {
    const arrived = performance.now();
    frames++;
    last = frame;
    log.frame(frame, arrived);
    const result = tracker.update(frame, arrived);
    if (result.calibrated && !wasCalibrated) ranger.rehome();
    wasCalibrated = result.calibrated;
    range = result.calibrated ? ranger.update(frame, frame.motionT ?? frame.t) : null;
    if (result.valid && result.units !== "normalized" && result.joints && result.jointWeights) {
      ruler.measure(result.joints, result.jointWeights, frame.t);
      // The punch reader runs here, on every pose, on the even clock.
      const t = frame.motionT ?? frame.t;
      const read = reader.update(result, t, ruler.lengths());
      punches.push(...read.punches);
      starts.push(...read.starts);
      busy = reader.busy(t);
      const far = range && range.ready && range.units > 0 ? range.units : 0;
      // The aim set-up: a moment with both fists straight out at the screen gives the camera's tilt.
      if (aimAsked && !aim && far > 0) {
        aimPoses.push(result as AimSource);
        if (aimPoses.length > 30) aimPoses.shift();
        const made = calibrateAim(aimPoses, far, ruler.lengths());
        if (made) {
          aim = made;
          aimPoses = [];
          shapes = createGuardShapes(made);
        }
      }
      for (const e of contact.update({
        t,
        tracking: result as typeof result & AimSource,
        arms: ruler.lengths(),
        starts: read.starts,
        punches: read.punches,
        busy,
        jitter: reader.jitter(),
        aim: aim && far > 0 ? { setup: aim, range: far, marks } : null,
      })) {
        contacts.push(e);
        if (e.kind === "confirm") flyingUntil[e.hand === "left" ? 0 : 1] = t + OUT_MS(e);
        else if (e.kind === "end" || e.kind === "home" || e.kind === "cancel") flyingUntil[e.hand === "left" ? 0 : 1] = Math.min(flyingUntil[e.hand === "left" ? 0 : 1], t + 60);
        // Where this player's own straights at the head end: at the pad every one of them is; later, those that read as the head.
        if (e.kind === "end" && e.shape === "straight" && e.point && !e.short && !e.touch && (padWork || e.level === "head")) {
          ends.push({ hand: e.hand, point: e.point });
          if (ends.length > 12) ends.shift();
          marks = learnMarks(ends, marks);
        }
      }
      if (contacts.length > 60) contacts = contacts.slice(-60);
      // The body, one to one: arms in real distances once the reach has been shown, a step toward the screen as a step.
      const picture = { lm: frame.lm, aspect: frame.imageAspect || 9 / 16 };
      size.update(result, frame.world, picture);
      bodyNow = bodyOf(result, {
        t,
        away: range && range.ready ? range.away : 0,
        setup: aim,
        range: far,
        arms: ruler.lengths(),
        previous: bodyNow && t - bodyNow.t < 400 ? bodyNow : null,
        // The model's own three-dimensional arms, in metres.
        world: frame.world,
        metres: size.metres(),
        tilt: size.tilt(),
        bones: size.bones(),
        picture: { ...picture, metresHigh: size.metresHigh() },
      });
      // From here on "busy" is a punch really thrown, as the contact reader has it.
      busy = [t < flyingUntil[0], t < flyingUntil[1]];
      if (shapes && far > 0) {
        shaped = guardFromShapes(shapes.update(result as AimSource, far, t), busy, covering);
        shapedAt = t;
        covering = shaped.sides ? [shaped.sides.high[0], shaped.sides.high[1]] : [false, false];
      }
    }
  };
  function stop() {
    wake.release();
    abort?.abort();
    abort = null;
    body?.stop();
    body = null;
    stopCamera(stream);
    stream = null;
    if (video.srcObject) {
      stopCamera(video.srcObject as MediaStream);
      video.srcObject = null;
    }
    last = null;
    tracker.reset();
    reader.reset();
    ranger.rehome();
    range = null;
    wasCalibrated = false;
    contact.reset();
    contacts = [];
    flyingUntil = [-Infinity, -Infinity];
    bodyNow = null;
    size.reset();
    aim = null;
    aimPoses = [];
    shapes = null;
    shaped = null;
    punches = [];
    starts = [];
    busy = [false, false];
    state = "off";
  }
  async function start(again = false): Promise<void> {
    if (!again) {
      retries = 0;
      retriedAt = -Infinity;
    }
    stop();
    const mine = (abort = new AbortController());
    say("starting", "Opening camera…");
    try {
      if (options.scripted) {
        body = createSyntheticPoseSource(options.scripted);
      } else if (options.recorded) {
        body = createRecordedPoseSource(options.recorded.session, { fromS: options.recorded.fromS });
      } else {
        const load = () =>
          createPoseSource(video, {
            signal: mine.signal,
            maxFps: 60,
            modelUrl: poseModelUrl(options.model ?? "lite"),
          });
        // The model loads while the player answers the camera prompt.
        const loading = load();
        loading.catch(() => {});
        try {
          stream = await startCamera(video, {
            width: 1280,
            height: 720,
            frameRate: 60,
            preferFrameRate: true,
            signal: mine.signal,
          });
        } catch (e) {
          void loading.then((source) => source.stop()).catch(() => {});
          throw e;
        }
        if (abort !== mine) return;
        const given = stream.getVideoTracks?.()[0]?.getSettings?.();
        cameraSays = given
          ? `${given.width ?? "?"}×${given.height ?? "?"} at ${given.frameRate ? Math.round(given.frameRate) : "?"} fps`
          : "unknown";
        log.describe({
          camera: cameraSays,
          model: options.model ?? "lite",
        });
        stream.getVideoTracks?.()[0]?.addEventListener?.("ended", () => {
          if (abort !== mine) return;
          // Unplugged or taken by another app: start it again, twice a minute at most.
          if (mayRetry()) void start(true);
          else {
            stop();
            say("off", "The camera stopped. Press Enable camera to try again.", "unknown");
          }
        });
        say("starting", "Loading body tracking…");
        try {
          body = await loading;
        } catch (e) {
          if (mine.signal.aborted) throw e;
          say("starting", "Body tracking did not load. Trying again…");
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (abort !== mine) return;
          try {
            body = await load();
          } catch {
            stop();
            say("off", "Body tracking did not load. Check the connection.", "model");
            return;
          }
        }
      }
      if (abort !== mine) {
        body?.stop();
        return;
      }
      body.onFrame(take);
      framesAt = performance.now();
      seenFrames = -1;
      wake.acquire();
      say(
        "live",
        options.scripted
          ? "Scripted boxer — no camera in use."
          : options.recorded
            ? "A saved recording — no camera in use."
            : "Stand back so the camera sees you from head to hips.",
      );
    } catch (e) {
      if (abort !== mine) return;
      stop();
      say(
        "off",
        e instanceof Error ? e.message : String(e),
        e instanceof CameraError ? e.code : "unknown",
      );
    }
  }
  return {
    start,
    stop,
    state: () => state,
    stream: () => stream,
    /** The last few minutes of what the camera reported and what the game made of it, for playing back. */
    recording: () => log.save(),
    /** What the game decided, kept beside the landmarks it decided it from. */
    note: (now: number, facts: Record<string, string | number | boolean | null>) =>
      log.note(now, facts),
    recenter: () => tracker.recenter(),
    /** Each hand's jitter while still, as the punch reader measures it: about metres at the player, [left, right]. */
    jitter: () => reader.jitter(),
    /** What the camera said it gave. */
    camera: () => cameraSays,
    /** Ask for the aim set-up: from now, a moment with both fists straight out at the screen is looked for. */
    askAim(on: boolean) {
      aimAsked = on;
      if (!on) aimPoses = [];
    },
    /** Pad work: every straight punch is one at the head, and says where this player's head punches end. */
    padWork(on: boolean) {
      padWork = on;
    },
    /** Where this player's straight punches at the head end, as learned so far: worth keeping between visits. */
    marks: () => marks,
    /** Where the player is, as of the newest pose. */
    sample(now: number): CaptureSample {
      // No pictures for four seconds with the page in view: the camera has
      // stalled (a phone back from sleep, a tab switch). Start it again.
      if (state === "live" && !options.scripted && !options.recorded) {
        const hidden = typeof document !== "undefined" && document.hidden;
        if (hidden || frames !== seenFrames) {
          seenFrames = frames;
          framesAt = now;
        } else if (now - framesAt > 4000) {
          framesAt = now;
          if (mayRetry()) void start(true);
        }
      }
      const tracking = tracker.sample(now);
      const frame = last;
      const bodySeen = !!frame && now - frame.t < 250;
      const lm = bodySeen ? frame!.lm : [];
      const left = lm[11],
        right = lm[12];
      const framing =
        left && right && left.v >= 0.5 && right.v >= 0.5
          ? framingOf(
              (left.x + right.x) / 2,
              Math.hypot(
                (left.x - right.x) / (frame!.imageAspect || 9 / 16),
                left.y - right.y,
              ),
            )
          : "no-body";
      const poseT = frame ? (frame.motionT ?? frame.t) : -Infinity;
      const arms = ruler.lengths();
      const read = { punches, starts, busy };
      punches = [];
      starts = [];
      const happened = contacts;
      contacts = [];
      const pose = trackedAvatar(tracking, DODGE_SENSITIVITY.default, {
        arms: arms ?? undefined,
        head: headTurn.update(tracking.joints, tracking.jointWeights, frame?.t ?? now),
      });
      const valid =
        tracking.valid && tracking.units !== "normalized" && validPose(pose);
      return {
        tracking,
        pose: valid ? pose : null,
        valid,
        calibrated: tracking.calibrated,
        calibrating: !tracking.calibrated && tracking.reason === "calibrating",
        progress: tracking.calibrationProgress ?? 0,
        bodySeen,
        framing,
        missing: missingBodyParts(lm),
        dim: options.scripted || options.recorded ? false : light.read(video, now).dim,
        poseT,
        poseAge: tracker.poseAge(now),
        arms,
        reason: tracking.reason,
        poseFps: body?.fps() ?? 0,
        read,
        range,
        nearness: range && range.ready && !range.held && range.units > 0 ? (range.units - range.away) / range.units : null,
        // How far the shoulders are from the camera, metres: what limits a step toward the screen.
        cameraMetres: range && range.ready && !range.held && range.units > 0 ? range.units * size.metres() : null,
        size: { metres: size.metres(), tilt: size.tilt(), measured: size.measured() },
        contacts: happened,
        aim: aim ? (tooSteep(aim) ? "steep" : "ready") : "none",
        // A guard read from a pose older than a fifth of a second is not a reading.
        guard: shaped && poseT - shapedAt < 200 ? shaped : null,
        body: valid && bodyNow && poseT - bodyNow.t < 250 ? bodyNow : null,
      };
    },
  };
}
export type Capture = ReturnType<typeof createCapture>;
