import {
  BIT, LM, PUNCH_BITS,
  type ActionEvent, type GestureEngineLike, type InputBits, type Landmark, type PoseFrame, type PunchKind, type Stance,
} from '@spar/protocol';
import { OneEuroPoint } from './oneEuro';
import { angleDeg, dist3, toBodyFrame, type BodyFrame, type Vec3 } from './bodyFrame';
import { DEFAULTS, mergeOptions, type GestureOptions } from './defaults';
import type { Calibration } from './calibration';

export type Hand = 'L' | 'R';
export type HandState = 'IDLE' | 'EXTENDING' | 'RETRACTING';
export type HeadState = 'CENTER' | 'SLIP_L' | 'SLIP_R' | 'DUCK';
type SlipState = 'CENTER' | 'SLIP_L' | 'SLIP_R';
type Shape = 'STRAIGHT' | 'HOOK' | 'UPPER';
const TRACKING_GRACE_MS = 250;

const HAND_IDX: Record<Hand, { s: number; e: number; w: number }> = {
  L: { s: LM.L_SHOULDER, e: LM.L_ELBOW, w: LM.L_WRIST },
  R: { s: LM.R_SHOULDER, e: LM.R_ELBOW, w: LM.R_WRIST },
};

export interface HandDebug {
  visible: boolean;
  state: HandState;
  /** extension |wrist − shoulder| / armLen */
  e: number;
  /** radial velocity, /s */
  eDot: number;
  /** wrist vertical velocity, units/s (negative = up) */
  vy: number;
  elbowAngle: number;
  /** lateral travel of the wrist from its rest x, units */
  lateral: number;
  restX: number;
  restY: number;
}

export interface GestureDebug {
  t: number;
  /** false when the last frame had no usable shoulders */
  valid: boolean;
  hands: Record<Hand, HandDebug>;
  head: {
    /** nose offset from calibrated center, body units (+x = fighter's left) */
    x: number;
    y: number;
    /** nose drop below neutral, shoulder-width units */
    drop: number;
    kneeAngle: number;
    state: HeadState;
    slip: SlipState;
    duck: boolean;
  };
  guard: { high: boolean; raw: boolean };
  scale: { ratio: number; armed: boolean; baseline: number };
  hipX: number;
  lastEvent: ActionEvent | null;
}

export interface GestureEngine extends GestureEngineLike {
  debug(): GestureDebug;
  reset(): void;
  calibration(): Calibration;
  readonly options: typeof DEFAULTS;
}

class HandTrack {
  state: HandState = 'IDLE';
  visible = false;
  hasVel = false;
  e = 0; eDot = 0; vy = 0; elbow = 180; lateral = 0;
  tPrev = 0; ePrev = 0; yPrev = 0;
  restX = 0; restY = 0; restInit = false;
  /** recent wrist x positions (body units) for lateral-travel / midline-crossing measures */
  hist: { t: number; x: number; z: number }[] = [];
  forwardMax = 0;
  // per-extension bookkeeping
  startT = 0; fired = false; maxE = 0; minVy = 0; lateralMax = 0; crossed = false; retractMinE = 1;
  lastEventT = -1e9;
}

function kindFor(shape: Shape, lead: boolean): PunchKind {
  switch (shape) {
    case 'STRAIGHT': return lead ? 'JAB' : 'CROSS';
    case 'HOOK': return lead ? 'LEAD_HOOK' : 'REAR_HOOK';
    case 'UPPER': return lead ? 'LEAD_UPPER' : 'REAR_UPPER';
  }
}

class Engine implements GestureEngine {
  readonly options: typeof DEFAULTS;
  private cal: Calibration;

  private filters: (OneEuroPoint | null)[] = [];
  private hasT = false;
  private tLast = 0;
  private body: BodyFrame | null = null;
  private frameValid = false;

  private hands: Record<Hand, HandTrack> = { L: new HandTrack(), R: new HandTrack() };
  private lastPunch: { t: number; hand: Hand; conf: number; bits: InputBits } | null = null;
  private pending: InputBits = 0;

  private slip: SlipState = 'CENTER';
  private duck = false;
  private headState: HeadState = 'CENTER';
  private headX = 0; private headY = 0; private drop = 0; private kneeAngle = 180;

