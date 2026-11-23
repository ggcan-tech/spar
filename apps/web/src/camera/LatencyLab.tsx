import { useEffect, useRef, useState } from "react";
import { createFlashProbe } from "../box/probe";

/**
 * The delay test page (CORE.md stage 1, part 1D): `?lab=latency`.
 *
 * The screen flashes white 24 times at uneven gaps; the camera's picture is
 * watched for each flash. Flash → seen is the screen's delay plus the camera's:
 * the part of the game's delay no code can remove. It also reports the facts
 * that decide the rest: the browser, how often the screen really draws, the
 * camera's size and pictures a second, and (where the browser says) how long a
 * camera picture takes to reach the page. `&cam=iphone` picks a camera whose
 * name contains that word.
 */
const FLASHES = 24;

interface Facts {
  browser: string;
  displayHz: number | null;
  cameras: { label: string; maxFps: number | null }[];
  using: string;
  size: string;
  cameraFps: number | null;
  /** Camera time stamp → the page has the picture, ms (only where the browser gives the capture time). */
  toPageMs: number | null;
}
interface Result {
  at: string;
  flashLoopMs: number | null;
  spreadMs: number;
  found: number;
  flashes: number;
  /** The screen's delay plus the camera's before its time stamp: what hits are judged with. */
  judgeMs: number | null;
  facts: Facts;
}

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);

function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return `Chrome ${ua.match(/Chrome\/(\d+)/)?.[1] ?? ""}`;
  if (/Safari\//.test(ua)) return `Safari ${ua.match(/Version\/(\d+)/)?.[1] ?? ""}`;
  if (/Firefox\//.test(ua)) return "Firefox";
  return "unknown";
}

/** How often the screen really draws, from a second of animation frames. */
function measureDisplay(): Promise<number> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      if (times.length < 90) requestAnimationFrame(tick);
      else {
        const gaps = times.slice(1).map((t2, i) => t2 - times[i]);
        const m = median(gaps) ?? 16.7;
        resolve(Math.round(1000 / m));
      }
    };
    requestAnimationFrame(tick);
  });
}

