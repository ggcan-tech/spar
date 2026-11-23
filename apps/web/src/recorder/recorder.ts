import type { ActionEvent, GestureEngineLike, PoseFrame, Stance } from '@spar/protocol';
import { createAutomaticGestureEngine, createGestureEngine, type Calibration } from '@spar/gestures';

/**
 * Pose recordings for offline tuning: `{ version: 1, stance, calibration, frames }`.
 * Frames keep their original `t` (performance.now() ms) so replays reproduce the exact timing.
 */
export interface Recording {
  version: 1;
  stance: Stance | 'auto';
  calibration: Calibration | null;
  frames: PoseFrame[];
  /** Optional provenance; ignored by replay. */
  meta?: { recordedAt?: string; userAgent?: string; fps?: number; delegate?: string; aspect?: number; width?: number; height?: number };
}

export interface Recorder {
  start(): void;
  stop(): void;
  isRecording(): boolean;
  /** Push a frame; ignored unless recording. */
  push(frame: PoseFrame): void;
  frames(): PoseFrame[];
  count(): number;
  durationMs(): number;
  clear(): void;
}

const MAX_FRAMES = 30 * 60 * 10; // 10 minutes at 30 fps

export function createRecorder(): Recorder {
  let recording = false;
  let buf: PoseFrame[] = [];
  return {
    start() {
      recording = true;
    },
    stop() {
      recording = false;
    },
    isRecording: () => recording,
    push(frame) {
      if (!recording) return;
      buf.push(frame);
      if (buf.length > MAX_FRAMES) buf.splice(0, buf.length - MAX_FRAMES);
    },
    frames: () => buf,
    count: () => buf.length,
    durationMs: () => (buf.length < 2 ? 0 : buf[buf.length - 1].t - buf[0].t),
    clear() {
      buf = [];
    },
  };
}

export function makeRecording(frames: PoseFrame[], stance: Stance | 'auto', calibration: Calibration | null, meta?: Recording['meta']): Recording {
  const rec: Recording = { version: 1, stance, calibration, frames };
  if (meta) rec.meta = meta;
  return rec;
}

/** Trigger a browser download of the recording as JSON via a Blob link. */
export function downloadRecording(rec: Recording, filename = defaultFilename(rec)): void {
  const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function defaultFilename(rec: Recording): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `spar-${rec.stance}-${rec.frames.length}f-${stamp}.json`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isLandmarkArray(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== 33) return false;
  return v.every(l => l && isNum(l.x) && isNum(l.y) && isNum(l.z) && isNum(l.v) && l.v >= 0 && l.v <= 1);
}

/** Parse + validate a recording JSON string. Throws with a readable message. */
export function parseRecording(text: string): Recording {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('Recording must be a JSON object.');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new Error(`Unsupported recording version: ${String(r.version)}`);
  if (!Array.isArray(r.frames) || r.frames.length === 0) throw new Error('Recording has no frames.');
  const stance: Recording['stance'] = r.stance === 'orthodox' || r.stance === 'southpaw' ? r.stance : 'auto';
  const frames: PoseFrame[] = [];
  for (let i = 0; i < r.frames.length; i++) {
    const f = r.frames[i] as { t?: unknown; lm?: unknown; world?: unknown; imageAspect?: unknown } | null;
    if (!f || !isNum(f.t) || !isLandmarkArray(f.lm)) throw new Error(`Frame ${i} is malformed.`);
    if (f.imageAspect !== undefined && (!isNum(f.imageAspect) || f.imageAspect <= 0 || f.imageAspect > 10)) throw new Error(`Frame ${i} has an invalid camera aspect.`);
    frames.push({ t: f.t, lm: f.lm as PoseFrame['lm'], world: isLandmarkArray(f.world) ? (f.world as PoseFrame['world']) : [], ...(isNum(f.imageAspect) ? { imageAspect: f.imageAspect } : {}) });
  }
  const calibration = typeof r.calibration === 'object' && r.calibration !== null ? (r.calibration as Calibration) : null;
  if (calibration && (
    !['orthodox', 'southpaw'].includes(calibration.stance) ||
    !calibration.armLen || !isNum(calibration.armLen.lead) || calibration.armLen.lead <= 0 ||
    !isNum(calibration.armLen.rear) || calibration.armLen.rear <= 0 ||
    !isNum(calibration.shoulderWBaseline) || calibration.shoulderWBaseline <= 0 ||
    ![calibration.chinY, calibration.neutralNoseY, calibration.neutralNoseX, calibration.neutralNoseBodyY].every(isNum) ||
    typeof calibration.auto !== 'boolean'
  )) throw new Error('Recording contains invalid body measurements.');
  const rec: Recording = { version: 1, stance, calibration, frames };
  if (typeof r.meta === 'object' && r.meta !== null) {
    const meta = r.meta as NonNullable<Recording['meta']>;
    if (meta.aspect !== undefined && (!isNum(meta.aspect) || meta.aspect <= 0 || meta.aspect > 10)) {
      throw new Error('Recording camera aspect must be a positive finite height / width ratio.');
    }
    rec.meta = meta;
  }
  return rec;
}

export interface ReplayEvent extends ActionEvent {
  /** Index of the frame that produced it. */
  frame: number;
  /** ms since the first frame. */
  rel: number;
}

export interface ReplayResult {
  events: ReplayEvent[];
  frames: number;
  durationMs: number;
}

/** Reproduce the declared setup path; never learn measurements from future actions. */
export function createRecordingEngine(rec: Recording): GestureEngineLike {
  const aspect = rec.frames[0]?.imageAspect ?? rec.meta?.aspect;
  if (!aspect) throw new Error('Recording is missing its camera aspect (height / width). Save a new recording with this version.');
  if (rec.calibration && rec.frames.some(f => f.imageAspect !== undefined && Math.abs(f.imageAspect - aspect) > 0.001)) {
    throw new Error('This recording changes camera orientation after setup. Record a separate attempt in each orientation.');
  }
  return rec.calibration ? createGestureEngine(rec.calibration, { aspect })
    : createAutomaticGestureEngine(rec.stance === 'auto' ? undefined : rec.stance, { aspect });
}

/** Push every frame of a recording through an engine and collect what it says. */
export function replayRecording(rec: Recording, engine: GestureEngineLike): ReplayResult {
  const events: ReplayEvent[] = [];
  const t0 = rec.frames[0]?.t ?? 0;
  rec.frames.forEach((frame, i) => {
    for (const ev of engine.push(frame)) events.push({ ...ev, frame: i, rel: ev.t - t0 });
  });
  const last = rec.frames[rec.frames.length - 1]?.t ?? t0;
  return { events, frames: rec.frames.length, durationMs: last - t0 };
}
