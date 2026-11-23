import { LM, type PoseFrame, type Stance } from '@spar/protocol';
import { DEFAULTS, mergeOptions, type GestureOptions } from './defaults';
import { OneEuroPoint } from './oneEuro';
import { dist3, toBodyFrame } from './bodyFrame';

export interface Calibration {
  stance: Stance;
  /** max wrist–shoulder distance per hand, body units (shoulder widths). */
  armLen: { lead: number; rear: number };
  /** median shoulder width in image-normalized units (STEP_IN/OUT reference). */
  shoulderWBaseline: number;
  /** chin box center y in body units (= neutral nose y + guard.chinOffset). */
  chinY: number;
  /** neutral nose y in image-normalized units (aspect-corrected) — DUCK reference. */
  neutralNoseY: number;
  /** neutral nose position in body units (SLIP reference / chin box). */
  neutralNoseX: number;
  neutralNoseBodyY: number;
  /**
   * true for `defaultCalibration()`: the engine snaps the image-space baselines (neutralNoseY,
   * shoulderWBaseline, neutral nose body position) from the first valid frame it sees.
   */
  auto: boolean;
}

/** Arm length used when calibration saw no extension. ≈2.2 shoulder widths for a bladed stance. */
export const DEFAULT_ARM_LEN = 2.2;
const DEFAULT_NOSE_BODY_Y = -0.65;

export function defaultCalibration(stance: Stance = 'orthodox'): Calibration {
  return {
    stance,
    armLen: { lead: DEFAULT_ARM_LEN, rear: DEFAULT_ARM_LEN },
    shoulderWBaseline: 0.2,
    chinY: DEFAULT_NOSE_BODY_Y + DEFAULTS.guard.chinOffset,
    neutralNoseY: 0.35,
    neutralNoseX: 0,
    neutralNoseBodyY: DEFAULT_NOSE_BODY_Y,
    auto: true,
  };
}

function median(xs: number[], fallback: number): number {
  if (xs.length === 0) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Calibrate from ~2 s of frames: guard stance, then full arm extensions (each hand).
 * - armLen = max wrist–shoulder distance per hand (body units), from One-Euro-filtered landmarks
 * - shoulderWBaseline = median shoulder width (image units)
 * - chinY = median nose body-y + 0.25; neutralNoseY = median image nose y
 * - stance (if not given): the shoulder that is closer to the camera (smaller z on average) is the lead.
 */
export function calibrate(frames: PoseFrame[], stance?: Stance, opts?: GestureOptions): Calibration {
  const o = mergeOptions(DEFAULTS, opts);
  const vmin = o.visibilityMin;
  const filters: OneEuroPoint[] = [];
  const dists: Record<'L' | 'R', number[]> = { L: [], R: [] };
  const sws: number[] = [];
  const noseY: number[] = [];
  const noseBX: number[] = [];
  const noseBY: number[] = [];
  let zL = 0, zR = 0, zN = 0;
  let tPrev = -Infinity;

  for (const raw of frames) {
    if (!(raw.t > tPrev)) continue;
    tPrev = raw.t;
    const lm = raw.lm.map((p, i) => {
      if (p.v < vmin) { filters[i]?.reset(); return p; }
      const f = (filters[i] ??= new OneEuroPoint(o.filter.minCutoff, o.filter.beta, o.filter.dCutoff));
      const q = f.filter(p, raw.t);
      return { x: q.x, y: q.y, z: q.z, v: p.v };
    });
    const bf = toBodyFrame({ t: raw.t, lm, world: raw.world }, o.aspect, vmin);
    if (!bf.valid) continue;
    sws.push(bf.shoulderWidthPx);
    if (bf.vis[LM.NOSE] >= vmin) {
      noseY.push(bf.noseYImg);
      noseBX.push(bf.pts[LM.NOSE].x);
      noseBY.push(bf.pts[LM.NOSE].y);
    }
    zL += lm[LM.L_SHOULDER].z; zR += lm[LM.R_SHOULDER].z; zN++;
    if (bf.vis[LM.L_WRIST] >= vmin) dists.L.push(dist3(bf.pts[LM.L_WRIST], bf.pts[LM.L_SHOULDER]));
    if (bf.vis[LM.R_WRIST] >= vmin) dists.R.push(dist3(bf.pts[LM.R_WRIST], bf.pts[LM.R_SHOULDER]));
  }

  let st: Stance = stance ?? 'orthodox';
  if (!stance && zN > 0) {
    const dz = (zL - zR) / zN;           // negative → left shoulder closer → orthodox
    st = dz <= 0 ? 'orthodox' : 'southpaw';
  }
  const leadHand = st === 'orthodox' ? 'L' : 'R';
  const rearHand = leadHand === 'L' ? 'R' : 'L';
  // reach = mean of the 5 largest samples (a plain max is inflated by depth noise at the peak)
  const reach = (ds: number[]) => {
    const top = [...ds].sort((a, b) => b - a).slice(0, 5);
    const m = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
    return m < 1.2 ? DEFAULT_ARM_LEN : m;                      // no extension seen → default
  };
  const nbY = median(noseBY, DEFAULT_NOSE_BODY_Y);

  return {
    stance: st,
    armLen: { lead: reach(dists[leadHand]), rear: reach(dists[rearHand]) },
    shoulderWBaseline: median(sws, 0.2),
    chinY: nbY + o.guard.chinOffset,
    neutralNoseY: median(noseY, 0.35),
    neutralNoseX: median(noseBX, 0),
    neutralNoseBodyY: nbY,
    auto: sws.length === 0,
  };
}