  private headSeenAt = -Infinity; private guardSeenAt = -Infinity;
  private guardHigh = false; private guardRaw = false; private guardRawSince = 0; private guardHaveRaw = false;

  private hipBuf: { t: number; x: number }[] = [];
  private lastLateralT = -1e9; private lastLateralDir = 0;

  private scaleArmed = true; private lastScaleT = -1e9; private ratio = 1;
  private torsoBaseline = 0;
  private neutralTorsoLean: number | null = null;
  private baseline = 0; private neutralNoseY = 0; private neutralNoseX = 0; private chinY = 0;
  private needBaseline = false;

  private raisedSince: number | null = null; private getUpFired = false;
  private lastEvent: ActionEvent | null = null;

  constructor(cal: Calibration, opts?: GestureOptions) {
    this.options = mergeOptions(DEFAULTS, opts);
    this.cal = { ...cal, armLen: { ...cal.armLen } };
    this.reset();
  }

  // ───────────── public ─────────────
  stance(): Stance { return this.cal.stance; }
  calibration(): Calibration { return { ...this.cal, armLen: { ...this.cal.armLen }, shoulderWBaseline: this.baseline, neutralNoseY: this.neutralNoseY, neutralNoseX: this.neutralNoseX, chinY: this.chinY }; }

  reset(): void {
    this.filters = new Array(33).fill(null);
    this.hasT = false; this.tLast = 0; this.body = null; this.frameValid = false;
    this.hands = { L: new HandTrack(), R: new HandTrack() };
    this.lastPunch = null; this.pending = 0;
    this.slip = 'CENTER'; this.duck = false; this.headState = 'CENTER';
    this.headX = 0; this.headY = 0; this.drop = 0; this.kneeAngle = 180;
    this.headSeenAt = -Infinity; this.guardSeenAt = -Infinity;
    this.guardHigh = false; this.guardRaw = false; this.guardRawSince = 0; this.guardHaveRaw = false;
    this.hipBuf = []; this.lastLateralT = -1e9; this.lastLateralDir = 0;
    this.scaleArmed = true; this.lastScaleT = -1e9; this.ratio = 1;
    this.torsoBaseline = 0;
    this.neutralTorsoLean = null;
    this.baseline = this.cal.shoulderWBaseline; this.neutralNoseY = this.cal.neutralNoseY;
    this.neutralNoseX = this.cal.neutralNoseX; this.chinY = this.cal.chinY;
    this.needBaseline = !!this.cal.auto;
    this.raisedSince = null; this.getUpFired = false; this.lastEvent = null;
  }

  held(): InputBits {
    let b = 0;
    if (this.slip === 'SLIP_L') b |= BIT.SLIP_L;
    if (this.slip === 'SLIP_R') b |= BIT.SLIP_R;
    if (this.duck) b |= BIT.DUCK;
    if (this.guardHigh) b |= BIT.GUARD_HIGH;
    return b;
  }

  drainImpulses(): InputBits {
    const b = this.pending;
    this.pending = 0;
    return b;
  }

  sampleInput(): InputBits { return this.held() | this.drainImpulses(); }

  debug(): GestureDebug {
    const hd = (h: Hand): HandDebug => {
      const k = this.hands[h];
      return { visible: k.visible, state: k.state, e: k.e, eDot: k.eDot, vy: k.vy, elbowAngle: k.elbow, lateral: k.lateral, restX: k.restX, restY: k.restY };
    };
    return {
      t: this.tLast,
      valid: this.frameValid,
      hands: { L: hd('L'), R: hd('R') },
      head: { x: this.headX, y: this.headY, drop: this.drop, kneeAngle: this.kneeAngle, state: this.headState, slip: this.slip, duck: this.duck },
      guard: { high: this.guardHigh, raw: this.guardRaw },
      scale: { ratio: this.ratio, armed: this.scaleArmed, baseline: this.baseline },
      hipX: this.body ? this.body.hipCenterX : 0,
      lastEvent: this.lastEvent,
    };
  }

