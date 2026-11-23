import { JOINT } from "../pov/body";
import type { Figure, P2 } from "./body";
import type { Fan } from "./flight";
import { FIELD, FLIGHT, SLING, ZONES } from "./tune";

/**
 * The duel drawn flat on a 2D canvas, side view: two lanes, a low wall, the
 * figures as fat capsules, the goo balls. Nothing here decides anything; it
 * draws what it is given.
 *
 * Order matters: zones (head disc, chest plate) under the balls, arms, hips and
 * legs over them, so a ball passing through an arm reads as passing behind it.
 */
export interface FigureDraw {
  fig: Figure;
  colour: string;
  /** The darker shade for parts that never count. */
  shade: string;
  /** Balls held: glows on the back, with their clocks (0–1 left). */
  held?: number[];
  /** The sling's fan while a draw is held (what the other player reads). */
  fan?: { band: Fan; toward: 1 | -1; from: P2 } | null;
  /** The sling hand glows: near the camera picture's edge. */
  glow?: P2 | null;
  /** A ring at the pulling hand that fills while the draw is held still; green when ready to flick. */
  hold?: { at: P2; k: number; ready: boolean } | null;
  /** Small stains for the round. */
  stains?: P2[];
  /** Hit just now: flash. */
  flash?: number;
  /** The judged real body after a hit, as an outline. */
  ghost?: Figure | null;
  label?: string;
}
export interface BallDraw {
  at: P2;
  vel: P2;
  rim: string;
  /** Not drawn (dark until the wall), but the wall top pulses. */
  dark?: boolean;
  /** Squashed on an outline while the verdict waits. */
  squash?: boolean;
  /** A special look: an arrow instead of a ball (test 1 switch). */
  arrow?: boolean;
}
export interface Splat {
  at: P2;
  colour: string;
  /** 0–1 through its life. */
  k: number;
}
export interface FloatText {
  at: P2;
  text: string;
  colour: string;
  k: number;
}
export interface StageView {
  /** Each lane's back edge squeeze, metres lost: [left lane, right lane]. */
  squeeze: [number, number];
  figures: FigureDraw[];
  balls: BallDraw[];
  splats: Splat[];
  texts: FloatText[];
  /** Dotted paths: the aim stub, the last shot's trace. */
  paths: { pts: P2[]; colour: string; dashed?: boolean; width?: number }[];
  /** Rings on the floor or in the air: landing marks, targets. */
  rings: { at: P2; r: number; colour: string }[];
  /** The wall top pulses: a dark ball is coming. */
  wallPulse: number;
  /** Plain dummies and targets in the far lane are drawn as figures too. */
  now: number;
}

export const PALETTE = {
  sky: "#0d1019",
  floor: "#171c29",
  floorLine: "#2a3247",
  lane: "rgba(255,255,255,0.035)",
  wall: "#3b455c",
  wallTop: "#8592ad",
  me: "#f6ead6",
  meShade: "#8d8475",
  them: "#8fd8ec",
  themShade: "#4c7783",
  dummy: "#c9c3d9",
  dummyShade: "#6d6880",
  stone: "#7d7f86",
  squeeze: "#ff5d5d",
  text: "#f6ead6",
  goo: "#b8f36b",
};

/** Screen placement: metres to pixels. */
export function viewport(w: number, h: number) {
  const s = Math.min(w / FIELD.viewWidth, (h * 0.92) / FIELD.viewHeight);
  const ox = w / 2,
    oy = h - Math.max(18, h * 0.06);
  return {
    s,
    x: (x: number) => ox + x * s,
    y: (y: number) => oy - y * s,
    toField: (px: number, py: number): P2 => ({ x: (px - ox) / s, y: (oy - py) / s }),
  };
}

function capsule(ctx: CanvasRenderingContext2D, v: ReturnType<typeof viewport>, a: P2, b: P2, r: number, colour: string) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, r * 2 * v.s);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(v.x(a.x), v.y(a.y));
  ctx.lineTo(v.x(b.x), v.y(b.y));
  ctx.stroke();
}

