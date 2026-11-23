import { useEffect, useRef, useState } from "react";
import { cameraSession } from "../camera/session";
import { inputStore } from "../input/store";
import { meanLuma } from "../pov/lightMeter";
import { createBoxAudio } from "./boxAudio";
import { createCapture, type Capture, type CaptureStatus } from "./capture";
import { createCoach } from "./coach";
import { stance } from "./scriptedBoxer";
import {
  createFlashProbe,
  createStillMeter,
  describeProbe,
  type ProbeReport,
} from "./probe";
import "./box.css";

/**
 * The camera check: about a minute, once per place. It finds out what this
 * camera, this room and this person really give the game (see `probe.ts`),
 * shows the numbers and saves them as a file with the landmarks behind them.
 */
type Step = "landing" | "setup" | "guard" | "punch" | "tight" | "flash" | "done";
const GUARD_S = 15,
  TIGHT_S = 8,
  SETTLE_S = 2,
  PUNCHES = 6,
  BEAT_MS = 1600,
  FLASHES = 12;
export const PROBE_KEY = "box.probe";

interface Shown {
  step: Step;
  word: string;
  sub: string;
  count: number | null;
}

export function ProbeScreen({ onBack }: { onBack: () => void }) {
  const video = useRef<HTMLVideoElement>(null),
    flash = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<CaptureStatus>({ state: "off", message: "", problem: null });
  const [shown, setShown] = useState<Shown>({ step: "landing", word: "", sub: "", count: null });
  const [lines, setLines] = useState<string[]>([]);
  const [saved, setSaved] = useState("");
  const capture = useRef<Capture | null>(null);
  const audio = useRef<ReturnType<typeof createBoxAudio> | null>(null);
  const coach = useRef<ReturnType<typeof createCoach> | null>(null);
  const report = useRef<ProbeReport | null>(null);
  const step = useRef<Step>("landing");

  const begin = () => {
    audio.current?.resume();
    audio.current?.flow("bell");
    if (!video.current) return;
    // `&mocap=demo` puts a scripted person in front of it instead of a camera, to try the page itself.
    const scripted = new URLSearchParams(location.search).get("mocap") === "demo";
    capture.current ??= createCapture(video.current, {
      scripted: scripted ? { motion: () => stance() } : null,
      onStatus: setStatus,
    });
    void capture.current.start();
    step.current = "setup";
    coach.current?.say("Camera check. Stand where you play, about two metres back.", true);
  };
  const save = () => {
    try {
      const data = { report: report.current, recording: capture.current?.recording() ?? null };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `spar-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setSaved(`Saved ${link.download} to your downloads.`);
    } catch {
      setSaved("Could not save the file.");
    }
  };

  useEffect(() => {
    cameraSession.stop();
    inputStore.resetToKeyboard();
    const a = (audio.current = createBoxAudio());
    const c = (coach.current = createCoach());
    const guard = createStillMeter(),
      tight = createStillMeter(),
      probe = createFlashProbe();
    const ages: number[] = [];
    const called: string[] = [];
    // Punches the reader calls while the player only stands in the guard: there should be none.
    let invented = 0,
      stood = 0;
    let raf = 0,
      since = 0,
      lastPoseT = -Infinity,
      lastShown = "",
      beats = 0,
      flashes = 0,
      nextFlash = 0,
      flashOff = 0,
      said = "";
    // The camera's own picture, shrunk to a few pixels, for its brightness.
    const small = document.createElement("canvas");
    small.width = 32;
    small.height = 18;
    const pen = small.getContext("2d", { willReadFrequently: true });
    const look = (now: number) => {
      const v = video.current;
      if (!pen || !v || !(v.readyState >= 2) || !v.videoWidth) return;
      try {
        pen.drawImage(v, 0, 0, 32, 18);
        probe.brightness(now, meanLuma(pen.getImageData(0, 0, 32, 18).data));
      } catch {
        // The picture cannot be read here: the flash step reports nothing found.
      }
    };
    const go = (next: Step, now: number, line: string) => {
      step.current = next;
      since = now;
      beats = 0;
      if (line && line !== said) {
        said = line;
        c.say(line, true);
      }
      a.flow("lesson-step");
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const cap = capture.current;
      const live = cap && cap.state() === "live";
      const sample = live ? cap.sample(now) : null;
      const fresh = !!sample && sample.poseT > lastPoseT;
      if (sample && fresh) {
        lastPoseT = sample.poseT;
        ages.push(sample.poseAge);
      }
      let word = "",
        sub = "",
        count: number | null = null;
      const passed = (now - since) / 1000;
      switch (step.current) {
        case "landing":
          break;
        case "setup":
          if (!live) {
            word = "LOADING";
            sub = "Allow the camera if your browser asks";
          } else if (sample?.calibrated && sample.valid) go("guard", now, "Fists by your chin. Stand still.");
          else {
            const f = sample?.framing;
            [word, sub] =
              !sample?.bodySeen || f === "no-body"
                ? ["STEP INTO VIEW", "About two metres from the screen"]
                : f === "move-left"
                  ? ["MOVE LEFT", "Stand in the middle of the picture"]
                  : f === "move-right"
                    ? ["MOVE RIGHT", "Stand in the middle of the picture"]
                    : f === "come-closer"
                      ? ["COME CLOSER", "You are too small in the picture"]
                      : f === "step-back"
                        ? ["STEP BACK", "You are too close"]
                        : ["HOLD STILL", sample.dim ? "The picture is dark: more light will help" : "Facing the screen"];
          }
          break;
        case "guard":
          word = "GUARD";
          sub = "Fists by your chin. Stand still";
          count = Math.max(0, Math.ceil(GUARD_S + SETTLE_S - passed));
          if (sample && fresh && passed >= SETTLE_S) guard.pose(sample.tracking, sample.poseT, sample.valid);
          if (sample && passed >= SETTLE_S) invented += sample.read.punches.length;
          if (passed >= GUARD_S + SETTLE_S) stood += GUARD_S;
          if (passed >= GUARD_S + SETTLE_S) go("punch", now, "Now six straight punches at the screen. One on each beep.");
          break;
        case "punch": {
          // A beep, and which hand: left, right, left…
          const due = Math.floor((now - since - 2500) / BEAT_MS);
          if (due >= beats && beats < PUNCHES) {
            beats++;
            a.flow("count");
          }
          word = beats === 0 ? "PUNCH" : beats % 2 ? "LEFT" : "RIGHT";
          sub = beats === 0 ? "Six straight punches, one on each beep" : `Straight at the screen · ${beats} of ${PUNCHES}`;
          if (sample) for (const p of sample.read.punches) called.push(`${p.hand} ${p.shape}`);
          if (now - since > 2500 + PUNCHES * BEAT_MS + 600) go("tight", now, "Gloves on your cheeks. Hold them there.");
          break;
        }
        case "tight":
          word = "TIGHT GUARD";
          sub = "Gloves on your cheeks. Stand still";
          count = Math.max(0, Math.ceil(TIGHT_S + SETTLE_S - passed));
          if (sample && fresh && passed >= SETTLE_S) tight.pose(sample.tracking, sample.poseT, sample.valid);
          if (sample && passed >= SETTLE_S) invented += sample.read.punches.length;
          if (passed >= TIGHT_S + SETTLE_S) {
            stood += TIGHT_S;
            go("flash", now, "Stand still. The screen will flash.");
            flashes = 0;
            nextFlash = now + 1800;
          }
          break;
        case "flash": {
          word = "STAND STILL";
          sub = "The screen will flash a few times";
          look(now);
          const el = flash.current;
          if (el && flashOff && now >= flashOff) {
            el.style.opacity = "0";
            flashOff = 0;
          }
          if (el && flashes < FLASHES && now >= nextFlash) {
            // White for three frames, at uneven gaps so a steady flicker in the room cannot pass for it.
            el.style.opacity = "1";
            probe.flash(now);
            flashes++;
            flashOff = now + 50;
            nextFlash = now + 430 + ((flashes * 137) % 260);
          }
          if (flashes >= FLASHES && now >= nextFlash + 300) {
            const sorted = [...ages].sort((x, y) => x - y);
            const made: ProbeReport = {
              at: new Date().toISOString(),
              camera: cap?.camera() ?? "unknown",
              screen: `${screen.width}×${screen.height} at ×${window.devicePixelRatio}`,
              poseAgeMs: {
                middle: sorted.length ? sorted[sorted.length >> 1] : 0,
                worst: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : 0,
              },
              guard: guard.summary(),
              tight: tight.summary(),
              punches: { asked: PUNCHES, read: called.length, called },
              invented: { punches: invented, seconds: stood },
              flash: probe.result(),
              soundMs: a.latencyMs(),
            };
            report.current = made;
            setLines(describeProbe(made));
            try {
              const { guard: g, tight: t, ...rest } = made;
              localStorage.setItem(PROBE_KEY, JSON.stringify({ ...rest, guard: g, tight: t }));
            } catch {
              // Kept for this visit only.
            }
            go("done", now, "Done. Thank you.");
          }
          break;
        }
        case "done":
          break;
      }
      const key = `${step.current}|${word}|${sub}|${count}`;
      if (key !== lastShown) {
        lastShown = key;
        setShown({ step: step.current, word, sub, count });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      capture.current?.stop();
      capture.current = null;
      a.dispose();
      audio.current = null;
      c.stop();
      coach.current = null;
    };
  }, []);

  return (
    <main className="box">
      <section className="box-stage" data-tone={shown.step === "done" ? "good" : "setup"}>
        <video ref={video} className={`box-mirror ${shown.step !== "landing" && shown.step !== "done" ? "is-on" : ""}`} muted playsInline aria-hidden="true" />
        {shown.step === "landing" && (
          <div className="box-landing">
            <h1>SPAR · camera check</h1>
            <p className="probe-lead">
              One minute. It measures what your camera and room really give the game: how steady your
              hands look, how fast pictures arrive, whether straight punches are read, and how long
              the screen takes to show.
            </p>
            <button className="box-start" onClick={begin}>
              START
            </button>
            {status.problem && <p>The camera did not start: {status.message}</p>}
            <p>Stand where you play, about two metres back, with your hands in view.</p>
            <button className="box-chip-inline" onClick={onBack}>
              Back
            </button>
          </div>
        )}
        {shown.step !== "landing" && shown.step !== "done" && (
          <>
            {shown.word && (
              <div className="box-word" data-tone="setup" key={shown.word} role="status">
                <strong>{shown.word}</strong>
                {shown.sub && <span>{shown.sub}</span>}
              </div>
            )}
            {shown.count !== null && <div className="probe-count">{shown.count}</div>}
          </>
        )}
        {shown.step === "done" && (
          <div className="box-landing">
            <h1>SPAR · camera check</h1>
            <ul className="probe-lines">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <button className="box-start" onClick={save}>
              SAVE THE RESULTS
            </button>
            {saved && <p>{saved}</p>}
            <p>The file holds these numbers and the landmarks behind them. Nothing leaves this device unless you send it.</p>
            <button className="box-chip-inline" onClick={onBack}>
              Back
            </button>
          </div>
        )}
        <div ref={flash} className="probe-flash" aria-hidden="true" />
      </section>
    </main>
  );
}
