import type { ActionEvent, GestureEngineLike } from '@spar/protocol';

/**
 * Best-effort reader for `engine.debug()`. The gestures package returns per-hand
 * extension/velocity/state, head offsets, guard flag, scale ratio and the last event; the exact
 * key names are the other engineer's call, so this probes a few plausible spellings and always
 * keeps the raw object for the "raw" view. Everything unknown is `null`, never NaN.
 */
export interface HandDebug {
  extension: number | null;
  velocity: number | null;
  state: string | null;
  /** Wrist vertical velocity, units/s (negative = up). */
  vy: number | null;
  elbowAngle: number | null;
  visible: boolean | null;
}

export interface EngineDebugView {
  lead: HandDebug;
  rear: HandDebug;
  /** Nose x offset from mid-shoulder, body-frame units (+ = fighter's left). */
  headX: number | null;
  /** Nose y drop below calibrated neutral, body-frame units (+ = lower). */
  headY: number | null;
  headState: string | null;
  guard: boolean | null;
  /** Shoulder px width / baseline (STEP_IN > 1.12, STEP_OUT < 0.89). */
  scale: number | null;
  /** false when the last frame had no usable shoulders. */
  valid: boolean | null;
  lastEvent: ActionEvent | null;
  raw: unknown;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;

function pickNum(obj: unknown, keys: string[]): number | null {
  if (!isRec(obj)) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function pickStr(obj: unknown, keys: string[]): string | null {
  if (!isRec(obj)) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function pickBool(obj: unknown, keys: string[]): boolean | null {
  if (!isRec(obj)) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
    if (isRec(v) && typeof v.high === 'boolean') return v.high;
    if (isRec(v) && typeof v.up === 'boolean') return v.up;
  }
  return null;
}

function pickObj(obj: unknown, keys: string[]): Rec | null {
  if (!isRec(obj)) return null;
  for (const k of keys) {
    const v = obj[k];
    if (isRec(v)) return v;
  }
  return null;
}

function hand(obj: unknown): HandDebug {
  return {
    extension: pickNum(obj, ['e', 'extension', 'ext', 'extent']),
    velocity: pickNum(obj, ['eDot', 'edot', 'velocity', 'vel', 'de', 'speed']),
    state: pickStr(obj, ['state', 'phase', 'status']),
    vy: pickNum(obj, ['vy', 'wristVy', 'verticalVelocity']),
    elbowAngle: pickNum(obj, ['elbowAngle', 'elbow', 'elbowDeg']),
    visible: pickBool(obj, ['visible']),
  };
}

const EMPTY_HAND: HandDebug = { extension: null, velocity: null, state: null, vy: null, elbowAngle: null, visible: null };
const EMPTY: Omit<EngineDebugView, 'raw'> = {
  lead: EMPTY_HAND,
  rear: EMPTY_HAND,
  headX: null,
  headY: null,
  headState: null,
  guard: null,
  scale: null,
  valid: null,
  lastEvent: null,
};

export function readEngineDebug(engine: GestureEngineLike | null | undefined): EngineDebugView {
  const dbg = (engine as { debug?: () => unknown } | null | undefined)?.debug;
  let raw: unknown = null;
  if (typeof dbg === 'function') {
    try {
      raw = dbg.call(engine);
    } catch {
      raw = null;
    }
  }
  if (!isRec(raw)) return { ...EMPTY, raw };

  const hands = pickObj(raw, ['hands', 'hand']) ?? raw;
  let stance = pickStr(raw, ['stance']);
  if (!stance && engine && typeof engine.stance === 'function') {
    try {
      stance = engine.stance();
    } catch {
      stance = null;
    }
  }
  let leadObj = pickObj(hands, ['lead']);
  let rearObj = pickObj(hands, ['rear']);
  if (!leadObj || !rearObj) {
    // L/R spelling (the real engine): lead = left hand for orthodox, right for southpaw.
    const left = pickObj(hands, ['L', 'left', 'l']);
    const right = pickObj(hands, ['R', 'right', 'r']);
    const southpaw = stance === 'southpaw';
    leadObj = leadObj ?? (southpaw ? right : left);
    rearObj = rearObj ?? (southpaw ? left : right);
  }

  const head = pickObj(raw, ['head', 'headOffset', 'headOffsets', 'nose']);
  const headX = pickNum(head, ['x', 'dx', 'offsetX', 'offX', 'slip', 'lateral']) ?? pickNum(raw, ['headX', 'headDx', 'noseX', 'headOffsetX']);
  // "drop" is the DUCK measure (nose below calibrated neutral, shoulder-width units); plain y is the body-frame offset.
  const headY = pickNum(head, ['drop', 'y', 'dy', 'offsetY', 'offY', 'vertical']) ?? pickNum(raw, ['headDrop', 'headY', 'headDy', 'noseY', 'headOffsetY']);
  const headState = pickStr(head, ['state']);

  const guard = pickBool(raw, ['guard', 'guardHigh', 'guardUp', 'inGuard']);
  const scaleObj = pickObj(raw, ['scale']);
  const scale = pickNum(scaleObj, ['ratio']) ?? pickNum(raw, ['scaleRatio', 'scale', 'shoulderRatio', 'shoulderScale', 'stepRatio', 'ratio']);
  const valid = pickBool(raw, ['valid']);

  let lastEvent: ActionEvent | null = null;
  const le = pickObj(raw, ['lastEvent', 'last', 'event']);
  if (le && typeof le.type === 'string' && typeof le.t === 'number') {
    lastEvent = { t: le.t, type: le.type as ActionEvent['type'], confidence: typeof le.confidence === 'number' ? le.confidence : 1 };
    if (typeof le.body === 'boolean') lastEvent.body = le.body;
    if (typeof le.early === 'boolean') lastEvent.early = le.early;
  }

  return { lead: hand(leadObj), rear: hand(rearObj), headX, headY, headState, guard, scale, valid, lastEvent, raw };
}

/** Which hand a punch event belongs to (for wrist highlights). */
export function handOfEvent(type: ActionEvent['type']): 'lead' | 'rear' | null {
  switch (type) {
    case 'JAB':
    case 'LEAD_HOOK':
    case 'LEAD_UPPER':
      return 'lead';
    case 'CROSS':
    case 'REAR_HOOK':
    case 'REAR_UPPER':
      return 'rear';
    default:
      return null;
  }
}
