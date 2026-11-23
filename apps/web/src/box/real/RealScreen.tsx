import { useEffect, useRef, useState } from "react";
import { cameraSession } from "../../camera/session";
import { inputStore } from "../../input/store";
import { meanLuma } from "../../pov/lightMeter";
import { QUALITY, createQualityLadder, type RenderQuality } from "../../pov/quality";
import { createBoxAudio } from "../boxAudio";
import { createCapture, type Capture, type CaptureSample, type CaptureStatus } from "../capture";
import { createCoach } from "../coach";
import type { FightEvent } from "../fight";
import type { Punch } from "../punch";
import { addSession, dayOf, daysThisWeek, loadRecord, saveRecord, type BoxRecord, type SessionEntry } from "../record";
import { fitTimes, loadMotionPose } from "../motion/realPose";
import { createDelayMeter, type DeviceDelay } from "../read/delay";
import type { RecordedSession } from "../../pov/sessionLog";
import { AT_REST, boxDemoMotion } from "../scriptedBoxer";
import { createRealGame, type Corner, type RealInput, type RealKeys, type RealView, type Result } from "./game";
import { LADDER, type BoxerName } from "./mind";
import type { BoutEvent, Stakes } from "./rules";
import { createRealStage } from "./stage";
import "../box.css";
import "./real.css";

/**
 * The real exchange on screen. In a round there is nothing to read: no word,
 * no bar, only the ring, the opponent and the clock on its board. Words live
 * before the bell, in the corner between rounds, and on the card afterwards.
 */
const BOXER_KEY = "real.boxer",
  STANCE_KEY = "box.stance",
  VOICE_KEY = "box.voice",
  BARS_KEY = "real.bars",
  RANGE_KEY = "real.range",
  GYM_KEY = "real.gymDone",
  QUIET_KEY = "real.quiet",
  LENGTH_KEY = "real.length",
  DEVICE_KEY = "real.device",
  /** The rounds of a bout not yet finished, kept at every bell: a closed page loses nothing. */
  PROGRESS_KEY = "real.progress",
  /** Where this player's straight punches at the head end, as learned at the pad: the zones are measured from there. */
  MARKS_KEY = "real.marks";
/** How long the start waits for the reach (both fists straight out at the screen) before going on without it. */
/** How near the camera the player may come, metres from it: the ropes, then the referee. Nearer than this the camera loses the body. */
const NEAR = { ropes: 1.05, stop: 0.9 };
/** The scripted person with the reach in it (`&mocap=demo&reach`): arms down for set-up, both fists straight out, then the usual routine. */
const reachThenBox = (s: number) =>
  s < 2.2 ? AT_REST : s < 3.6 ? { leftHand: { x: 0, y: 0, z: 0.6 }, rightHand: { x: 0, y: 0, z: 0.6 } } : boxDemoMotion(s - 1.4);
const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice lasts for this visit only.
  }
};
export const BOXER_NAME: Record<BoxerName, [string, string]> = {
  beginner: ["Three weeks in", "Big right hands, one at a time. Keep your hands up and jab"],
  swinger: ["The swinger", "Rushes in with wide hooks. Step back, then go straight"],
  jabber: ["The jabber", "Jab, jab, one-two, and out. Catch it and answer"],
  pressure: ["The pressure fighter", "Walks you down, body then head. Jab and move"],
  counter: ["The counter-puncher", "Waits for your mistake. Feint, work the body"],
};
const STAKES_NAME: Record<Stakes, [string, string]> = {
  touch: ["Touch sparring", "Touches are counted. Nobody is hurt"],
  open: ["Open sparring", "It hurts, but nobody goes down"],
  bout: ["A bout", "Three rounds, the card, knockdowns"],
};
/** How long a session is: rounds, and seconds a round. */
type Length = "single" | "short" | "standard" | "long";
const LENGTH: Record<Length, [number, number, string, string]> = {
  single: [1, 120, "One round", "2 minutes"],
  short: [2, 90, "Short", "2 rounds of 90 seconds"],
  standard: [3, 120, "Standard", "3 rounds of 2 minutes"],
  long: [3, 180, "Long", "3 rounds of 3 minutes"],
};
/** Shoulders go first: nobody holds a guard for two minutes on their first day. */
const lengthFor = (record: BoxRecord): Length => (record.sessions.filter((s) => s.mode === "real").length < 2 ? "short" : "standard");
/** Where the screen is: what to do about it differs. */
type Device = "laptop" | "tv" | "phone";
const DEVICE: Record<Device, [string, string]> = {
  laptop: ["Laptop", "On a table, lid tilted to see you from head to hips. Stand two big steps from the table's edge."],
  tv: ["TV", "Laptop under the TV, joined by cable, TV in Game mode. Stand two big steps back."],
  phone: ["Phone", "At chest height, on its side. Stand one and a half steps back: you box in close."],
};
/** The first sessions are for learning: touches, then open sparring, then bouts. Back after two weeks away: one step down for the day. */
const stakesFor = (record: BoxRecord, at = Date.now()): Stakes => {
  const real = record.sessions.filter((s) => s.mode === "real");
  const step = real.length < 2 ? 0 : real.length < 4 ? 1 : 2;
  const last = real.at(-1);
  const rusty = last && at - last.at >= 14 * 86400000 ? 1 : 0;
  return (["touch", "open", "bout"] as const)[Math.max(0, step - rusty)];
};
/** Three bouts lost in a row to the same boxer: the gym minute comes before the next one. */
const stuckOn = (record: BoxRecord, boxer: string): boolean => {
  const bouts = record.sessions.filter((s) => s.mode === "real" && s.result !== "done").slice(-3);
  return bouts.length === 3 && bouts.every((s) => s.level === boxer && s.result === "loss");
};
const PROBLEM: Record<NonNullable<CaptureStatus["problem"]>, [string, string]> = {
  denied: ["CAMERA BLOCKED", "Allow the camera for this page: click the camera icon by the address bar"],
  "in-use": ["CAMERA BUSY", "Close other apps or tabs using the camera, then try again"],
  "not-found": ["NO CAMERA", "No camera was found on this device"],
  "insecure-context": ["CAMERA BLOCKED", "Open this page over https or on localhost"],
  unsupported: ["NO CAMERA", "This browser cannot use the camera"],
  model: ["TRACKING DID NOT LOAD", "Check the connection, then try again"],
  unknown: ["CAMERA ERROR", "Try again"],
};
const PUNCH_KEYS: Record<string, Pick<Punch, "hand" | "shape">> = {
  KeyF: { hand: "left", shape: "straight" },
  KeyJ: { hand: "right", shape: "straight" },
  KeyD: { hand: "left", shape: "hook" },
  KeyK: { hand: "right", shape: "hook" },
  KeyS: { hand: "left", shape: "uppercut" },
  KeyL: { hand: "right", shape: "uppercut" },
};
interface Banner {
  text: string;
  sub?: string;
  tone: "good" | "bad" | "warn" | "plain" | "setup";
  key: string;
}
interface Hud {
  phase: RealView["phase"];
  /** The gym minute's task: how many times done of how many. */
  dots: { done: number; need: number } | null;
  banner: Banner | null;
  count: number | null;
  countKind: RealView["countKind"];
  setup: boolean;
  hold: number;
  corner: Corner | null;
  result: Result | null;
  /** The player's and the opponent's health and breath, 0 to 1, for the optional bars. */
  bars: [number, number, number, number];
  /** 0 fresh to 1 spent, and hurt right now: what the player's own vision shows. */
  worn: number;
  hurt: boolean;
  notes: string;
  next: string;
  /** The player's spot, and how far past it they are (0 to 1). */
  spot: RealView["spot"];
  crowd: number;
  /** The corner is showing a punch again. */
  replay: boolean;
  stanceDoubt: boolean;
  /** The test room's read-out: what the camera gives and where the body is, in plain numbers. */
  room: string[];
}
const HUD: Hud = { room: [], spot: "home", crowd: 0, replay: false, stanceDoubt: false, phase: "setup", dots: null, banner: null, count: null, countKind: null, setup: false, hold: 0, corner: null, result: null, bars: [1, 1, 1, 1], worn: 0, hurt: false, notes: "", next: "" };