  push(frame: PoseFrame): ActionEvent[] {
    const events: ActionEvent[] = [];
    const t = frame.t;
    if (!Number.isFinite(t)) return events;
    if (this.hasT && t <= this.tLast) return events;          // non-increasing timestamp: ignore frame
    let dtSec = 0;
    if (this.hasT) {
      const gap = t - this.tLast;
      if (gap > this.options.maxGapMs) this.softReset(t, events);
      else dtSec = gap / 1000;
    }
    this.hasT = true;
    this.tLast = t;
    this.dtMs = dtSec * 1000;

    const filtered = this.filterFrame(frame);
    const bf = toBodyFrame(filtered, this.options.aspect, this.options.visibilityMin);
    this.body = bf;
    this.frameValid = bf.valid;
    this.expireTracking(bf, t, events);
    if (!bf.valid) {
      for (const h of ['L', 'R'] as Hand[]) this.loseHand(h);
      this.hipBuf = [];
      if (events.length) this.lastEvent = events[events.length - 1];
      return events;
    }

    if (this.needBaseline) this.snapBaseline(bf);

    this.updateHands(bf, t, events);
    this.updateHead(bf, t, events);
    this.updateGuard(bf, t, events);
    this.updateSteps(bf, t, events);
    this.updateGetUp(bf, t, events);
    this.adaptBaselines(bf, dtSec);

    if (events.length) this.lastEvent = events[events.length - 1];
    return events;
  }

  // ───────────── internals ─────────────
  private loseHand(h: Hand): void {
    const lastEventT = this.hands[h].lastEventT;
    this.hands[h] = new HandTrack();
    this.hands[h].lastEventT = lastEventT;
  }

  private clearHead(t: number, events: ActionEvent[]): void {
    if (this.slip !== 'CENTER' || this.duck) events.push({ t, type: 'HEAD_CENTER', confidence: 1 });
    this.slip = 'CENTER'; this.duck = false; this.headState = 'CENTER';
    this.headX = 0; this.headY = 0; this.drop = 0; this.kneeAngle = 180;
  }

  private clearGuard(t: number, events: ActionEvent[]): void {
    if (this.guardHigh) events.push({ t, type: 'GUARD_LOW', confidence: 1 });
    this.guardHigh = false; this.guardRaw = false; this.guardHaveRaw = false;
  }

  private expireTracking(bf: BodyFrame, t: number, events: ActionEvent[]): void {
    const visible = (i: number) => bf.valid && bf.vis[i] >= this.options.visibilityMin;
    const headVisible = visible(LM.NOSE);
    const guardVisible = [LM.L_WRIST, LM.R_WRIST, LM.L_ELBOW, LM.R_ELBOW].every(visible);
    if (headVisible) this.headSeenAt = t;
    else if (t - this.headSeenAt >= TRACKING_GRACE_MS) this.clearHead(t, events);
    if (guardVisible) this.guardSeenAt = t;
    else {
      // Unobserved time must never contribute to a guard debounce.
      this.guardHaveRaw = false;
      if (t - this.guardSeenAt >= TRACKING_GRACE_MS) this.clearGuard(t, events);
    }
    if (!headVisible || !visible(LM.L_WRIST) || !visible(LM.R_WRIST)) {
      this.raisedSince = null; this.getUpFired = false;
    }
  }

  /** A long gap invalidates evidence and queued input, but keeps learned body dimensions. */
  private softReset(t: number, events: ActionEvent[]): void {
    for (const f of this.filters) f?.reset();
    for (const h of ['L', 'R'] as Hand[]) this.loseHand(h);
    this.clearHead(t, events); this.clearGuard(t, events);
    this.headSeenAt = -Infinity; this.guardSeenAt = -Infinity;
    this.pending = 0; this.lastPunch = null;
    this.hipBuf = [];
    this.raisedSince = null; this.getUpFired = false;
  }

  private filterFrame(frame: PoseFrame): PoseFrame {
    const vmin = this.options.visibilityMin;
    const f = this.options.filter;
    const lm: Landmark[] = new Array(frame.lm.length);
    for (let i = 0; i < frame.lm.length; i++) {
      const raw = frame.lm[i];
      const p = raw && [raw.x, raw.y, raw.z, raw.v].every(Number.isFinite)
        ? raw : { x: 0, y: 0, z: 0, v: 0 };
      if (p.v < vmin) { this.filters[i]?.reset(); lm[i] = p; continue; }
      const flt = (this.filters[i] ??= new OneEuroPoint(f.minCutoff, f.beta, f.dCutoff));
      const q = flt.filter(p, frame.t);
      lm[i] = { x: q.x, y: q.y, z: q.z, v: p.v };
    }
    return { t: frame.t, lm, world: frame.world };
  }

