import { useEffect, useRef, useState } from "react";
import { LM, type PoseFrame, type Landmark } from "@spar/protocol";
import { CameraError, startCamera, stopCamera } from "../camera/camera";
import { cameraSession } from "../camera/session";
import { inputStore } from "../input/store";
import { createPoseSource, type PoseSource } from "../camera/pose";
import { createHandSource, type HandSource } from "./hands";
import {
  createPovTracker,
  missingBodyParts,
  shoulderOrientation,
} from "./tracking";
import { createThrowControl, type AimMarker } from "./aim";
import type { ThrowCue, ThrowState } from "./autoThrow";
import {
  trackedAvatar,
  type Rig,
  trackedFingers,
  DODGE_SENSITIVITY,
  nearCameraEdge,
  fitSensitivity,
} from "./input";
import { createSyntheticPoseSource } from "./syntheticBody";
import { parseNetworkState } from "./networkState";
import { createSnapshotBuffer } from "./presentation";
import { createPovScene } from "./scene";
import { createPovAudio } from "./povAudio";
import { HIT_STOP_MS, cameraKick, flinch } from "./impact";
import { MAX_HIT_LAG, incomingLead, leadBall } from "./ballDisplay";
import { createRaiseHand, createStartGate } from "./startGate";
import {
  createBotMind,
  dodgeShift,
  plannedBotThrow,
  windupClock,
  type BotDodge,
  type BotPlan,
} from "./botMind";
import { createWakeLock } from "./wakeLock";
import { createSessionLog } from "./sessionLog";
import { createArmRuler } from "./body";
import { createHeadTurn } from "./headTurn";
import { createInertialBlend } from "./inertial";
import {
  QUALITY,
  createQualityLadder,
  createTierAdvisor,
  isModelTier,
  poseModelUrl,
  type ModelTier,
  type RenderQuality,
} from "./quality";
import { createLightMeter } from "./lightMeter";
import { handCrop } from "./handCrop";
import {
  createBannerLatch,
  framingOf,
  outcomeWord,
  selectBanner,
  type Banner,
  type CameraProblem,
} from "./banner";
import { approach, createSoundDirector } from "./soundCues";
import {
  createRally,
  ownsBall,
  canRelease,
  neutralPose,
  validPose,
  launchBall,
  stepDuel,
  blendPose,
  botPose,
  FIXED_STEP,
  TRAINING_PACE,
  COURT,
  COURT_DISTANCE,
  type TrainingPace,
  type PlayerPose,
  type ThrowInput,
  solveFlight,
  worldPoint,
  localPoint,
  useWideCourt,
} from "./duel";
import { MATCH_PHYSICS } from "./physics";
import { MOVE } from "./input";
import { createCameraRig, KEY_NAMES, type DodgeKey } from "./cameraRig";
import { FlickPad } from "./FlickPad";
import { flickVelocity, FLICK_ORIGIN } from "./flick";
import type { Vec3 } from "./physics";
import "./pov.css";

type Control = "preview" | "camera";
const PREVIEW = {
  x: 0,
  depth: 0,
  duck: 0,
  azimuth: -2,
  elevation: 19,
  speed: 12,
  spin: 0,
};
function previewPose(p: typeof PREVIEW): PlayerPose {
  const v = neutralPose();
  for (const key of ["head", "root", "leftHand", "rightHand"] as const) {
    v[key].x += p.x;
    v[key].z += p.depth;
    v[key].y -= p.duck;
  }
  return v;
}
const friendlyReason = (reason: string | null) =>
  ({
    uncalibrated:
      "Keep your head, shoulders and hips visible. Setup is automatic.",
    calibrating: "Hold still, facing the camera…",
    stale: "Tracking lost — round paused.",
    "out-of-bounds": "Return to the marked area.",
    "shoulder-yaw": "Face the screen to recover tracking.",
    "occluded-or-invalid-landmark":
      "Keep your head, shoulders and hips visible to track movement.",
    "shoulder-span-jump": "Movement estimate uncertain — hold still.",
    "aspect-changed-recalibrate":
      "Camera framing changed. Hold still for automatic setup.",
    "different-person":
      "That does not look like the player who set up. Step back in, or hold still for a new setup.",
    "shoulder-span-too-small":
      "Move a little closer while keeping your head, shoulders and hips visible.",
  })[reason ?? ""] ??
  reason ??
  "Ready";

const PACE_KEY = "pov.pace";
function storedPace(): TrainingPace {
  try {
    const saved = localStorage.getItem(PACE_KEY);
    if (saved === "practice" || saved === "duel") return saved;
  } catch {
    // No storage available.
  }
  return "practice";
}
// The body model that fits this device is found by measuring and remembered
// for the next start. A model the player picked themselves is left alone.
const MODEL_KEY = "pov.model",
  MODEL_PINNED_KEY = "pov.modelPinned";
function storedModel(): ModelTier {
  try {
    const saved = localStorage.getItem(MODEL_KEY);
    if (isModelTier(saved)) return saved;
  } catch {
    // No storage available.
  }
  return "lite";
}
function storedPinned(): boolean {
  try {
    return localStorage.getItem(MODEL_PINNED_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberModel(tier: ModelTier, pinned: boolean) {
  try {
    localStorage.setItem(MODEL_KEY, tier);
    localStorage.setItem(MODEL_PINNED_KEY, pinned ? "1" : "0");
  } catch {
    // The choice lasts for this visit only.
  }
}
/** The body model could not be loaded, twice. */
class ModelLoadError extends Error {}
/** Seconds a player may hold the ball before it goes to the opponent, by pace. */
const SHOT_CLOCK_S = { practice: 10, duel: 6 } as const;
/** Standing still out of place this long, before a round, re-centres on the spot. */
const RECENTER_AFTER_MS = 1200;
/** How far from the middle of the court the hips may be when a round begins. */
const IN_PLACE_X = 0.3;
/** Longest stretch of game time one drawn frame may advance. */
const MAX_FRAME_STEP = 1 / 30;
/** Five lives as dots: one going out is seen at a glance from across the room. */
function Pips({ left }: { left: number }) {
  return (
    <span className="pov-pips" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < left ? "is-on" : ""} />
      ))}
    </span>
  );
}
const THROW_STATE_TEXT: Record<ThrowState, string> = {
  "no-pose": "not your turn, or no fresh pose",
  "hand-not-seen": "right wrist not seen",
  "raise-hand": "waiting for the right hand above the waist",
  ready: "ready, waiting for the drive",
  driving: "drive seen, releasing",
  released: "released",
};
/**
 * Tap mode (`?tap=1`, or `?pov=1&tap`): the founder's game. On your turn you
 * touch (or click) the screen where you want the ball to hit the opponent; hold
 * longer for a faster ball. Then you step back into your spot and dodge their
 * ball with your body. Seen from behind the opponent: your whole 3D body,
 * facing you like a mirror.
 */
