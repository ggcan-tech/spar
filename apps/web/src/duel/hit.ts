import { dist, p2, type Figure, type P2 } from "./body";
import { ZONES } from "./tune";

/**
 * Does a ball touch a figure's head disc or chest plate? Arms, hips and legs
 * never count. Zones are drawn exactly as they are judged.
 */
export type Zone = "head" | "chest";

/** Distance from point p to the segment a–b, and where along it (0–1) the nearest point is. */
function toSegment(p: P2, a: P2, b: P2): { d: number; k: number } {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { d: Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k)), k };
}

/** Distance from point p to a rectangle (0 inside). */
function toRect(p: P2, r: Figure["chest"]): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1),
    dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
  return Math.hypot(dx, dy);
}

/** How far the ball's edge is from each zone's edge (negative: overlapping). */
export function gaps(fig: Figure, ball: P2, r: number = ZONES.ball): { head: number; chest: number } {
  return {
    head: dist(ball, fig.head.c) - fig.head.r - r,
    chest: toRect(ball, fig.chest) - r,
  };
}

/** Which zone a ball at `ball` overlaps, head first; null for none. */
export function overlap(fig: Figure, ball: P2, r: number = ZONES.ball): Zone | null {
  const g = gaps(fig, ball, r);
  if (g.head <= 0) return "head";
  if (g.chest <= 0) return "chest";
  return null;
}

/**
 * The first touch of a ball moving from a to b this frame (swept, so a fast
 * ball cannot pass between two frames): the zone and how far along (0–1).
 */
export function sweep(fig: Figure, a: P2, b: P2, r: number = ZONES.ball): { zone: Zone; k: number; at: P2 } | null {
  const steps = Math.max(2, Math.ceil(dist(a, b) / 0.02));
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const q = p2(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
    const z = overlap(fig, q, r);
    if (z) return { zone: z, k, at: q };
  }
  return null;
}

/** The nearest the segment a–b comes to either zone, edge to edge, metres (for close calls). */
export function nearest(fig: Figure, a: P2, b: P2, r: number = ZONES.ball): number {
  const head = toSegment(fig.head.c, a, b).d - fig.head.r - r;
  const steps = Math.max(2, Math.ceil(dist(a, b) / 0.02));
  let chest = Infinity;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    chest = Math.min(chest, toRect(p2(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k), fig.chest) - r);
  }
  return Math.min(head, chest);
}

/**
 * Rule D: a touch on the drawn figure is held (the goo squashes on the outline)
 * until the pose captured `ruleDMs` after the drawn pose arrives. The hit counts
 * only if that later body overlaps too; otherwise the ball slides off.
 */
export interface Pending {
  ball: number;
  zone: Zone;
  at: P2;
  /** Capture time of the pose that was drawn at the touch. */
  cap: number;
  /** When the touch was drawn, ms (page clock). */
  drawnAt: number;
}

export type Verdict = { kind: "hit"; zone: Zone } | { kind: "slide"; gap: number } | { kind: "wait" };

/**
 * Judge a held touch against the poses that came after it. `later` is the
 * figure from the first pose captured at least `ruleDMs` after the touch's pose,
 * or null if none has arrived. After `giveUpMs` with no such pose (the camera
 * lost the body), the drawn touch stands alone.
 */
export function judge(p: Pending, later: Figure | null, now: number, giveUpMs = 250): Verdict {
  if (later) {
    const z = overlap(later, p.at);
    if (z) return { kind: "hit", zone: z };
    const g = gaps(later, p.at);
    return { kind: "slide", gap: Math.min(g.head, g.chest) };
  }
  if (now - p.drawnAt > giveUpMs) return { kind: "hit", zone: p.zone };
  return { kind: "wait" };
}