function drawZones(ctx: CanvasRenderingContext2D, v: ReturnType<typeof viewport>, d: FigureDraw) {
  const f = d.fig;
  const base = f.stone ? PALETTE.stone : d.colour;
  const shade = f.stone ? "#55575c" : d.shade;
  // The trunk below the plate: never counts.
  const lh = f.j[JOINT.L_HIP],
    rh = f.j[JOINT.R_HIP];
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(v.x(f.chest.x0 + 0.02), v.y(f.chest.y0));
  ctx.lineTo(v.x(f.chest.x1 - 0.02), v.y(f.chest.y0));
  ctx.lineTo(v.x(rh.x + 0.04), v.y(rh.y - 0.02));
  ctx.lineTo(v.x(lh.x - 0.04), v.y(lh.y - 0.02));
  ctx.closePath();
  ctx.fill();
  // The neck.
  capsule(ctx, v, { x: (f.chest.x0 + f.chest.x1) / 2, y: f.chest.y1 }, f.head.c, 0.035, shade);
  // The chest plate, drawn exactly as judged.
  ctx.fillStyle = base;
  const r = 0.05 * v.s;
  const x0 = v.x(f.chest.x0),
    x1 = v.x(f.chest.x1),
    y0 = v.y(f.chest.y1),
    y1 = v.y(f.chest.y0);
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r);
  ctx.fill();
  // The head disc.
  ctx.beginPath();
  ctx.arc(v.x(f.head.c.x), v.y(f.head.c.y), f.head.r * v.s, 0, Math.PI * 2);
  ctx.fill();
  if (d.flash && d.flash > 0) {
    ctx.fillStyle = `rgba(255,90,90,${0.6 * d.flash})`;
    ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(v.x(f.head.c.x), v.y(f.head.c.y), f.head.r * v.s, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const st of d.stains ?? []) {
    ctx.fillStyle = "rgba(150,210,80,0.55)";
    ctx.beginPath();
    ctx.arc(v.x(st.x), v.y(st.y), 0.025 * v.s, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLimbs(ctx: CanvasRenderingContext2D, v: ReturnType<typeof viewport>, d: FigureDraw) {
  const f = d.fig;
  const base = f.stone ? PALETTE.stone : d.colour;
  const shade = f.stone ? "#55575c" : d.shade;
  const j = f.j;
  // Legs (invented below mid-thigh) and hips: never count.
  for (const [hip, k, ft] of [
    [j[JOINT.L_HIP], f.knees[0], f.feet[0]],
    [j[JOINT.R_HIP], f.knees[1], f.feet[1]],
  ] as const) {
    capsule(ctx, v, hip, k, 0.065, shade);
    capsule(ctx, v, k, ft, 0.055, shade);
  }
  capsule(ctx, v, j[JOINT.L_HIP], j[JOINT.R_HIP], 0.07, shade);
  // Arms: in the figure's colour, never count; the hand a little brighter.
  for (const side of [0, 1]) {
    const s = j[side ? JOINT.R_SHOULDER : JOINT.L_SHOULDER],
      e = j[side ? JOINT.R_ELBOW : JOINT.L_ELBOW],
      w = j[side ? JOINT.R_WRIST : JOINT.L_WRIST];
    const seen = f.w[side ? JOINT.R_WRIST : JOINT.L_WRIST] ?? 1;
    ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.min(1, seen));
    capsule(ctx, v, s, e, 0.045, base);
    capsule(ctx, v, e, w, 0.04, base);
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.arc(v.x(w.x), v.y(w.y), 0.05 * v.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Balls held, on the back.
  (d.held ?? []).forEach((left, i) => {
    const at = { x: f.shoulders.x + (i ? 0.12 : -0.12), y: f.shoulders.y + 0.02 };
    ctx.fillStyle = "rgba(246,234,214,0.9)";
    ctx.beginPath();
    ctx.arc(v.x(at.x), v.y(at.y), ZONES.ball * 0.7 * v.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = left < 0.25 ? "#ff6b5d" : d.colour;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(v.x(at.x), v.y(at.y), ZONES.ball * v.s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, left));
    ctx.stroke();
  });
  if (d.glow) {
    ctx.strokeStyle = "rgba(255,200,80,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(v.x(d.glow.x), v.y(d.glow.y), 0.09 * v.s, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (d.hold) {
    const r = 0.11 * v.s;
    const cx = v.x(d.hold.at.x),
      cy = v.y(d.hold.at.y);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = d.hold.ready ? "#7dff7a" : "#ffd27a";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (d.hold.ready ? 1 : d.hold.k));
    ctx.stroke();
    if (d.hold.ready) {
      ctx.fillStyle = "#7dff7a";
      ctx.font = `700 ${Math.round(Math.max(16, 0.09 * v.s))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("FLICK!", cx, cy - r - 8);
    }
  }
  if (d.ghost) {
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    const g = d.ghost;
    ctx.beginPath();
    ctx.arc(v.x(g.head.c.x), v.y(g.head.c.y), g.head.r * v.s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeRect(v.x(g.chest.x0), v.y(g.chest.y1), (g.chest.x1 - g.chest.x0) * v.s, (g.chest.y1 - g.chest.y0) * v.s);
    ctx.setLineDash([]);
  }
  if (d.label) {
    ctx.fillStyle = d.colour;
    ctx.font = `${Math.round(Math.max(12, 0.07 * v.s))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(d.label, v.x(f.hips.x), v.y(-0.0) + Math.max(14, 0.06 * v.s));
  }
}

function drawFan(ctx: CanvasRenderingContext2D, v: ReturnType<typeof viewport>, d: FigureDraw, now: number) {
  if (!d.fan) return;
  const bands: Record<Fan, [number, number]> = { flat: [SLING.angleMin, FLIGHT.fanFlat], middle: [FLIGHT.fanFlat, FLIGHT.fanMiddle], high: [FLIGHT.fanMiddle, SLING.angleMax] };
  const [a0, a1] = bands[d.fan.band];
  const r = 0.55 * v.s;
  const cx = v.x(d.fan.from.x),
    cy = v.y(d.fan.from.y);
  const toRad = (a: number) => (d.fan!.toward > 0 ? -(a * Math.PI) / 180 : Math.PI + (a * Math.PI) / 180);
  ctx.fillStyle = `rgba(255,214,120,${0.22 + 0.08 * Math.sin(now / 90)})`;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  const s0 = toRad(a0),
    s1 = toRad(a1);
  ctx.arc(cx, cy, r, Math.min(s0, s1), Math.max(s0, s1));
  ctx.closePath();
  ctx.fill();
}

export function drawStage(ctx: CanvasRenderingContext2D, w: number, h: number, view: StageView) {
  const v = viewport(w, h);
  ctx.fillStyle = PALETTE.sky;
  ctx.fillRect(0, 0, w, h);
  // Floor.
  ctx.fillStyle = PALETTE.floor;
  ctx.fillRect(0, v.y(0), w, h - v.y(0));
  ctx.strokeStyle = PALETTE.floorLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, v.y(0));
  ctx.lineTo(w, v.y(0));
  ctx.stroke();
  // Lanes, with the squeeze at their back edges.
  for (const [i, sign] of [
    [0, -1],
    [1, 1],
  ] as const) {
    const mid = sign * FIELD.laneMiddle;
    const back = view.squeeze[i];
    const near = mid - sign * FIELD.laneWidth / 2,
      far = mid + sign * (FIELD.laneWidth / 2 - back);
    ctx.fillStyle = PALETTE.lane;
    ctx.fillRect(v.x(Math.min(near, far)), v.y(2.3), Math.abs(far - near) * v.s, 2.3 * v.s);
    ctx.strokeStyle = back > 0 ? PALETTE.squeeze : PALETTE.floorLine;
    ctx.lineWidth = back > 0 ? 3 : 1;
    for (const x of [near, far]) {
      ctx.beginPath();
      ctx.moveTo(v.x(x), v.y(0));
      ctx.lineTo(v.x(x), v.y(0.08));
      ctx.stroke();
    }
    if (back > 0) {
      ctx.fillStyle = "rgba(255,93,93,0.12)";
      const x0 = far,
        x1 = mid + sign * (FIELD.laneWidth / 2);
      ctx.fillRect(v.x(Math.min(x0, x1)), v.y(2.3), Math.abs(x1 - x0) * v.s, 2.3 * v.s);
    }
  }
  // The wall.
  ctx.fillStyle = PALETTE.wall;
  ctx.fillRect(v.x(-FIELD.wallThick / 2), v.y(FIELD.wallHeight), FIELD.wallThick * v.s, FIELD.wallHeight * v.s);
  ctx.fillStyle = view.wallPulse > 0 ? `rgba(255,214,120,${0.5 + 0.5 * view.wallPulse})` : PALETTE.wallTop;
  ctx.fillRect(v.x(-FIELD.wallThick / 2 - 0.02), v.y(FIELD.wallHeight) - 3, (FIELD.wallThick + 0.04) * v.s, 6);
  // Rings and paths.
  for (const r of view.rings) {
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(v.x(r.at.x), v.y(r.at.y), r.r * v.s, Math.max(3, r.r * v.s * (r.at.y < 0.05 ? 0.25 : 1)), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const p of view.paths) {
    if (p.pts.length < 2) continue;
    ctx.strokeStyle = p.colour;
    ctx.lineWidth = p.width ?? 2;
    ctx.setLineDash(p.dashed ? [5, 6] : []);
    ctx.beginPath();
    ctx.moveTo(v.x(p.pts[0].x), v.y(p.pts[0].y));
    for (const q of p.pts.slice(1)) ctx.lineTo(v.x(q.x), v.y(q.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Figures: fans, then zones.
  for (const d of view.figures) drawFan(ctx, v, d, view.now);
  for (const d of view.figures) drawZones(ctx, v, d);
  // Ball shadows and balls.
  for (const b of view.balls) {
    if (b.dark) continue;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(v.x(b.at.x), v.y(0.01), ZONES.ball * v.s * 1.1, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const b of view.balls) {
    if (b.dark) continue;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const ang = Math.atan2(-b.vel.y, b.vel.x);
    ctx.save();
    ctx.translate(v.x(b.at.x), v.y(b.at.y));
    ctx.rotate(ang);
    const r = ZONES.ball * v.s;
    if (b.arrow) {
      ctx.strokeStyle = PALETTE.me;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-r * 3, 0);
      ctx.lineTo(r, 0);
      ctx.stroke();
      ctx.fillStyle = b.rim;
      ctx.beginPath();
      ctx.moveTo(r * 1.6, 0);
      ctx.lineTo(r * 0.6, -r * 0.5);
      ctx.lineTo(r * 0.6, r * 0.5);
      ctx.fill();
    } else {
      const stretch = b.squash ? 0.6 : 1 + Math.min(0.35, speed * 0.06);
      // A short tail.
      ctx.fillStyle = "rgba(246,234,214,0.18)";
      ctx.beginPath();
      ctx.ellipse(-r * 1.2, 0, r * 1.1, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f6ead6";
      ctx.strokeStyle = b.rim;
      ctx.lineWidth = Math.max(2, r * 0.3);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * stretch, r / stretch, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  // Limbs over the balls.
  for (const d of view.figures) drawLimbs(ctx, v, d);
  // Splats.
  for (const s of view.splats) {
    const r = (0.08 + 0.12 * s.k) * v.s;
    ctx.fillStyle = s.colour;
    ctx.globalAlpha = 1 - s.k;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      ctx.beginPath();
      ctx.arc(v.x(s.at.x) + Math.cos(a) * r, v.y(s.at.y) + Math.sin(a) * r, 0.025 * v.s * (1 - s.k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(v.x(s.at.x), v.y(s.at.y), r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Floating texts.
  ctx.textAlign = "center";
  for (const t of view.texts) {
    ctx.globalAlpha = Math.max(0, 1 - t.k);
    ctx.fillStyle = t.colour;
    ctx.font = `600 ${Math.round(Math.max(14, 0.075 * v.s))}px system-ui, sans-serif`;
    ctx.fillText(t.text, v.x(t.at.x), v.y(t.at.y + 0.15 * t.k));
    ctx.globalAlpha = 1;
  }
  // High balls above the view: an edge marker.
  for (const b of view.balls)
    if (!b.dark && v.y(b.at.y) < 0) {
      ctx.fillStyle = b.rim;
      ctx.beginPath();
      ctx.moveTo(v.x(b.at.x), 4);
      ctx.lineTo(v.x(b.at.x) - 8, 16);
      ctx.lineTo(v.x(b.at.x) + 8, 16);
      ctx.fill();
    }
}