/** What the rules said, as the sounds made for the first build understand it. */
function heard(e: BoutEvent): FightEvent | null {
  const base = { id: e.id, at: e.at };
  if (e.kind === "mine") {
    if (e.outcome === "clean" || e.outcome === "partly")
      return { ...base, kind: "landed", hand: e.hand, shape: e.shape, target: e.level, damage: e.damage * 3.2, power: e.outcome === "clean" ? 1.05 : 0.9, counter: e.counter && e.outcome === "clean", combo: 0 };
    if (e.outcome === "gloves") return { ...base, kind: "blocked", hand: e.hand, shape: e.shape, target: e.level };
    return null;
  }
  if (e.kind === "its") {
    const attack = e.level === "body" ? "body" : e.shape === "hook" || e.shape === "uppercut" ? "hook" : e.code === "j" ? "jab" : "cross";
    if (e.outcome === "clean" || e.outcome === "partly")
      return { ...base, kind: "hit-me", attack, hand: e.hand, damage: e.damage * (e.outcome === "clean" ? 4 : 2), early: false, open: false, caught: false };
    if (e.outcome === "gloves" || e.outcome === "unseen") return { ...base, kind: "blocked-me", attack, damage: 0, hands: 2, how: e.level === "body" ? "low" : "cover", placed: false };
    if (e.outcome === "miss") return { ...base, kind: "dodged", how: e.how ?? "slip", attack, late: false };
    return null;
  }
  if (e.kind === "down") return e.who === "foe" ? { ...base, kind: "foe-down", downs: e.downs } : { ...base, kind: "me-down", downs: e.downs };
  if (e.kind === "up") return { ...base, kind: e.who === "foe" ? "foe-up" : "me-up" };
  if (e.kind === "over") return { ...base, kind: "over", winner: e.winner === "me" ? 0 : e.winner === "foe" ? 1 : null, how: e.how === "stoppage" ? "ko" : e.how };
  return null;
}

