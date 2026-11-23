import type { PunchKind } from '@spar/protocol';

/** Dark-ring palette shared by the canvas renderer and fight.css. */
export const COLORS = {
  bg: '#0e0f13',
  red: '#e23b4a',
  blue: '#5b8bf0',
  border: '#2c303a',
  fill: '#1a1c24',
  panel: '#15171d',
  text: '#e8e9ee',
  dim: '#8b8f9c',
  gold: '#f2c14e',
  amber: '#f0a030',
  green: '#6fcf7a',
  grey: '#9aa0ad',
  cyan: '#8fe3ff',
  white: '#ffffff',
} as const;

/** Everything is laid out in a virtual 16:9 stage and scaled to the canvas. */
export const STAGE_W = 1600;
export const STAGE_H = 900;

export const RING = {
  /** Where the opponent's feet sit. */
  floorY: 820,
  oppX: 800,
  figureW: 520,
  figureH: 640,
  horizonY: 300,
  ropesY: [330, 400, 470],
} as const;

/** Local player's picture-in-picture box (bottom-right). */
export const PIP = { x: 1290, y: 640, w: 280, h: 200 } as const;

/** index.html loads Barlow / Barlow Condensed / Anton; fall back to system faces. */
export const FONT = "'Barlow Condensed', 'Barlow', 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";
export const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

export interface Vec {
  x: number;
  y: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Exponential smoothing toward `target`; `rateMs` is the time constant. */
export function damp(current: number, target: number, rateMs: number, dtMs: number): number {
  if (dtMs <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-dtMs / rateMs));
}

/** Range → silhouette scale: 200 → 1.35×, 600 → 1.0×, 1000 → 0.7× (piecewise linear). */
export function rangeScale(range: number): number {
  const r = clamp(range, 200, 1000);
  return r <= 600 ? lerp(1.35, 1.0, (r - 200) / 400) : lerp(1.0, 0.7, (r - 600) / 400);
}

export type RangeZone = 'INSIDE' | 'MID' | 'OUT';

/** Inside < 300 (sim's straight-halving zone), OUT > 700 (beyond jab range). */
export function rangeZone(range: number): RangeZone {
  return range < 300 ? 'INSIDE' : range > 700 ? 'OUT' : 'MID';
}

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

/** Linear blend of two hex colours (t=0 → a). */
export function mixColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const ch = (shift: number) => Math.round(lerp((pa >> shift) & 255, (pb >> shift) & 255, clamp(t, 0, 1)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const PUNCH_LABEL: Record<PunchKind, string> = {
  JAB: 'JAB',
  CROSS: 'CROSS',
  LEAD_HOOK: 'LEAD HOOK',
  REAR_HOOK: 'REAR HOOK',
  LEAD_UPPER: 'LEAD UPPER',
  REAR_UPPER: 'REAR UPPER',
};

export function punchLabel(p: PunchKind | null | undefined, body?: boolean): string {
  if (!p) return '';
  return body ? `BODY ${PUNCH_LABEL[p]}` : PUNCH_LABEL[p];
}
