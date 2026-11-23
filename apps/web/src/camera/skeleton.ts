import { LM, type Landmark, type PoseFrame, type Stance } from '@spar/protocol';

/** BlazePose 33-point topology (same pairs as PoseLandmarker.POSE_CONNECTIONS, inlined so the overlay has no MediaPipe import). */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

const LEFT_ARM = new Set([13, 15, 17, 19, 21]);
const RIGHT_ARM = new Set([14, 16, 18, 20, 22]);

export type WristState = 'idle' | 'extending' | 'fired' | 'retracting';

export interface DrawOptions {
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /** Mirror x to match a CSS scaleX(-1) video. */
  mirror: boolean;
  stance: Stance;
  wrists: { lead: WristState; rear: WristState };
  /** Draw the chin box (guard target) around the live nose. */
  chinBox?: boolean;
  /** Minimum visibility to draw a landmark at full alpha. */
  minVisibility?: number;
}

const COLORS = {
  red: '#e23b4a',
  blue: '#5b8bf0',
  bone: 'rgba(236, 235, 230, 0.85)',
  faint: 'rgba(236, 235, 230, 0.35)',
  amber: '#f2b134',
  white: '#ffffff',
  green: '#4fd18b',
};

export function wristStateFromLabel(label: string | null | undefined): WristState {
  if (!label) return 'idle';
  const s = label.toUpperCase();
  if (s.includes('FIRE') || s.includes('PEAK') || s.includes('HIT')) return 'fired';
  if (s.includes('EXT')) return 'extending';
  if (s.includes('RETR') || s.includes('RECOV') || s.includes('RETURN')) return 'retracting';
  return 'idle';
}

function wristColor(state: WristState, base: string): string {
  switch (state) {
    case 'extending':
      return COLORS.amber;
    case 'fired':
      return COLORS.white;
    case 'retracting':
      return COLORS.green;
    default:
      return base;
  }
}

/**
 * Draw the skeleton, chin box and wrist highlights for one frame. Coordinates are the
 * image-normalized landmarks (0..1); `mirror` flips x so the overlay matches a mirrored preview.
 */
export function drawPose(ctx: CanvasRenderingContext2D, frame: PoseFrame | null, o: DrawOptions): void {
  const { width: W, height: H } = o;
  ctx.clearRect(0, 0, W, H);
  if (!frame || frame.lm.length < 33) return;
  const lm = frame.lm;
  const minV = o.minVisibility ?? 0.35;
  const px = (l: Landmark) => (o.mirror ? (1 - l.x) * W : l.x * W);
  const py = (l: Landmark) => l.y * H;
  const leadIsLeft = o.stance === 'orthodox';
  const armColor = (idx: number): string | null => {
    if (LEFT_ARM.has(idx)) return leadIsLeft ? COLORS.red : COLORS.blue;
    if (RIGHT_ARM.has(idx)) return leadIsLeft ? COLORS.blue : COLORS.red;
    return null;
  };

  const scale = Math.max(1, Math.min(W, H) / 540);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Bones
  for (const [a, b] of POSE_CONNECTIONS) {
    const la = lm[a];
    const lb = lm[b];
    if (!la || !lb) continue;
    const vis = Math.min(la.v, lb.v);
    const c = armColor(a) ?? armColor(b) ?? COLORS.bone;
    ctx.strokeStyle = c;
    ctx.globalAlpha = vis < minV ? 0.25 : 1;
    ctx.lineWidth = (armColor(a) || armColor(b) ? 4 : 2.5) * scale;
    ctx.beginPath();
    ctx.moveTo(px(la), py(la));
    ctx.lineTo(px(lb), py(lb));
    ctx.stroke();
  }

  // Joints
  ctx.globalAlpha = 1;
  for (let i = 0; i < lm.length; i++) {
    const l = lm[i];
    if (i >= 1 && i <= 10 && i !== 0) continue; // skip face detail except nose
    ctx.fillStyle = armColor(i) ?? COLORS.bone;
    ctx.globalAlpha = l.v < minV ? 0.25 : 0.95;
    ctx.beginPath();
    ctx.arc(px(l), py(l), 3.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Chin box: ±0.6 shoulder-widths around mid-shoulder, from just above the nose to nose + 0.25.
  const ls = lm[LM.L_SHOULDER];
  const rs = lm[LM.R_SHOULDER];
  const nose = lm[LM.NOSE];
  if (o.chinBox !== false && ls && rs && nose && Math.min(ls.v, rs.v, nose.v) >= minV) {
    const cx = (px(ls) + px(rs)) / 2;
    const u = Math.hypot(px(ls) - px(rs), py(ls) - py(rs));
    if (u > 4) {
      const x0 = cx - 0.6 * u;
      const x1 = cx + 0.6 * u;
      const y0 = py(nose) - 0.2 * u;
      const y1 = py(nose) + 0.25 * u;
      ctx.save();
      ctx.setLineDash([6 * scale, 5 * scale]);
      ctx.strokeStyle = 'rgba(236, 235, 230, 0.6)';
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      ctx.fillStyle = 'rgba(236, 235, 230, 0.7)';
      ctx.font = `${11 * scale}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText('CHIN', x0 + 4 * scale, y0 - 2 * scale);
    }
  }

  // Wrist highlights by punch state
  const leadWrist = leadIsLeft ? lm[LM.L_WRIST] : lm[LM.R_WRIST];
  const rearWrist = leadIsLeft ? lm[LM.R_WRIST] : lm[LM.L_WRIST];
  const drawWrist = (w: Landmark | undefined, state: WristState, base: string, label: string) => {
    if (!w || w.v < minV) return;
    const r = (state === 'fired' ? 16 : state === 'extending' ? 13 : 10) * scale;
    ctx.strokeStyle = wristColor(state, base);
    ctx.lineWidth = (state === 'idle' ? 2 : 3.5) * scale;
    ctx.beginPath();
    ctx.arc(px(w), py(w), r, 0, Math.PI * 2);
    ctx.stroke();
    if (state === 'fired') {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fill();
    }
    ctx.fillStyle = wristColor(state, base);
    ctx.font = `bold ${11 * scale}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText(label, px(w), py(w) + r + 3 * scale);
    ctx.textAlign = 'start';
  };
  drawWrist(leadWrist, o.wrists.lead, COLORS.red, 'LEAD');
  drawWrist(rearWrist, o.wrists.rear, COLORS.blue, 'REAR');
}
