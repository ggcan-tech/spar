import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordedSession } from "../pov/sessionLog";
import { createDuelAudio, type DuelAudio } from "./audio";
import { createDuelCapture, type CaptureStatus, type DuelCapture } from "./capture";
import { slingRoutine } from "./scripted";
import { createDuelSession, type DuelMode, type DuelSession, type Hud } from "./session";
import { drawStage } from "./stage";
import "./duel.css";

/**
 * The duel's test pages (DUEL.md 11, steps 1a to 3):
 *   ?duel=1&probe   the sling probe: live numbers and a guided recording
 *   ?duel=1&sling   test 1: the sling alone, on dummies and a walking target
 *   ?duel=1&dodge   test 2: a bot sling fires 40 balls at you
 *   ?duel=1         test 3: a duel against the Coach bot (&wall for the perfect defender, &turns for one ball)
 * Add &replay (&from=4) to play the saved recording instead of the camera,
 * or &scripted for a scripted person. &still and &height switch the release and the aim.
 */
const MODES: { id: DuelMode; label: string; q: string }[] = [
  { id: "probe", label: "Probe", q: "probe" },
  { id: "sling", label: "1 · Sling", q: "sling" },
  { id: "dodge", label: "2 · Dodge", q: "dodge" },
  { id: "duel", label: "3 · Duel", q: "" },
];

function download(name: string, data: unknown) {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    // Nothing to save.
  }
}