  private snapBaseline(bf: BodyFrame): void {
    const vmin = this.options.visibilityMin;
    if (bf.vis[LM.NOSE] < vmin) return;
    this.baseline = bf.shoulderWidthPx;
    this.neutralNoseY = bf.noseYImg;
    this.neutralNoseX = bf.pts[LM.NOSE].x;
    this.chinY = bf.pts[LM.NOSE].y + this.options.guard.chinOffset;
    this.needBaseline = false;
  }

  private isLead(h: Hand): boolean {
    return (h === 'L') === (this.cal.stance === 'orthodox');
  }

  private armLen(h: Hand): number {
    return this.isLead(h) ? this.cal.armLen.lead : this.cal.armLen.rear;
  }

  private updateHands(bf: BodyFrame, t: number, events: ActionEvent[]): void {
    for (const h of ['L', 'R'] as Hand[]) this.updateHand(h, bf, t, events);
  }

  private updateHand(h: Hand, bf: BodyFrame, t: number, events: ActionEvent[]): void {
    const o = this.options.punch;
    const vmin = this.options.visibilityMin;
    const k = this.hands[h];
    const idx = HAND_IDX[h];
    const visible = bf.vis[idx.s] >= vmin && bf.vis[idx.e] >= vmin && bf.vis[idx.w] >= vmin;
    k.visible = visible;
    if (!visible) {
      this.loseHand(h); // An occluded trajectory cannot be continued or classified on recovery.
      return;
    }
    const S = bf.pts[idx.s], E = bf.pts[idx.e], W = bf.pts[idx.w];
    const e = dist3(W, S) / this.armLen(h);
    const elbow = angleDeg(S, E, W);
    let eDot = 0, vy = 0;
    if (k.hasVel) {
      const dt = (t - k.tPrev) / 1000;
      if (dt > 0) { eDot = (e - k.ePrev) / dt; vy = (W.y - k.yPrev) / dt; }
    }
    k.hasVel = true; k.tPrev = t; k.ePrev = e; k.yPrev = W.y;
    k.e = e; k.eDot = eDot; k.vy = vy; k.elbow = elbow;

    if (!k.restInit) { k.restX = W.x; k.restY = W.y; k.restInit = true; }

    // lateral travel = largest x displacement of the wrist over the last lateralWindowMs (captures the
    // outward swing of a hook that happens before e starts rising); crossing = sign change vs history.
    k.hist.push({ t, x: W.x, z: W.z });
    while (k.hist.length && t - k.hist[0].t > o.lateralWindowMs) k.hist.shift();
    let lateral = 0, crossed = false, forward = 0;
    for (const hh of k.hist) {
      lateral = Math.max(lateral, Math.abs(W.x - hh.x));
      forward = Math.max(forward, hh.z - W.z);
      if ((hh.x > 0.1 && W.x < -0.05) || (hh.x < -0.1 && W.x > 0.05)) crossed = true;
    }
    k.lateral = lateral;

    const beginExtension = () => {
      k.state = 'EXTENDING';
      k.startT = t; k.fired = false; k.maxE = e; k.minVy = vy; k.lateralMax = lateral; k.crossed = crossed;
      k.forwardMax = forward;
    };

    switch (k.state) {
      case 'IDLE': {
        if (eDot > o.extendEdot && e > o.extendE) beginExtension();
        else this.trackRest(k, W);                       // rest (guard) position of the wrist
        break;
      }
      case 'EXTENDING': {
        k.maxE = Math.max(k.maxE, e);
        k.minVy = Math.min(k.minVy, vy);
        k.lateralMax = Math.max(k.lateralMax, lateral);
        k.forwardMax = Math.max(k.forwardMax, forward);
        if (crossed) k.crossed = true;
        if (!k.fired && e >= o.earlyE && eDot > o.earlyEdot) {
          this.fire(h, k, W, t, true, o.earlyConfidence, events);
        }
        if (eDot <= 0) {
          // ė crossed ≤ 0: the extension peaked. Judge the peak by the max e reached (the sample where
          // ė turns negative is already past the peak and, with noise, can sit a few % below it).
          if (k.maxE >= o.peakE) {
            if (!k.fired) this.fire(h, k, W, t, false, o.peakConfidence, events);
            k.state = 'RETRACTING'; k.retractMinE = e;
          } else if (k.fired) {
            k.state = 'RETRACTING'; k.retractMinE = e;
          } else if (e < o.rearmE) {
            k.state = 'IDLE';
          }
        }
        if (k.state === 'EXTENDING' && t - k.startT > o.maxExtendMs) {
          k.state = k.fired ? 'RETRACTING' : 'IDLE'; k.retractMinE = e;
        }
        break;
      }
      case 'RETRACTING': {
        k.retractMinE = Math.min(k.retractMinE, e);
        if (e < o.rearmE) { k.state = 'IDLE'; }
        else if (eDot > o.extendEdot && e > o.extendE && e > k.retractMinE + o.reextendDrop && t - k.lastEventT >= o.sameHandGapMs) {
          beginExtension();                                // double jab without full retraction
        }
        break;
      }
    }
  }