export function RealScreen({ onBack }: { onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null),
    mirror = useRef<HTMLVideoElement>(null),
    flash = useRef<HTMLDivElement>(null);
  const query = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
  const scripted = query.get("mocap") === "demo";
  // The test room (`&room`): the opponent only stands there, in reach, and the screen says in numbers what the camera gives and where the body is.
  const room = query.has("room");
  // A saved recording of a real person played back in place of the camera (`&replay`, from `&from=` seconds in): kept at /_replay/session.json, never committed.
  const replay = query.has("replay");
  const recorded = useRef<RecordedSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({ state: "off", message: "", problem: null });
  const [mode, setMode] = useState<"camera" | "keys">(query.has("keys") ? "keys" : "camera");
  const [menu, setMenu] = useState(false);
  const [hud, setHud] = useState<Hud>(HUD);
  const [record, setRecord] = useState<BoxRecord>(() => loadRecord());
  const recordNow = useRef(record);
  recordNow.current = record;
  const wanted = (query.get("boxer") ?? stored(BOXER_KEY)) as BoxerName | null;
  const [boxer, setBoxerState] = useState<BoxerName>(wanted && LADDER.includes(wanted) ? wanted : "beginner");
  const asked = query.get("stakes") as Stakes | null;
  const [stakes, setStakesState] = useState<Stakes>(asked && asked in STAKES_NAME ? asked : stakesFor(record));
  const [stance, setStanceState] = useState<"left" | "right">(stored(STANCE_KEY) === "right" ? "right" : "left");
  const [voice, setVoiceState] = useState(stored(VOICE_KEY) !== "0");
  const [bars, setBarsState] = useState(stored(BARS_KEY) === "1");
  const kept = stored(DEVICE_KEY) as Device | null;
  const [device, setDeviceState] = useState<Device>(
    kept && kept in DEVICE ? kept : typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "phone" : "laptop",
  );
  // A phone's small picture at two metres cannot show a real-speed punch: on a phone the game is boxed in close unless asked otherwise.
  const [range, setRangeState] = useState(stored(RANGE_KEY) === null ? device !== "phone" : stored(RANGE_KEY) !== "0");
  const [quiet, setQuietState] = useState(stored(QUIET_KEY) === "1");
  const wantedLength = stored(LENGTH_KEY) as Length | null;
  const [length, setLengthState] = useState<Length>(wantedLength && wantedLength in LENGTH ? wantedLength : lengthFor(record));
  const [fatal, setFatal] = useState("");
  const [waiting, setWaiting] = useState(false);
  const capture = useRef<Capture | null>(null);
  const audio = useRef<ReturnType<typeof createBoxAudio> | null>(null);
  const coach = useRef<ReturnType<typeof createCoach> | null>(null);
  // The opponent's body is recorded motion; until the clips have arrived (or if they never do) it is the formula body.
  const motion = useRef(query.has("standin") ? null : loadMotionPose());
  const game = useRef(
    createRealGame({
      ...(motion.current ? { pose: motion.current.pose, times: fitTimes } : {}),
      boxer,
      stakes: room ? "touch" : stakes,
      range: room ? false : range,
      lead: stance,
      rounds: room ? 1 : Number(query.get("rounds")) || LENGTH[length][0],
      clock: room ? 3600 : Number(query.get("clock")) || LENGTH[length][1],
      seed: Number(query.get("seed")) || undefined,
      still: room,
      // A first visit begins with the gym minute.
      gym: !room && stored(GYM_KEY) !== "1" && !query.has("nogym"),
    }),
  );
  const live = useRef({ mode, status, menu });
  live.current = { mode, status, menu };
  const keys = useRef({ punches: [] as Punch[], held: new Set<string>(), start: false });

  const setBoxer = (next: BoxerName) => {
    store(BOXER_KEY, next);
    game.current.queueBoxer(next);
    setBoxerState(next);
  };
  const setStakes = (next: Stakes) => {
    game.current.setStakes(next);
    setStakesState(next);
  };
  const setStance = (next: "left" | "right") => {
    store(STANCE_KEY, next);
    game.current.setLead(next);
    setStanceState(next);
  };
  const setVoice = (on: boolean) => {
    store(VOICE_KEY, on ? "1" : "0");
    coach.current?.setEnabled(on);
    audio.current?.setVoice(on);
    setVoiceState(on);
  };
  const setBars = (on: boolean) => {
    store(BARS_KEY, on ? "1" : "0");
    setBarsState(on);
  };
  const setRange = (on: boolean) => {
    store(RANGE_KEY, on ? "1" : "0");
    game.current.setRange(on);
    setRangeState(on);
  };
  const setQuiet = (on: boolean) => {
    store(QUIET_KEY, on ? "1" : "0");
    game.current.setQuietCorner(on);
    setQuietState(on);
  };
  const setLength = (next: Length) => {
    store(LENGTH_KEY, next);
    game.current.setFormat(LENGTH[next][0], LENGTH[next][1]);
    setLengthState(next);
  };
  const setDevice = (next: Device) => {
    store(DEVICE_KEY, next);
    setDeviceState(next);
    if (stored(RANGE_KEY) === null) {
      game.current.setRange(next !== "phone");
      setRangeState(next !== "phone");
    }
  };
  const enableCamera = () => {
    audio.current?.resume();
    if (!video.current) return;
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !document.fullscreenElement)
      void document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
    if (replay && !recorded.current) {
      // Fetch the recording first, then come back here.
      void fetch("/_replay/session.json")
        .then((r) => r.json())
        .then((session: RecordedSession) => {
          recorded.current = session;
          enableCamera();
        })
        .catch(() => setStatus({ state: "off", message: "No recording at /_replay/session.json", problem: "unknown" }));
      return;
    }
    let marks = null;
    try {
      marks = JSON.parse(stored(MARKS_KEY) ?? "null");
    } catch {
      // Learned again at the pad.
    }
    capture.current ??= createCapture(video.current, {
      scripted: scripted ? { motion: query.has("reach") ? reachThenBox : boxDemoMotion, fps: Number(query.get("fps")) || undefined, delayMs: Number(query.get("delay")) || undefined } : null,
      marks: marks && typeof marks.head === "number" && Array.isArray(marks.middle) ? marks : null,
      recorded: recorded.current ? { session: recorded.current, fromS: Number(query.get("from")) || 0 } : null,
      onStatus: setStatus,
    });
    void capture.current.start();
  };
  const begin = () => {
    enableCamera();
    audio.current?.flow("bell");
    // Each safety line is said at its own moment in the gym minute; here only where to stand.
    coach.current?.say("Stand where the camera sees you. Hands up.", true);
  };
  /** The last four minutes of what the camera reported, as a file: the real movement, to be played back through the game. */
  const saveCamera = () => {
    try {
      const data = capture.current?.recording() ?? null;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `spar-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      // Nothing to save.
    }
  };
  const cancelCamera = () => {
    capture.current?.stop();
    setStatus({ state: "off", message: "", problem: null });
  };
  useEffect(() => {
    if (status.state !== "live") return;
    const stream = capture.current?.stream();
    if (mirror.current && stream && mirror.current.srcObject !== stream) {
      mirror.current.srcObject = stream;
      void mirror.current.play?.()?.catch?.(() => {});
    }
  }, [status.state]);
  useEffect(() => {
    setWaiting(false);
    if (status.state !== "starting") return;
    const timer = setTimeout(() => setWaiting(true), 8000);
    return () => clearTimeout(timer);
  }, [status.state]);

  useEffect(() => {
    cameraSession.stop();
    inputStore.resetToKeyboard();
    let stage: ReturnType<typeof createRealStage>;
    try {
      stage = createRealStage(canvas.current!);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
      return;
    }
    const a = (audio.current = createBoxAudio());
    const c = (coach.current = createCoach());
    c.setEnabled(stored(VOICE_KEY) !== "0");
    a.setVoice(stored(VOICE_KEY) !== "0");
    game.current.setQuietCorner(stored(QUIET_KEY) === "1");
    // Rounds boxed in a bout that was never finished (the page was closed): they are kept as a session, and nobody lost.
    try {
      const left = stored(PROGRESS_KEY);
      if (left) {
        localStorage.removeItem(PROGRESS_KEY);
        const entry = JSON.parse(left) as SessionEntry;
        if (entry && entry.mode === "real" && entry.rounds > 0) {
          const kept = addSession(recordNow.current, entry);
          recordNow.current = kept;
          saveRecord(kept);
          setRecord(kept);
        }
      }
    } catch {
      // Nothing to bring back.
    }
    /** A bout, or as much of one as was boxed, as the record keeps it. */
    const entryOf = (view: RealView, rounds: Result["rounds"], total: [number, number], result: SessionEntry["result"]): SessionEntry => {
      const mine = rounds.reduce((sum, t) => [sum[0] + t.thrown[0], sum[1] + t.clean[0] + t.partly[0], sum[2] + t.gloves[1] + t.missed[1], sum[3] + t.thrown[1]], [0, 0, 0, 0]);
      return {
        day: dayOf(new Date()),
        at: Date.now(),
        mode: "real",
        level: view.boxer,
        result,
        grade: "",
        rounds: rounds.length,
        seconds: Math.round(view.bout.time),
        thrown: mine[0],
        landed: mine[1],
        defended: mine[2],
        incoming: mine[3],
        counters: 0,
        bestCombo: 0,
        score: total[0],
      };
    };
    const ladder = createQualityLadder();
    let quality: RenderQuality = 0;
    // This device's own delay, measured in every count-in: each beat flashes the screen, and the flash is looked for in the camera's picture.
    const meter = createDelayMeter();
    let delay: DeviceDelay | null = null,
      lastPose = -Infinity,
      beatShown: number | null = null,
      flashOff = 0,
      lookUntil = 0,
      wasCount = false,
      wirelessDue = false,
      wirelessSaid = false,
      readyAt = -Infinity,
      lastPhase = "",
      aimed = false;
    const small = document.createElement("canvas");
    small.width = 32;
    small.height = 18;
    const pen = small.getContext("2d", { willReadFrequently: true });
    const look = (now: number) => {
      const v = video.current;
      if (!pen || !v || !(v.readyState >= 2) || !v.videoWidth) return;
      try {
        pen.drawImage(v, 0, 0, 32, 18);
        meter.brightness(now, meanLuma(pen.getImageData(0, 0, 32, 18).data));
      } catch {
        // The picture cannot be read here: the delay is taken from the camera's own figures.
      }
    };
    let lastHit = "";
    let raf = 0,
      lastHud = 0,
      lastKey = "",
      lastFrame = performance.now(),
      fps = 60,
      lastLoad = 0,
      slowSince = -1,
      hiddenSince = -1,
      nextName = "";
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = keys.current;
      k.held.add(e.code);
      a.resume();
      const hit = PUNCH_KEYS[e.code];
      if (hit && live.current.mode === "keys") k.punches.push({ ...hit, target: e.shiftKey ? "body" : "head", power: 1, t: performance.now() });
      if (e.code === "Enter") k.start = true;
      if (e.code === "Escape" || e.code === "KeyM") setMenu((open) => !open);
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter"].includes(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => keys.current.held.delete(e.code);
    const tap = () => {
      a.resume();
      keys.current.start = true;
    };
    // A hidden page stops the round at once: nothing may land on someone who is not looking.
    const hidden = () => {
      hiddenSince = document.hidden ? performance.now() : -1;
      if (document.hidden) a.hall(false);
      else a.resume();
    };
    const el = canvas.current!;
    el.addEventListener("pointerdown", tap);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      fps = fps * 0.9 + Math.min(240, 1000 / Math.max(1, now - lastFrame)) * 0.1;
      lastFrame = now;
      const { mode: m, status: st, menu: menuOpen } = live.current;
      const startAsked = keys.current.start;
      const cap = capture.current;
      let sample: CaptureSample | null = null;
      let tooSlow = false;
      let input: RealInput;
      const away = menuOpen || hiddenSince >= 0;
      if (m === "keys") {
        const k = keys.current;
        const held = (code: string) => k.held.has(code);
        const pressed: RealKeys = {
          punches: k.punches,
          slip: held("ArrowLeft") ? -1 : held("ArrowRight") ? 1 : 0,
          duck: held("ArrowDown"),
          high: held("ArrowUp") || held("Space"),
          low: held("KeyB"),
          back: held("KeyX"),
          start: k.start,
        };
        k.punches = [];
        // N stands in for a step toward the screen, so the ropes and the referee can be tried without a camera.
        input = { tracking: null, pose: null, valid: true, calibrated: true, poseT: now, poseAge: 0, arms: null, keys: pressed, hold: away, near: held("KeyN") ? 1.4 : null };
      } else if (cap && cap.state() === "live") {
        sample = cap.sample(now);
        const rate = sample.poseFps;
        if (rate > 0 && rate < 18) {
          if (slowSince < 0) slowSince = now;
        } else if (rate >= 20) slowSince = -1;
        tooSlow = slowSince >= 0 && now - slowSince > 3000;
        input = {
          tracking: sample.tracking,
          pose: sample.pose,
          valid: sample.valid && !tooSlow,
          calibrated: sample.calibrated,
          poseT: sample.poseT,
          poseAge: sample.poseAge,
          arms: sample.arms,
          keys: null,
          reason: sample.reason,
          start: startAsked,
          hold: away,
          read: sample.read,
          // A step or a lean away counts the same; too near the screen brings the ropes, then the referee.
          back: sample.range?.ready === true && !sample.range.held && sample.range.back,
          // A step toward the opponent is part of boxing. Only the camera limits it: the ropes about a metre from it, the referee a little nearer.
          near: sample.cameraMetres === null ? null : sample.cameraMetres >= NEAR.ropes ? 1 : sample.cameraMetres <= NEAR.stop ? 1.32 : 1.2 + (0.11 * (NEAR.ropes - sample.cameraMetres)) / (NEAR.ropes - NEAR.stop),
          leadMs: delay?.leadMs ?? null,
          behindMs: delay ? delay.modelMs + delay.poseMs : null,
          // The punches with their moment of full stretch, where they go and how well they were thrown; the guard from the gloves' real places.
          contacts: sample.contacts,
          guard: sample.guard,
          // The player's own body, one to one: it is what is drawn, and its gloves are what hit.
          body: sample.body,
        };
      } else input = { tracking: null, pose: null, valid: false, calibrated: false, poseT: -Infinity, poseAge: 0, arms: null, keys: null };
      keys.current.start = false;
      // Away for three minutes: the rounds boxed are kept, the camera is let go, and the start card comes back.
      if (hiddenSince >= 0 && now - hiddenSince > 180000 && cap && cap.state() !== "off") {
        game.current.stop();
        cap.stop();
        setStatus({ state: "off", message: "", problem: null });
      }
      const view = game.current.frame(now, input);
      stage.render(view, now);
      if (view.phase === "ready" && lastPhase !== "ready") readyAt = now;
      lastPhase = view.phase;
      if (cap) {
        // At the pad every straight is one at the head: that is where this player's head punches end.
        cap.padWork(view.phase === "gym" && view.teach?.beat === 1);
        if (view.gymDone || view.bell || view.finished) store(MARKS_KEY, JSON.stringify(cap.marks()));
      }
      if (sample && sample.aim !== "none" && !aimed) {
        aimed = true;
        a.flow("setup-done");
      } else if (sample && sample.aim === "none") aimed = false;
      // ── This device's delay ──────────────────────────────────────────────
      if (m === "camera" && sample) {
        if (sample.poseT > lastPose) {
          lastPose = sample.poseT;
          meter.pose(now - sample.poseAge, now);
        }
        const counting = view.phase === "count" && view.count !== null;
        if (counting && view.count !== beatShown && flash.current) {
          // White for three frames on each beat of the count.
          flash.current.style.opacity = "1";
          meter.flash(now);
          flashOff = now + 50;
          lookUntil = now + 600;
        }
        beatShown = counting ? view.count : null;
        if (flashOff && now >= flashOff && flash.current) {
          flash.current.style.opacity = "0";
          flashOff = 0;
        }
        if (counting || now < lookUntil) look(now);
        if (wasCount && !counting && now >= lookUntil) {
          // The count is over: what it measured stands until the next one.
          wasCount = false;
          meter.sound((a.latencyMs() ?? NaN) / 1000);
          meter.screen(fps);
          delay = meter.result();
          if (delay.wireless && !wirelessSaid) wirelessDue = true;
          cap?.note(now, { ev: "delay", how: delay.how, lead: Math.round(delay.leadMs), sound: Math.round(delay.soundMs) });
        } else if (counting) wasCount = true;
      } else if (flashOff && flash.current) {
        flash.current.style.opacity = "0";
        flashOff = 0;
      }
      // Wireless sound cannot be made tight: said once, between rounds, never in one.
      if (wirelessDue && (view.phase === "rest" || view.phase === "over")) {
        wirelessDue = false;
        wirelessSaid = true;
        c.say("Your sound is arriving late: it is wireless. The speakers or a cable are tighter.");
      }
      if (view.gymDone) store(GYM_KEY, "1");
      // ── Kept for tuning: what the game decided, beside the landmarks it decided it from ──
      if (cap && m === "camera" && sample)
        for (const e of view.events)
          if (e.kind === "its" || e.kind === "mine") cap.note(now, { ev: e.kind, outcome: e.outcome, shape: e.shape, level: e.level, hand: e.hand });
      for (const tch of view.touches) {
        const cm = (n: number) => `${Math.round(n * 100)} cm`;
        lastHit = `${tch.hand} glove met its ${tch.what === "glove" ? "glove" : tch.what === "arm" ? "forearm" : tch.what} at ${tch.speed.toFixed(1)} m/s, ${cm(tch.at.z)} in front of your spot and ${cm(tch.at.y)} up`;
      }
      // ── Sound ────────────────────────────────────────────────────────────
      for (const line of view.lines) if (!(line.call && a.voice(line.call, line.must))) c.say(line.text, line.must);
      for (const p of view.sent) a.swing(p.shape, p.hand);
      for (const sound of view.sounds) a.flow(sound);
      for (const e of view.events) {
        // Its breath at the first movement of a punch, and its foot as it steps in: the honest warnings.
        if (e.kind === "throw") a.breath((e.hand === "left") === (view.bout.lead === "left"), e.feint ? 0.6 : 1);
        else if (e.kind === "step" && e.to === "pocket") a.foot();
        // Its punches are heard as they are seen to arrive (view.shown), not as the rules settle them.
        const old = e.kind === "its" ? null : heard(e);
        if (old) a.event(old);
      }
      for (const e of view.shown) {
        const old = heard(e);
        if (old) a.event(old);
      }
      a.hall(view.phase === "fight", (1 - view.bout.foe.health / 100) * 0.6 + (view.hurt ? 0.4 : 0));
      // ── Kept between visits ──────────────────────────────────────────────
      // Every bell: what has been boxed so far is put by, so a closed page loses nothing.
      if (view.bell) {
        const done = view.bout.card.rounds.slice(0, view.bout.card.scores.length);
        const total = view.bout.card.scores.reduce<[number, number]>((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
        if (done.length) store(PROGRESS_KEY, JSON.stringify(entryOf(view, done, total, "done")));
      }
      if (view.finished && view.result) {
        const r = view.result;
        try {
          localStorage.removeItem(PROGRESS_KEY);
        } catch {
          // Nothing was put by.
        }
        const kept = addSession(
          recordNow.current,
          entryOf(view, r.rounds, r.total, r.how === "ended" ? "done" : r.winner === "me" ? "win" : r.winner === "foe" ? "loss" : "draw"),
        );
        recordNow.current = kept;
        saveRecord(kept);
        setRecord(kept);
        // A win brings the next opponent up the ladder out at the next bell.
        const at = LADDER.indexOf(view.boxer);
        const up1 = r.winner === "me" && view.bout.stakes === "bout" ? LADDER[at + 1] : undefined;
        if (up1 && !(kept.beaten[up1] ?? 0)) {
          game.current.queueBoxer(up1);
          store(BOXER_KEY, up1);
          setBoxerState(up1);
          nextName = `${BOXER_NAME[up1][0].toUpperCase()} · ${BOXER_NAME[up1][1]}`;
        } else if (r.winner === "foe" && stuckOn(kept, view.boxer)) {
          // Three in a row to the same boxer: back to the gym for a minute first.
          game.current.teach();
          nextName = "THE GYM MINUTE FIRST · then him again";
        } else nextName = "";
        const stakesNext = stakesFor(kept);
        if (stakesNext !== view.bout.stakes && !asked) {
          game.current.setStakes(stakesNext);
          setStakesState(stakesNext);
        }
        // After the first days the rounds grow to two minutes, unless a length was chosen.
        if (!stored(LENGTH_KEY) && !query.get("rounds") && !query.get("clock")) {
          const next = lengthFor(kept);
          game.current.setFormat(LENGTH[next][0], LENGTH[next][1]);
          setLengthState(next);
        }
      }
      if (now - lastLoad > 2000) {
        lastLoad = now;
        const next = ladder.update({ renderFps: fps, poseFps: m === "camera" ? (sample?.poseFps ?? 0) : 0 }, now);
        if (next !== quality) {
          quality = next;
          stage.setQuality(QUALITY[next]);
        }
      }
      // ── Words, and only where there may be words ─────────────────────────
      const camera = m === "camera";
      let banner: Banner | null = null;
      if (camera && st.state === "off") {
        if (st.problem) banner = { text: PROBLEM[st.problem][0], sub: PROBLEM[st.problem][1], tone: "warn", key: st.problem };
      } else if (camera && st.state === "starting") banner = null;
      else if (camera && tooSlow && view.phase !== "fight" && view.phase !== "over")
        banner = { text: "MORE LIGHT", sub: `The camera is giving ${Math.round(sample?.poseFps ?? 0)} pictures a second; it needs 18`, tone: "warn", key: "slow" };
      else if (view.phase === "setup") {
        const f = sample?.framing;
        banner =
          !sample?.bodySeen || f === "no-body"
            ? sample?.dim
              ? { text: "MORE LIGHT", sub: "A lamp in front of you, not a window behind", tone: "warn", key: "light" }
              : { text: "STEP INTO VIEW", sub: "About two metres from the screen", tone: "setup", key: "view" }
            : f === "move-left"
              ? { text: "MOVE LEFT", sub: "Stand in the middle of the picture", tone: "setup", key: "left" }
              : f === "move-right"
                ? { text: "MOVE RIGHT", sub: "Stand in the middle of the picture", tone: "setup", key: "right" }
                : f === "come-closer"
                  ? { text: "COME CLOSER", sub: "You are too small in the picture", tone: "setup", key: "closer" }
                  : f === "step-back"
                    ? { text: "STEP BACK", sub: "You are too close to the camera", tone: "setup", key: "close" }
                    : sample.reason === "shoulder-yaw"
                      ? { text: "FACE THE SCREEN", sub: "Shoulders square, just for a moment", tone: "setup", key: "face" }
                      : { text: "HOLD STILL", sub: sample.calibrating ? `${Math.round(sample.progress * 100)}%` : "Head and shoulders in view", tone: "setup", key: "hold" };
      } else if (view.phase === "gym" && view.teach)
        // Training is where words live: one task at a time, with a partner at real speed.
        banner = { text: view.teach.word, sub: view.teach.sub, tone: "warn", key: `gym${view.teach.beat}` };
      else if (view.phase === "ready" && view.grade === "not-yet")
        banner = { text: "THE CAMERA CAN'T FOLLOW YOUR PUNCHES", sub: "More light in front of you · camera at chest height · then punch to try again", tone: "warn", key: "unread" };
      else if (view.phase === "ready")
        banner = camera
          ? { text: "HANDS UP", sub: "Punch when you are ready", tone: "good", key: "ready" }
          : { text: "PRESS ENTER", sub: "F J straight · D K hook · S L uppercut · Shift body · arrows move · Space cover · B elbows · X back", tone: "good", key: "ready" };
      else if (view.phase === "paused")
        banner =
          view.pausedWhy === "menu"
            ? { text: "PAUSED", tone: "plain", key: "menu" }
            : view.pausedWhy === "other-person"
              ? { text: "ONE AT A TIME", sub: "Only the boxer in the picture", tone: "warn", key: "other" }
              : { text: "STEP BACK IN", sub: "Where the camera sees you", tone: "plain", key: "paused" };
      // The count waits: back to the spot first.
      if (view.spot === "back") banner = { text: "BACK TO YOUR SPOT", sub: "A step away from the screen", tone: "warn", key: "spot" };
      const key = `${view.phase}|${banner?.key ?? ""}|${view.count}|${view.corner?.left ?? ""}|${view.corner?.ready ?? ""}|${Math.round(view.hold * 20)}|${view.teach?.done ?? ""}|${view.spot}|${view.replay ? 1 : 0}|${Math.round(view.crowd * 10)}`;
      if (key !== lastKey || now - lastHud > 120) {
        lastKey = key;
        lastHud = now;
        const b = view.bout;
        setHud({
          phase: view.phase,
          dots: view.teach && view.teach.need > 1 ? { done: view.teach.done, need: view.teach.need } : null,
          banner,
          count: view.count,
          countKind: view.countKind,
          setup: camera && st.state === "live" && view.phase === "setup",
          hold: view.hold,
          corner: view.corner,
          result: view.result,
          bars: [b.me.health / 100, b.me.breath / 100, b.foe.health / 100, b.foe.breath / 100],
          worn: view.phase === "fight" ? view.worn : 0,
          hurt: view.phase === "fight" && view.hurt,
          room: room
            ? (() => {
                const me = view.me;
                const cm = (n: number) => `${Math.round(n * 100)} cm`;
                if (!me) return ["Step into view"];
                const out = (i: number) => cm(Math.hypot(me.wrists[i].x - me.shoulders[i].x, me.wrists[i].y - me.shoulders[i].y, me.wrists[i].z - me.shoulders[i].z));
                return [
                  camera ? `Camera: ${Math.round(sample?.poseFps ?? 0)} pictures a second, each ${Math.round(sample?.poseAge ?? 0)} ms old when used${delay ? ` · whole delay about ${Math.round(delay.leadMs)} ms (${delay.how === "flash" ? "measured" : "typical figures"})` : ""}` : "Keyboard: no camera, no delay",
                  camera ? `You: ${sample?.size.measured ? "measured" : "not measured yet (hips must be in the picture)"} · one tracker unit is ${(sample?.size.metres ?? 0).toFixed(2)} m · camera pitched ${Math.round((sample?.size.tilt ?? 0) * 57.3)}° · ${sample?.cameraMetres ? `you are ${sample.cameraMetres.toFixed(2)} m from it` : ""}` : "Keyboard body",
                  `Your arm: ${cm(me.bones.upperArm + me.bones.foreArm)} shoulder to wrist · you stand ${Math.abs(me.hips.z) < 0.03 ? "on your spot" : `${cm(Math.abs(me.hips.z))} ${me.hips.z > 0 ? "nearer than" : "back from"} your spot`}`,
                  `Fists out from the shoulder: left ${out(0)}, right ${out(1)} · in front of it: left ${cm(me.gloves[0].z - me.shoulders[0].z)}, right ${cm(me.gloves[1].z - me.shoulders[1].z)}`,
                  `He stands ${cm(view.distance)} from your spot`,
                  lastHit ? `Last: ${lastHit}` : "Hit him: the glove lands where it gets to",
                ];
              })()
            : [],
          spot: view.spot,
          crowd: view.crowd,
          replay: view.replay !== null,
          stanceDoubt: view.stanceDoubt,
          notes: `${delay ? `Delay ${Math.round(delay.leadMs)} ms (${delay.how === "flash" ? "measured by the flash" : delay.how === "camera-reported" ? "from the camera's own figure" : "typical figures"})${delay.wireless ? " · sound is late: wireless. Speakers or a cable are tighter" : ""} · ` : ""}Drawing ${fps.toFixed(0)} fps · poses ${(sample?.poseFps ?? 0).toFixed(0)} a second · pose age ${(sample?.poseAge ?? 0).toFixed(0)} ms · hands jitter ${(cap?.jitter() ?? [0, 0]).map((v) => (v * 100).toFixed(1)).join(" / ")} cm · body ${sample?.size.measured ? `measured (${sample.size.metres.toFixed(2)} m a unit, camera ${Math.round(sample.size.tilt * 57.3)}°)` : "not measured yet"} · quality step ${quality} · tracker: ${sample ? (sample.valid ? "tracking" : (sample.reason ?? "waiting")) : "off"}`,
          next: nextName,
        });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      el.removeEventListener("pointerdown", tap);
      document.removeEventListener("visibilitychange", hidden);
      capture.current?.stop();
      capture.current = null;
      a.dispose();
      audio.current = null;
      c.stop();
      coach.current = null;
      stage.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const camera = mode === "camera";
  const landing = camera && status.state === "off" && !status.problem && !fatal && !menu;
  const starting = camera && status.state === "starting" && !menu;
  const week = daysThisWeek(record, dayOf(new Date()));
  const r = hud.result;
  // How the player's own state shows: colour drains and the edges darken as they are worn down; more when hurt.
  const drained = Math.max(0, (hud.worn - 0.4) / 0.6);
  if (fatal)
    return (
      <main className="box">
        <section className="box-stage">
          <canvas ref={canvas} aria-hidden="true" />
          <div className="box-card" role="alert">
            <strong>THIS DEVICE CANNOT DRAW THE RING</strong>
            <p>3D drawing did not start ({fatal}). Try another browser, or turn on hardware acceleration.</p>
            <button className="box-primary" onClick={onBack}>
              Back
            </button>
          </div>
        </section>
        <video ref={video} className="box-capture" muted playsInline />
      </main>
    );
  return (
    <main className="box is-immersive">
      <section className="box-stage real-stage" data-tone={hud.banner?.tone ?? (hud.corner ? "plain" : "")}>
        <canvas ref={canvas} aria-label="Your view of the ring" style={{ filter: drained > 0.01 || hud.hurt ? `saturate(${(1 - 0.35 * drained - (hud.hurt ? 0.3 : 0)).toFixed(2)})` : undefined }} />
        <video ref={mirror} className={`box-mirror ${hud.setup ? "is-on" : ""}`} muted playsInline aria-hidden="true" />
        <div ref={flash} className="probe-flash" aria-hidden="true" />
        {room && hud.room.length > 0 && (
          <div className="real-room" role="status">
            {hud.room.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
            <button onClick={saveCamera}>Save what the camera saw (4 minutes)</button>
          </div>
        )}
        {/* The edges darken as the player is worn down, and close in when they are hurt. Nothing to read. */}
        <div className="real-vision" style={{ opacity: Math.min(1, 0.75 * drained + (hud.hurt ? 0.6 : 0)) }} />
        {/* A step too near the screen: the ropes come up at the bottom of the view. Then the referee. */}
        <div className="real-ropes" data-on={hud.spot === "ropes" || hud.spot === "break"} style={{ opacity: hud.spot === "break" ? 1 : Math.min(1, hud.crowd * 1.2) }} aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {hud.spot === "break" && (
          <div className="box-word" data-tone="warn" role="status">
            <strong>BREAK</strong>
            <span>Step back to your spot</span>
          </div>
        )}
        {bars && hud.phase === "fight" && (
          <div className="real-bars" aria-hidden="true">
            <div>
              <i style={{ width: `${hud.bars[0] * 100}%` }} />
              <i data-kind="breath" style={{ width: `${hud.bars[1] * 100}%` }} />
            </div>
            <div data-side="foe">
              <i style={{ width: `${hud.bars[2] * 100}%` }} />
              <i data-kind="breath" style={{ width: `${hud.bars[3] * 100}%` }} />
            </div>
          </div>
        )}
        {hud.setup && (
          <svg className="box-outline" data-ok={hud.banner?.key === "hold"} viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <ellipse cx="80" cy="24" rx="6.5" ry="8" />
            <path d="M62 44 Q62 36 72 35 L88 35 Q98 36 98 44 L96 74 L64 74 Z" />
            <path d="M62 44 L57 68 M98 44 L103 68" />
          </svg>
        )}
        {hud.count !== null && (
          <div className="box-count" data-kind={hud.countKind ?? ""} key={`${hud.countKind}${hud.count}`} role="status">
            {hud.count}
          </div>
        )}
        {/* The corner: the score, the round's punches, and one thing to do. */}
        {hud.corner && hud.count === null && (
          <div className={`box-rest real-corner${hud.replay ? " is-replay" : ""}`} role="status">
            <strong>
              ROUND {hud.corner.round} · {hud.corner.score[0]}–{hud.corner.score[1]}
            </strong>
            {hud.corner.round > 1 && !hud.replay && (
              <span>
                Card {hud.corner.total[0]}–{hud.corner.total[1]}
              </span>
            )}
            {/* The punch that got through, shown again from the side: one cause, in a line. */}
            {hud.replay && hud.corner.cause && <p className="real-cause">{hud.corner.cause}</p>}
            <div className="box-numbers" hidden={hud.replay}>
              <div>
                <b>
                  {hud.corner.tally.clean[0]}/{hud.corner.tally.thrown[0]}
                </b>
                <small>YOUR CLEAN PUNCHES</small>
              </div>
              <div>
                <b>
                  {hud.corner.tally.clean[1]}/{hud.corner.tally.thrown[1]}
                </b>
                <small>ITS CLEAN PUNCHES</small>
              </div>
              <div>
                <b>{hud.corner.tally.gloves[1] + hud.corner.tally.partly[1]}</b>
                <small>ON YOUR GLOVES</small>
              </div>
              {hud.corner.up !== null && (
                <div>
                  <b>{Math.round(hud.corner.up * 100)}%</b>
                  <small>HANDS UP</small>
                </div>
              )}
            </div>
            <p data-tone="warn">{hud.corner.say}</p>
            <em>
              {hud.corner.ready ? (camera ? "Hands up when you are ready" : "Press Enter when you are ready") : "Breathe"} · round {hud.corner.round + 1} in{" "}
              {hud.corner.left}
            </em>
            <button className="box-chip-inline real-stop" onClick={() => game.current.stop()}>
              Stop here · the rounds are kept
            </button>
          </div>
        )}
        {/* The card: round by round, the way a boxer reads a fight. No grade. */}
        {r && hud.phase === "over" && (
          <div className="box-rest real-card" role="status">
            <strong data-tone={r.winner === "me" ? "good" : r.winner === "foe" ? "bad" : "plain"}>
              {r.how === "ended" ? "SESSION DONE" : r.winner === "me" ? "YOUR BOUT" : r.winner === "foe" ? "ITS BOUT" : "A DRAW"}
            </strong>
            <span>
              {r.how === "ended"
                ? r.rounds.length
                  ? `${r.rounds.length} ${r.rounds.length === 1 ? "round" : "rounds"} kept. Nobody lost`
                  : "Nothing to keep this time"
                : r.how === "stoppage"
                  ? "Stopped"
                  : r.how === "draw"
                    ? "Level on the card"
                    : "On points"}
              {r.how !== "ended" && r.total[0] + r.total[1] > 0 ? ` · ${r.total[0]}–${r.total[1]}` : ""}
            </span>
            <table>
              <caption>Clean punches of those thrown</caption>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Score</th>
                  <th>Jabs</th>
                  <th>Power</th>
                  <th>To the body</th>
                  <th>Its clean punches</th>
                  <th>On your gloves</th>
                  <th>Hands up</th>
                </tr>
              </thead>
              <tbody>
                {r.rounds.map((t, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{r.scores[i] ? `${r.scores[i][0]}–${r.scores[i][1]}` : "·"}</td>
                    {(["jabs", "power", "body"] as const).map((kind) => (
                      <td key={kind}>{r.mix[i] ? `${r.mix[i][kind][1]} of ${r.mix[i][kind][0]}` : "·"}</td>
                    ))}
                    <td>
                      {t.clean[1]} of {t.thrown[1]}
                    </td>
                    <td>{t.gloves[1] + t.partly[1]}</td>
                    <td>{r.up[i] === null || r.up[i] === undefined ? "·" : `${Math.round(r.up[i]! * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hud.next && <u>NEXT: {hud.next}</u>}
            <em>
              {week} of 3 days this week · {camera ? "hold your hands up to go again" : "press Enter to go again"}
            </em>
            {hud.hold > 0.02 && hud.hold < 1 && (
              <div className="box-hold">
                <i style={{ width: `${hud.hold * 100}%` }} />
              </div>
            )}
          </div>
        )}
        {hud.banner && (hud.count === null || hud.spot === "back") && !landing && !hud.corner && hud.phase !== "over" && hud.phase !== "fight" && hud.spot !== "break" && (
          <div className="box-word" data-tone={hud.banner.tone} key={hud.banner.key} role="status">
            <strong>{hud.banner.text}</strong>
            {hud.banner.sub && <span>{hud.banner.sub}</span>}
            {hud.dots && (
              <div className="box-dots" aria-label={`${hud.dots.done} of ${hud.dots.need}`}>
                {Array.from({ length: hud.dots.need }, (_, i) => (
                  <b key={i} data-on={i < hud.dots!.done} />
                ))}
              </div>
            )}
          </div>
        )}
        {landing && (
          <div className="box-landing">
            <h1>SPAR · boxing</h1>
            <ol className="box-steps">
              <li>
                <svg viewBox="0 0 64 48" aria-hidden="true">
                  <rect x="4" y="12" width="20" height="14" rx="2" />
                  <path d="M10 26 L8 36 M18 26 L20 36 M4 36 L26 36" />
                  <circle cx="50" cy="12" r="5" />
                  <path d="M50 17 L50 32 M50 22 L42 27 M50 22 L58 27 M50 32 L44 44 M50 32 L56 44" />
                  <path d="M28 40 L38 40 M34 37 L38 40 L34 43" />
                </svg>
                <b>{DEVICE[device][1]}</b>
              </li>
              <li>
                <svg viewBox="0 0 64 48" aria-hidden="true">
                  <circle cx="32" cy="12" r="5" />
                  <path d="M32 17 L32 32 M32 32 L26 45 M32 32 L38 45" />
                  <path d="M32 21 L24 22 L24 14 M32 21 L40 22 L40 14" />
                  <rect x="20" y="8" width="8" height="8" rx="3" />
                  <rect x="36" y="8" width="8" height="8" rx="3" />
                </svg>
                <b>Hands up. It punches for real.</b>
              </li>
              <li>
                <svg viewBox="0 0 64 48" aria-hidden="true">
                  <path d="M8 20 L16 20 L26 12 L26 36 L16 28 L8 28 Z" />
                  <path d="M32 18 Q36 24 32 30 M38 13 Q46 24 38 35" />
                  <path d="M50 40 L62 40 M50 44 L62 44" />
                </svg>
                <b>Sound on. Nothing behind you.</b>
              </li>
            </ol>
            <div className="box-row real-device" role="group" aria-label="What the screen is">
              {(Object.keys(DEVICE) as Device[]).map((choice) => (
                <button key={choice} aria-pressed={device === choice} onClick={() => setDevice(choice)}>
                  {DEVICE[choice][0]}
                </button>
              ))}
            </div>
            <div className="box-pick is-two" role="group" aria-label="Which hand do you write with">
              <button aria-pressed={stance === "left"} onClick={() => setStance("left")}>
                <b>Right-handed</b>
                <small>Left foot forward</small>
              </button>
              <button aria-pressed={stance === "right"} onClick={() => setStance("right")}>
                <b>Left-handed</b>
                <small>Right foot forward</small>
              </button>
            </div>
            <button className="box-start" onClick={begin}>
              {scripted ? "START THE SCRIPTED BOXER" : "START"}
            </button>
            <p>
              {STAKES_NAME[stakes][0]} with {BOXER_NAME[boxer][0].toLowerCase()}, {LENGTH[length][3]}. Trainers or bare feet, nothing hard within two
              steps. Stop if anything hurts. The picture never leaves this device.
              {record.sessions.length > 0 && ` · ${week} of 3 days this week`}
            </p>
          </div>
        )}
        {starting && (
          <div className="box-card" role="status">
            <strong>{waiting ? "ALLOW THE CAMERA" : "LOADING"}</strong>
            <p>{waiting ? "Your browser is asking to use the camera: look for the prompt near the address bar and choose Allow." : status.message}</p>
            <button className="box-chip-inline" onClick={cancelCamera}>
              Cancel
            </button>
          </div>
        )}
        <div className="box-bottom">
          {hud.phase === "gym" && <p role="status">{camera ? "Tap the screen to skip the gym minute" : "Press Enter to skip the gym minute"}</p>}
          {camera && status.state === "off" && status.problem && (
            <button className="box-primary" onClick={enableCamera}>
              Try the camera again
            </button>
          )}
        </div>
        {hud.phase !== "fight" && (
          <button className="box-chip box-menu-toggle" onClick={() => setMenu(!menu)}>
            {menu ? "Close" : "Menu"}
          </button>
        )}
      </section>
      {menu && (
        <aside className="box-menu">
          <h1>SPAR · boxing</h1>
          <p>
            It moves and punches at real speed, and nothing tells you what to do. Keep your hands up: gloves stop punches where they
            are. Watch its feet: when it steps in, something is coming. Hit the side whose hand is out.
          </p>
          <div className="box-levels" aria-label="Opponent">
            {LADDER.map((choice) => (
              <button key={choice} aria-pressed={boxer === choice} onClick={() => setBoxer(choice)}>
                <b>
                  {BOXER_NAME[choice][0]}
                  {(record.beaten[choice] ?? 0) > 0 && " ✓"}
                </b>
                <small>{BOXER_NAME[choice][1]}</small>
              </button>
            ))}
          </div>
          <div className="box-levels" aria-label="What is at stake">
            {(["touch", "open", "bout"] as const).map((choice) => (
              <button key={choice} aria-pressed={stakes === choice} onClick={() => setStakes(choice)}>
                <b>{STAKES_NAME[choice][0]}</b>
                <small>{STAKES_NAME[choice][1]}</small>
              </button>
            ))}
          </div>
          <div className="box-levels" aria-label="How long">
            {(Object.keys(LENGTH) as Length[]).map((choice) => (
              <button key={choice} aria-pressed={length === choice} onClick={() => setLength(choice)}>
                <b>{LENGTH[choice][2]}</b>
                <small>{LENGTH[choice][3]}</small>
              </button>
            ))}
          </div>
          {hud.stanceDoubt && <p className="box-keys">Your first punches led with the other hand. If that is how you stand, switch here.</p>}
          <div className="box-row">
            <button aria-pressed={stance === "left"} onClick={() => setStance("left")}>
              Right-handed (left foot forward)
            </button>
            <button aria-pressed={stance === "right"} onClick={() => setStance("right")}>
              Left-handed (right foot forward)
            </button>
          </div>
          <div className="box-row">
            <button aria-pressed={range} onClick={() => setRange(!range)}>
              Range (it steps in and out; you can pull back): {range ? "on" : "off"}
            </button>
            <button aria-pressed={bars} onClick={() => setBars(!bars)}>
              Health bars: {bars ? "on" : "off"}
            </button>
            <button aria-pressed={voice} onClick={() => setVoice(!voice)}>
              Corner's voice: {voice ? "on" : "off"}
            </button>
            <button aria-pressed={quiet} onClick={() => setQuiet(!quiet)}>
              Quiet corner (no shouts in a round): {quiet ? "on" : "off"}
            </button>
          </div>
          <div className="box-row">
            <button aria-pressed={camera} onClick={() => setMode("camera")}>Use my camera</button>
            <button aria-pressed={!camera} onClick={() => setMode("keys")}>Use the keyboard</button>
          </div>
          {!camera && (
            <p className="box-keys">
              F / J straight · D / K hook · S / L uppercut · hold Shift for the body · ← → move your head · ↓ duck · ↑ or Space cover · B
              elbows down · X pull back · Enter start
            </p>
          )}
          <div className="box-row">
            <button
              onClick={() => {
                game.current.teach();
                setMenu(false);
              }}
            >
              The gym minute again
            </button>
            {(hud.phase === "paused" || hud.phase === "rest" || hud.phase === "fight") && (
              <button
                onClick={() => {
                  game.current.stop();
                  setMenu(false);
                }}
              >
                End the session here (the rounds are kept)
              </button>
            )}
          </div>
          <p className="box-notes">{hud.notes}</p>
          {record.sessions.length > 0 && (
            <p className="box-notes">
              {record.fights} bouts, {record.wins} won · {week} of 3 days this week
            </p>
          )}
          <div className="box-row">
            {camera && status.state !== "off" && <button onClick={enableCamera}>Restart camera</button>}
            <button
              onClick={() => {
                location.search = "?box=1&room";
              }}
            >
              The test room (your body and reach, nothing coming back)
            </button>
            <button onClick={saveCamera}>Save what the camera saw</button>
            <button
              onClick={() => {
                location.search = "?box=1&probe";
              }}
            >
              Camera check (one minute)
            </button>
            <button
              onClick={() => {
                location.search = "?box=1&mode=pads";
              }}
            >
              Pad work (from the first build)
            </button>
            <button
              onClick={() => {
                location.search = "?box=1&classic";
              }}
            >
              The first build
            </button>
            <button onClick={onBack}>Back to the studio</button>
          </div>
        </aside>
      )}
      <video ref={video} className="box-capture" muted playsInline />
    </main>
  );
}
