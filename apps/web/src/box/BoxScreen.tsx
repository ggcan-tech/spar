import { useEffect, useRef, useState } from "react";
import { cameraSession } from "../camera/session";
import { inputStore } from "../input/store";
import { QUALITY, createQualityLadder, type RenderQuality } from "../pov/quality";
import { createBoxAudio } from "./boxAudio";
import { LADDER, LEVEL_NAME, type BoxLevel } from "./boxer";
import {
  createCapture,
  type Capture,
  type CaptureSample,
  type CaptureStatus,
} from "./capture";
import { createCoach } from "./coach";
import { RULES } from "./fight";
import {
  createBoxGame,
  type BoxInput,
  type BoxMode,
  type BoxView,
  type Keys,
  type RestInfo,
  type Stats,
} from "./game";
import type { Punch } from "./punch";
import {
  addSession,
  dayOf,
  loadRecord,
  nextUp,
  saveRecord,
  streakOn,
  type BoxRecord,
} from "./record";
import { createBoxScene } from "./scene";
import { boxDemoMotion } from "./scriptedBoxer";
import "./box.css";

const LEVEL_KEY = "box.level",
  INTRO_KEY = "box.introDone",
  STANCE_KEY = "box.stance",
  VOICE_KEY = "box.voice",
  GENTLE_KEY = "box.gentle";
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
function introDone(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return true;
  }
}
function storedLevel(): BoxLevel {
  const saved = stored(LEVEL_KEY) as BoxLevel | null;
  return saved && LADDER.includes(saved) ? saved : "rookie";
}
const MODE_NAME: Record<BoxMode, [string, string]> = {
  bout: ["Fight", "Three rounds against an opponent"],
  defence: ["Defence", "One minute: don't get hit"],
  pads: ["Pads", "One minute: throw the numbers it calls"],
  session: ["Session", "Six minutes: warm-up, pads, defence, a round, a finisher"],
};
const MODES = ["session", "bout", "defence", "pads"] as const;
/** Said once, as the camera starts: what a coach says before a first round. */
const SAFETY =
  "Clear two big steps around you. Don't lock your elbows: stop short and snap back. Bend your knees to duck. Stop if anything hurts.";
/** What is shown large when a bout or a drill ends. */
interface Result {
  numbers: [string, string][];
  grade: string;
  advice: string;
  next: string;
}
function resultOf(s: Stats, next: string): Result {
  if (s.mode === "session" && s.session)
    return {
      numbers: [
        ["PADS", String(s.session.pads)],
        ["DEFENCE", String(s.session.defence)],
        ["ROUND", s.session.round === "win" ? "WON" : s.session.round === "draw" ? "DRAW" : "LOST"],
        ["FINISHER", String(s.session.burst)],
      ],
      grade: s.session.grade,
      advice: s.advice,
      next,
    };
  if (s.mode === "defence")
    return { numbers: [["LONGEST RUN", String(s.streak)], ["CLEAN", `${s.clean}/${s.faced}`]], grade: "", advice: "", next };
  if (s.mode === "pads")
    return { numbers: [["COMBINATIONS", String(s.combos)], ["ON THE CALL", String(s.onCall)]], grade: "", advice: "", next };
  const incoming = s.dodged + s.blocked + s.taken;
  return {
    numbers: [
      ["LANDED", s.thrown ? `${Math.round((100 * s.landed) / s.thrown)}%` : "0%"],
      ["DEFENDED", incoming ? `${Math.round((100 * (s.dodged + s.blocked)) / incoming)}%` : "–"],
      ["BEST", `×${s.bestCombo}`],
    ],
    grade: s.grade,
    advice: s.advice,
    next,
  };
}
const PROBLEM: Record<NonNullable<CaptureStatus["problem"]>, [string, string]> = {
  denied: ["CAMERA BLOCKED", "Allow the camera for this page, then press Enable camera"],
  "in-use": ["CAMERA BUSY", "Close other apps or tabs using the camera, then try again"],
  "not-found": ["NO CAMERA", "No camera was found on this device"],
  "insecure-context": ["CAMERA BLOCKED", "Open this page over https or on localhost"],
  unsupported: ["NO CAMERA", "This browser cannot use the camera"],
  model: ["TRACKING DID NOT LOAD", "Check the connection, then press Enable camera"],
  unknown: ["CAMERA ERROR", "Press Enable camera to try again"],
};
/** Keyboard stand-in for the camera: punches on the home row, defence on the arrows. */
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
  /** 0 to 1: a held start gesture filling. */
  hold: number;
  countKind: BoxView["countKind"];
  lesson: BoxView["lesson"];
  hp: number;
  stamina: number;
  downs: number;
  foeHp: number;
  foeDowns: number;
  clock: number;
  combo: number;
  count: number | null;
  banner: Banner | null;
  phase: BoxView["phase"];
  setup: boolean;
  line: string;
  summary: string;
  notes: string;
  round: number;
  rounds: number;
  play: BoxMode;
  /** The opponent's guard and breath, 0 to 1: both can be worn down. */
  foeGuard: number;
  foeBreath: number;
  stage: BoxView["stage"];
  rest: RestInfo | null;
  result: Result | null;
}
const HUD: Hud = {
  hold: 0,
  countKind: null,
  lesson: null,
  hp: 1,
  stamina: 1,
  downs: 0,
  foeHp: 1,
  foeDowns: 0,
  clock: RULES.clock,
  combo: 0,
  count: null,
  banner: null,
  phase: "setup",
  setup: false,
  line: "",
  summary: "",
  notes: "",
  round: 1,
  rounds: 1,
  play: "bout",
  foeGuard: 1,
  foeBreath: 1,
  stage: null,
  rest: null,
  result: null,
};