  private trackRest(k: HandTrack, W: Vec3): void {
    const tau = this.options.adapt.restTauMs;
    if (tau <= 0) return;
    const a = Math.min(1, this.dtMs / tau);
    k.restX += (W.x - k.restX) * a;
    k.restY += (W.y - k.restY) * a;
  }

  /** spacing of the current frame from the previous one (ms); 0 on the first frame / after a gap */
  private dtMs = 0;

  private classify(k: HandTrack, W: Vec3): Shape | null {
    const o = this.options.punch;
    if (k.elbow >= o.straightElbowMin && k.lateralMax < o.straightLateralMax) return 'STRAIGHT';
    // At early fire a legitimate straight still has a bent elbow. Require a
    // forward-dominant path instead of classifying every unknown motion as a jab.
    if (k.forwardMax >= o.straightForwardMin && k.lateralMax < o.straightLateralMax && k.minVy >= o.upperVyMax) return 'STRAIGHT';
    if (k.minVy < o.upperVyMax && k.elbow < o.upperElbowMax && W.y < o.upperEndYMax) return 'UPPER';
    if (k.elbow >= o.hookElbowMin && k.elbow <= o.hookElbowMax && (k.crossed || k.lateralMax >= o.hookLateralMin)) return 'HOOK';
    return null; // Insufficient shape evidence is not a straight punch.
  }

  private fire(h: Hand, k: HandTrack, W: Vec3, t: number, early: boolean, confidence: number, events: ActionEvent[]): void {
    const o = this.options.punch;
    if (t - k.lastEventT < o.sameHandGapMs) { k.fired = true; return; }
    const shape = this.classify(k, W);
    if (!shape) return; // Keep an early candidate open until its trajectory provides evidence.
    k.fired = true;
    // Confidence is a heuristic rule score, not a measured probability of correctness.
    const body = W.y > o.bodyDy;
    const kind = kindFor(shape, this.isLead(h));
    const bits = PUNCH_BITS[kind] | (body ? BIT.BODY : 0);

    // both hands within the window: keep the higher confidence
    const lp = this.lastPunch;
    if (lp && lp.hand !== h && t - lp.t < o.bothHandsGapMs) {
      if (confidence <= lp.conf) return;
      this.pending &= ~lp.bits;                            // retract the weaker one if not yet drained
    }
    k.lastEventT = t;
    this.lastPunch = { t, hand: h, conf: confidence, bits };
    this.pending |= bits;
    events.push({ t, type: kind, body, confidence, early: early || undefined });
  }