export const TAP = {
  /** Flight time of a quick tap and of a long hold, seconds. */
  slowFlight: 1.3,
  fastFlight: 0.85,
  /** Holding this long gives the fastest ball, ms. */
  fullHoldMs: 900,
  /** After your ball lands, the opponent waits at least this long, seconds: time to get back. */
  getBack: 2.8,
  /** Extra time on your shot clock, seconds: you walk to the screen. */
  extraClock: 6,
};
export function POVScreen({ onBack }: { onBack: () => void }) {
  const pageQuery = useRef(typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams()).current;
  /**
   * `?play=1`: the game as one page. The bot throws, you dodge; on your turn you
   * go to the screen and flick the ball at them, then step back. Turn-taking
   * as tap mode; the throw is the flick, not a click.
   */
  const playMode = pageQuery.has("play");
  const tapMode = pageQuery.has("tap") || playMode;
  /** Your turn now (read by the flick pad between HUD redraws). */
  const myTurn = useRef(false);
  /** Your shoulder width in the picture at your spot, and whether set-up is done: to tell when you are up at the screen. */
  const homeSpan = useRef(0);
  const calibratedRef = useRef(false);
  /**
   * CORE.md stage 1 (`?pov=1&core`): the dodgeball with test switches.
   * `&lane` no ball, the wide lane; `&cam` bot balls on camera keys 1–4; `&flick` the flick probe.
   */
  const coreMode = pageQuery.has("core");
  const corePart: "lane" | "cam" | "flick" | null = !coreMode ? null : pageQuery.has("lane") ? "lane" : pageQuery.has("flick") ? "flick" : "cam";
  const chaseMode = coreMode || tapMode;
  // The wide lane and the movement curve on these pages; the classic page keeps its own.
  useWideCourt(chaseMode);
  if (!chaseMode) MOVE.mode = "classic";
  else if (MOVE.mode === "classic") MOVE.mode = "B";
  const newRally = () => (chaseMode ? { ...createRally(corePart === "flick" ? 0 : 1), physics: MATCH_PHYSICS } : createRally());
  const rig = useRef(createCameraRig(1));
  /** Keys pressed on the test page, with times, for the saved recording. */
  const keyLog = useRef<{ t: number; key: string }[]>([]);
  const camStats = useRef<Record<DodgeKey, { balls: number; hits: number }>>({ 1: { balls: 0, hits: 0 }, 2: { balls: 0, hits: 0 }, 3: { balls: 0, hits: 0 }, 4: { balls: 0, hits: 0 } });
  // The key just pressed, shown for a moment (a ref: the HUD redraws ten times a second anyway).
  const keyNote = useRef<{ text: string; at: number } | null>(null);
  const setKeyNote = (v: { text: string; at: number }) => (keyNote.current = v);
  /** A throw made on the flick pad, waiting to leave. */
  const flickPending = useRef<ThrowInput | null>(null);
  useEffect(() => {
    if (!chaseMode) return;
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const now = performance.now();
      if (k >= "1" && k <= "4") {
        const key = Number(k) as DodgeKey;
        rig.current.setKey(key);
        keyLog.current.push({ t: now, key: `camera ${key}` });
        sessionLog.current.note(now, { cameraKey: key });
        setKeyNote({ text: `${key} · ${KEY_NAMES[key]}`, at: now });
      } else if (k === "a" || k === "b") {
        MOVE.mode = k === "a" ? "A" : "B";
        keyLog.current.push({ t: now, key: `move ${k}` });
        sessionLog.current.note(now, { move: k.toUpperCase() });
        setKeyNote({ text: `Movement ${k.toUpperCase()}`, at: now });
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
  /** A touch on the screen waiting to become a throw: where it lands on the opponent, in your own frame, and how long it was held. */
  const tapPending = useRef<{ aim: Vec3; holdMs: number } | null>(null);
  const tapDown = useRef<{ at: number } | null>(null);
  const sceneRef = useRef<{ pointAt(x: number, y: number, seat: 0 | 1, at: Vec3): Vec3 | null } | null>(null);
  const tapPose = useRef<{ foe: PlayerPose; me: 0 | 1 } | null>(null);
  /** Whether the tap-mode canvas is drawn mirrored now (the dodge view only). */
  const tapFlip = useRef(false);
  const impactFlash = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [control, setControl] = useState<Control>(corePart === "flick" ? "preview" : "camera"),
    [preview, setPreview] = useState(PREVIEW),
    [running, setRunning] = useState(false);
  const [cameraStatus, setCameraStatus] = useState("off"),
    [cameraMessage, setCameraMessage] = useState(""),
    [handMessage, setHandMessage] = useState("");
  // The test pages start on the full body model (CORE.md 2.2): 2 ms dearer, much better.
  const [model, setModel] = useState<ModelTier>(chaseMode ? "full" : storedModel());
  // A new player starts on the slower pace; their own choice is remembered.
  const [pace, choosePace] = useState<TrainingPace>(storedPace());
  const setPace = (next: TrainingPace) => {
    try {
      localStorage.setItem(PACE_KEY, next);
    } catch {
      // Private mode or no storage: the choice lasts for this visit only.
    }
    choosePace(next);
  };
  const [dodgeSensitivity, setDodgeSensitivity] = useState<number>(
    DODGE_SENSITIVITY.default,
  );
  const [opponentView, setOpponentView] = useState(false);
  const [room, setRoom] = useState(""),
    [network, setNetwork] = useState(""),
    [joined, setJoined] = useState(false);
  const [error, setError] = useState(""),
    [hud, setHud] = useState({
      hp: [5, 5],
      time: 0,
      balls: 0,
      gate: "Practice is ready.",
      fps: 0,
      bodyFps: 0,
      handFps: 0,
      p95: 0,
      handP95: 0,
      bodyAge: 0,
      poseAge: 0,
      cameraDelay: null as number | null,
      inferMs: 0,
      delegate: "",
      execution: "",
      quality: 0 as RenderQuality,
      luma: null as number | null,
      trackingPauses: 0,
      pausedSeconds: 0,
      trackingHeld: false,
      cameraEdge: false,
      feedback: "",
      feedbackId: 0,
      feedbackHit: false,
      shoulderAngles: "No current shoulder observation",
      handError: "",
      holding: false,
      throwCue: "bring-back" as ThrowCue,
      throwState: "no-pose" as ThrowState,
      throwSpeed: 0,
      lastThrowSpeed: 0,
      windup: false,
      countdown: null as number | null,
      banner: null as Banner | null,
      opponentStatus: "Waiting for camera setup",
      canThrow: false,
      hits: 0,
      misses: 0,
      message: "",
      bodySeen: false,
      bodyComplete: false,
      bodyTracked: false,
      handTracked: false,
      rightWristTracked: false,
      calibrated: false,
      calibrating: false,
      calibrationProgress: 0,
      landmarks: [] as Landmark[],
      videoAspect: 16 / 9,
    });
  const settings = useRef({
    control,
    preview,
    running,
    cameraStatus,
    cameraMessage,
    pace,
    dodgeSensitivity,
    opponentView,
  });
  settings.current = {
    control,
    preview,
    running,
    cameraStatus,
    cameraMessage,
    pace,
    dodgeSensitivity,
    opponentView,
  };
  const duel = useRef(newRally()),
    local = useRef<0 | 1>(0),
    socket = useRef<WebSocket | null>(null),
    networkReady = useRef(false),
    networkReason = useRef(""),
    lastNetworkAt = useRef(-Infinity);
  const presentation = useRef(createSnapshotBuffer());
  const tracker = useRef(
      createPovTracker(
        chaseMode
          ? { automatic: true, scaleMode: "body-relative", bounds: { x: 1.0, y: 1.2, z: 0.25 } }
          : { automatic: true, scaleMode: "body-relative" },
      ),
    ),
    lastBody = useRef<PoseFrame | null>(null),
    release = useRef(createThrowControl());
  // Sound is the main feedback channel for a player standing across the room.
  const audio = useRef(createPovAudio()),
    sounds = useRef(createSoundDirector());
  // Starting without touching the screen: a raised hand asks for a round, and
  // the clock waits until the player has stood in place through a count.
  const bannerLatch = useRef(createBannerLatch());
  // Set once the player moves the dodge slider themselves.
  const sensitivityChosen = useRef(false);
  const botMind = useRef(createBotMind());
  // The screen must stay on while the player stands away from the device.
  const wake = useRef(createWakeLock());
  // The last minute of what the camera reported and what the game made of it,
  // saved on request so a problem on a real camera can be played back.
  const sessionLog = useRef(createSessionLog());
  const [cameraInfo, setCameraInfo] = useState("");
  // While the camera is on, the stage fills the window: the player is across
  // the room and everything on it has to be as large as the screen allows.
  // The menu brings the page and its settings back.
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelPinned, setModelPinned] = useState(storedPinned());
  // "See myself" is a mirror unless the player wants the opponent's true view.
  const [mirror, setMirror] = useState(true);
  const mirrorRef = useRef(true);
  mirrorRef.current = mirror;
  const modelRef = useRef(model);
  modelRef.current = model;
  const modelPinnedRef = useRef(modelPinned);
  modelPinnedRef.current = modelPinned;
  /** Frames a second the camera said it gives; 0 when not known. */
  const cameraRate = useRef(0);
  const scriptedRef = useRef(false);
  // A camera that stops is started again by itself, twice a minute at most.
  const autoRetry = useRef({ count: 0, first: -Infinity });
  const enableCameraRef = useRef<() => void>(() => {});
  const recoverCamera = useRef<(why: string) => void>(() => {});
  const swapModel = useRef<(next: ModelTier) => void>(() => {});
  // Why the camera did not start, for the stage; and the camera's own picture
  // shown large during setup so the player can see where they stand in it.
  const cameraProblem = useRef<CameraProblem | null>(null);
  const stageVideo = useRef<HTMLVideoElement>(null);
  function saveSession() {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(sessionLog.current.save())], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `spar-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setCameraMessage(
        `Could not save the session: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const startGate = useRef(createStartGate()),
    raisedHand = useRef(createRaiseHand()),
    startByGesture = useRef(() => {});
  startByGesture.current = () => {
    if (duel.current.hp.some((hp) => hp <= 0)) {
      duel.current = newRally();
      release.current.reset();
    }
    setRunning(true);
  };
  const sources = useRef<{
    abort: AbortController;
    body?: PoseSource;
    hands?: HandSource;
    stream?: MediaStream;
    swapping?: boolean;
  } | null>(null);
  const takeBodyFrame = (frame: PoseFrame) => {
    const arrived = performance.now();
    lastBody.current = frame;
    sessionLog.current.frame(frame, arrived);
    if (playMode) {
      // On your turn you walk up to the screen to flick. Up close you are not fed to the
      // tracker, so it neither takes a new home at the screen nor takes you for someone else.
      const l = frame.lm[11],
        r = frame.lm[12];
      const span = l && r && l.v > 0.5 && r.v > 0.5 ? Math.hypot((l.x - r.x) / (frame.imageAspect || 9 / 16), l.y - r.y) : 0;
      if (span > 0 && !myTurn.current && calibratedRef.current)
        homeSpan.current = homeSpan.current ? homeSpan.current * 0.98 + span * 0.02 : span;
      if (myTurn.current && homeSpan.current > 0 && (span === 0 || span > 1.3 * homeSpan.current)) return;
    }
    tracker.current.update(frame, arrived);
  };
  const sendShot = useRef<(shot: ThrowInput) => void>(() => {}),
    readyRef = useRef(false),
    poseRef = useRef(neutralPose());
  const stopCapture = () => {
    wake.current.release();
    if (stageVideo.current) stageVideo.current.srcObject = null;
    const s = sources.current;
    sources.current = null;
    s?.abort.abort();
    s?.body?.stop();
    s?.hands?.stop();
    stopCamera(s?.stream);
    if (video.current) {
      stopCamera(video.current.srcObject as MediaStream | null);
      video.current.srcObject = null;
    }
    lastBody.current = null;
    tracker.current.reset();
    release.current.reset();
  };
  const leaveRoom = () => {
    const ws = socket.current;
    socket.current = null;
    ws?.close();
    local.current = 0;
    networkReady.current = false;
    lastNetworkAt.current = -Infinity;
    presentation.current.reset();
    setJoined(false);
    setNetwork("");
    setRunning(false);
    duel.current = newRally();
  };
  const selectControl = (next: Control) => {
    setRunning(false);
    release.current.reset();
    if (next === "preview") {
      stopCapture();
      setCameraStatus("off");
      setCameraMessage("");
      setHandMessage("");
    }
    setControl(next);
  };
  async function enableCamera() {
    if (!video.current) return;
    setRunning(false);
    stopCapture();
    cameraSession.stop();
    inputStore.resetToKeyboard();
    setError("");
    setHandMessage("");
    cameraProblem.current = null;
    setCameraStatus("starting");
    setCameraMessage("Opening camera…");
    const s: {
      abort: AbortController;
      body?: PoseSource;
      hands?: HandSource;
      stream?: MediaStream;
    } = { abort: new AbortController() };
    sources.current = s;
    const permissionHint = setTimeout(() => {
      if (sources.current === s && !s.stream)
        setCameraMessage(
          "Still waiting for camera access. Allow the camera request in your browser, or cancel and retry.",
        );
    }, 8000);
    // `?mocap=demo` replaces the camera with a scripted person, to check the
    // tracker-to-avatar path without a camera. It is not evidence of real tracking.
    const scripted =
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("mocap") === "demo";
    scriptedRef.current = scripted;
    const tier = modelRef.current;
    const loadBody = () =>
      createPoseSource(video.current!, {
        signal: s.abort.signal,
        maxFps: 60,
        modelUrl: poseModelUrl(tier),
      });
    try {
      if (scripted) {
        clearTimeout(permissionHint);
        // `&fps=20&delay=90&occlude` make the scripted camera slower, later
        // and patchier, to see how the game holds up.
        const query = new URLSearchParams(location.search);
        s.body = createSyntheticPoseSource({
          fps: Number(query.get("fps")) || undefined,
          delayMs: Number(query.get("delay")) || undefined,
          occlude: query.has("occlude"),
        });
      } else {
        // The body model is a download of several megabytes plus a compile.
        // It starts now, while the player is still answering the camera
        // prompt, instead of after it. It waits quietly for frames.
        const loading = loadBody();
        // If the camera fails first, the loaded model must not be left running.
        loading.catch(() => {});
        try {
          s.stream = await startCamera(video.current, {
            width: 1280,
            height: 720,
            frameRate: 60,
            // Pose rate matters more to a dodge than picture size.
            preferFrameRate: true,
            signal: s.abort.signal,
          });
        } catch (e) {
          void loading.then((body) => body.stop()).catch(() => {});
          throw e;
        }
        clearTimeout(permissionHint);
        // What the camera actually gave, which may not be what was asked for.
        const given = s.stream.getVideoTracks?.()[0]?.getSettings?.();
        const info = given
          ? `${given.width ?? "?"}×${given.height ?? "?"} at ${given.frameRate ? Math.round(given.frameRate) : "?"} fps`
          : "unknown";
        setCameraInfo(info);
        cameraRate.current = given?.frameRate ?? 0;
        sessionLog.current.describe({ camera: info, model: tier });
        // Unplugged, taken by another app, or dropped while the page was
        // hidden: start it again rather than leave a frozen game.
        s.stream.getVideoTracks?.()[0]?.addEventListener?.("ended", () => {
          if (sources.current === s)
            recoverCamera.current("The camera stopped.");
        });
        if (stageVideo.current) {
          stageVideo.current.srcObject = s.stream;
          void stageVideo.current.play?.()?.catch?.(() => {});
        }
        if (sources.current !== s) {
          stopCamera(s.stream);
          void loading.then((body) => body.stop()).catch(() => {});
          return;
        }
        setCameraMessage("Loading body tracking…");
        try {
          s.body = await loading;
        } catch (e) {
          if (s.abort.signal.aborted || sources.current !== s) throw e;
          // A dropped connection or a busy graphics card: once more before
          // the player is asked to do anything.
          setCameraMessage("Body tracking did not load. Trying again…");
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (sources.current !== s) return;
          try {
            s.body = await loadBody();
          } catch (again) {
            throw new ModelLoadError(
              again instanceof Error ? again.message : String(again),
            );
          }
        }
      }
      if (sources.current !== s) {
        s.body.stop();
        return;
      }
      s.body.onFrame(takeBodyFrame);
      // Body feedback and calibration must not wait for the independent hand model.
      wake.current.acquire();
      setCameraStatus("live");
      setCameraMessage("Face the camera and hold still. Setup is automatic.");
      if (scripted) {
        setCameraMessage("Scripted body demo — no camera in use.");
        return;
      }
      setHandMessage("Loading hand tracking…");
      try {
        s.hands = await createHandSource(video.current, {
          signal: s.abort.signal,
        });
        if (sources.current === s) setHandMessage("");
      } catch (e) {
        if (s.abort.signal.aborted) return;
        setHandMessage(
          e instanceof Error ? e.message : "Hand tracking unavailable.",
        );
      }
      if (sources.current !== s) {
        s.hands?.stop();
        return;
      }
    } catch (e) {
      if (sources.current !== s) return;
      stopCapture();
      cameraProblem.current =
        e instanceof CameraError
          ? e.code
          : e instanceof ModelLoadError
            ? "model"
            : ("unknown" as const);
      setCameraStatus("off");
      setCameraMessage(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(permissionHint);
    }
  }
  // The whole screen, where the browser allows it (not iPhone Safari).
  const toggleFullscreen = () => {
    try {
      const page = document as Document & {
        webkitFullscreenElement?: Element;
        webkitExitFullscreen?: () => void;
      };
      const root = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => void;
      };
      if (page.fullscreenElement || page.webkitFullscreenElement)
        void (page.exitFullscreen?.() ?? page.webkitExitFullscreen?.());
      else
        void (
          root.requestFullscreen?.({ navigationUI: "hide" }) ??
          root.webkitRequestFullscreen?.()
        )?.catch?.(() => {});
    } catch {
      // Not allowed here: the full window is what there is.
    }
  };
  enableCameraRef.current = () => void enableCamera();
  recoverCamera.current = (why) => {
    const retry = autoRetry.current,
      now = performance.now();
    if (now - retry.first > 60_000) {
      retry.first = now;
      retry.count = 0;
    }
    if (retry.count >= 2) {
      stopCapture();
      cameraProblem.current = "unknown";
      setCameraStatus("off");
      setCameraMessage(`${why} Press Enable camera to try again.`);
      return;
    }
    retry.count++;
    setCameraMessage(`${why} Starting it again…`);
    enableCameraRef.current();
  };
  // Change the body model without stopping the camera or the game: the new
  // one is loaded beside the old, which keeps working until it is ready.
  swapModel.current = (next) => {
    const s = sources.current;
    if (!s?.body || !video.current || s.swapping || scriptedRef.current) return;
    s.swapping = true;
    void (async () => {
      try {
        const fresh = await createPoseSource(video.current!, {
          signal: s.abort.signal,
          maxFps: 60,
          modelUrl: poseModelUrl(next),
        });
        if (sources.current !== s) {
          fresh.stop();
          return;
        }
        const old = s.body;
        fresh.onFrame(takeBodyFrame);
        s.body = fresh;
        old?.stop();
        setModel(next);
        rememberModel(next, false);
        sessionLog.current.describe({ model: next });
      } catch {
        // The model in use still works; stay on it.
      } finally {
        s.swapping = false;
      }
    })();
  };
  function recenter() {
    tracker.current.reset();
    release.current.reset();
    setRunning(false);
    setCameraMessage(
      "Finding your new center. Hold still with your head, shoulders and hips in view.",
    );
  }
  function connect() {
    if (!/^[A-Z0-9]{6}$/.test(room)) {
      setNetwork("Use six letters or digits.");
      return;
    }
    leaveRoom();
    setNetwork("Connecting…");
    // Local development only; deployment must supply a separately reviewed secure endpoint.
    const endpoint = (import.meta as unknown as { env: Record<string, string> })
      .env.VITE_POV_URL;
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(
      location.hostname,
    );
    if (!endpoint && !isLocal) {
      setNetwork("Private match service is not configured on this host.");
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint ?? "ws://127.0.0.1:8791");
    } catch {
      setNetwork("Could not open the private match connection.");
      return;
    }
    socket.current = ws;
    const timeout = setTimeout(() => {
      if (socket.current === ws && !networkReady.current) {
        setNetwork("Connection timed out. Check the local match service.");
        ws.close();
      }
    }, 8000);
    ws.onopen = () => {
      if (socket.current === ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "join", room }));
    };
    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      let m;
      try {
        m = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      if (m.type === "joined" && (m.player === 0 || m.player === 1)) {
        clearTimeout(timeout);
        local.current = m.player;
        setJoined(true);
        setRunning(true);
        setNetwork(`Room ${room} · Player ${m.player + 1}`);
      } else if (m.type === "state") {
        const decoded = parseNetworkState(m.state);
        if (!decoded) {
          networkReady.current = false;
          setNetwork("Invalid match update — connection closed.");
          ws.close();
          return;
        }
        duel.current = decoded;
        networkReady.current = m.ready === true;
        networkReason.current = typeof m.reason === "string" ? m.reason : "";
        lastNetworkAt.current = performance.now();
        presentation.current.push(decoded, lastNetworkAt.current);
      } else if (m.type === "error") {
        setNetwork(String(m.message));
      }
    };
    ws.onerror = () => {
      if (socket.current === ws)
        setNetwork("Private match service unavailable.");
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (socket.current !== ws) return;
      socket.current = null;
      networkReady.current = false;
      setJoined(false);
      setRunning(false);
      setNetwork("Connection closed. Join again to start a fresh round.");
      local.current = 0;
      duel.current = newRally();
    };
  }
  function previewThrow() {
    const a = (preview.azimuth * Math.PI) / 180,
      e = (preview.elevation * Math.PI) / 180;
    sendShot.current({
      origin: poseRef.current.rightHand,
      velocity: {
        x: Math.sin(a) * Math.cos(e) * preview.speed,
        y: Math.sin(e) * preview.speed,
        z: Math.cos(a) * Math.cos(e) * preview.speed,
      },
      spin: { x: 0, y: preview.spin, z: 0 },
    });
  }
  function primaryAction() {
    // Browsers only allow sound after a tap; every path into play starts here.
    audio.current.resume();
    if (!joined && hud.hp.some((hp) => hp <= 0)) {
      duel.current = newRally();
      release.current.reset();
      setRunning(true);
      return;
    }
    if (running) {
      setRunning(false);
      return;
    }
    if (control === "camera") {
      if (cameraStatus === "off") {
        void enableCamera();
        return;
      }
      if (cameraStatus === "starting") {
        stopCapture();
        setCameraStatus("off");
        setCameraMessage("Camera setup cancelled. You can retry when ready.");
        return;
      }
      if (!hud.calibrated) return;
    }
    setRunning(true);
  }
  const primaryLabel =
    !joined && hud.hp.some((hp) => hp <= 0)
      ? "Play again"
      : running
        ? "Pause round"
        : control === "preview"
          ? "Start round"
          : cameraStatus === "off"
            ? "Enable camera"
            : cameraStatus === "starting"
              ? "Cancel camera setup"
              : hud.calibrating
                ? `Calibrating ${Math.round(hud.calibrationProgress * 100)}%`
                : !hud.calibrated
                  ? "Finding you…"
                  : "Start round";
  const primaryDisabled =
    !running &&
    control === "camera" &&
    cameraStatus === "live" &&
    !hud.calibrated;
  const sensitivityLocked = running && hud.hp.every((hp) => hp > 0);
  useEffect(() => {
    cameraSession.stop();
    inputStore.resetToKeyboard();
    const releaseResources = () => {
      audio.current.incoming(null);
      sendShot.current = () => {};
      stopCapture();
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
    let scene: ReturnType<typeof createPovScene>;
    try {
      scene = createPovScene(canvas.current!);
      sceneRef.current = scene;
    } catch (e) {
      setError(
        `3D view unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
      return releaseResources;
    }
    let raf = 0,
      last = performance.now(),
      accumulator = 0,
      lastUi = 0,
      lastSend = 0,
      lastBotAt = -Infinity,
      botPlan: BotPlan | null = null,
      botPlanFor = Number.NaN,
      // The opponent's step out of the way of the ball now in the air.
      botDodge: BotDodge | null = null,
      dodgedBall = -1,
      // Hit response, display only: when the sim resumes, when and on which
      // side the player was struck, when the opponent was.
      hitStopUntil = -Infinity,
      struck: { at: number; side: number } | null = null,
      opponentStruckAt = -Infinity,
      // Smoothed age of the pose the hit test uses, seconds. See ballDisplay.ts.
      hitLag = 0,
      // Where the ring last was, and after a throw where it was thrown and how
      // that ended: the ring stays, faint, until the ball resolves.
      // This round, from the player's side: balls thrown at them and dodged,
      // balls they threw and landed.
      tally = { faced: 0, dodged: 0, caught: 0, thrown: 0, landed: 0 },
      drawnValid = false,
      // The opponent does not throw in the first second after play resumes.
      botHoldUntil = -Infinity,
      tallyTime = 0,
      // Whether setup had completed on the previous frame.
      wasCalibrated = false,
      // The ball's flight into the hand of whoever gets it next, display only.
      handover: { from: Vec3; at: number; to: 0 | 1 } | null = null,
      hadBall: 0 | 1 | -1 = -1,
      // After the hit that ends the round, the aftermath plays slowly.
      slowUntil = -Infinity,
      wasOver = false,
      ringLocked = false;
    // Balls that struck the opponent's head, by ball id, for the outcome word.
    const headHits = new Set<number>();
    let // A throw that just failed to register, shown for a moment.
      throwHint: { kind: "too-soft" | "hand-low"; at: number } | null = null,
      // The last whole second of the shot clock that was ticked.
      clockTick = -1,
      // Where the hips have been standing still while out of place, and since when.
      misplaced: { since: number; x: number; y: number } | null = null,
      lastAim: Vec3 | null = null,
      thrownAt: {
        point: Vec3;
        since: number;
        result?: "hit" | "miss";
        at?: number;
      } | null = null,
      trackingPauses = 0,
      pausedSeconds = 0,
      renderFps = 0,
      lastThrowSpeed = 0,
      wasActive = false,
      // Your hearts last frame: a drop is a hit (the camera test counts them per key).
      lastHp = 5,
      // The camera key in use when the last bot ball left.
      launchKey: DodgeKey = 1;
    sendShot.current = (shot) => {
      if (!readyRef.current) return;
      const ws = socket.current;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN && networkReady.current)
          ws.send(
            JSON.stringify({ type: "throw", shot, pose: poseRef.current }),
          );
      } else duel.current = launchBall(duel.current, 0, shot);
    };
    // The avatar's fit to this player: their own arm lengths, their head's
    // turn read across the picture, and a glide over breaks in tracking.
    const armRuler = createArmRuler(),
      headTurn = createHeadTurn(),
      glide = createInertialBlend();
    // Measured every two seconds: is the device keeping up, is the body model
    // the right size for it, and is the camera still sending pictures.
    const qualityLadder = createQualityLadder(),
      tierAdvisor = createTierAdvisor(),
      lightMeter = createLightMeter();
    let quality: RenderQuality = 0,
      lastLoadCheck = -Infinity,
      seenFrames = -1,
      framesAt = performance.now();
    function frame() {
      // rAF's timestamp is the start of this render frame. A detector callback can
      // have completed later in that frame, so freshness must use the current clock.
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      last = now;
      renderFps = renderFps
        ? renderFps * 0.9 + Math.min(240, 1 / Math.max(elapsed, 0.001)) * 0.1
        : 60;
      const config = settings.current;
      if (now - lastLoadCheck >= 2000) {
        lastLoadCheck = now;
        const body = sources.current?.body;
        const camera =
          config.control === "camera" && config.cameraStatus === "live";
        const level = qualityLadder.update(
          { renderFps, poseFps: camera ? (body?.fps() ?? 0) : 0 },
          now,
        );
        if (level !== quality) {
          quality = level;
          scene.setQuality?.(QUALITY[level]);
        }
        if (body && camera && !scriptedRef.current) {
          // Any sign of life: a detector answer, or a pose handed over.
          const frames =
            (body.stats().frames ?? 0) + (lastBody.current?.t ?? 0);
          if (document.hidden || frames !== seenFrames) {
            seenFrames = frames;
            framesAt = now;
          } else if (now - framesAt > 4000) {
            framesAt = now;
            recoverCamera.current("The camera stopped sending pictures.");
          }
          if (!modelPinnedRef.current) {
            const next = tierAdvisor.advise(modelRef.current, {
              inferenceMs: body.inferenceMs?.() ?? 0,
              poseFps: body.fps(),
              cameraFps: cameraRate.current,
            });
            // Down at once; up only between rounds.
            if (next && (next === "lite" || !config.running))
              swapModel.current(next);
          }
        } else framesAt = now;
      }
      const light =
        config.control === "camera" &&
        config.cameraStatus === "live" &&
        !scriptedRef.current
          ? lightMeter.read(video.current, now)
          : { luma: null, dim: false };
      const turn = duel.current.rally;
      let nextBot = Infinity,
        botFake = 0;
      if (turn?.turn === 1 && turn.phase === "ready") {
        // One plan per possession: when to release, where to aim, how fast.
        if (botPlanFor !== turn.readyAt) {
          botPlan = botMind.current.next(config.pace);
          botPlanFor = turn.readyAt;
        }
        // The opening throw comes when the round's opening delay ends. After
        // that the rules allow a release 0.6 s after the ball arrives, and the
        // plan may hold it longer so the rhythm cannot be dodged by habit.
        const opening = duel.current.nextId === 1;
        botFake = opening ? 0 : botPlan!.fake;
        nextBot = opening
          ? turn.readyAt
          : turn.readyAt + Math.max(0, botPlan!.windup - 0.6) + botFake;
      }
      if (corePart === "lane" || corePart === "flick") nextBot = Infinity;
      if (corePart === "flick" && turn?.turn === 1 && turn.phase === "ready")
        duel.current = { ...duel.current, rally: { turn: 0, phase: "ready", readyAt: duel.current.time + 0.4 } };
      if (duel.current.time + 5 < botHoldUntil) botHoldUntil = -Infinity;
      if (nextBot !== Infinity) nextBot = Math.max(nextBot, botHoldUntil);
      // What the opponent's arm acts out: the real count to release, or a fake.
      const botWindup = (time: number) => windupClock(nextBot - time, botFake);
      if (duel.current.time < lastBotAt) lastBotAt = -Infinity;
      const foreground = !document.hidden && elapsed <= 0.25;
      let pose = previewPose(config.preview),
        gate = config.running
          ? "Move freely inside your area."
          : "Press Start to play.",
        valid = true,
        handsReady = true,
        fingersSeen = false,
        holding = true;
      // Both wrists seen: the player can catch.
      let bothHands = false;
      let throwCue: ThrowCue = "bring-back";
      let throwState: ThrowState = "no-pose";
      let throwSpeed = 0;
      let aimMarker: AimMarker | null = null;
      let calibrated = false;
      // For the session log: why the tracker is in the state it is in.
      let trackReason: string | null = null,
        inferredParts = "";
      // Tracked and near the middle of the space, sideways.
      let inPlace = true;
      // The tracker has the body outside the court it was set up in.
      let offCourt = false;
      let trackingHeld = false;
      let calibrating = false;
      let calibrationProgress = 0;
      const observed = lastBody.current;
      const bodySeen = !!observed && now - observed.t < 250;
      const cameraEdge = bodySeen && nearCameraEdge(observed!.lm);
      const missing = missingBodyParts(bodySeen ? observed!.lm : []);
      const orientation = bodySeen ? shoulderOrientation(observed!) : null;
      const degrees = (angle: number | null | undefined) =>
        angle == null
          ? "unavailable"
          : `${((angle * 180) / Math.PI).toFixed(0)}°`;
      let fingers: ReturnType<typeof trackedFingers> = [];
      let visibleHands: [boolean, boolean] = [true, true];
      let visualPose: PlayerPose | null = null;
      let pending: ThrowInput | null = null;
      if (config.control === "camera") {
        const t = tracker.current.sample(now);
        calibrated = t.calibrated;
        trackReason = t.reason;
        inferredParts = t.inferred?.join("+") ?? "";
        trackingHeld = t.held === true;
        calibrating = !calibrated && t.reason === "calibrating";
        calibrationProgress = t.calibrationProgress ?? 0;
        if (t.joints && t.jointWeights && observed && t.valid)
          armRuler.measure(t.joints, t.jointWeights, observed.t);
        const rig: Rig = {
          arms: armRuler.lengths() ?? undefined,
          head: headTurn.update(t.joints, t.jointWeights, observed?.t ?? now),
        };
        pose = trackedAvatar(t, config.dodgeSensitivity, rig);
        visibleHands = [
          t.leftHandTracked !== false,
          t.rightHandTracked !== false,
        ];
        valid = t.valid && t.units !== "normalized" && validPose(pose);
        if (tapMode && !valid && poseRef.current) pose = poseRef.current;
        if (valid) {
          // What is drawn leads the measured pose across part of its age, so the
          // avatar sits nearer to where the body is now. Hits, throws and the
          // network keep using the measured pose above.
          const predicted = trackedAvatar(
            tracker.current.predict(now),
            config.dodgeSensitivity,
            rig,
          );
          visualPose = validPose(predicted) ? predicted : pose;
        }
        gate = valid
          ? config.running
            ? "Read the release, then make a small dodge."
            : "Ready. Raise a hand above your head to start."
          : friendlyReason(t.reason);
        if (
          !valid &&
          bodySeen &&
          t.reason === "occluded-or-invalid-landmark" &&
          missing.length
        ) {
          const parts =
            missing.length > 1
              ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`
              : missing[0];
          gate = `Camera needs a clear view of your ${parts}. Step back or adjust the camera to include your head through your hips.`;
        }
        if (t.valid && !valid)
          gate = "Movement outside the supported area — paused.";
        // Only sideways position decides whether a round may start. Depth is a
        // guess that shifts when an arm goes up, and being near the edge of the
        // picture is a warning, not a reason to refuse: on a laptop the hips
        // are near the bottom edge all the time.
        inPlace = valid && Math.abs(pose.root.x) < IN_PLACE_X;
        offCourt = t.outOfBounds;
        const body = lastBody.current,
          hand = sources.current?.hands?.latest() ?? null;
        // Fingers are only drawn on a raised hand. The finger model shares the
        // device with the body model, so it rests while both hands are down.
        // The finger model looks at one hand at a time, in a square cut from
        // the full-size picture around the wrist the body model found; with
        // both hands up it takes them in turn.
        {
          const up = (["Left", "Right"] as const).filter((side) =>
            side === "Left"
              ? t.leftHandTracked !== false && t.leftHand.y >= 0.15
              : t.rightHandTracked !== false && t.rightHand.y >= 0.15,
          );
          const side =
            up.length === 2 ? up[Math.floor(now / 150) % 2] : (up[0] ?? null);
          const picture = video.current;
          sources.current?.hands?.setFocus?.(
            side && observed && picture?.videoWidth
              ? handCrop(
                  observed.lm,
                  side,
                  picture.videoWidth,
                  picture.videoHeight,
                )
              : null,
          );
        }
        sources.current?.hands?.setActive?.(
          valid &&
            QUALITY[quality].fingers &&
            ((t.leftHandTracked !== false && t.leftHand.y >= 0.15) ||
              (t.rightHandTracked !== false && t.rightHand.y >= 0.15)),
        );
        const handDetected =
          !!body &&
          !!hand &&
          Math.abs(body.t - hand.t) <= 80 &&
          hand.hands.some(
            (h) =>
              h.side === "Right" &&
              h.world.length === 21 &&
              h.world.every((p) => [p.x, p.y, p.z].every(Number.isFinite)),
          );
        // Only the wrist is needed to throw. Turned shoulders stop forward/back
        // tracking, not throwing: people turn their shoulders when they throw.
        const handReady = t.rightHandTracked !== false;
        fingersSeen = handDetected;
        handsReady = handReady;
        bothHands =
          valid &&
          t.leftHandTracked !== false &&
          t.rightHandTracked !== false;
        // Body movement and match readiness are different capabilities. Losing
        // finger detail must not freeze an otherwise valid local head/body pose.
        if (valid && !handReady)
          gate = config.running
            ? "Keep dodging. Show your right hand to throw."
            : "Body tracking ready. Raise a hand above your head to start.";
        // Turned shoulders, a held pose and a settling depth scale are the
        // tracker's business: the session log records them (held, reason), the
        // player is not told.
        if (
          valid &&
          (t.outOfBounds ||
            Math.abs(pose.root.x) >= COURT.halfWidth ||
            Math.abs(pose.head.x) >= COURT.headHalfWidth)
        )
          gate =
            "At the court edge. You don't need to move any farther; return toward center.";
        if (valid && !t.held && cameraEdge)
          gate =
            "Near the camera edge — use smaller dodges and ease back toward center.";
        if (config.cameraStatus === "off")
          gate = "Enable your camera to start tracking.";
        else if (config.cameraStatus === "starting")
          gate = config.cameraMessage;
        else if (calibrating)
          gate = `Hold still — automatic setup ${Math.round(calibrationProgress * 100)}%.`;
        if (valid && body)
          fingers = trackedFingers(hand, visualPose ?? pose, body.t);
        if (chaseMode && !tapMode) {
          release.current.reset();
          const flicked = flickPending.current;
          if (flicked && config.running && ownsBall(duel.current, local.current) && canRelease(duel.current, local.current)) {
            flickPending.current = null;
            pending = flicked;
          } else if (corePart === "cam" && config.running && ownsBall(duel.current, local.current) && canRelease(duel.current, local.current)) {
            // The camera test: your ball goes back by itself so the next one comes.
            const me = local.current;
            const foe = (1 - me) as 0 | 1;
            const chest = duel.current.poses[foe].root;
            const aim = localPoint(worldPoint({ x: chest.x, y: chest.y + 0.35, z: chest.z }, foe), me);
            pending = solveFlight(duel.current.poses[me].rightHand, aim, 1.2, MATCH_PHYSICS);
          }
        } else if (tapMode) {
          release.current.reset();
          const flicked = playMode ? flickPending.current : null;
          if (flicked && config.running && ownsBall(duel.current, local.current) && canRelease(duel.current, local.current)) {
            flickPending.current = null;
            pending = flicked;
            lastThrowSpeed = Math.hypot(flicked.velocity.x, flicked.velocity.y, flicked.velocity.z);
            // Time to walk back before their ball comes.
            botHoldUntil = duel.current.time + 1.2 + TAP.getBack;
          } else if (flicked && !ownsBall(duel.current, local.current)) flickPending.current = null;
          const tap = playMode ? null : tapPending.current;
          if (tap && config.running && ownsBall(duel.current, local.current) && canRelease(duel.current, local.current)) {
            tapPending.current = null;
            const me = local.current;
            const mine = duel.current.poses[me];
            // From the right hand if it is seen, else from in front of the shoulder.
            const hand = valid ? mine.rightHand : { x: mine.root.x + 0.22, y: 1.45, z: 0.25 };
            const k = Math.min(1, tap.holdMs / TAP.fullHoldMs);
            pending = solveFlight(hand, tap.aim, TAP.slowFlight + (TAP.fastFlight - TAP.slowFlight) * k, MATCH_PHYSICS);
            lastThrowSpeed = Math.hypot(pending.velocity.x, pending.velocity.y, pending.velocity.z);
            // Time to walk back before their ball comes.
            botHoldUntil = duel.current.time + TAP.slowFlight + TAP.getBack;
          } else if (tap && !ownsBall(duel.current, local.current)) tapPending.current = null;
        } else if (
          valid &&
          body &&
          config.running &&
          ownsBall(duel.current, local.current) &&
          foreground &&
          (!socket.current || networkReady.current)
        ) {
          // The marker shows as soon as the ball is yours; the throw itself waits
          // until the ball may be released. A wrist missing for a few poses is
          // handled inside, not treated as a restart here.
          const result = release.current.update(
            t,
            // The even clock: a throw's speed is distance over time.
            { ...pose, t: body.motionT ?? body.t },
            now,
            duel.current.poses[1 - local.current],
            canRelease(duel.current, local.current),
          );
          throwCue = result.cue;
          throwState = result.state;
          throwSpeed = result.speed;
          aimMarker = result.marker;
          // The ring commits with a small tick.
          if (result.marker?.locked && !ringLocked)
            audio.current.play({ kind: "lock" });
          ringLocked = result.marker?.locked === true;
          if (result.hint) {
            throwHint = { kind: result.hint, at: now };
            audio.current.play({ kind: "dud" });
          }
          if (result.shot) lastThrowSpeed = result.speed;
          pending = result.shot;
          fingers = trackedFingers(hand, visualPose ?? pose, body.t);
        } else {
          release.current.reset();
        }
        holding = ownsBall(duel.current, local.current) && visibleHands[1];
        if (
          valid &&
          config.running &&
          ownsBall(duel.current, local.current) &&
          !cameraEdge &&
          !t.held
        )
          gate = !handReady
            ? "Your ball is ready. Show your right hand to throw."
            : throwCue === "throw-forward"
              ? "Move your hand to place the ring, then throw."
              : "Your ball. Raise your right hand to aim, then throw it forward.";
      }
      // Body readiness controls the round; a fresh wrist and depth gate throwing.
      // Setup has just completed: fit the dodge gain to how much of the
      // picture the player has to move in, unless they set it themselves.
      if (calibrated && !wasCalibrated && !sensitivityChosen.current) {
        const left = observed?.lm[LM.L_SHOULDER],
          right = observed?.lm[LM.R_SHOULDER];
        if (bodySeen && left && right) {
          const wide = 1 / (observed!.imageAspect || 9 / 16);
          const fitted = fitSensitivity(
            (left.x + right.x) / 2,
            Math.hypot((left.x - right.x) * wide, left.y - right.y),
            wide,
          );
          if (Math.abs(fitted - config.dodgeSensitivity) >= 0.05)
            setDodgeSensitivity(fitted);
        }
      }
      wasCalibrated = calibrated;
      const over = duel.current.hp.some((h) => h <= 0);
      // A new round: its own tally.
      if (duel.current.time < tallyTime) {
        tally = { faced: 0, dodged: 0, caught: 0, thrown: 0, landed: 0 };
        headHits.clear();
      }
      tallyTime = duel.current.time;
      // Offline camera play starts by gesture and count; online start is the server's.
      const hands = config.control === "camera" && !socket.current;
      if (
        hands &&
        calibrated &&
        config.cameraStatus === "live" &&
        (!config.running || over)
      ) {
        if (raisedHand.current.update(bodySeen ? observed!.lm : undefined, now))
          startByGesture.current();
      } else raisedHand.current.reset();
      const gateState = hands
        ? startGate.current.update({
            now,
            running: config.running,
            over,
            valid,
            inPlace,
          })
        : null;
      if (gateState?.cue) audio.current.tick(gateState.cue === "go");
      // Setup often completes while the player is still on the way to their
      // spot, so the saved centre is where they paused, not where they play.
      // Standing still with the arms down, off-centre or outside the court,
      // before a round is live, takes the centre again where they now stand.
      // This re-centres on the spot: it does not send them through setup
      // again, which at their real spot (hips at the edge of the picture, say)
      // might never finish.
      const lm = bodySeen ? observed!.lm : null;
      const hips =
        lm?.[LM.L_HIP] && lm[LM.R_HIP]
          ? {
              x: (lm[LM.L_HIP].x + lm[LM.R_HIP].x) / 2,
              y: (lm[LM.L_HIP].y + lm[LM.R_HIP].y) / 2,
            }
          : null;
      // A raised arm shifts the shoulders the scale is read from.
      const armsDown =
        !!lm &&
        [
          [LM.L_WRIST, LM.L_SHOULDER],
          [LM.R_WRIST, LM.R_SHOULDER],
        ].every(
          ([wrist, shoulder]) =>
            !lm[wrist] ||
            !lm[shoulder] ||
            lm[wrist].v < 0.5 ||
            lm[wrist].y > lm[shoulder].y,
        );
      if (
        hands &&
        calibrated &&
        !gateState?.live &&
        valid &&
        (!inPlace || offCourt) &&
        armsDown &&
        hips
      ) {
        if (
          !misplaced ||
          Math.hypot(hips.x - misplaced.x, hips.y - misplaced.y) > 0.02
        )
          misplaced = { since: now, ...hips };
        else if (now - misplaced.since > RECENTER_AFTER_MS) {
          tracker.current.recenter();
          release.current.reset();
          misplaced = null;
        }
      } else misplaced = null;
      if (gateState && config.running && valid && !over && !gateState.live)
        gate =
          gateState.phase === "counting"
            ? `Starting in ${gateState.count}`
            : "Stand in the middle of your space and hold still.";
      const myTapTurn =
        tapMode &&
        (ownsBall(duel.current, local.current) || duel.current.balls.some((b) => b.owner === local.current));
      const active =
        (valid || (myTapTurn && !!poseRef.current)) && config.running && foreground && (gateState?.live ?? true);
      if (tapMode && config.running && !over && active)
        gate = myTapTurn
          ? ownsBall(duel.current, local.current)
            ? playMode
              ? "Your turn: go to the screen and flick the ball at them. Then step back."
              : "Your turn: touch the screen where you want to hit them. Hold longer for a faster ball."
            : "Get back to your spot — their ball is coming."
          : valid
            ? "Dodge! Step, duck or lean."
            : "Get back to your spot — their ball is coming.";
      if (
        config.control === "camera" &&
        config.running &&
        foreground &&
        !valid
      ) {
        if (wasActive) trackingPauses++;
        pausedSeconds += Math.min(0.1, Math.max(0, elapsed));
      }
      if (!foreground) {
        release.current.reset();
        gate = "View paused. Return to the court to continue.";
      }
      // Shot clock, against the bot. Holding the ball had no cost, so a player
      // who was ahead could simply keep it. The last three seconds tick; when
      // it runs out the ball goes to the opponent.
      let clockLeft: number | null = null;
      const held = duel.current.rally;
      if (
        !socket.current &&
        active &&
        !over &&
        held?.turn === local.current &&
        held.phase === "ready"
      ) {
        clockLeft =
          held.readyAt + SHOT_CLOCK_S[config.pace] + (tapMode ? TAP.extraClock : 0) - duel.current.time;
        if (clockLeft <= 0) {
          duel.current = {
            ...duel.current,
            rally: {
              turn: (1 - local.current) as 0 | 1,
              phase: "ready",
              readyAt: duel.current.time + 0.6,
            },
            message: "Shot clock — the ball goes to the opponent.",
          };
          release.current.reset();
          audio.current.play({ kind: "missed" });
          clockLeft = null;
          clockTick = -1;
        } else if (clockLeft <= 3 && Math.ceil(clockLeft) !== clockTick) {
          clockTick = Math.ceil(clockLeft);
          audio.current.tick();
        }
      } else clockTick = -1;
      readyRef.current = active;
      if (valid) poseRef.current = pose;
      const ws = socket.current;
      if (ws) {
        if (now - lastSend >= 33 && ws.readyState === WebSocket.OPEN) {
          lastSend = now;
          ws.send(
            JSON.stringify({
              type: "pose",
              pose: poseRef.current,
              ready: active,
            }),
          );
        }
        if (now - lastNetworkAt.current > 500) {
          networkReady.current = false;
          gate = "Waiting for a fresh match update…";
        } else if (!networkReady.current)
          gate = networkReason.current || "Waiting for the other player…";
        if (pending) sendShot.current(pending);
        accumulator = 0;
      } else {
        // The opponent may step aside from the player's ball: decided once,
        // when the ball appears, from where it is going to cross.
        const thrown = duel.current.balls.find((ball) => ball.owner === 0);
        if (duel.current.time < 0.05) {
          botDodge = null;
          dodgedBall = -1;
        }
        if (thrown && thrown.id !== dodgedBall) {
          dodgedBall = thrown.id;
          // Seat 0 throws down -z; the opponent's sideways axis is mirrored.
          const until =
            thrown.velocity.z < 0
              ? (-COURT_DISTANCE - thrown.position.z) / thrown.velocity.z
              : 0;
          botDodge = botMind.current.dodge(
            config.pace,
            -(thrown.position.x + thrown.velocity.x * until),
            duel.current.poses[1].root.x,
            duel.current.time,
          );
        } else if (!thrown && botDodge && botDodge.endAt === Infinity)
          botDodge = { ...botDodge, endAt: duel.current.time };
        const trainingPose = (time: number) =>
          botPose(
            time,
            botWindup(time),
            time - lastBotAt,
            dodgeShift(botDodge, time),
          );
        if (corePart === "flick" && !pending && flickPending.current && ownsBall(duel.current, local.current) && canRelease(duel.current, local.current)) {
          pending = flickPending.current;
          flickPending.current = null;
        }
        if (active) {
          if (!wasActive) {
            duel.current = {
              ...duel.current,
              poses: [pose, trainingPose(duel.current.time)],
              previous: [pose, trainingPose(duel.current.time)],
            };
            accumulator = 0;
            release.current.reset();
            pending = null;
            // Coming back from a pause, the player gets a second to look up
            // before a ball can leave the opponent's hand.
            botHoldUntil = duel.current.time + 1;
            if (nextBot !== Infinity) nextBot = Math.max(nextBot, botHoldUntil);
          }
          // Update hand origin before launch; target sweep still uses the previous state.
          const old = duel.current.poses[0];
          duel.current = {
            ...duel.current,
            poses: [
              { ...old, leftHand: pose.leftHand, rightHand: pose.rightHand },
              duel.current.poses[1],
            ],
          };
          if (pending) sendShot.current(pending);
          // One slow frame must not be simulated as one long leap: at 14 m/s a
          // 250 ms hitch would move the ball 3.5 m between two drawn frames.
          // A hit holds the simulation for a few frames so the moment registers;
          // the player's own view keeps following their body.
          accumulator +=
            now < hitStopUntil
              ? 0
              : Math.min(Math.max(0, elapsed), MAX_FRAME_STEP);
          const steps = Math.floor(accumulator / FIXED_STEP),
            from = duel.current.poses[0];
          for (let i = 0; i < steps; i++) {
            duel.current = stepDuel(
              duel.current,
              [
                blendPose(from, pose, (i + 1) / steps),
                trainingPose(duel.current.time + FIXED_STEP),
              ],
              FIXED_STEP,
              // Only the camera player catches; the training opponent never does.
              [bothHands, false],
            );
            accumulator -= FIXED_STEP;
          }
          if (duel.current.time >= nextBot && canRelease(duel.current, 1)) {
            let shot = plannedBotThrow(duel.current, botPlan ?? botMind.current.next(config.pace));
            if (corePart === "cam") {
              const mine = duel.current.poses[0].root;
              const aim = localPoint(worldPoint({ x: mine.x, y: mine.y + 0.35, z: mine.z }, 0), 1);
              shot = solveFlight(duel.current.poses[1].rightHand, aim, 1.0, MATCH_PHYSICS);
              camStats.current[rig.current.key()].balls++;
              launchKey = rig.current.key();
              keyLog.current.push({ t: performance.now(), key: `ball@${rig.current.key()}` });
            }
            duel.current = launchBall(duel.current, 1, shot);
            lastBotAt = duel.current.time;
          }
        } else {
          accumulator = 0;
          if (valid)
            duel.current = {
              ...duel.current,
              poses: [pose, duel.current.poses[1]],
              previous: [pose, duel.current.poses[1]],
            };
        }
      }
      wasActive = active;
      const s = duel.current,
        me = local.current;
      for (const cue of sounds.current.update({
        me,
        calibrated,
        active,
        running: config.running,
        ownsBall: ownsBall(s, me),
        windup:
          !ws && active && botWindup(s.time) < 0.6 && s.hp.every((h) => h > 0),
        released: pending ? lastThrowSpeed : null,
        events: s.events ?? [],
        hp: s.hp,
      })) {
        audio.current.play(cue);
        // The opponent plays to the player: it hears how each ball ended.
        if (!ws) {
          if (cue.kind === "hit-self") botMind.current.report("hit-player");
          else if (cue.kind === "dodged" || cue.kind === "caught")
            botMind.current.report("missed-player");
          else if (cue.kind === "hit-opponent")
            botMind.current.report("was-hit");
          else if (cue.kind === "missed") botMind.current.report("was-missed");
        }
        if (cue.kind === "hit-self" || cue.kind === "hit-opponent") {
          // Head or body: whichever centre the ball was nearer when it struck.
          const body = s.poses[cue.event.target];
          const height = cue.event.position.y;
          if (
            Math.abs(height - body.head.y) <
            Math.abs(height - (body.root.y + 0.2))
          )
            headHits.add(cue.event.id);
        }
        if (cue.kind === "hit-self") tally.faced++;
        else if (cue.kind === "dodged") {
          tally.faced++;
          tally.dodged++;
        } else if (cue.kind === "caught") {
          tally.faced++;
          tally.caught++;
          // The moment registers: the world holds for a few frames.
          if (!ws) hitStopUntil = now + HIT_STOP_MS.opponent;
        } else if (cue.kind === "hit-opponent") {
          tally.thrown++;
          tally.landed++;
        } else if (cue.kind === "missed") tally.thrown++;
        if (cue.kind === "hit-self") {
          const x =
            (me === 0 ? cue.event.position.x : -cue.event.position.x) -
            s.poses[me].head.x;
          struck = { at: now, side: Math.sign(x) };
          if (!ws) hitStopUntil = now + HIT_STOP_MS.self;
          // Straight to the element: the HUD state is only refreshed ten times a second.
          impactFlash.current?.animate?.([{ opacity: 0.85 }, { opacity: 0 }], {
            duration: 280,
            easing: "ease-out",
          });
        } else if (cue.kind === "hit-opponent") {
          opponentStruckAt = now;
          if (!ws) hitStopUntil = now + HIT_STOP_MS.opponent;
          if (thrownAt) thrownAt = { ...thrownAt, result: "hit", at: now };
        } else if (cue.kind === "missed" && thrownAt)
          thrownAt = { ...thrownAt, result: "miss", at: now };
        else if (cue.kind === "release" && lastAim)
          thrownAt = { point: lastAim, since: now };
      }
      if (s.hp.some((h) => h <= 0)) {
        readyRef.current = false;
        gate =
          s.hp[me] <= 0
            ? "Round complete · opponent wins"
            : "Round complete · you win";
        if (hands && calibrated) gate += " · raise a hand to play again";
      }
      // Keep local eyes, hands and finger geometry together without waiting for a round trip.
      // This affects rendering only; server snapshots still decide every online collision.
      const display = ws ? (presentation.current.sample(now) ?? s) : s;
      const visualPoses: [PlayerPose, PlayerPose] = [...display.poses];
      // Tracking that comes back somewhere else glides there instead of popping.
      if (valid)
        visualPoses[me] =
          config.control === "camera"
            ? glide.update(visualPose ?? pose, now, !drawnValid)
            : (visualPose ?? pose);
      drawnValid = valid;
      visualPoses[1 - me] = flinch(visualPoses[1 - me], now - opponentStruckAt);
      // Balls are drawn ahead of the simulation: by the part of this frame not
      // yet simulated, and, for a ball coming at a camera-tracked player, by the
      // age of the pose it will be tested against, so that what the player
      // sees reach them is what the game judges.
      hitLag +=
        ((config.control === "camera" && valid
          ? Math.min(MAX_HIT_LAG, tracker.current.poseAge(now) / 1000)
          : 0) -
          hitLag) *
        0.1;
      if (aimMarker) lastAim = aimMarker.point;
      // The thrown ring shows its result for a moment, then goes.
      if (thrownAt?.at !== undefined && now - thrownAt.at > 350)
        thrownAt = null;
      // No ball of the player's in the air and no result: the throw never left.
      if (
        thrownAt &&
        !thrownAt.result &&
        now - thrownAt.since > 500 &&
        !s.balls.some((b) => b.owner === me)
      )
        thrownAt = null;
      const remainder = !ws && active && now >= hitStopUntil ? accumulator : 0;
      const shownBalls = display.balls.map((ball) =>
        leadBall(
          ball,
          remainder +
            (!ws && ball.owner !== me ? incomingLead(ball.age, hitLag) : 0),
        ),
      );
      // A ball coming at the player gets louder and brighter as it closes.
      const coming = active
        ? shownBalls.find((ball) => ball.owner !== me)
        : null;
      audio.current.room?.(active && config.running);
      audio.current.incoming(
        coming
          ? approach(
              me === 0
                ? { x: coming.position.x, z: -coming.position.z }
                : {
                    x: -coming.position.x,
                    z: coming.position.z + COURT_DISTANCE,
                  },
              s.poses[me].head,
              COURT_DISTANCE,
            )
          : null,
      );
      // Your turn: over your shoulder. Theirs: the chosen dodge camera, still while their ball flies. Never mirrored.
      const incoming = s.balls.some((b) => b.owner !== me);
      const throwing = (tapMode && myTapTurn) || corePart === "flick";
      const chase = chaseMode ? rig.current.shot(now, throwing, incoming) : null;
      // A hit on you in the camera test, counted against the key in use.
      if (corePart === "cam" && s.hp[me] < lastHp) camStats.current[launchKey].hits++;
      lastHp = s.hp[me];
      tapPose.current = { foe: s.poses[(1 - me) as 0 | 1], me };
      myTurn.current = ownsBall(s, me) && s.hp.every((hp) => hp > 0);
      calibratedRef.current = calibrated;
      const shown = scene.render(
        { ...display, poses: visualPoses, balls: shownBalls },
        me,
        ownsBall(s, me) &&
          visibleHands[1] &&
          active &&
          s.hp.every((hp) => hp > 0),
        fingers,
        visibleHands,
        {
          opponentHolding: ownsBall(s, (1 - me) as 0 | 1),
          opponentView: config.opponentView && !chaseMode,
          chase,
          darkFloor: chaseMode,
          aim:
            aimMarker ??
            (thrownAt
              ? {
                  point: thrownAt.point,
                  locked: true,
                  ghost: true,
                  result: thrownAt.result,
                }
              : null),
          kick: struck ? cameraKick(now - struck.at, struck.side) : undefined,
          handover,
          rate: now < slowUntil ? 0.25 : 1,
          // The opponent lights up for the instant the ball lands on them.
          flash: Math.max(0, 1 - (now - opponentStruckAt) / 130),
        },
      );
      sessionLog.current.note(now, {
        camera: config.cameraStatus,
        running: config.running,
        bodySeen,
        missing: missing.join("+"),
        calibrated,
        // In tenths, so a climbing percentage is a handful of notes, not hundreds.
        progress: Math.round(calibrationProgress * 10) / 10,
        valid,
        held: trackingHeld,
        reason: trackReason,
        inferred: inferredParts,
        inPlace,
        offCourt,
        gate: gateState?.phase ?? null,
        count: gateState?.count ?? null,
        active,
        throwState,
        hp: s.hp.join("-"),
        poseHz: Math.round((sources.current?.body?.fps() ?? 0) / 5) * 5,
        said: gate,
      });
      // Whoever is given the ball next sees it come to their hand from where
      // the last one ended, instead of appearing there.
      const holder: 0 | 1 | -1 = ownsBall(s, 0) ? 0 : ownsBall(s, 1) ? 1 : -1;
      if (holder !== hadBall) {
        const ended = s.events?.at(-1);
        handover =
          holder >= 0 && ended && s.time - ended.at < 1
            ? { from: ended.position, at: now, to: holder as 0 | 1 }
            : null;
        hadBall = holder;
      }
      // The hit that ends the round: the next 0.7 s run at quarter speed.
      const finished = s.hp.some((hp) => hp <= 0);
      if (finished && !wasOver) slowUntil = now + 700;
      wasOver = finished;
      // Balls the game is done with still bounce off the floor and walls.
      for (const speed of shown?.bounces ?? []) audio.current.bounce(speed);
      if (now - lastUi > 100) {
        lastUi = now;
        setHud({
          hp: [s.hp[me], s.hp[1 - me]],
          time: s.time,
          balls: s.balls.length,
          gate,
          fps: renderFps,
          bodyFps: sources.current?.body?.fps() ?? 0,
          handFps: sources.current?.hands?.stats().fps ?? 0,
          p95: sources.current?.body?.stats().pipelineP95Ms ?? 0,
          handP95: sources.current?.hands?.stats().pipelineP95Ms ?? 0,
          bodyAge: observed ? Math.max(0, now - observed.t) : 0,
          poseAge: tracker.current.poseAge(now),
          cameraDelay: sources.current?.body?.stats().cameraDelayMs ?? null,
          inferMs: sources.current?.body?.inferenceMs?.() ?? 0,
          delegate: sources.current?.body?.delegate?.() ?? "",
          execution: sources.current?.body?.stats().execution ?? "",
          quality,
          luma: light.luma,
          trackingPauses,
          pausedSeconds,
          trackingHeld,
          cameraEdge: valid && !trackingHeld && cameraEdge,
          feedback: (() => {
            const event = s.events?.at(-1);
            if (!event || s.time - event.at > 0.65) return "";
            return outcomeWord(
              event.kind,
              event.target === me,
              headHits.has(event.id),
            );
          })(),
          feedbackId: s.events?.at(-1)?.id ?? 0,
          feedbackHit:
            s.events?.at(-1)?.kind === "hit" && s.events?.at(-1)?.target === me,
          shoulderAngles: `Shoulder angle estimate: 3D ${degrees(orientation?.worldYaw)} · image ${degrees(orientation?.imageYaw)} · using ${orientation?.worldYaw != null ? "3D" : "image fallback"}.`,
          handError: sources.current?.hands?.stats().error ?? "",
          holding,
          throwCue,
          throwState,
          throwSpeed,
          lastThrowSpeed,
          countdown: gateState?.phase === "counting" ? gateState.count : null,
          // The few large words a player across the room can read.
          banner:
            config.control === "camera"
              ? bannerLatch.current.update(
                  selectBanner({
                    camera: config.cameraStatus as "off" | "starting" | "live",
                    bodySeen,
                    missing,
                    calibrating,
                    calibrated,
                    progress: calibrationProgress,
                    running: config.running,
                    valid,
                    gate: gateState?.phase ?? null,
                    result: s.hp.every((h) => h > 0)
                      ? null
                      : s.hp[me] > 0
                        ? "won"
                        : "lost",
                    problem: cameraProblem.current,
                    framing: (() => {
                      const left = observed?.lm[LM.L_SHOULDER],
                        right = observed?.lm[LM.R_SHOULDER];
                      return bodySeen &&
                        left &&
                        right &&
                        left.v >= 0.5 &&
                        right.v >= 0.5
                        ? framingOf(
                            (left.x + right.x) / 2,
                            Math.hypot(
                              (left.x - right.x) /
                                (observed!.imageAspect || 9 / 16),
                              left.y - right.y,
                            ),
                          )
                        : "no-body";
                    })(),
                    ownsBall: ownsBall(s, me) && active,
                    hint:
                      throwHint && now - throwHint.at < 1300
                        ? throwHint.kind
                        : null,
                    clock: clockLeft,
                    dim: light.dim,
                    loading: config.cameraMessage,
                    summary:
                      tally.faced + tally.thrown > 0
                        ? `Dodged ${tally.dodged} of ${tally.faced}${tally.caught ? ` · caught ${tally.caught}` : ""} · landed ${tally.landed} of ${tally.thrown}`
                        : undefined,
                    aiming: aimMarker !== null,
                    tap: tapMode,
                    tapSub: playMode ? "Flick the ball at them, then step back" : undefined,
                    handLost: !handsReady,
                    nearEdge: valid && !trackingHeld && cameraEdge,
                    network:
                      ws && !networkReady.current
                        ? networkReason.current ||
                          "Waiting for the other player"
                        : null,
                  }),
                  now,
                )
              : null,
          opponentStatus: s.hp.some((h) => h <= 0)
            ? "Round complete"
            : ownsBall(s, me) && active
              ? tapMode
                ? playMode
                  ? "Your ball · flick it at them"
                  : "Your ball · touch the screen"
                : "Your ball · throw back"
              : ws
                ? networkReady.current
                  ? "Player connected"
                  : "Waiting for the other player"
                : config.control === "camera" && !calibrated
                  ? "Waiting for camera setup"
                  : !config.running
                    ? "Waiting for Start"
                    : !active
                      ? "Paused until tracking returns"
                      : s.balls.some((ball) => ball.owner === 1)
                        ? "Ball incoming"
                        : s.balls.length
                          ? "Your throw is in flight"
                          : nextBot === Infinity
                            ? corePart === "lane"
                              ? "Lane test: no ball"
                              : "Waiting"
                            : `Throws in ${Math.max(0, nextBot - s.time).toFixed(1)} s`,
          windup:
            !ws && active && botWindup(s.time) < 0.6 && s.hp.every((h) => h > 0),
          canThrow:
            active &&
            handsReady &&
            s.hp.every((h) => h > 0) &&
            canRelease(s, me) &&
            (!ws || networkReady.current),
          hits: s.hits,
          misses: s.misses,
          message: s.message,
          bodySeen,
          bodyComplete: bodySeen && missing.length === 0,
          bodyTracked: config.control === "camera" && valid,
          handTracked: config.control === "camera" && fingersSeen,
          rightWristTracked:
            config.control === "camera" && valid && visibleHands[1],
          calibrated,
          calibrating,
          calibrationProgress,
          landmarks: bodySeen ? observed!.lm : [],
          videoAspect:
            observed?.imageAspect && observed.imageAspect > 0
              ? 1 / observed.imageAspect
              : 16 / 9,
        });
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      releaseResources();
      scene.dispose();
    };
  }, []);

  const meter = (
    name: string,
    value: number,
    min: number,
    max: number,
    step: number,
    key: keyof typeof PREVIEW,
    unit = "",
  ) => (
    <label className="pov-slider">
      <span>
        {name}
        <output>
          {value.toFixed(step < 1 ? 2 : 0)}
          {unit}
        </output>
      </span>
      <input
        aria-label={name}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) =>
          setPreview((p) => ({ ...p, [key]: Number(e.target.value) }))
        }
      />
    </label>
  );
  return (
    <main
      className={`pov ${
        control === "camera" && cameraStatus !== "off" && !menuOpen
          ? "is-immersive"
          : ""
      }`}
    >
      <div className="pov-heading">
        <button className="pov-back" onClick={onBack}>
          ← Studio
        </button>
        <div>
          <span className="pov-eyebrow">MOTION SERIES / 01</span>
          <h1>Read the flight.</h1>
        </div>
        <span className="pov-build">POV PLAYTEST</span>
      </div>
      <div className="pov-layout">
        <section
          className="pov-stage"
          data-tone={
            hud.banner?.tone ?? (hud.countdown !== null ? "ready" : "")
          }
          aria-label="First-person ball duel"
        >
          <canvas
            ref={canvas}
            aria-label="Your first-person view of the court"
            style={
              tapMode ? { touchAction: "none" } : opponentView && mirror ? { transform: "scaleX(-1)" } : undefined
            }
            onPointerDown={(e) => {
              if (!tapMode || playMode) return;
              tapDown.current = { at: performance.now() };
            }}
            onPointerUp={(e) => {
              if (!tapMode || playMode || !tapDown.current) return;
              const holdMs = performance.now() - tapDown.current.at;
              tapDown.current = null;
              const sc = sceneRef.current,
                tp = tapPose.current,
                el = canvas.current;
              if (!sc || !tp || !el) return;
              // The picture is drawn mirrored: undo it to find the point in the scene.
              const r = el.getBoundingClientRect();
              const x = e.clientX;
              const foe = (1 - tp.me) as 0 | 1;
              const onFoe = sc.pointAt(x, e.clientY, foe, tp.foe.root);
              if (!onFoe) return;
              // From the opponent's frame to the thrower's own.
              tapPending.current = { aim: localPoint(worldPoint(onFoe, foe), tp.me), holdMs };
            }}
          />
          {(corePart === "flick" || (playMode && myTurn.current)) && (
            <FlickPad
              canThrow={playMode ? myTurn.current : hud.canThrow || control === "preview"}
              onFlick={(f) => {
                const root = duel.current.poses[local.current].root;
                flickPending.current = { origin: { ...FLICK_ORIGIN, x: root.x + FLICK_ORIGIN.x }, velocity: flickVelocity(f), spin: { x: 0, y: 0, z: 0 } };
                sessionLog.current.note(performance.now(), { flick: f.shot, power: Math.round(f.power * 100), aim: Math.round(f.aim) });
              }}
            />
          )}
          {chaseMode && (
            <div style={{ position: "absolute", left: 12, bottom: 12, zIndex: 3, color: "#fff", fontSize: 13, background: "rgba(0,0,0,0.45)", padding: "6px 10px", borderRadius: 8, pointerEvents: "none", maxWidth: 360 }}>
              {corePart === "lane" && <>Lane test · walk to each wall, dodge, duck, lean · keys A / B switch the movement (blind)</>}
              {corePart === "cam" && (
                <>
                  Camera test · keys 1–4 · now {rig.current.key()} {KEY_NAMES[rig.current.key()]}
                  <br />
                  {([1, 2, 3, 4] as DodgeKey[]).map((k) => `${k} ${KEY_NAMES[k]}: ${camStats.current[k].balls} balls, ${camStats.current[k].hits} hits`).join(" · ")}
                </>
              )}
              {corePart === "flick" && <>Flick test · press Start round, then flick</>}
              {tapMode && <>Keys 1–4 change the camera</>}
            </div>
          )}
          {keyNote.current && performance.now() - keyNote.current.at < 1500 && (
            <div style={{ position: "absolute", left: 0, right: 0, top: "38%", textAlign: "center", zIndex: 3, fontSize: 44, fontWeight: 700, color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,0.7)", pointerEvents: "none" }}>
              {keyNote.current.text}
            </div>
          )}
          {control === "camera" && cameraStatus !== "off" && (
            <button
              className="pov-menu-toggle"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? "Full window" : "Menu"}
            </button>
          )}
          {control === "camera" && cameraStatus !== "off" && !menuOpen && (
            <button
              className="pov-menu-toggle pov-fullscreen"
              onClick={toggleFullscreen}
            >
              Full screen
            </button>
          )}
          {opponentView && (
            <button
              className="pov-menu-toggle pov-mirror"
              aria-pressed={mirror}
              onClick={() => setMirror(!mirror)}
            >
              {mirror ? "Mirror: on" : "Mirror: off"}
            </button>
          )}
          {/* Where to stand: an outline to fill, over the camera's picture. */}
          {control === "camera" && cameraStatus === "live" && !hud.calibrated && (
            <svg
              className="pov-silhouette"
              data-ok={hud.calibrating ? "true" : "false"}
              viewBox="0 0 160 90"
              preserveAspectRatio="xMidYMid slice"
              aria-hidden="true"
            >
              <ellipse cx="80" cy="24" rx="6.5" ry="8" />
              <path d="M62 44 Q62 36 72 35 L88 35 Q98 36 98 44 L96 74 L64 74 Z" />
              <path d="M62 44 L57 68 M98 44 L103 68" />
            </svg>
          )}
          {/* During setup the player sees themselves, mirrored, behind the words. */}
          <video
            ref={stageVideo}
            className={`pov-setup-view ${
              control === "camera" && cameraStatus === "live" && !hud.calibrated
                ? "is-on"
                : ""
            }`}
            muted
            playsInline
            autoPlay
            aria-hidden="true"
          />
          <div className="pov-impact" ref={impactFlash} aria-hidden="true" />
          {opponentView && (
            <span className="pov-view-label">
              OPPONENT VIEW ·{" "}
              {control === "preview" ? "SIMULATED AVATAR" : "YOUR AVATAR"}
            </span>
          )}
          <div className="pov-score">
            <div>
              <span>YOU</span>
              <strong>
                {hud.hp[0]}
                <small> / 5</small>
              </strong>
              <Pips left={hud.hp[0]} />
            </div>
            <span className="pov-court">
              COURT 01
              <br />
              <b>{joined ? "PRIVATE DUEL" : "TRAINING"}</b>
            </span>
            <div className="pov-rival">
              <span>OPPONENT</span>
              <strong>
                {hud.hp[1]}
                <small> / 5</small>
              </strong>
              <Pips left={hud.hp[1]} />
              <p className="pov-opponent-status">{hud.opponentStatus}</p>
            </div>
          </div>
          {hud.feedback && (
            <div
              key={hud.feedbackId}
              className={`pov-feedback ${hud.feedbackHit ? "is-hit" : ""}`}
              role="status"
            >
              {hud.feedback}
            </div>
          )}
          {hud.banner && hud.countdown === null && (
            <div
              className="pov-banner"
              data-tone={hud.banner.tone}
              role="status"
            >
              <strong>{hud.banner.text}</strong>
              {hud.banner.sub && <span>{hud.banner.sub}</span>}
            </div>
          )}
          {hud.countdown !== null && (
            <span className="pov-countdown" role="status">
              {hud.countdown}
            </span>
          )}
          {hud.windup && !hud.banner && (
            <span className="pov-windup" role="status">
              OPPONENT PREPARING A THROW
            </span>
          )}
          <div className="pov-stage-bottom">
            <span className="pov-live">
              {control === "camera"
                ? hud.bodyTracked
                  ? "BODY TRACKING"
                  : "CAMERA SETUP"
                : "SIMULATED INPUT"}
            </span>
            <p role="status">{error || hud.gate}</p>
            <div className="pov-stage-actions">
              <button
                className="pov-secondary"
                onClick={primaryAction}
                disabled={primaryDisabled}
              >
                {primaryLabel}
              </button>
              {control === "preview" && (
                <button
                  className="pov-secondary"
                  disabled={!hud.canThrow}
                  onClick={previewThrow}
                >
                  Throw ↗
                </button>
              )}
            </div>
            <div className="pov-space">
              <span>← Left limit</span>
              <i />
              <span>Right limit →</span>
            </div>
          </div>
        </section>
        <aside className="pov-panel">
          <span className="pov-eyebrow">YOUR SIDE OF THE COURT</span>
          <h2>
            Small space.
            <br />
            Every movement.
          </h2>
          <p className="pov-muted">
            Dodge, then throw back. The ball appears in your hand automatically
            after their shot finishes.
          </p>
          <button
            className="pov-secondary pov-view-toggle"
            aria-pressed={opponentView}
            onClick={() => {
              setOpponentView((shown) => !shown);
              canvas.current?.scrollIntoView({
                block: "center",
                behavior: "smooth",
              });
            }}
          >
            {opponentView ? "Back to my view" : "See myself from opponent view"}
          </button>
          {!joined && (
            <div className="pov-pace" aria-label="Training pace">
              {(Object.keys(TRAINING_PACE) as TrainingPace[]).map((choice) => (
                <button
                  key={choice}
                  aria-pressed={pace === choice}
                  onClick={() => setPace(choice)}
                >
                  <strong>{TRAINING_PACE[choice].label}</strong>
                  <span>
                    {choice === "duel"
                      ? "Quick throws · precise dodges"
                      : "More time to read the ball"}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="pov-tabs" aria-label="Input source">
            <button
              aria-pressed={control === "preview"}
              onClick={() => selectControl("preview")}
            >
              Explore flight
            </button>
            <button
              aria-pressed={control === "camera"}
              onClick={() => selectControl("camera")}
            >
              Use my camera
            </button>
          </div>
          {control === "preview" ? (
            <div className="pov-controls">
              <p className="pov-caption">
                Simulated controls · try the space and ball physics.
              </p>
              {meter("Side step", preview.x, -0.6, 0.6, 0.01, "x", " m")}
              {meter(
                "Forward / back",
                preview.depth,
                -0.25,
                0.25,
                0.01,
                "depth",
                " m",
              )}
              {meter("Crouch", preview.duck, 0, 0.6, 0.01, "duck", " m")}
              <details open className="pov-flight">
                <summary>Your throw</summary>
                {meter(
                  "Direction",
                  preview.azimuth,
                  -20,
                  20,
                  1,
                  "azimuth",
                  "°",
                )}
                {meter(
                  "Elevation",
                  preview.elevation,
                  -5,
                  40,
                  1,
                  "elevation",
                  "°",
                )}
                {meter("Speed", preview.speed, 2, 18, 1, "speed", " m/s")}
                {meter("Sidespin", preview.spin, -60, 60, 1, "spin", " rad/s")}
              </details>
              <button
                className="pov-primary"
                disabled={!hud.canThrow}
                onClick={previewThrow}
              >
                Release ball <span>↗</span>
              </button>
            </div>
          ) : (
            <div className="pov-camera">
              <label className="pov-slider">
                <span>
                  Dodge sensitivity{" "}
                  <output>{dodgeSensitivity.toFixed(1)}×</output>
                </span>
                <input
                  aria-label="Dodge sensitivity"
                  aria-describedby="pov-dodge-help"
                  type="range"
                  min={DODGE_SENSITIVITY.min}
                  max={DODGE_SENSITIVITY.max}
                  step={0.1}
                  value={dodgeSensitivity}
                  disabled={sensitivityLocked}
                  onChange={(e) => {
                    if (
                      !settings.current.running ||
                      duel.current.hp.some((hp) => hp <= 0)
                    )
                      // The player's own choice: no automatic fitting after this.
                      sensitivityChosen.current = true;
                    setDodgeSensitivity(Number(e.target.value));
                  }}
                />
              </label>
              <p className="pov-caption" id="pov-dodge-help">
                Small movements cover more of the court. Ducks and jumps get a
                gentler boost.{" "}
                {sensitivityLocked
                  ? "Pause to adjust."
                  : "Raise this if you need to move too far."}
              </p>
              <div
                className={`pov-camera-view${hud.cameraEdge ? " is-near-edge" : ""}`}
                style={{
                  position: "relative",
                  aspectRatio: hud.videoAspect,
                  background: "#0c1a20",
                }}
              >
                <video
                  ref={video}
                  muted
                  playsInline
                  autoPlay
                  aria-label="Mirrored camera preview"
                  style={{ width: "100%", height: "100%", objectFit: "fill" }}
                />
                <svg
                  aria-label="Detected body landmarks"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    transform: "scaleX(-1)",
                    pointerEvents: "none",
                  }}
                >
                  {[
                    [LM.L_SHOULDER, LM.R_SHOULDER],
                    [LM.L_SHOULDER, LM.L_HIP],
                    [LM.R_SHOULDER, LM.R_HIP],
                    [LM.L_HIP, LM.R_HIP],
                    [LM.L_SHOULDER, LM.L_ELBOW],
                    [LM.L_ELBOW, LM.L_WRIST],
                    [LM.R_SHOULDER, LM.R_ELBOW],
                    [LM.R_ELBOW, LM.R_WRIST],
                  ].map(([a, b]) => {
                    const p = hud.landmarks[a],
                      q = hud.landmarks[b];
                    return p?.v >= 0.6 && q?.v >= 0.6 ? (
                      <line
                        key={`${a}-${b}`}
                        x1={p.x * 100}
                        y1={p.y * 100}
                        x2={q.x * 100}
                        y2={q.y * 100}
                        stroke="#b6edda"
                        strokeWidth=".5"
                      />
                    ) : null;
                  })}
                  {hud.landmarks.map((p, i) =>
                    p.v >= 0.6 &&
                    Number.isFinite(p.x) &&
                    Number.isFinite(p.y) ? (
                      <circle
                        key={i}
                        cx={p.x * 100}
                        cy={p.y * 100}
                        r=".7"
                        fill="#b6edda"
                      />
                    ) : null,
                  )}
                </svg>
              </div>
              <p className="pov-caption" role="status">
                Body:{" "}
                {hud.bodyTracked
                  ? hud.trackingHeld
                    ? "brief hold"
                    : "tracking"
                  : hud.bodySeen
                    ? hud.bodyComplete
                      ? "in view"
                      : "partial view"
                    : "not detected"}
                {" · "}Setup:{" "}
                {hud.calibrated
                  ? "ready"
                  : hud.calibrating
                    ? `${Math.round(hud.calibrationProgress * 100)}%`
                    : cameraStatus === "live"
                      ? "finding you…"
                      : "waiting for camera"}
                {" · "}Right wrist:{" "}
                {hud.rightWristTracked ? "tracking" : "out of view"}
                {" · "}Fingers: {hud.handTracked ? "tracking" : "finding…"}
              </p>
              <p className="pov-caption">
                Keep your camera fixed. Leave room in the camera view above your
                head and below your hips, then stand upright and hold still
                briefly. Setup is automatic. Keep clear space around you.
              </p>
              {cameraStatus === "live" && !hud.calibrated && (
                <div>
                  <progress
                    aria-label="Automatic setup progress"
                    max={1}
                    value={hud.calibrationProgress}
                    style={{ width: "100%", accentColor: "#b6edda" }}
                  />
                  <p className="pov-caption" role="status">
                    {hud.gate}
                  </p>
                </div>
              )}
              {cameraStatus === "live" && hud.calibrated && (
                <button className="pov-secondary" onClick={recenter}>
                  Recenter
                </button>
              )}
              {cameraStatus === "live" && (
                <button className="pov-text" onClick={enableCamera}>
                  Restart camera
                </button>
              )}
              <p className="pov-caption" role="status">
                {hud.bodyTracked
                  ? "Your viewpoint follows your body, even while the round is paused."
                  : hud.calibrated
                    ? "Center saved. Keep your head, shoulders and hips visible to resume movement."
                    : cameraMessage}
              </p>
              {handMessage && (
                <p className="pov-warning">
                  {handMessage} You can still dodge and throw with body
                  tracking.
                </p>
              )}
              {hud.handError && (
                <p className="pov-warning">
                  {hud.handError}. Dodging and wrist-based throws remain
                  available.
                </p>
              )}
              <p className="pov-caption">
                Your turn: the ball is placed in your right hand. Raise that
                hand and a ring appears on your opponent's side: it shows where
                the ball will go and follows your hand. Hold it where you want,
                then throw like a real throw. A faster hand gets the ball there
                sooner. No pinch or screen tap.
              </p>
            </div>
          )}
          {/* Keep the capture target mounted when preview controls are selected. */}
          {control === "preview" && (
            <video
              ref={video}
              muted
              playsInline
              autoPlay
              className="pov-capture-idle"
              aria-hidden="true"
              tabIndex={-1}
            />
          )}
          <div className="pov-actions">
            <button
              className="pov-secondary"
              onClick={primaryAction}
              disabled={primaryDisabled}
            >
              {primaryLabel}
            </button>
            {!joined && (
              <button
                className="pov-text"
                onClick={() => {
                  duel.current = newRally();
                  release.current.reset();
                  setRunning(false);
                }}
              >
                Reset round
              </button>
            )}
          </div>
          <details className="pov-room">
            <summary>Play with a friend</summary>
            <p className="pov-caption">
              Local two-player test. Both players enter the same six-character
              room.
            </p>
            <div className="pov-room-row">
              <input
                aria-label="Room code"
                maxLength={6}
                value={room}
                placeholder="COURT1"
                onChange={(e) =>
                  setRoom(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                  )
                }
                disabled={joined}
              />
              <button
                className="pov-secondary"
                onClick={joined ? leaveRoom : connect}
              >
                {joined ? "Leave" : "Join"}
              </button>
            </div>
            <p className="pov-caption" role="status">
              {network}
            </p>
          </details>
        </aside>
      </div>
      <div className="pov-footer">
        <p>
          <b>Bounded movement</b> <span>·</span> <b>8 m</b> virtual court{" "}
          <span>·</span> continuous motion
        </p>
        <details>
          <summary>Playtest notes & measurements</summary>
          <div className="pov-diagnostics">
            <p>
              <button className="pov-secondary" onClick={saveSession}>
                Save the last minute of tracking
              </button>{" "}
              Saves where the camera saw your body and what the game did with it
              to a file in your downloads, so a problem can be played back. No
              picture or video is saved. Camera: {cameraInfo || "not started"}.
            </p>
            <p>
              Automatic setup maps your body proportions to the avatar and saves
              your neutral position. It does not measure your room or physical
              movement in metres.
            </p>
            <p>
              Dodge sensitivity: {dodgeSensitivity.toFixed(1)}× sideways,{" "}
              {(1 + (dodgeSensitivity - 1) * 0.5).toFixed(2)}× vertically.
              Forward/back movement and hand size keep their original scale.
              Position stays bounded; amplification cannot track you outside the
              image.
            </p>
            <p>
              Round {hud.time.toFixed(1)} s · Balls {hud.balls} · Contacts{" "}
              {hud.hits} · Misses {hud.misses}. {hud.message}
            </p>
            <p>
              Render {hud.fps.toFixed(0)} fps · Body {hud.bodyFps.toFixed(0)} Hz
              · Hands {hud.handFps.toFixed(0)} Hz · Body pipeline p95{" "}
              {hud.p95.toFixed(0)} ms · Hand pipeline p95{" "}
              {hud.handP95.toFixed(0)} ms · Body result age{" "}
              {hud.bodyAge.toFixed(0)} ms · Pose age when drawn{" "}
              {hud.poseAge.toFixed(0)} ms · Camera delay{" "}
              {hud.cameraDelay === null
                ? "not reported by this browser"
                : `${hud.cameraDelay.toFixed(0)} ms`}
              . Where the time goes: the model takes{" "}
              {hud.inferMs.toFixed(0)} ms a pose
              {hud.delegate ? ` on the ${hud.delegate}` : ""}
              {hud.execution === "worker"
                ? " in a worker"
                : hud.execution
                  ? " on the page's own thread"
                  : ""}
              ; the rest of the pipeline is handing the picture over and
              getting the result back. Picture quality step {hud.quality} of 2
              (0 is full). Camera picture brightness{" "}
              {hud.luma === null
                ? "not measured"
                : `${hud.luma.toFixed(0)} of 255${hud.luma < 45 ? " — dark" : ""}`}
              . The drawn body leads the measured pose across half of its age,
              up to 120 ms. These are software timings; sensor exposure and
              screen delay are not included.
            </p>
            <p>
              Throw: {THROW_STATE_TEXT[hud.throwState]} · hand speed{" "}
              {hud.throwSpeed.toFixed(1)} · last throw{" "}
              {hud.lastThrowSpeed ? hud.lastThrowSpeed.toFixed(1) : "none yet"}.
              A throw is a raised right hand driven forward, down or across; the
              ball leaves as the hand slows. It is sent to the ring, which is
              placed by where the right hand is held relative to the shoulder
              (sideways and up/down only) and fixed from just before the drive.
              Hand speed sets how soon the ball arrives (18 m/s cap). The
              direction of the throwing motion is not used: one camera cannot
              measure it well enough to aim with. Spin is not inferred in this
              mode. Opponent view uses the same state and a prototype avatar;
              limb connections are approximations, not a full-body motion
              capture.
            </p>
            <p>
              120 Hz physics: gravity, air drag and spin lift. Ball coefficients
              and court size are test settings. Finger geometry and depth are
              camera estimates; standing avatar uses a 1.65 m eye-height
              reference. Remote finger joints are not yet transmitted. No camera
              accuracy or real-phone performance result has been recorded.
            </p>
            <p>{hud.shoulderAngles}</p>
            <p>
              Tracking pauses {hud.trackingPauses} · Time paused for tracking{" "}
              {hud.pausedSeconds.toFixed(1)} s. Short holds are limited to 250
              ms; longer losses pause the rally.
            </p>
            <label>
              Body model candidate{" "}
              <select
                value={modelPinned ? model : "auto"}
                disabled={cameraStatus !== "off"}
                onChange={(e) => {
                  const picked = e.target.value;
                  if (isModelTier(picked)) {
                    setModel(picked);
                    setModelPinned(true);
                    rememberModel(picked, true);
                  } else {
                    setModelPinned(false);
                    rememberModel(model, false);
                  }
                }}
              >
                <option value="auto">
                  Automatic · the largest that keeps up (now {model})
                </option>
                <option value="lite">MediaPipe Lite · responsive</option>
                <option value="full">MediaPipe Full · more accurate</option>
                <option value="heavy">MediaPipe Heavy</option>
              </select>
            </label>
          </div>
        </details>
      </div>
    </main>
  );
}