export function DuelScreen({ onBack }: { onBack: () => void }) {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const mode: DuelMode = query.has("probe") ? "probe" : query.has("sling") ? "sling" : query.has("dodge") ? "dodge" : "duel";
  const replay = query.has("replay"),
    scripted = query.has("scripted");
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const capture = useRef<DuelCapture | null>(null);
  const audio = useRef<DuelAudio | null>(null);
  const recorded = useRef<RecordedSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({ state: "off", message: "", problem: null });
  const [hud, setHud] = useState<Hud | null>(null);
  const [panel, setPanel] = useState(mode !== "duel");
  const [muted, setMuted] = useState(false);
  const session = useMemo<DuelSession>(
    () =>
      createDuelSession({
        mode,
        defender: query.has("wall") ? "wall" : "coach",
        balls: query.has("turns") ? 1 : 2,
        release: query.has("still") ? "still" : "flick",
        aim: query.has("height") ? "height" : "line",
        dark: query.has("nodark") ? "off" : query.has("squeezedark") ? "squeeze" : "always",
      }),
    [mode, query],
  );
  const [settings, setSettings] = useState(session.settings());

  const enable = useCallback(() => {
    audio.current ??= createDuelAudio();
    audio.current.unlock();
    if (!video.current) return;
    if (replay && !recorded.current) {
      void fetch("/_replay/session.json")
        .then((r) => r.json())
        .then((s: RecordedSession) => {
          recorded.current = s;
          enable();
        })
        .catch(() => setStatus({ state: "off", message: "No recording at /_replay/session.json", problem: "unknown" }));
      return;
    }
    if (!capture.current) {
      capture.current = createDuelCapture(video.current, {
        scripted: scripted ? { motion: slingRoutine, fps: 30 } : null,
        recorded: recorded.current ? { session: recorded.current, fromS: Number(query.get("from")) || 0 } : null,
        onStatus: setStatus,
      });
      capture.current.onPose((p) => session.onPose(p));
    }
    void capture.current.start();
  }, [replay, scripted, query, session]);

  // The frame loop.
  useEffect(() => {
    let raf = 0,
      lastHud = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const c = canvas.current;
      if (!c) return;
      const now = performance.now();
      const w = c.clientWidth,
        h = c.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const sample = capture.current?.sample(now);
      const f = session.frame(now, {
        live: capture.current?.state() === "live",
        calibrated: !!sample?.calibrated,
        pose: sample?.pose ?? null,
      });
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawStage(ctx, w, h, f.stage);
      }
      const a = audio.current;
      if (a) {
        for (const cue of f.cues) {
          if (cue.kind === "whistle") a.whistle(cue.seconds ?? 1, cue.quiet);
          else a[cue.kind]();
        }
        a.hum(f.hud.fan);
      }
      if (now - lastHud > 100) {
        lastHud = now;
        setHud(f.hud);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  // Keys.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const now = performance.now();
      if (k === "n") session.nextLine(now);
      else if (k === "s") session.skipSetup();
      else if (k === "r") session.restartMatch(now);
      else if (k === "p") setPanel((v) => !v);
      else session.key(k);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [session]);

  useEffect(
    () => () => {
      capture.current?.stop();
      audio.current?.close();
    },
    [],
  );

  const set = (next: Parameters<DuelSession["set"]>[0]) => {
    session.set(next);
    setSettings(session.settings());
  };
  const live = status.state === "live";
  const m = hud?.match;
  const me = m?.me ?? 1;
  const them = (1 - me) as 0 | 1;
  const portrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth * 1.1;
  const hearts = (n: number) => "●".repeat(Math.max(0, n)) + "○".repeat(Math.max(0, 4 - n));

  return (
    <div className={`duel${panel ? " has-panel" : ""}`}>
      <video ref={video} className="duel-video" playsInline muted />
      <canvas ref={canvas} className="duel-canvas" />
      <div className="duel-top">
        <button className="duel-link" onClick={onBack}>
          ←
        </button>
        {MODES.map((x) => (
          <a key={x.id} className={`duel-tab${x.id === mode ? " is-on" : ""}`} href={`?duel=1${x.q ? `&${x.q}` : ""}${replay ? "&replay" : ""}${scripted ? "&scripted" : ""}`}>
            {x.label}
          </a>
        ))}
        <span className="duel-spacer" />
        {m && (
          // Each player's hearts on the side of the screen their figure stands.
          <span className="duel-score">
            <b className={me === 0 ? "is-me" : "is-them"}>{hearts(m.hearts[0])}</b>
            <span>
              R{m.round} · you {m.score[me]}–{m.score[them]} · {m.phase === "play" ? `${Math.floor(m.clock)} s` : m.phase}
            </span>
            <b className={me === 1 ? "is-me" : "is-them"}>{hearts(m.hearts[1])}</b>
          </span>
        )}
        <span className="duel-spacer" />
        <button className="duel-link" onClick={() => setMuted((v) => (audio.current?.setMuted(!v), !v))}>
          {muted ? "sound off" : "sound on"}
        </button>
        <button className="duel-link" onClick={() => setPanel((v) => !v)}>
          {panel ? "hide panel" : "panel"}
        </button>
      </div>

      {live && portrait && <div className="duel-line">Turn the phone sideways: the duel needs a wide picture.</div>}
      {(!live || hud?.prompt) && (
        <div className="duel-prompt">
          {!live ? (
            <>
              <h1>{mode === "probe" ? "Sling probe" : mode === "sling" ? "Test 1 · the sling" : mode === "dodge" ? "Test 2 · the dodge" : "Test 3 · the duel"}</h1>
              <p>
                {replay ? "Plays your saved recording instead of the camera." : scripted ? "A scripted person, no camera." : "Laptop on the desk, you about 1.5 m back, the camera sees you from above your head to your hips."}
              </p>
              <button className="duel-go" onClick={enable}>
                {status.state === "starting" ? status.message || "Starting…" : "Start camera"}
              </button>
              {status.problem && <p className="duel-warn">{status.message}</p>}
            </>
          ) : (
            <>
              <h1>{hud?.prompt}</h1>
              {hud?.sub && <p>{hud.sub}</p>}
            </>
          )}
        </div>
      )}

      {hud?.sling && live && (
        <div className="duel-check">
          <span data-ok={hud.sling.armOut}>1 · arm out to the side</span>
          <span data-ok={hud.sling.pulled}>2 · other hand pulled back</span>
          <span data-ok={hud.sling.hold >= 1 || hud.sling.ready}>3 · hold still {hud.sling.ready ? "" : `${Math.round(hud.sling.hold * 100)}%`}</span>
          <span data-ok={hud.sling.ready} data-go={hud.sling.ready}>4 · FLICK back</span>
        </div>
      )}
      {hud?.line && live && hud.step === "play" && (
        <div className="duel-line">
          {hud.line.text}
          {hud.asking && <em> · Keep still for "mine", or both hands on your head for "not mine"{mode === "dodge" ? ", one arm out for 'I guessed wrong'" : ""}.</em>}
        </div>
      )}

      {panel && (
        <aside className="duel-panel">
          {hud?.lines.length ? (
            <table>
              <tbody>
                {hud.lines.map((l) => (
                  <tr key={l.id} data-pass={l.pass === null ? "" : String(l.pass)}>
                    <td>{l.name}</td>
                    <td>{l.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {hud?.numbers.length ? (
            <dl>
              {hud.numbers.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="duel-buttons">
            {(mode === "sling" || mode === "probe") && <button onClick={() => session.nextLine(performance.now())}>Next {mode === "probe" ? "step" : "line"} (N)</button>}
            {hud?.step === "holds" && <button onClick={() => session.skipSetup()}>Skip set-up (S)</button>}
            {mode === "duel" && <button onClick={() => session.restartMatch(performance.now())}>New match (R)</button>}
            <button onClick={() => download("spar-duel-session", capture.current?.recording() ?? null)}>Save recording</button>
            <button onClick={() => download(`spar-duel-${mode}-log`, session.report())}>Save log</button>
          </div>
          <div className="duel-switches">
            <label>
              release
              <select value={settings.release} onChange={(e) => set({ release: e.target.value as "flick" | "still" })}>
                <option value="flick">flick</option>
                <option value="still">hold still</option>
              </select>
            </label>
            <label>
              aim
              <select value={settings.aim} onChange={(e) => set({ aim: e.target.value as "line" | "height" })}>
                <option value="line">hand line</option>
                <option value="height">by height</option>
              </select>
            </label>
            {mode === "sling" && (
              <>
                <label>
                  look
                  <select value={settings.look} onChange={(e) => set({ look: e.target.value as "ball" | "arrow" })}>
                    <option value="ball">ball</option>
                    <option value="arrow">arrow</option>
                  </select>
                </label>
                <label>
                  launch delay
                  <select value={settings.launchDelayMs} onChange={(e) => set({ launchDelayMs: Number(e.target.value) })}>
                    <option value={0}>0</option>
                    <option value={150}>+0.15 s</option>
                  </select>
                </label>
              </>
            )}
            {mode === "duel" && (
              <label>
                dark balls
                <select value={settings.dark} onChange={(e) => set({ dark: e.target.value as "always" | "squeeze" | "off" })}>
                  <option value="always">always</option>
                  <option value="squeeze">only in the Squeeze</option>
                  <option value="off">never</option>
                </select>
              </label>
            )}
          </div>
          <p className="duel-status">
            {status.message}
            {capture.current ? ` · ${capture.current.camera()}` : ""}
          </p>
        </aside>
      )}
    </div>
  );
}