  private updateHead(bf: BodyFrame, t: number, events: ActionEvent[]): void {
    const o = this.options.head;
    const vmin = this.options.visibilityMin;
    if (bf.vis[LM.NOSE] < vmin) return;                    // hold
    const nose = bf.pts[LM.NOSE];
    // A boxing slip often moves the shoulders together with the head. Nose-only
    // displacement misses that motion. Add torso lean over the pelvis while a
    // whole-body lateral translation cancels out of this relative measurement.
    let torsoLean = 0;
    if (bf.hipVisible) {
      const alignment = (bf.midShoulder.x - bf.hipCenterXImg) / bf.shoulderWidthPx;
      if (this.neutralTorsoLean === null) this.neutralTorsoLean = alignment;
      torsoLean = alignment - this.neutralTorsoLean;
    }
    this.headX = nose.x - this.neutralNoseX + torsoLean;
    this.headY = nose.y - this.cal.neutralNoseBodyY;
    this.drop = (bf.noseYImg - this.neutralNoseY) / bf.shoulderWidthPx;

    // slip with hysteresis
    let slip = this.slip;
    if (slip === 'CENTER') {
      if (this.headX > o.slipEnter) slip = 'SLIP_L';
      else if (this.headX < -o.slipEnter) slip = 'SLIP_R';
    } else if (slip === 'SLIP_L') {
      if (this.headX < o.slipExit) slip = this.headX < -o.slipEnter ? 'SLIP_R' : 'CENTER';
    } else {
      if (this.headX > -o.slipExit) slip = this.headX > o.slipEnter ? 'SLIP_L' : 'CENTER';
    }
    this.slip = slip;

    // duck: nose drop in image space (shoulder-width units) + knee bend when knees are visible
    let kneeOk = true;
    const knees: number[] = [];
    for (const [hip, knee, ankle] of [[LM.L_HIP, LM.L_KNEE, LM.L_ANKLE], [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE]] as const) {
      if (bf.vis[hip] >= vmin && bf.vis[knee] >= vmin && bf.vis[ankle] >= vmin) {
        knees.push(angleDeg(bf.pts[hip], bf.pts[knee], bf.pts[ankle]));
      }
    }
    if (knees.length) {
      this.kneeAngle = knees.reduce((a, b) => a + b, 0) / knees.length;
      kneeOk = this.kneeAngle < o.duckKneeMax;
    } else {
      this.kneeAngle = 180;
    }
    if (!this.duck) {
      if (this.drop > o.duckDrop && kneeOk) this.duck = true;
    } else if (this.drop < o.duckExitDrop) {
      this.duck = false;
    }

    const next: HeadState = slip !== 'CENTER' ? slip : this.duck ? 'DUCK' : 'CENTER';
    if (next !== this.headState) {
      this.headState = next;
      events.push({ t, type: next === 'CENTER' ? 'HEAD_CENTER' : next, confidence: 1 });
    }
  }

  private updateGuard(bf: BodyFrame, t: number, events: ActionEvent[]): void {
    const o = this.options.guard;
    const vmin = this.options.visibilityMin;
    if (bf.vis[LM.L_WRIST] < vmin || bf.vis[LM.R_WRIST] < vmin || !this.hands.L.visible || !this.hands.R.visible) return;
    const inBox = (w: Vec3, e: number) => Math.abs(w.x) <= o.halfW && Math.abs(w.y - this.chinY) <= o.halfH && e < o.maxE;
    const raw = inBox(bf.pts[LM.L_WRIST], this.hands.L.e) && inBox(bf.pts[LM.R_WRIST], this.hands.R.e);
    if (!this.guardHaveRaw || raw !== this.guardRaw) { this.guardRaw = raw; this.guardRawSince = t; this.guardHaveRaw = true; }
    if (raw !== this.guardHigh && t - this.guardRawSince >= o.debounceMs) {
      this.guardHigh = raw;
      events.push({ t, type: raw ? 'GUARD_HIGH' : 'GUARD_LOW', confidence: 1 });
    }
  }