function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="box-bar" data-tone={tone}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
function Downs({ n }: { n: number }) {
  return (
    <div className="box-downs" aria-label={`${n} knockdowns`}>
      {Array.from({ length: RULES.knockdowns }, (_, i) => (
        <b key={i} data-on={i < n} />
      ))}
    </div>
  );
}

export function BoxScreen({ onBack }: { onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null),
    mirror = useRef<HTMLVideoElement>(null),
    impact = useRef<HTMLDivElement>(null);
  const query = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
  const scripted = query.get("mocap") === "demo";
  const [status, setStatus] = useState<CaptureStatus>({ state: "off", message: "", problem: null });
  const [mode, setMode] = useState<"camera" | "keys">(query.has("keys") ? "keys" : "camera");
  const [level, setLevelState] = useState<BoxLevel>(storedLevel());
  const [menu, setMenu] = useState(false);
  const [hud, setHud] = useState<Hud>(HUD);
  // Which foot is forward: the left for most right-handers. Everything is mirrored for the other.
  const [stance, setStanceState] = useState<"left" | "right">(stored(STANCE_KEY) === "right" ? "right" : "left");
  const [voice, setVoiceState] = useState(stored(VOICE_KEY) !== "0");
  const [gentle, setGentleState] = useState(stored(GENTLE_KEY) === "1");
  const asked = query.get("mode");
  const [play, setPlayState] = useState<BoxMode>(
    asked === "defence" || asked === "pads" || asked === "session" ? asked : "bout",
  );
  const [record, setRecord] = useState<BoxRecord>(() => loadRecord());
  const recordNow = useRef(record);
  recordNow.current = record;
  /** 3D drawing could not start: nothing else on the stage can work. */
  const [fatal, setFatal] = useState("");
  /** The camera prompt has been up a while: say where to look. */
  const [waiting, setWaiting] = useState(false);
  const [upright, setUpright] = useState(false);
  const capture = useRef<Capture | null>(null);
  const coach = useRef<ReturnType<typeof createCoach> | null>(null);
  // A first visit begins with the lessons, which teach what a rookie's slow first punches used to.
  const game = useRef(
    createBoxGame({
      level,
      intro: !introDone() && !query.has("nointro"),
      lead: stance,
      openers: false,
      gentle,
      mode: play,
      rounds: Number(query.get("rounds")) || undefined,
    }),
  );
  // Made inside the effect: in development React mounts twice, and an audio
  // object disposed by the first mount stayed silent for good.
  const audio = useRef<ReturnType<typeof createBoxAudio> | null>(null);
  const [saved, setSaved] = useState("");
  const live = useRef({ mode, status, menu });
  live.current = { mode, status, menu };
  const keys = useRef({
    punches: [] as Punch[],
    held: new Set<string>(),
    start: false,
  });
  const setLevel = (next: BoxLevel) => {
    store(LEVEL_KEY, next);
    game.current.setLevel(next);
    setLevelState(next);
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
  const setGentle = (on: boolean) => {
    store(GENTLE_KEY, on ? "1" : "0");
    game.current.setGentle(on);
    setGentleState(on);
  };
  const setPlay = (next: BoxMode) => {
    game.current.setMode(next);
    setPlayState(next);
  };
  const cancelCamera = () => {
    capture.current?.stop();
    setStatus({ state: "off", message: "", problem: null });
  };
  /** The one tap that starts everything: the bell proves the sound is on, and the coach says the safety line. */
  const begin = () => {
    enableCamera();
    audio.current?.flow("bell");
    coach.current?.say(SAFETY, true);
  };
  const enableCamera = () => {
    audio.current?.resume();
    if (!video.current) return;
    // On a phone the whole screen is wanted, and this tap is the one chance to ask.
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !document.fullscreenElement)
      void document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
    capture.current ??= createCapture(video.current, {
      scripted: scripted
        ? {
            motion: boxDemoMotion,
            fps: Number(query.get("fps")) || undefined,
            delayMs: Number(query.get("delay")) || undefined,
            occlude: query.has("occlude"),
          }
        : null,
      onStatus: setStatus,
    });
    void capture.current.start();
  };
  // The setup picture is attached whenever the camera comes live, including after it restarted itself.
  useEffect(() => {
    if (status.state !== "live") return;
    const stream = capture.current?.stream();
    if (mirror.current && stream && mirror.current.srcObject !== stream) {
      mirror.current.srcObject = stream;
      void mirror.current.play?.()?.catch?.(() => {});
    }
  }, [status.state]);
  // A camera prompt left unanswered: after eight seconds, say where it is.
  useEffect(() => {
    setWaiting(false);
    if (status.state !== "starting") return;
    const timer = setTimeout(() => setWaiting(true), 8000);
    return () => clearTimeout(timer);
  }, [status.state]);
  // Blocked, then allowed in the browser's settings: start without being asked again.
  useEffect(() => {
    let live = true;
    let permission: PermissionStatus | null = null;
    const changed = () => {
      if (permission?.state === "granted" && capture.current?.state() === "off") enableCamera();
    };
    void navigator.permissions
      ?.query({ name: "camera" as PermissionName })
      .then((p) => {
        if (!live) return;
        permission = p;
        p.addEventListener("change", changed);
      })
      .catch(() => {});
    return () => {
      live = false;
      permission?.removeEventListener("change", changed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A phone held upright: ask for it on its side, where the camera sees wider.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const tall = matchMedia("(orientation: portrait) and (pointer: coarse)");
    const update = () => setUpright(tall.matches);
    update();
    tall.addEventListener?.("change", update);
    return () => tall.removeEventListener?.("change", update);
  }, []);
  const fullscreen = () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.();
      else void document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
    } catch {
      // Not allowed here.
    }
  };
  const save = () => {
    try {
      const data = capture.current?.recording();
      if (!data) {
        setSaved("Nothing to save yet: the camera has not run.");
        return;
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `spar-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setSaved(`Saved ${link.download} to your downloads.`);
    } catch {
      setSaved("Could not save the session.");
    }
  };

  useEffect(() => {
    cameraSession.stop();
    inputStore.resetToKeyboard();
    let scene: ReturnType<typeof createBoxScene>;
    try {
      scene = createBoxScene(canvas.current!);
    } catch (e) {
      // Nothing on the stage is drawn without it: say so on a plain card.
      setFatal(e instanceof Error ? e.message : String(e));
      return;
    }
    const a = (audio.current = createBoxAudio());
    const c = (coach.current = createCoach());
    c.setEnabled(stored(VOICE_KEY) !== "0");
    a.setVoice(stored(VOICE_KEY) !== "0");
    let shownLevel: BoxLevel = game.current.level();
    let nextName = "";
    /** When the result went up: the numbers wait a moment, so the knockout itself is watched. */
    let overSince = -1;
    /** Since when the camera has given too few pictures to follow a punch, or -1. */
    let slowSince = -1;
    const ladder = createQualityLadder();
    let quality: RenderQuality = 0;
    let noted = 0;
    let raf = 0,
      lastHud = 0,
      lastPhase: BoxView["phase"] = "setup",
      lastBanner = "",
      lastFrame = performance.now(),
      fps = 60,
      lastLoad = 0;
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = keys.current;
      k.held.add(e.code);
      a.resume();
      const hit = PUNCH_KEYS[e.code];
      if (hit && live.current.mode === "keys")
        k.punches.push({ ...hit, target: e.shiftKey ? "body" : "head", power: 1, t: performance.now() });
      // Enter starts in either mode; Space too with the camera, where it is not the cover.
      if (e.code === "Enter" || (e.code === "Space" && live.current.mode === "camera")) k.start = true;
      if (e.code === "Escape" || e.code === "KeyM") setMenu((open) => !open);
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter"].includes(e.code)) e.preventDefault();
    };
    const tap = () => {
      a.resume();
      keys.current.start = true;
    };
    const stage = canvas.current!;
    stage.addEventListener("pointerdown", tap);
    const seenAgain = () => {
      if (document.hidden) a.hall(false);
      else a.resume();
    };
    document.addEventListener("visibilitychange", seenAgain);
    const upKey = (e: KeyboardEvent) => keys.current.held.delete(e.code);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", upKey);
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      fps = fps * 0.9 + Math.min(240, 1000 / Math.max(1, now - lastFrame)) * 0.1;
      lastFrame = now;
      const { mode: m, status: st, menu: menuOpen } = live.current;
      const asked = keys.current.start;
      const cap = capture.current;
      let sample: CaptureSample | null = null;
      let tooSlow = false;
      let input: BoxInput;
      if (m === "keys") {
        const k = keys.current;
        const held = (code: string) => k.held.has(code);
        const pressed: Keys = {
          punches: k.punches,
          slip: held("ArrowLeft") ? -1 : held("ArrowRight") ? 1 : 0,
          duck: held("ArrowDown"),
          high: held("ArrowUp") || held("Space"),
          low: held("KeyB"),
          start: k.start,
        };
        k.punches = [];
        k.start = false;
        input = { tracking: null, pose: null, valid: true, calibrated: true, poseT: now, poseAge: 0, arms: null, keys: pressed, hold: menuOpen };
      } else if (cap && cap.state() === "live") {
        sample = cap.sample(now);
        // Under 18 poses a second a jab is three pictures: the game says so rather than play badly.
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
          start: asked,
          hold: menuOpen,
          read: sample.read,
        };
      } else
        input = { tracking: null, pose: null, valid: false, calibrated: false, poseT: -Infinity, poseAge: 0, arms: null, keys: null };
      keys.current.start = false;
      const view = game.current.frame(now, input);
      scene.render(view, now);
      // What the game decided, beside the landmarks it decided it from: a
      // session saved from the menu can then be played back and tuned from.
      if (cap && m === "camera" && sample) {
        const f = view.fight;
        cap.note(now, {
          phase: view.phase,
          tracked: sample.valid,
          reason: sample.reason,
          high: view.guard.high,
          low: view.guard.low,
          up: view.guard.up,
          foe: f.foe.phase,
          headX: Math.round(view.head.x * 100) / 100,
          headY: Math.round(view.head.y * 100) / 100,
        });
        for (const p of view.punches)
          cap.note(now, { n: ++noted, ev: "start", hand: p.hand, shape: p.shape, target: p.target });
        for (const p of view.confirmed)
          cap.note(now, { n: ++noted, ev: "punch", hand: p.hand, shape: p.shape, target: p.target, power: Math.round(p.power * 100) / 100 });
        for (const e of view.events)
          cap.note(now, {
            n: ++noted,
            ev: e.kind,
            ...("attack" in e ? { attack: e.attack } : {}),
            ...("how" in e ? { how: e.how } : {}),
            ...("early" in e ? { early: e.early, open: e.open } : {}),
          });
      }
      // Standing ready at the end of a count: that spot is the middle of the ring.
      if (view.recenter) cap?.recenter();
      if (view.lessonDone) {
        try {
          localStorage.setItem(INTRO_KEY, "1");
        } catch {
          // The lessons will be offered again next time.
        }
      }
      if (view.phase !== "over") overSince = -1;
      else if (overSince < 0) overSince = now;
      // The opponent changed with the bell (the next one up the ladder): remember it.
      if (view.fight.level !== shownLevel) {
        shownLevel = view.fight.level;
        store(LEVEL_KEY, shownLevel);
        setLevelState(shownLevel);
        nextName = "";
      }
      // A bout or a drill has just ended: keep it, and line up the next opponent after a win.
      if (view.finished) {
        const s = view.stats;
        const over = view.fight.over;
        const won = s.mode === "bout" && over?.winner === 0;
        const kept = addSession(recordNow.current, {
          day: dayOf(new Date()),
          at: Date.now(),
          mode: s.mode,
          level: view.fight.level,
          result: s.mode !== "bout" ? "done" : won ? "win" : over?.winner === null ? "draw" : "loss",
          grade: s.grade,
          rounds: s.rounds,
          seconds: Math.round(s.seconds),
          thrown: s.thrown,
          landed: s.landed,
          defended: s.dodged + s.blocked,
          incoming: s.dodged + s.blocked + s.taken,
          counters: s.counters,
          bestCombo: s.bestCombo,
          score: s.mode === "defence" ? s.streak : s.mode === "pads" ? s.combos : s.mode === "session" ? (s.session?.burst ?? 0) : 0,
        });
        recordNow.current = kept;
        saveRecord(kept);
        setRecord(kept);
        const up = won ? nextUp(kept, view.fight.level) : null;
        if (up) {
          game.current.queueLevel(up);
          nextName = LEVEL_NAME[up][0].toUpperCase();
        } else nextName = "";
      }
      // ── Sound ────────────────────────────────────────────────────────────
      // A recorded call where there is one (on time); the browser's speech for the rest.
      for (const line of view.lines) if (!(line.call && a.voice(line.call, line.must))) c.say(line.text, line.must);
      for (const p of view.punches) a.swing(p.shape, p.hand);
      for (const sound of view.sounds) a.flow(sound);
      for (const e of view.events) {
        a.event(e);
        if (e.kind === "hit-me") {
          // Red from the side the punch came from.
          const el = impact.current;
          if (el) el.style.setProperty("--from", e.hand === "left" ? "78%" : "22%");
          el?.animate?.([{ opacity: 0.9 }, { opacity: 0 }], { duration: 320, easing: "ease-out" });
        }
      }
      const fight = view.fight;
      a.hall(
        view.phase === "fight" || view.phase === "lesson",
        (1 - fight.foe.hp / RULES.health) * 0.6 + Math.min(1, fight.me.combo / 5) * 0.4,
      );
      if (now - lastLoad > 2000) {
        lastLoad = now;
        const next = ladder.update({ renderFps: fps, poseFps: m === "camera" ? (sample?.poseFps ?? 0) : 0 }, now);
        if (next !== quality) {
          quality = next;
          scene.setQuality(QUALITY[next]);
        }
      }
      // ── Words ────────────────────────────────────────────────────────────
      let banner: Banner | null = null;
      const camera = m === "camera";
      if (camera && st.state === "off") {
        if (st.problem) {
          const [text, sub] = PROBLEM[st.problem];
          banner = { text, sub, tone: "warn", key: text };
        }
      } else if (camera && st.state === "starting") banner = null;
      else if (camera && tooSlow && (view.phase === "setup" || view.phase === "ready" || view.phase === "paused"))
        banner = {
          text: "MORE LIGHT",
          sub: `The camera is giving ${Math.round(sample?.poseFps ?? 0)} pictures a second; it needs 18`,
          tone: "warn",
          key: "slow",
        };
      else if (view.phase === "setup") {
        // One cause, one word, in the order of what is quickest to put right.
        const f = sample?.framing;
        banner =
          !sample?.bodySeen || f === "no-body"
            ? sample?.dim
              ? { text: "MORE LIGHT", sub: "The camera's picture is too dark to see you", tone: "warn", key: "light" }
              : { text: "STEP INTO VIEW", sub: "Stand where the camera sees you", tone: "setup", key: "view" }
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
                      : sample.calibrating
                        ? { text: "HOLD STILL", sub: `${Math.round(sample.progress * 100)}%`, tone: "setup", key: "hold" }
                        : sample.dim
                          ? { text: "MORE LIGHT", sub: "The camera's picture is too dark to see you", tone: "warn", key: "light" }
                          : {
                              text: "STEP BACK",
                              sub: sample.missing.length ? `Show your ${sample.missing.join(" and ")}` : "Head and shoulders in view",
                              tone: "setup",
                              key: "back",
                            };
      } else if (view.phase === "ready")
        banner = camera
          ? { text: "PUNCH", sub: "to start", tone: "good", key: "ready" }
          : { text: "PRESS ENTER", sub: "to start", tone: "good", key: "ready" };
      // In the corner the card is the whole message.
      else if (view.phase === "rest") banner = null;
      else if (view.phase === "paused")
        banner =
          view.pausedWhy === "menu"
            ? { text: "PAUSED", tone: "plain", key: "menu" }
            : view.pausedWhy === "other-person"
              ? { text: "ONE AT A TIME", sub: "Only the player in the picture", tone: "warn", key: "other" }
              : sample?.dim
                ? { text: "MORE LIGHT", sub: "The picture is too dark", tone: "warn", key: "light" }
                : { text: "STEP BACK IN", sub: "Where the camera sees you", tone: "plain", key: "paused" };
      else if (view.cue) banner = { ...view.cue, key: `cue${view.cue.at}` };
      else if (view.word) banner = { ...view.word, key: `word${view.word.at}` };
      // Knocked down: the count is the banner, with what to do under it.
      const downSub =
        view.countKind === "down"
          ? fight.time - fight.me.downAt >= RULES.downFor
            ? camera
              ? "PUNCH TO GET UP"
              : "PUNCH OR COVER TO GET UP"
            : "YOU'RE DOWN"
          : "";
      const changed =
        (banner?.key ?? "") !== lastBanner || view.count !== hudCount || view.phase !== lastPhase;
      lastPhase = view.phase;
      if (changed || now - lastHud > 100) {
        lastHud = now;
        lastBanner = banner?.key ?? "";
        hudCount = view.count;
        const s = view.stats;
        const kept = recordNow.current;
        const streak = streakOn(kept, dayOf(new Date()));
        const standing = [
          view.mode === "bout" ? `${LEVEL_NAME[game.current.level()][0]} · ${fight.rounds} rounds` : MODE_NAME[view.mode][1],
          kept.wins ? `${kept.wins} ${kept.wins === 1 ? "win" : "wins"}` : "",
          streak > 1 ? `${streak} days running` : "",
          view.mode === "defence" && kept.bestDefence ? `best run ${kept.bestDefence}` : "",
          view.mode === "pads" && kept.bestPads ? `best ${kept.bestPads} combinations` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        setHud({
          round: fight.round,
          rounds: fight.rounds,
          play: view.mode,
          foeGuard: fight.foe.guardLeft / RULES.guardStrength,
          foeBreath: 1 - fight.foe.tired,
          stage: view.stage,
          rest: view.rest,
          result:
            view.phase === "over" && now - overSince >= 2500
              ? resultOf(s, nextName ? `NEXT: ${nextName}` : streak > 1 ? `${streak} DAYS RUNNING` : "")
              : null,
          hold: view.hold,
          countKind: view.countKind,
          lesson: view.lesson,
          hp: fight.me.hp / RULES.health,
          stamina: fight.me.stamina / RULES.stamina,
          downs: fight.me.downs,
          foeHp: fight.foe.hp / RULES.health,
          foeDowns: fight.foe.downs,
          clock: view.clock,
          combo: fight.me.combo,
          count: view.count,
          banner,
          phase: view.phase,
          setup: camera && st.state === "live" && view.phase === "setup",
          line: downSub
            ? downSub
            : view.phase === "lesson"
              ? "Tap or press Enter to skip the lessons"
              : !camera && view.phase === "ready"
                ? "F / J straight · D / K hook · S / L uppercut · Shift body · ← → slip · ↓ duck · ↑ cover · B low"
                : view.phase === "ready"
                  ? standing
                  : "",
          summary:
            s.thrown > 0
              ? `Landed ${s.landed} of ${s.thrown} · counters ${s.counters} · made them miss ${s.dodged} · blocked ${s.blocked} · took ${s.taken} · best combination ×${s.bestCombo}`
              : "",
          notes: `Drawing ${fps.toFixed(0)} fps · poses ${(sample?.poseFps ?? 0).toFixed(0)} a second · pose age ${(sample?.poseAge ?? 0).toFixed(0)} ms · hands jitter ${(cap?.jitter() ?? [0, 0]).map((v) => (v * 100).toFixed(1)).join(" / ")} cm · picture quality step ${quality} · tracker: ${sample ? (sample.valid ? "tracking" : (sample.reason ?? "waiting")) : "off"} · block: ${view.guard.high} high, ${view.guard.low} low`,
        });
      }
    };
    let hudCount: number | null = null;
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", upKey);
      stage.removeEventListener("pointerdown", tap);
      document.removeEventListener("visibilitychange", seenAgain);
      capture.current?.stop();
      capture.current = null;
      a.dispose();
      audio.current = null;
      c.stop();
      coach.current = null;
      scene.dispose();
    };
  }, []);

  const camera = mode === "camera";
  const immersive = !menu && (!camera || status.state !== "off");
  const minutes = Math.floor(hud.clock / 60),
    seconds = Math.floor(hud.clock % 60);
  // Before the camera is on: the one moment the player is close enough to read.
  const landing = camera && status.state === "off" && !status.problem && !fatal && !menu;
  const starting = camera && status.state === "starting" && !menu;
  const streak = streakOn(record, dayOf(new Date()));
  const roundLabel =
    hud.phase === "lesson"
      ? "LESSONS"
      : hud.stage
        ? `${hud.stage.name} ${hud.stage.index}/${hud.stage.of}`
        : hud.play !== "bout"
        ? MODE_NAME[hud.play][0].toUpperCase()
        : hud.rounds > 1
          ? `ROUND ${hud.round}/${hud.rounds}`
          : "";
  if (fatal)
    return (
      <main className="box">
        <section className="box-stage">
          <canvas ref={canvas} aria-hidden="true" />
          <div className="box-card" role="alert">
            <strong>THIS DEVICE CANNOT DRAW THE RING</strong>
            <p>3D drawing did not start ({fatal}). Try another browser, or turn on hardware acceleration.</p>
            <button className="box-primary" onClick={onBack}>
              Back to the studio
            </button>
          </div>
        </section>
        <video ref={video} className="box-capture" muted playsInline />
      </main>
    );
  return (
    <main className={`box ${immersive ? "is-immersive" : ""}`}>
      <section className="box-stage" data-tone={hud.banner?.tone ?? (hud.rest ? "plain" : "")}>
        <canvas ref={canvas} aria-label="Your view of the ring" />
        <video ref={mirror} className={`box-mirror ${hud.setup ? "is-on" : ""}`} muted playsInline aria-hidden="true" />
        <div className="box-top">
          <div className="box-side">
            <span>YOU</span>
            <Bar value={hud.hp} tone="me" />
            <Bar value={hud.stamina} tone="stamina" />
            <Downs n={hud.downs} />
          </div>
          <div className="box-clock">
            {minutes}:{String(seconds).padStart(2, "0")}
            {roundLabel && <small>{roundLabel}</small>}
          </div>
          <div className="box-side is-foe">
            <span>{LEVEL_NAME[level][0].toUpperCase()}</span>
            <Bar value={hud.foeHp} tone="foe" />
            {/* Its guard can be broken and its breath taken with body punches: both are shown. */}
            <div className="box-pair">
              <Bar value={hud.foeGuard} tone="guard" />
              <Bar value={hud.foeBreath} tone="stamina" />
            </div>
            <Downs n={hud.foeDowns} />
          </div>
        </div>
        {/* Where to stand: an outline to fill, over the camera's own picture. */}
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
        {/* In the corner between rounds: the score, one thing done well, one to put right. */}
        {hud.rest && hud.count === null && (
          <div className="box-rest" role="status">
            <strong>
              {hud.rest.title ?? `ROUND ${hud.rest.round} · ${hud.rest.score[0]}–${hud.rest.score[1]}`}
            </strong>
            {!hud.rest.title && hud.rest.round > 1 && (
              <span>
                Card {hud.rest.total[0]}–{hud.rest.total[1]}
              </span>
            )}
            <p data-tone="good">{hud.rest.praise}</p>
            {hud.rest.fix && <p data-tone="warn">{hud.rest.fix}</p>}
            <em>
              {hud.rest.ready ? (camera ? "Punch when you're ready" : "Press Enter when you're ready") : "Breathe"} ·{" "}
              {hud.rest.next ? hud.rest.next.toLowerCase() : `round ${hud.rest.round + 1}`} in {hud.rest.left}
            </em>
          </div>
        )}
        {/* The count over a floored opponent sits beside the word: the knockdown is the moment to read it. */}
        {hud.banner && (hud.count === null || hud.countKind === "foe") && !landing && (
          <div className="box-word" data-tone={hud.banner.tone} data-over={hud.result !== null} key={hud.banner.key} role="status">
            <strong>{hud.banner.text}</strong>
            {hud.banner.sub && <span>{hud.banner.sub}</span>}
            {hud.lesson && (
              <div className="box-dots" aria-label={`${hud.lesson.done} of ${hud.lesson.need}`}>
                {Array.from({ length: hud.lesson.need }, (_, i) => (
                  <b key={i} data-on={i < hud.lesson!.done} />
                ))}
              </div>
            )}
            {hud.hold > 0.02 && hud.hold < 1 && (
              <div className="box-hold">
                <i style={{ width: `${hud.hold * 100}%` }} />
              </div>
            )}
            {/* The result: three numbers that can be read from across the room, and what to do next. */}
            {hud.result && (
              <div className="box-result">
                <div className="box-numbers">
                  {hud.result.grade && (
                    <div data-grade={hud.result.grade}>
                      <b>{hud.result.grade}</b>
                      <small>GRADE</small>
                    </div>
                  )}
                  {hud.result.numbers.map(([label, value]) => (
                    <div key={label}>
                      <b>{value}</b>
                      <small>{label}</small>
                    </div>
                  ))}
                </div>
                {hud.result.advice && <em>{hud.result.advice}</em>}
                {hud.result.next && <u>{hud.result.next}</u>}
              </div>
            )}
          </div>
        )}
        {/* The combination's count has its own place, by the gloves, and is not a word. */}
        {hud.combo >= 2 && hud.phase === "fight" && (
          <div className="box-combo" key={hud.combo} aria-label={`Combination of ${hud.combo}`}>
            ×{hud.combo}
          </div>
        )}
        <div ref={impact} className="box-impact" />
        {landing && (
          <div className="box-landing">
            <h1>SPAR · boxing</h1>
            <ol className="box-steps">
              {upright && (
                <li>
                  <svg viewBox="0 0 64 48" aria-hidden="true">
                    <rect x="8" y="6" width="16" height="30" rx="3" />
                    <rect x="30" y="20" width="30" height="16" rx="3" />
                    <path d="M22 4 Q40 2 44 16 M44 16 L39 12 M44 16 L47 10" />
                  </svg>
                  <b>Turn your phone on its side</b>
                </li>
              )}
              <li>
                <svg viewBox="0 0 64 48" aria-hidden="true">
                  <rect x="4" y="12" width="20" height="14" rx="2" />
                  <path d="M10 26 L8 36 M18 26 L20 36 M4 36 L26 36" />
                  <circle cx="50" cy="12" r="5" />
                  <path d="M50 17 L50 32 M50 22 L42 27 M50 22 L58 27 M50 32 L44 44 M50 32 L56 44" />
                  <path d="M28 40 L38 40 M34 37 L38 40 L34 43" />
                </svg>
                <b>Prop the screen up. Step back three steps.</b>
              </li>
              <li>
                <svg viewBox="0 0 64 48" aria-hidden="true">
                  <circle cx="14" cy="14" r="5" />
                  <path d="M14 19 L14 34 M14 34 L9 45 M14 34 L19 45 M14 24 L8 28" />
                  <path d="M14 23 L36 21" />
                  <rect x="36" y="15" width="13" height="12" rx="5" />
                  <path d="M54 14 L60 10 M55 21 L62 21 M54 28 L60 32" />
                </svg>
                <b>Punch at the screen to start.</b>
              </li>
              <li>
                <svg viewBox="0 0 64 48" aria-hidden="true">
                  <path d="M8 20 L16 20 L26 12 L26 36 L16 28 L8 28 Z" />
                  <path d="M32 18 Q36 24 32 30 M38 13 Q46 24 38 35" />
                  <path d="M50 40 L62 40 M50 44 L62 44" />
                </svg>
                <b>Sound on. Two clear steps around you.</b>
              </li>
            </ol>
            <div className="box-pick is-four" role="group" aria-label="What to do">
              {MODES.map((choice) => (
                <button key={choice} aria-pressed={play === choice} onClick={() => setPlay(choice)}>
                  <b>{MODE_NAME[choice][0]}</b>
                  <small>{MODE_NAME[choice][1]}</small>
                </button>
              ))}
            </div>
            <div className="box-pick is-two" role="group" aria-label="Which foot is forward">
              <button aria-pressed={stance === "left"} onClick={() => setStance("left")}>
                <b>Left foot forward</b>
                <small>Most right-handers</small>
              </button>
              <button aria-pressed={stance === "right"} onClick={() => setStance("right")}>
                <b>Right foot forward</b>
                <small>Most left-handers</small>
              </button>
            </div>
            <button className="box-start" onClick={begin}>
              {scripted ? "START THE SCRIPTED BOXER" : "START"}
            </button>
            <p>
              Don't lock your elbows: stop short and snap back. Stop if anything hurts.
              {record.sessions.length > 0 &&
                ` · ${record.wins} ${record.wins === 1 ? "win" : "wins"}${streak > 1 ? ` · ${streak} days running` : ""}`}
            </p>
          </div>
        )}
        {starting && (
          <div className="box-card" role="status">
            <strong>{waiting ? "ALLOW THE CAMERA" : "LOADING"}</strong>
            <p>
              {waiting
                ? "Your browser is asking to use the camera: look for the prompt near the address bar and choose Allow."
                : status.message}
            </p>
            <button className="box-chip-inline" onClick={cancelCamera}>
              Cancel
            </button>
          </div>
        )}
        <div className="box-bottom">
          {hud.line && !landing && <p role="status">{hud.line}</p>}
          {camera && status.state === "off" && status.problem && (
            <>
              {status.problem === "denied" && (
                <p role="status">Click the camera or lock icon by the address bar and allow the camera: it starts by itself.</p>
              )}
              <button className="box-primary" onClick={enableCamera}>
                {scripted ? "Start the scripted boxer" : "Enable camera"}
              </button>
            </>
          )}
        </div>
        <button className="box-chip box-menu-toggle" onClick={() => setMenu(!menu)}>
          {menu ? "Close" : "Menu"}
        </button>
        {immersive && (
          <button className="box-chip box-fullscreen" onClick={fullscreen}>
            Full screen
          </button>
        )}
      </section>
      {menu && (
        <aside className="box-menu">
          <h1>SPAR · boxing</h1>
          <p>
            Stand two or three steps from the screen, fists by your chin. Punch at the screen; the
            opponent shows every punch before it throws it.
          </p>
          <div className="box-levels" aria-label="What to do">
            {MODES.map((choice) => (
              <button key={choice} aria-pressed={play === choice} onClick={() => setPlay(choice)}>
                <b>{MODE_NAME[choice][0]}</b>
                <small>{MODE_NAME[choice][1]}</small>
              </button>
            ))}
          </div>
          <div className="box-levels" aria-label="Opponent">
            {LADDER.map((choice) => (
              <button key={choice} aria-pressed={level === choice} onClick={() => setLevel(choice)}>
                <b>
                  {LEVEL_NAME[choice][0]}
                  {(record.beaten[choice] ?? 0) > 0 && " ✓"}
                </b>
                <small>{LEVEL_NAME[choice][1]}</small>
              </button>
            ))}
          </div>
          <ul>
            <li><b>Straight punch coming:</b> move your head to one side, or duck.</li>
            <li>
              <b>Hook coming (arm out wide):</b>{" "}
              {gentle ? "glove to your temple on the side it comes from." : "bend your knees and get under it."}
            </li>
            <li><b>Body shot coming (it dips):</b> the elbow on that side down to your ribs, other hand up.</li>
            <li><b>Cover up</b> (gloves to your forehead, look between them) blocks any head punch, at a cost.</li>
            <li><b>Make it miss, then hit back:</b> that punch counts double, more if you left it late.</li>
            <li>It guards its head or its body, never both. Hit where the gloves are not.</li>
            <li>Every punch costs breath. Swinging without stopping leaves you with nothing.</li>
          </ul>
          <div className="box-row">
            <button aria-pressed={stance === "left"} onClick={() => setStance("left")}>Left foot forward</button>
            <button aria-pressed={stance === "right"} onClick={() => setStance("right")}>Right foot forward</button>
          </div>
          <div className="box-row">
            <button aria-pressed={voice} onClick={() => setVoice(!voice)}>Coach's voice: {voice ? "on" : "off"}</button>
            <button aria-pressed={gentle} onClick={() => setGentle(!gentle)}>
              Low impact (no ducking): {gentle ? "on" : "off"}
            </button>
          </div>
          <div className="box-row">
            <button aria-pressed={camera} onClick={() => setMode("camera")}>Use my camera</button>
            <button aria-pressed={!camera} onClick={() => setMode("keys")}>Use the keyboard</button>
          </div>
          {!camera && (
            <p className="box-keys">
              F / J straight · D / K hook · S / L uppercut · hold Shift for the body · ← → slip · ↓ duck ·
              ↑ or Space cover up · B block low · Enter start
            </p>
          )}
          <div className="box-row">
            <button
              onClick={() => {
                game.current.teach();
                setPlay("bout");
                setMenu(false);
              }}
            >
              Show me the moves again
            </button>
          </div>
          {record.sessions.length > 0 && (
            <p className="box-notes">
              {record.fights} fights, {record.wins} won · {streak > 0 ? `${streak} ${streak === 1 ? "day" : "days"} running` : "no streak"} · best
              combination ×{record.bestCombo}
              {record.bestDefence > 0 && ` · best defence run ${record.bestDefence}`}
              {record.bestPads > 0 && ` · best pads ${record.bestPads}`}
            </p>
          )}
          <p className="box-notes">{hud.notes}</p>
          {saved && <p className="box-notes">{saved}</p>}
          {hud.summary && <p className="box-notes">{hud.summary}</p>}
          <div className="box-row">
            {camera && status.state !== "off" && <button onClick={enableCamera}>Restart camera</button>}
            {camera && <button onClick={save}>Save the last minute of tracking</button>}
            <button
              onClick={() => {
                location.search = "?box=1&probe";
              }}
            >
              Camera check (one minute)
            </button>
            <button onClick={onBack}>Back to the studio</button>
          </div>
        </aside>
      )}
      <video ref={video} className="box-capture" muted playsInline />
    </main>
  );
}
