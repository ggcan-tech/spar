import { useEffect, useRef, useState } from "react";
import { readFlick, type FlickRead, type FlickSample } from "./flick";

/**
 * The flick probe (CORE.md stage 1, part 1E): a ball resting at the bottom of
 * the screen, three ways to flick it, a live readout, and every sample kept
 * for saving. Two-finger swipe (no click), press-drag, and touch.
 */
type Mode = "swipe" | "drag" | "touch";
export interface FlickRecord {
  mode: Mode;
  at: number;
  samples: FlickSample[];
  read: FlickRead | null;
  /** Raw wheel deltas for the swipe mode. */
  wheel?: { t: number; dx: number; dy: number }[];
}

export function FlickPad({ onFlick, canThrow }: { onFlick: (f: FlickRead) => void; canThrow: boolean }) {
  const [mode, setMode] = useState<Mode>(() => (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "touch" : "swipe"));
  const [last, setLast] = useState<FlickRead | null>(null);
  const [count, setCount] = useState(0);
  const records = useRef<FlickRecord[]>([]);
  const pad = useRef<HTMLDivElement>(null);
  const ball = useRef<HTMLDivElement>(null);
  const live = useRef<{ samples: FlickSample[]; rest: { x: number; y: number } } | null>(null);
  const onFlickRef = useRef(onFlick);
  onFlickRef.current = onFlick;
  const canRef = useRef(canThrow);
  canRef.current = canThrow;

  const restOf = () => {
    const r = ball.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight * 0.85 };
  };
  const finish = (samples: FlickSample[], rest: { x: number; y: number }, wheel?: FlickRecord["wheel"]) => {
    const read = readFlick(samples, rest, mode);
    records.current.push({ mode, at: performance.now(), samples, read, wheel });
    setCount(records.current.length);
    setLast(read);
    if (read && !read.drop && canRef.current) onFlickRef.current(read);
    if (ball.current) ball.current.style.transform = "";
  };

  // Two-finger swipe: wheel events, read as a finger moving the other way; the stroke ends when they stop.
  useEffect(() => {
    if (mode !== "swipe") return;
    const el = pad.current;
    if (!el) return;
    let wheel: { t: number; dx: number; dy: number }[] = [];
    let pos = { x: 0, y: 0 };
    let samples: FlickSample[] = [];
    let timer = 0;
    let peak = 0;
    const end = () => {
      if (samples.length > 2) {
        const rest = restOf();
        // Place the stroke so it starts on the ball.
        const s0 = samples[0];
        finish(
          samples.map((p) => ({ t: p.t, x: rest.x + (p.x - s0.x), y: rest.y + (p.y - s0.y) })),
          rest,
          wheel,
        );
      }
      wheel = [];
      samples = [];
      pos = { x: 0, y: 0 };
      peak = 0;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const t = e.timeStamp;
      wheel.push({ t, dx: e.deltaX, dy: e.deltaY });
      // The content scrolls with the fingers on a Mac ("natural"): the fingers move opposite to the delta.
      pos = { x: pos.x - e.deltaX, y: pos.y - e.deltaY };
      samples.push({ t, x: pos.x, y: pos.y });
      const n = samples.length;
      if (n > 1) {
        const v = Math.hypot(samples[n - 1].x - samples[n - 2].x, samples[n - 1].y - samples[n - 2].y) / Math.max(1, samples[n - 1].t - samples[n - 2].t);
        peak = Math.max(peak, v);
        // The fingers have lifted when the movement falls into its slow glide.
        if (peak > 0.5 && v < 0.35 * peak) {
          samples.pop();
          clearTimeout(timer);
          end();
          // Ignore the rest of the glide.
          suppressUntil = t + 400;
          return;
        }
      }
      clearTimeout(timer);
      timer = window.setTimeout(end, 70);
    };
    let suppressUntil = 0;
    const gate = (e: WheelEvent) => {
      if (e.timeStamp < suppressUntil) {
        e.preventDefault();
        return;
      }
      onWheel(e);
    };
    el.addEventListener("wheel", gate, { passive: false });
    return () => {
      el.removeEventListener("wheel", gate);
      clearTimeout(timer);
    };
  }, [mode]);

  const down = (e: React.PointerEvent) => {
    if (mode === "swipe") return;
    const rest = restOf();
    // Start on (or near) the ball.
    if (Math.hypot(e.clientX - rest.x, e.clientY - rest.y) > 90) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    live.current = { samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }], rest };
  };
  const move = (e: React.PointerEvent) => {
    const l = live.current;
    if (!l) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent as PointerEvent];
    for (const c of events) l.samples.push({ t: c.timeStamp, x: c.clientX, y: c.clientY });
    if (ball.current) ball.current.style.transform = `translate(${e.clientX - l.rest.x}px, ${e.clientY - l.rest.y}px) scale(1.12)`;
  };
  const up = (e: React.PointerEvent) => {
    const l = live.current;
    live.current = null;
    if (!l) return;
    l.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    finish(l.samples, l.rest);
  };
  const save = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ at: new Date().toISOString(), userAgent: navigator.userAgent, records: records.current })], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `spar-core-1-flick-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div
      ref={pad}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => (live.current = null)}
      style={{ position: "absolute", inset: 0, zIndex: 4, touchAction: "none", userSelect: "none" }}
    >
      <div style={{ position: "absolute", top: 12, left: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {/* No clicking on a laptop: the two-finger swipe; touch on a phone or tablet. Press-drag only with &drag. */}
        {(["swipe", "touch", ...(new URLSearchParams(location.search).has("drag") ? (["drag"] as Mode[]) : [])] as Mode[]).map((m) => (
          <button
            key={m}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMode(m)}
            style={{ font: "inherit", fontSize: 14, padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.3)", background: m === mode ? "#ffd27a" : "rgba(0,0,0,0.5)", color: m === mode ? "#111" : "#fff", cursor: "pointer" }}
          >
            {m === "swipe" ? "Two-finger swipe" : m === "drag" ? "Press and drag" : "Touch"}
          </button>
        ))}
        <button onPointerDown={(e) => e.stopPropagation()} onClick={save} style={{ font: "inherit", fontSize: 14, padding: "6px 12px", borderRadius: 8, border: 0, background: "#ffb35c", color: "#111", cursor: "pointer" }}>
          Save flicks ({count})
        </button>
      </div>
      <div style={{ position: "absolute", top: 54, left: 12, fontSize: 14, color: "#fff", background: "rgba(0,0,0,0.5)", padding: "6px 10px", borderRadius: 8, maxWidth: 420 }}>
        {mode === "swipe"
          ? "Swipe up with two fingers on the trackpad, fast, toward the opponent. No click."
          : mode === "drag"
            ? "Press on the ball, drag it, flick up and let go."
            : "Touch the ball, flick it up and let go."}
        {last && (
          <div style={{ marginTop: 4, opacity: 0.9 }}>
            {last.drop ? "Too slow or too short: no throw." : `${last.shot.toUpperCase()} · ${Math.round(last.power * 100)}% power · ${Math.round(last.launchSpeed * 10) / 10} m/s · aim ${Math.round(last.aim)}°`}
            <span style={{ opacity: 0.6 }}> · finger {Math.round(last.speed)} {last.device === "touch" ? "mm" : "px"}/s, let go {last.e.toFixed(2)} H up, bend {Math.round(last.bend)}°</span>
          </div>
        )}
      </div>
      <div
        ref={ball}
        style={{
          position: "absolute",
          left: "50%",
          bottom: "12%",
          width: 64,
          height: 64,
          marginLeft: -32,
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 30%, #fff3b0, #f2c230 55%, #a87b0a)",
          boxShadow: "0 6px 18px rgba(0,0,0,0.5)",
          opacity: canThrow ? 1 : 0.35,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
