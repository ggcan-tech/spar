import { LM, type ActionEvent, type PoseFrame, type Stance } from '@spar/protocol';
import { calibrate, defaultCalibration, type Calibration } from './calibration';
import { dist3, toBodyFrame } from './bodyFrame';
import { createGestureEngine, type GestureEngine } from './engine';
import { DEFAULTS, mergeOptions, type GestureOptions } from './defaults';

export interface TrackingStatus {
  phase: 'looking' | 'settling' | 'ready' | 'limited';
  message: string;
  progress: number;
}

export interface AutomaticGestureEngine extends GestureEngine {
  tracking(): TrackingStatus;
}

const REQUIRED = [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_ELBOW, LM.R_ELBOW, LM.L_WRIST, LM.R_WRIST, LM.L_HIP, LM.R_HIP];
const SETTLE_MS = 900;
const MIN_SAMPLES = 18;
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};

/** Passive setup: learn reach from both arm segments, without requesting an extension.
 * These are monocular estimates, not measured anatomical lengths or room coordinates.
 * A stable observation window is required before any game actions are emitted.
 */
export function createAutomaticGestureEngine(stance?: Stance, opts?: GestureOptions): AutomaticGestureEngine {
  const options = mergeOptions(DEFAULTS, opts);
  let inner = createGestureEngine(defaultCalibration(stance), options);
  let ready = false;
  let frames: PoseFrame[] = [];
  let lastT = -Infinity;
  let status: TrackingStatus = { phase: 'looking', message: 'Step into view with your head, hands and hips visible.', progress: 0 };

  const missing = (f: PoseFrame) => REQUIRED.some(i => {
    const p = f.lm[i];
    return !p || ![p.x, p.y, p.z, p.v].every(Number.isFinite) || p.v < options.visibilityMin || p.x < 0.02 || p.x > 0.98 || p.y < 0.02 || p.y > 0.98;
  });

  const reset = () => {
    inner.reset();
    ready = false;
    frames = [];
    lastT = -Infinity;
    status = { phase: 'looking', message: 'Step into view with your head, hands and hips visible.', progress: 0 };
  };

  return {
    options,
    stance: () => inner.stance(),
    calibration: () => inner.calibration(),
    debug: () => inner.debug(),
    tracking: () => ({ ...status }),
    reset,
    held: () => ready ? inner.held() : 0,
    drainImpulses: () => ready ? inner.drainImpulses() : 0,
    sampleInput: () => ready ? inner.sampleInput() : 0,
    push(frame): ActionEvent[] {
      if (!Number.isFinite(frame.t) || frame.t <= lastT) return [];
      if (frame.imageAspect !== undefined && Number.isFinite(frame.imageAspect) && frame.imageAspect > 0 && Math.abs(frame.imageAspect - options.aspect) > 0.001) {
        // Rotating a phone changes normalization. Discard the old coordinate frame
        // and acquire again, rather than turn a resize into a punch or depth step.
        options.aspect = frame.imageAspect;
        inner = createGestureEngine(defaultCalibration(stance), options);
        reset();
      }
      if (frame.t - lastT > options.maxGapMs) frames = [];
      lastT = frame.t;
      if (missing(frame)) {
        frames = [];
        status = { phase: ready ? 'limited' : 'looking', message: 'Keep your head, both hands and hips inside the camera view.', progress: ready ? 1 : 0 };
        return ready ? inner.push(frame) : [];
      }
      if (ready) {
        status = { phase: 'ready', message: 'Tracking ready. Move naturally.', progress: 1 };
        return inner.push(frame);
      }
      const body = toBodyFrame(frame, options.aspect, options.visibilityMin);
      if (!body.valid || body.shoulderWidthPx < 0.06) {
        frames = [];
        status = { phase: 'looking', message: 'Move a little closer and face the camera.', progress: 0 };
        return [];
      }
      // Compare against the start of the candidate window, not only the previous
      // frame: slow drift must not accumulate into a false stable observation.
      if (frames.length) {
        const first = toBodyFrame(frames[0], options.aspect, options.visibilityMin);
        const scale = body.shoulderWidthPx / first.shoulderWidthPx;
        const moving = REQUIRED.some(i => dist3(body.pts[i], first.pts[i]) > 0.2) ||
          Math.abs(body.midShoulder.x - first.midShoulder.x) / first.shoulderWidthPx > 0.18 ||
          Math.abs(body.midShoulder.y - first.midShoulder.y) / first.shoulderWidthPx > 0.18 ||
          Math.abs(scale - 1) > 0.08;
        if (moving) frames = [];
      }
      frames.push(frame);
      // Bounded memory even if a broken source emits excessively high frame rates.
      if (frames.length > 180) frames.splice(1, frames.length - 180);
      const elapsed = frame.t - frames[0].t;
      status = { phase: 'settling', message: 'Stand comfortably for a moment. No punches needed.', progress: Math.min(1, elapsed / SETTLE_MS) };
      if (elapsed < SETTLE_MS || frames.length < MIN_SAMPLES) return [];

      const cal: Calibration = calibrate(frames, stance, options);
      const lengths = { L: [] as number[], R: [] as number[] };
      for (const f of frames) {
        const b = toBodyFrame(f, options.aspect, options.visibilityMin);
        for (const [hand, s, e, w] of [
          ['L', LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST],
          ['R', LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST],
        ] as const) lengths[hand].push(dist3(b.pts[s], b.pts[e]) + dist3(b.pts[e], b.pts[w]));
      }
      const left = median(lengths.L), right = median(lengths.R);
      if (![left, right].every(v => Number.isFinite(v) && v >= 0.8 && v <= 4.5)) {
        frames = [];
        status = { phase: 'looking', message: 'Face the camera with both elbows and hands visible.', progress: 0 };
        return [];
      }
      // Square-on players have no reliable visual lead side; default consistently
      // instead of choosing a stance from tiny depth jitter. The UI offers an override.
      const blade = median(frames.map(f => (f.lm[LM.L_SHOULDER].z - f.lm[LM.R_SHOULDER].z) / toBodyFrame(f, options.aspect).shoulderWidthPx));
      cal.stance = stance ?? (blade > 0.08 ? 'southpaw' : 'orthodox');
      cal.armLen = cal.stance === 'orthodox' ? { lead: left, rear: right } : { lead: right, rear: left };
      cal.auto = false;
      inner = createGestureEngine(cal, options);
      // Prime filters with the stable observations. Setup can never produce an action.
      for (const f of frames) inner.push(f);
      inner.drainImpulses();
      frames = [];
      ready = true;
      status = { phase: 'ready', message: 'Tracking ready. Move naturally.', progress: 1 };
      return [];
    },
  };
}