export function LatencyLab() {
  const video = useRef<HTMLVideoElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "ready" | "flashing" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [count, setCount] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const stop = useRef<() => void>(() => {});

  useEffect(() => () => stop.current(), []);

  async function start() {
    setPhase("starting");
    setMessage("Opening the camera…");
    try {
      const want = new URLSearchParams(location.search).get("cam")?.toLowerCase() ?? "";
      // Ask once so the cameras' names are readable.
      const first = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      first.getTracks().forEach((t) => t.stop());
      const chosen = (want && devices.find((d) => d.label.toLowerCase().includes(want))) || devices[0];
      const cameras: Facts["cameras"] = [];
      for (const d of devices) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } });
          const track = s.getVideoTracks()[0];
          const caps = track.getCapabilities?.() as MediaTrackCapabilities | undefined;
          cameras.push({ label: d.label || "camera", maxFps: caps?.frameRate?.max ?? null });
          s.getTracks().forEach((t) => t.stop());
        } catch {
          cameras.push({ label: d.label || "camera", maxFps: null });
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: chosen ? { exact: chosen.deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
        audio: false,
      });
      const v = video.current!;
      v.srcObject = stream;
      await v.play();
      const track = stream.getVideoTracks()[0];
      const set = track.getSettings();
      const displayHz = await measureDisplay();
      // Every camera picture: its brightness, when the page got it, and how old it was.
      const probe = createFlashProbe();
      const small = document.createElement("canvas");
      small.width = 32;
      small.height = 18;
      const pen = small.getContext("2d", { willReadFrequently: true });
      const arrivals: number[] = [];
      const toPage: number[] = [];
      let alive = true;
      type Meta = { captureTime?: number; receiveTime?: number; mediaTime?: number };
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: Meta) => void) => number }).requestVideoFrameCallback?.bind(v);
      const look = (now: number) => {
        if (!pen || !v.videoWidth) return;
        try {
          pen.drawImage(v, 0, 0, 32, 18);
          const d = pen.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          probe.brightness(now, sum / (d.length / 4));
        } catch {
          // Unreadable picture: no flash will be found.
        }
      };
      if (rvfc) {
        const onFrame = (now: number, meta: Meta) => {
          if (!alive) return;
          const t = performance.now();
          arrivals.push(t);
          if (typeof meta.captureTime === "number" && meta.captureTime > 0) toPage.push(t - meta.captureTime);
          look(t);
          rvfc(onFrame);
        };
        rvfc(onFrame);
      } else {
        const loop = () => {
          if (!alive) return;
          look(performance.now());
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }
      stop.current = () => {
        alive = false;
        stream.getTracks().forEach((t) => t.stop());
      };
      const facts = (): Facts => {
        const recent = arrivals.slice(-121);
        const gaps = recent.slice(1).map((t, i) => t - recent[i]);
        const fps = gaps.length > 5 ? Math.round(1000 / (median(gaps.filter((g) => g > 0)) ?? 33)) : null;
        return {
          browser: browserName(),
          displayHz,
          cameras,
          using: chosen?.label || track.label || "camera",
          size: `${set.width ?? "?"}×${set.height ?? "?"}`,
          cameraFps: fps,
          toPageMs: median(toPage),
        };
      };
      setPhase("ready");
      setMessage("Sit about half a metre from the screen, facing it. Dim the lights if you can. Press Flash.");
      runFlashes.current = async () => {
        setPhase("flashing");
        setMessage("Keep still. The screen will flash 24 times.");
        const el = flash.current!;
        await new Promise((r) => setTimeout(r, 1500));
        for (let i = 0; i < FLASHES; i++) {
          // Show on the next drawn frame, and stamp it there.
          await new Promise<void>((r) =>
            requestAnimationFrame(() => {
              el.style.opacity = "1";
              probe.flash(performance.now());
              r();
            }),
          );
          await new Promise((r) => setTimeout(r, 60));
          el.style.opacity = "0";
          setCount(i + 1);
          // Uneven gaps, so a steady flicker in the room cannot pass for a flash.
          await new Promise((r) => setTimeout(r, 450 + ((i * 137) % 280)));
        }
        await new Promise((r) => setTimeout(r, 500));
        const f = probe.result();
        const fx = facts();
        const made: Result = {
          at: new Date().toISOString(),
          flashLoopMs: f.ms,
          spreadMs: f.spreadMs,
          found: f.found,
          flashes: f.flashes,
          judgeMs: f.ms !== null && fx.toPageMs !== null ? Math.round(f.ms - fx.toPageMs) : null,
          facts: fx,
        };
        setResult(made);
        setPhase("done");
        setMessage(f.ms === null ? "The flashes were not seen. Sit nearer the screen, facing it, lights lower, and try again." : "Done. Press Save, and send the file.");
      };
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }
  const runFlashes = useRef<() => Promise<void>>(async () => {});

  const save = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `spar-core-1-latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const big = (label: string, value: string, note = "") => (
    <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.06)", borderRadius: 10, minWidth: 170 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 650 }}>{value}</div>
      {note && <div style={{ fontSize: 12, opacity: 0.6 }}>{note}</div>}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0d1019", color: "#f3efe6", fontFamily: "system-ui, sans-serif", padding: 24, overflow: "auto" }}>
      <video ref={video} playsInline muted style={{ position: "absolute", width: 160, right: 16, bottom: 16, borderRadius: 8, opacity: 0.6, transform: "scaleX(-1)" }} />
      <h1 style={{ margin: "0 0 6px", fontSize: 30 }}>Delay test</h1>
      <p style={{ margin: "0 0 16px", maxWidth: 680, opacity: 0.85 }}>
        This measures how long your screen and camera take, the part of the delay no code can remove. It takes about one minute. Use Chrome.
      </p>
      <p style={{ margin: "0 0 16px", fontSize: 18 }}>{message}</p>
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {(phase === "idle" || phase === "error") && (
          <button onClick={start} style={btn}>
            Start camera
          </button>
        )}
        {(phase === "ready" || phase === "done") && (
          <button onClick={() => void runFlashes.current()} style={btn}>
            {phase === "done" ? "Flash again" : "Flash"}
          </button>
        )}
        {phase === "done" && (
          <button onClick={save} style={btn}>
            Save
          </button>
        )}
        {phase === "flashing" && <span style={{ fontSize: 22 }}>{count} / {FLASHES}</span>}
      </div>
      {result && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, maxWidth: 900 }}>
          {big("Screen + camera (flash loop)", result.flashLoopMs === null ? "not seen" : `${Math.round(result.flashLoopMs)} ms`, `${result.found} of ${result.flashes} flashes seen · spread ${Math.round(result.spreadMs)} ms`)}
          {big("Screen draws", result.facts.displayHz ? `${result.facts.displayHz} Hz` : "?", result.facts.browser)}
          {big("Camera", result.facts.cameraFps ? `${result.facts.cameraFps} fps` : "?", `${result.facts.size} · ${result.facts.using}`)}
          {big("Camera → page", result.facts.toPageMs === null ? "not given" : `${Math.round(result.facts.toPageMs)} ms`, "where the browser says")}
          {big("Used to judge hits", result.judgeMs === null ? "50 ms (default)" : `${result.judgeMs} ms`)}
        </div>
      )}
      {result && (
        <p style={{ marginTop: 16, opacity: 0.8, maxWidth: 760 }}>
          Cameras on this computer: {result.facts.cameras.map((c) => `${c.label} (up to ${c.maxFps ?? "?"} fps)`).join(" · ")}.
          {result.flashLoopMs !== null && result.flashLoopMs >= 70 ? " This camera and screen alone take 70 ms or more: a 60 fps camera would help." : ""}
        </p>
      )}
      <div ref={flash} style={{ position: "fixed", inset: 0, background: "#fff", opacity: 0, pointerEvents: "none", zIndex: 10 }} />
    </div>
  );
}

const btn: React.CSSProperties = {
  font: "inherit",
  fontSize: 18,
  fontWeight: 600,
  padding: "10px 22px",
  borderRadius: 10,
  border: 0,
  background: "#ffb35c",
  color: "#0d1019",
  cursor: "pointer",
};
