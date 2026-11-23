import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import * as T from "three";
import { twoBone } from "../../pov/body";
import { PACK_URL, loadPack } from "./pack";
import { gloveOf, mirrorBody, sampleClip } from "./sampler";
import type { Body, Clip, Pack, PunchMark } from "./types";
import { distance, sub, v3 } from "./vec";

/**
 * A page for looking at the recorded clips: each one on a stick figure, a
 * frame at a time, with its events as ticks on a graph of the fists' speed
 * and reach. This is how the cuts are checked by eye.
 *
 * It stands alone: its own small three.js view, nothing from the game's
 * scene. It is not routed anywhere. To mount it, in whatever decides what to
 * show (App.tsx today):
 *
 *   import { ClipViewer } from "./box/motion/ClipViewer";
 *   if (new URLSearchParams(location.search).has("clips")) return <ClipViewer />;
 *
 * and open `/?clips`. `pack` may be handed in; otherwise it is fetched from
 * `/box/anim/pack.json`.
 */
const COLOR = { left: "#3b8eea", right: "#e8693a", body: "#d8dee9", floor: "#2a3441", back: "#10161d" };
const EVENTS: [keyof PunchMark["events"], string, string][] = [
  ["first", "first", "#8fbf7f"],
  ["seen", "seen", "#5f8f5f"],
  ["launch", "launch", "#e5c07b"],
  ["contact", "contact", "#ff5c5c"],
  ["guard", "home", "#9aa5b1"],
];

/** The series the graph draws for a clip: each fist's speed against the chest, and each punch's reach. */
function measure(clip: Clip) {
  const frames = Array.from({ length: clip.frames }, (_, f) => sampleClip(clip, f));
  const speed = [0, 1].map((h) =>
    frames.map((_, f) => {
      const a = frames[Math.max(0, f - 1)],
        b = frames[Math.min(clip.frames - 1, f + 1)];
      const span = (Math.min(clip.frames - 1, f + 1) - Math.max(0, f - 1)) / clip.fps;
      return span > 0 ? distance(sub(b.wrists[h], b.chest), sub(a.wrists[h], a.chest)) / span : 0;
    }),
  );
  // Reach: for a straight punch how far the glove is toward the player; for
  // a hook or uppercut how near it is to where the boxer was throwing.
  const reach = clip.punches.map((m) => {
    const h = m.hand === "lead" ? 0 : 1;
    return frames.map((b) => {
      const glove = gloveOf(b.shoulders[h], b.wrists[h]);
      return m.shape === "straight" ? glove.z : -distance(glove, m.contact.aim);
    });
  });
  return { speed, reach };
}