  private updateSteps(bf: BodyFrame, t: number, events: ActionEvent[]): void {
    const o = this.options.step;
    // Lateral translation requires an observed hip center.
    // Without hips, a head/torso lean cannot be distinguished from a lateral step.
    if (!bf.hipVisible || bf.torsoLengthPx <= 1e-6) {
      this.hipBuf = [];
      return;
    }
    if (this.torsoBaseline <= 0) this.torsoBaseline = bf.torsoLengthPx;
    const x = bf.hipCenterXImg;
    this.hipBuf.push({ t, x });
    while (this.hipBuf.length && t - this.hipBuf[0].t > o.lateralWindowMs) this.hipBuf.shift();
    const disp = (x - this.hipBuf[0].x) / bf.shoulderWidthPx;   // +x image = fighter's left
    if (Math.abs(disp) > o.lateralDist) {
      const dir = disp > 0 ? 1 : -1;
      const isReturn = dir === -this.lastLateralDir && t - this.lastLateralT < o.recenterMs;
      this.hipBuf = [{ t, x }];
      if (!isReturn) {
        this.lastLateralT = t; this.lastLateralDir = dir;
        const type = dir > 0 ? 'STEP_L' : 'STEP_R';
        this.pending |= dir > 0 ? BIT.STEP_L : BIT.STEP_R;
        events.push({ t, type, confidence: 0.9 });
      }
    }

    // In/out requires agreeing shoulder and torso scale ratios.
    this.ratio = this.baseline > 0 ? bf.shoulderWidthPx / this.baseline : 1;
    const torsoRatio = bf.torsoLengthPx / this.torsoBaseline;
    // Rotation changes projected shoulder width without a matching torso-size change.
    // Require independent scale evidence; world landmarks are hip-relative, not room depth.
    const scaleAgrees = Math.abs(Math.log(this.ratio / torsoRatio)) < 0.08;
    if (!scaleAgrees) return;
    if (!this.scaleArmed) {
      if (Math.abs(this.ratio - 1) <= o.rearmBand) this.scaleArmed = true;
    } else if (t - this.lastScaleT >= o.cooldownMs) {
      if (this.ratio > o.inRatio && torsoRatio > o.inRatio) {
        this.scaleArmed = false; this.lastScaleT = t; this.pending |= BIT.STEP_IN;
        events.push({ t, type: 'STEP_IN', confidence: 0.9 });
      } else if (this.ratio < o.outRatio && torsoRatio < o.outRatio) {
        this.scaleArmed = false; this.lastScaleT = t; this.pending |= BIT.STEP_OUT;
        events.push({ t, type: 'STEP_OUT', confidence: 0.9 });
      }
    }
  }

  private updateGetUp(bf: BodyFrame, t: number, events: ActionEvent[]): void {
    const vmin = this.options.visibilityMin;
    if (bf.vis[LM.L_WRIST] < vmin || bf.vis[LM.R_WRIST] < vmin || bf.vis[LM.NOSE] < vmin) return;
    const noseY = bf.pts[LM.NOSE].y;
    const raised = bf.pts[LM.L_WRIST].y < noseY && bf.pts[LM.R_WRIST].y < noseY;
    if (!raised) { this.raisedSince = null; this.getUpFired = false; return; }
    if (this.raisedSince === null) this.raisedSince = t;
    if (!this.getUpFired && t - this.raisedSince >= this.options.getUp.holdMs) {
      this.getUpFired = true;
      this.pending |= BIT.GET_UP;
      events.push({ t, type: 'GET_UP', confidence: 0.9 });
    }
  }

  private adaptBaselines(bf: BodyFrame, dtSec: number): void {
    const a = this.options.adapt;
    const dtMs = dtSec * 1000;
    if (dtMs <= 0) return;
    if (a.noseTauMs > 0 && !this.duck && this.drop < 0.15 && this.drop > -0.3 && bf.vis[LM.NOSE] >= this.options.visibilityMin) {
      this.neutralNoseY += (bf.noseYImg - this.neutralNoseY) * Math.min(1, dtMs / a.noseTauMs);
    }
    if (a.shoulderTauMs > 0 && bf.hipVisible && this.torsoBaseline > 0 && this.baseline > 0 &&
        Math.abs(Math.log((bf.shoulderWidthPx / this.baseline) / (bf.torsoLengthPx / this.torsoBaseline))) < 0.08 &&
        this.tLast - this.lastScaleT >= this.options.step.cooldownMs) {
      const alpha = Math.min(1, dtMs / a.shoulderTauMs);
      this.baseline += (bf.shoulderWidthPx - this.baseline) * alpha;
      this.torsoBaseline += (bf.torsoLengthPx - this.torsoBaseline) * alpha;
    }
  }
}

export function createGestureEngine(cal: Calibration, opts?: GestureOptions): GestureEngine {
  return new Engine(cal, opts);
}