/** The stick figure: bones as thin rods, a head, two gloves. Points are in the opponent's frame; the view is the player's side. */
function createFigure(scene: T.Scene) {
  const rod = (color: string, radius: number) => {
    const mesh = new T.Mesh(new T.CylinderGeometry(radius, radius, 1, 8), new T.MeshBasicMaterial({ color }));
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  const ball = (radius: number, color: string) => {
    const mesh = new T.Mesh(new T.SphereGeometry(radius, 16, 12), new T.MeshBasicMaterial({ color }));
    scene.add(mesh);
    return mesh;
  };
  // Spine, neck, shoulders, hips' line; then for each side: upper arm, forearm, thigh, shin.
  const trunk = [0, 1, 2, 3].map(() => rod(COLOR.body, 0.018));
  const limbs = [COLOR.left, COLOR.right].map((color) => [0, 1, 2, 3].map(() => rod(color, 0.016)));
  const head = ball(0.1, COLOR.body);
  const gloves = [ball(0.075, COLOR.left), ball(0.075, COLOR.right)];
  const up = new T.Vector3(0, 1, 0);
  // The opponent's right is +x; seen from the player's side that is on the left of the picture.
  const at = (p: { x: number; y: number; z: number }) => new T.Vector3(-p.x, p.y, p.z);
  const put = (mesh: T.Mesh, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
    const from = at(a),
      to = at(b);
    const along = to.clone().sub(from);
    const length = Math.max(1e-4, along.length());
    mesh.position.copy(from).addScaledVector(along, 0.5);
    mesh.quaternion.setFromUnitVectors(up, along.divideScalar(length));
    mesh.scale.set(1, length, 1);
  };
  return {
    set(b: Body) {
      put(trunk[0], b.hips, b.chest);
      put(trunk[1], b.chest, b.head);
      put(trunk[2], b.shoulders[0], b.shoulders[1]);
      // The hips' own line, level with the hip joints.
      put(trunk[3], v3(b.hips.x - 0.1, b.hips.y - 0.04, b.hips.z), v3(b.hips.x + 0.1, b.hips.y - 0.04, b.hips.z));
      for (const h of [0, 1]) {
        put(limbs[h][0], b.shoulders[h], b.elbows[h]);
        put(limbs[h][1], b.elbows[h], b.wrists[h]);
        // Legs as the game draws them: hip joint to ankle, the knee solved.
        const side = h ? 1 : -1;
        const hip = v3(b.hips.x + side * 0.1, b.hips.y - 0.04, b.hips.z);
        const knee = twoBone(hip, b.feet[h], 0.5, 0.48, v3(side * 0.1, 0, 1));
        put(limbs[h][2], hip, knee);
        put(limbs[h][3], knee, b.feet[h]);
        gloves[h].position.copy(at(gloveOf(b.shoulders[h], b.wrists[h])));
      }
      head.position.copy(at(b.head));
    },
  };
}

export function ClipViewer({ pack: given, url = PACK_URL }: { pack?: Pack; url?: string }) {
  const [pack, setPack] = useState<Pack | null>(given ?? null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [mirror, setMirror] = useState(false);
  const [side, setSide] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  const graph = useRef<HTMLCanvasElement>(null);
  const figure = useRef<ReturnType<typeof createFigure> | null>(null);
  const draw = useRef<() => void>(() => {});
  const camera = useRef<T.PerspectiveCamera | null>(null);

  useEffect(() => {
    if (given) return;
    let alive = true;
    loadPack(url).then(
      (p) => alive && setPack(p),
      (e: unknown) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [given, url]);

  const clip = useMemo(() => (pack ? (pack.byId.get(id ?? "") ?? pack.clips[0] ?? null) : null), [pack, id]);
  const series = useMemo(() => (clip ? measure(clip) : null), [clip]);

  // The three.js view, made once.
  useEffect(() => {
    const host = view.current;
    if (!host) return;
    const renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setClearColor(COLOR.back);
    // The drawing size is set by hand; the element itself fills its box.
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(renderer.domElement);
    const scene = new T.Scene();
    const grid = new T.GridHelper(4, 16, COLOR.floor, COLOR.floor);
    scene.add(grid);
    const cam = new T.PerspectiveCamera(38, 1, 0.1, 30);
    camera.current = cam;
    figure.current = createFigure(scene);
    const size = () => {
      const w = host.clientWidth,
        h = host.clientHeight;
      renderer.setSize(w, h, false);
      cam.aspect = w / Math.max(1, h);
      cam.updateProjectionMatrix();
    };
    size();
    const watch = new ResizeObserver(size);
    watch.observe(host);
    draw.current = () => renderer.render(scene, cam);
    return () => {
      watch.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      figure.current = null;
    };
  }, []);

  // From the player's side, or from the opponent's left, level with its chest.
  useEffect(() => {
    const cam = camera.current;
    if (!cam) return;
    if (side) cam.position.set(3.3, 1.2, 0.35);
    else cam.position.set(0, 1.3, 3.6);
    cam.lookAt(0, 0.95, 0.35);
    draw.current();
  }, [side, pack]);

  // Playing: the frame runs on at the clip's rate times the speed chosen.
  useEffect(() => {
    if (!playing || !clip) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setFrame((f) => {
        const next = f + dt * clip.fps * rate;
        return next > clip.frames - 1 ? 0 : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip, rate]);

  useEffect(() => setFrame(0), [clip]);

  // The figure at this frame.
  useEffect(() => {
    if (!clip || !figure.current) return;
    const body = sampleClip(clip, Math.min(frame, clip.frames - 1));
    figure.current.set(mirror ? mirrorBody(body) : body);
    draw.current();
  }, [clip, frame, mirror]);

  // The graph: speeds, reach, event ticks, and where the frame is.
  useEffect(() => {
    const canvas = graph.current;
    if (!canvas || !clip || !series) return;
    const ratio = Math.min(2, window.devicePixelRatio);
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = COLOR.back;
    g.fillRect(0, 0, w, h);
    const x = (f: number) => 8 + (f / Math.max(1, clip.frames - 1)) * (w - 16);
    const top = 16,
      bottom = h - 18;
    // Speed: 0 to 10 metres a second, a faint line at each two.
    const y = (speed: number) => bottom - (Math.min(10, speed) / 10) * (bottom - top);
    g.strokeStyle = COLOR.floor;
    g.fillStyle = "#6b7785";
    g.font = "10px system-ui, sans-serif";
    for (let s = 0; s <= 10; s += 2) {
      g.beginPath();
      g.moveTo(8, y(s));
      g.lineTo(w - 8, y(s));
      g.stroke();
      g.fillText(`${s} m/s`, 10, y(s) - 2);
    }
    const line = (values: number[], color: string, at: (v: number) => number, dash: number[] = []) => {
      g.strokeStyle = color;
      g.setLineDash(dash);
      g.lineWidth = 1.5;
      g.beginPath();
      values.forEach((v, f) => (f ? g.lineTo(x(f), at(v)) : g.moveTo(x(f), at(v))));
      g.stroke();
      g.setLineDash([]);
    };
    line(series.speed[0], COLOR.left, y);
    line(series.speed[1], COLOR.right, y);
    // Reach, dashed, each punch's own scale: lowest at the bottom, greatest at the top.
    clip.punches.forEach((m, i) => {
      const values = series.reach[i];
      const low = Math.min(...values),
        high = Math.max(...values);
      line(values, m.hand === "lead" ? COLOR.left : COLOR.right, (v) => bottom - ((v - low) / Math.max(1e-6, high - low)) * (bottom - top), [5, 4]);
      for (const [key, label, color] of EVENTS) {
        const f = m.events[key];
        g.strokeStyle = color;
        g.lineWidth = key === "contact" ? 2 : 1;
        g.beginPath();
        g.moveTo(x(f), top - 6);
        g.lineTo(x(f), bottom + 4);
        g.stroke();
        g.fillStyle = color;
        g.fillText(label, x(f) + 2, top - 6 + 10 * (1 + (EVENTS.findIndex((e) => e[0] === key) % 3)));
      }
    });
    if (clip.step) {
      for (const f of [clip.step.start, clip.step.end]) {
        g.strokeStyle = "#e5c07b";
        g.beginPath();
        g.moveTo(x(f), top - 6);
        g.lineTo(x(f), bottom + 4);
        g.stroke();
      }
    }
    g.strokeStyle = "#ffffff";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x(frame), 0);
    g.lineTo(x(frame), h);
    g.stroke();
  }, [clip, series, frame]);

  const scrub = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!clip || !(e.buttons & 1)) return;
    const box = e.currentTarget.getBoundingClientRect();
    setPlaying(false);
    setFrame(Math.max(0, Math.min(clip.frames - 1, ((e.clientX - box.left - 8) / (box.width - 16)) * (clip.frames - 1))));
  };
  const step = (by: number) => {
    if (!clip) return;
    setPlaying(false);
    // Whole and half frames: events were timed at twice the clip's rate.
    setFrame((f) => Math.max(0, Math.min(clip.frames - 1, Math.round((f + by) * 2) / 2)));
  };
  const ms = (frames: number) => (clip ? Math.round((frames / clip.fps) * 1000) : 0);
  const button: CSSProperties = { background: "#1c2530", color: "#d8dee9", border: "1px solid #2f3b49", borderRadius: 6, padding: "6px 10px", font: "inherit", cursor: "pointer" };

  return (
    <div style={{ position: "fixed", inset: 0, display: "grid", gridTemplateColumns: "230px 1fr", background: COLOR.back, color: "#d8dee9", font: "13px system-ui, sans-serif" }}>
      <div style={{ overflowY: "auto", borderRight: "1px solid #2a3441", padding: 8 }}>
        <div style={{ opacity: 0.6, padding: "4px 6px 8px" }}>{pack ? `${pack.clips.length} clips` : (error ?? "Loading the clips…")}</div>
        {pack?.clips.map((c) => (
          <button
            key={c.id}
            onClick={() => setId(c.id)}
            style={{ ...button, display: "block", width: "100%", textAlign: "left", marginBottom: 4, background: c === clip ? "#2c5a8a" : "#1c2530" }}
          >
            {c.id}
            <span style={{ opacity: 0.55, float: "right" }}>{(c.frames / c.fps).toFixed(2)} s</span>
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateRows: "1fr auto 170px auto", minWidth: 0, minHeight: 0 }}>
        <div ref={view} style={{ minHeight: 0, overflow: "hidden" }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: 8, flexWrap: "wrap" }}>
          <button style={button} onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <button style={button} onClick={() => step(-1)}>‹ frame</button>
          <button style={button} onClick={() => step(-0.5)}>‹ ½</button>
          <button style={button} onClick={() => step(0.5)}>½ ›</button>
          <button style={button} onClick={() => step(1)}>frame ›</button>
          {[1, 0.5, 0.25, 0.1].map((r) => (
            <button key={r} style={{ ...button, background: r === rate ? "#2c5a8a" : "#1c2530" }} onClick={() => setRate(r)}>{r}×</button>
          ))}
          <button style={{ ...button, background: side ? "#2c5a8a" : "#1c2530" }} onClick={() => setSide((s) => !s)}>From the side</button>
          <button style={{ ...button, background: mirror ? "#2c5a8a" : "#1c2530" }} onClick={() => setMirror((m) => !m)}>Southpaw</button>
          <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
            frame {frame.toFixed(1)} of {clip ? clip.frames - 1 : 0} · {ms(frame)} ms
          </span>
        </div>
        <canvas ref={graph} onPointerDown={scrub} onPointerMove={scrub} style={{ width: "100%", height: 170, touchAction: "none", cursor: "ew-resize" }} />
        <div style={{ padding: "6px 10px 10px", lineHeight: 1.5, minHeight: 64 }}>
          {clip && (
            <>
              <div>
                <b>{clip.id}</b> · {clip.source} frames {clip.from}–{clip.to} (120/s){clip.mirrored ? " · mirrored from southpaw" : ""}
                {clip.other === "busy" ? " · other arm taken from the guard" : ""}
                {clip.step ? ` · step ${clip.step.dir}, ${clip.step.travel.toFixed(2)} m in ${ms(clip.step.end - clip.step.start)} ms` : ""}
              </div>
              {clip.punches.map((m, i) => (
                <div key={i} style={{ color: m.hand === "lead" ? COLOR.left : COLOR.right }}>
                  {m.kind} ({m.hand} hand, {m.shape}, {m.level}): first movement to launch {ms(m.events.launch - m.events.first)} ms (stands out for {ms(m.events.launch - m.events.seen)}), launch to contact{" "}
                  {ms(m.events.contact - m.events.launch)} ms, contact to home {ms(m.events.guard - m.events.contact)} ms; lands at {m.contact.hand.x.toFixed(2)}, {m.contact.hand.y.toFixed(2)},{" "}
                  {m.contact.hand.z.toFixed(2)}
                </div>
              ))}
              <div style={{ opacity: 0.55 }}>Solid: each fist's speed against the chest (blue its left, orange its right). Dashed: reach. Drag on the graph to move through the clip.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
