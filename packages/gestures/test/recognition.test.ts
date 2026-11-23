import { describe, expect, it } from 'vitest';
import { BIT, LM, PUNCH_BITS, type ActionEvent, type PunchKind } from '@spar/protocol';
import { synth, createGestureEngine, defaultCalibration } from '../src/index';
import { FPS, SIGMA, PUNCH_KINDS, isPunch, noisyCalibration, run, count } from './helpers';

const cal = noisyCalibration();

function reps(kind: PunchKind, body = false, n = 20, seed = 1) {
  const clips: ReturnType<typeof synth.guard>[] = [synth.guard(1000, { fps: FPS })];
  for (let i = 0; i < n; i++) {
    clips.push(synth.punch(kind, 'orthodox', { fps: FPS, body }));
    clips.push(synth.guard(450 + (i % 3) * 100, { fps: FPS }));
  }
  const seq = synth.sequenceWithStarts(clips, FPS);
  const starts = seq.starts.filter((_, i) => i >= 1 && i % 2 === 1);
  return { frames: synth.withNoise(seq.frames, SIGMA, seed), starts };
}

describe('punch recognition at 30 fps with noise (20 reps each)', () => {
  const cases: [PunchKind, boolean][] = [...PUNCH_KINDS.map((k) => [k, false] as [PunchKind, boolean]), ['JAB', true]];
  for (const [kind, body] of cases) {
    it(`${kind}${body ? ' (body)' : ''}: recall ≥ 90%, type ≥ 85%, one event per rep`, () => {
      const { frames, starts } = reps(kind, body, 20, 11 + PUNCH_KINDS.indexOf(kind) + (body ? 40 : 0));
      const { events, inputs } = run(frames, cal);
      const punches = events.filter(isPunch);
      let recalled = 0, correct = 0;
      for (const s of starts) {
        const inRep = punches.filter((e) => e.t >= s && e.t < s + 600);
        expect(inRep.length, `rep at ${s} fired ${inRep.length} events`).toBeLessThanOrEqual(1);
        if (inRep.length === 1) {
          recalled++;
          if (inRep[0].type === kind && !!inRep[0].body === body) correct++;
        }
      }
      expect(recalled / starts.length).toBeGreaterThanOrEqual(0.9);
      expect(correct / Math.max(1, punches.length)).toBeGreaterThanOrEqual(0.85);
      // the impulse bit reaches the input stream exactly once per rep
      const expectBit = PUNCH_BITS[kind];
      const ticks = inputs.filter((b) => (b & expectBit) !== 0).length;
      expect(ticks).toBe(recalled);
      if (body) expect(inputs.filter((b) => (b & BIT.BODY) !== 0).length).toBeGreaterThanOrEqual(Math.floor(0.85 * recalled));
    });
  }

  it('maps hands through the stance (southpaw: right hand straight = JAB)', () => {
    const cal2 = { ...noisyCalibration(), stance: 'southpaw' as const };
    const frames = synth.withNoise(synth.sequence([synth.guard(600, { fps: FPS, figure: { stance: 'southpaw' } }), synth.straight('R', { fps: FPS, figure: { stance: 'southpaw' } }), synth.guard(400, { fps: FPS, figure: { stance: 'southpaw' } })]), SIGMA, 3);
    const { events } = run(frames, cal2);
    const p = events.filter(isPunch);
    expect(p).toHaveLength(1);
    expect(p[0].type).toBe('JAB');
  });
});

describe('false positives and timing', () => {
  it('idle guard for 60 s with noise → ≤ 3 punch events', () => {
    const frames = synth.withNoise(synth.guard(60_000, { fps: FPS }), SIGMA, 99);
    const { events } = run(frames, cal);
    expect(events.filter(isPunch).length).toBeLessThanOrEqual(3);
    // and no step / head chatter either
    expect(events.filter((e) => e.type.startsWith('STEP') || e.type.startsWith('SLIP') || e.type === 'DUCK')).toHaveLength(0);
  });

  it('a jab fires early — before the peak frame — and does not fire again at the peak', () => {
    const seq = synth.sequenceWithStarts([synth.guard(500, { fps: FPS }), synth.jab('L', { fps: FPS, durationMs: 150 }), synth.guard(500, { fps: FPS })], FPS);
    const peakT = seq.starts[1] + 150;
    const { events } = run(synth.withNoise(seq.frames, SIGMA, 21), cal);
    const p = events.filter(isPunch);
    expect(p).toHaveLength(1);
    expect(p[0].type).toBe('JAB');
    expect(p[0].early).toBe(true);
    expect(p[0].confidence).toBeCloseTo(0.8, 5);
    expect(p[0].t).toBeLessThan(peakT);
    expect(p[0].t).toBeGreaterThan(seq.starts[1]);
  });

  it('a slow push that never satisfies the early rule still fires once at the peak', () => {
    const frames = synth.sequence([synth.guard(500, { fps: FPS }), synth.jab('L', { fps: FPS, durationMs: 150 }), synth.guard(500, { fps: FPS })], FPS);
    const { events } = run(frames, cal, { punch: { earlyEdot: 1e9 } });
    const p = events.filter(isPunch);
    expect(p).toHaveLength(1);
    expect(p[0].early).toBeUndefined();
    expect(p[0].confidence).toBeCloseTo(0.95, 5);
  });

  it('a rapid double jab produces two events', () => {
    const frames = synth.sequence([synth.guard(500, { fps: FPS }), synth.jab('L', { fps: FPS, returnMs: 150 }), synth.jab('L', { fps: FPS }), synth.guard(500, { fps: FPS })], FPS);
    const { events } = run(frames, cal);
    expect(events.filter(isPunch).map((e) => e.type)).toEqual(['JAB', 'JAB']);
  });

  it('both hands firing within 60 ms keep only one event; 100 ms apart keeps both', () => {
    const fig = synth.FIGURE;
    const both = (offsetMs: number) => synth.animate(400 + offsetMs, (t) => {
      const p = synth.neutralPose(fig);
      for (const [h, t0] of [['L', 0], ['R', offsetMs]] as const) {
        const tt = t - t0;
        const s = tt < 0 ? 0 : tt <= 150 ? synth.ease(tt / 150) : 1 - synth.ease(Math.min(1, (tt - 150) / 210));
        p.wrist[h] = { x: 0, y: 0, z: 0 };
        const G = synth.guardWrist(fig, h), T = synth.straightTarget(fig, h, 0.95, false);
        p.wrist[h] = { x: G.x + (T.x - G.x) * s, y: G.y + (T.y - G.y) * s, z: G.z + (T.z - G.z) * s };
      }
      return p;
    }, { fps: FPS });
    const simultaneous = run(synth.sequence([synth.guard(500, { fps: FPS }), both(0), synth.guard(400, { fps: FPS })], FPS), cal);
    expect(simultaneous.events.filter(isPunch)).toHaveLength(1);
    expect(simultaneous.inputs.filter((b) => b & (BIT.JAB | BIT.CROSS))).toHaveLength(1);
    const staggered = run(synth.sequence([synth.guard(500, { fps: FPS }), both(100), synth.guard(400, { fps: FPS })], FPS), cal);
    expect(staggered.events.filter(isPunch).map((e) => e.type)).toEqual(['JAB', 'CROSS']);
  });

  it('works before calibration with defaultCalibration()', () => {
    const frames = synth.withNoise(synth.sequence([synth.guard(800, { fps: FPS }), synth.jab('L', { fps: FPS }), synth.guard(400, { fps: FPS }), synth.straight('R', { fps: FPS }), synth.guard(400, { fps: FPS })]), SIGMA, 4);
    const { events } = run(frames, defaultCalibration());
    expect(events.filter(isPunch).map((e) => e.type)).toEqual(['JAB', 'CROSS']);
  });
});

describe('robustness', () => {
  it('low-visibility landmarks do not produce events', () => {
    const base = synth.withNoise(synth.sequence([synth.guard(500, { fps: FPS }), synth.jab('L', { fps: FPS }), synth.guard(300, { fps: FPS }), synth.hook('R', { fps: FPS }), synth.guard(500, { fps: FPS })]), SIGMA, 8);
    // sanity: visible → two punches
    expect(run(base, cal).events.filter(isPunch)).toHaveLength(2);
    // wrists hidden → nothing, and the guard detector holds (no GUARD_LOW chatter)
    const hidden = synth.withVisibility(base, [LM.L_WRIST, LM.R_WRIST], 0.2);
    const r = run(hidden, cal);
    expect(r.events.filter(isPunch)).toHaveLength(0);
    expect(count(r.events, 'GUARD_LOW')).toBe(0);
    // shoulders hidden → whole frame ignored
    const noShoulders = synth.withVisibility(base, [LM.L_SHOULDER], 0.1);
    expect(run(noShoulders, cal).events).toHaveLength(0);
    // nose hidden during a slip → no head events
    const slipFrames = synth.withVisibility(synth.sequence([synth.guard(300, { fps: FPS }), synth.slip('L', { fps: FPS }), synth.guard(300, { fps: FPS })]), [LM.NOSE], 0.3);
    expect(run(slipFrames, cal).events.filter((e) => e.type.startsWith('SLIP') || e.type === 'HEAD_CENTER')).toHaveLength(0);
  });

  it('ignores frames whose timestamp does not increase and survives the first frame', () => {
    const engine = createGestureEngine(cal);
    const frames = synth.sequence([synth.guard(200, { fps: FPS }), synth.jab('L', { fps: FPS }), synth.guard(300, { fps: FPS })], FPS);
    expect(engine.push(frames[0])).toEqual([]);
    const all: ActionEvent[] = [];
    for (const f of frames) {
      all.push(...engine.push(f));
      all.push(...engine.push({ ...f, t: f.t - 5 }));   // stale frame: ignored
      all.push(...engine.push(f));                      // duplicate timestamp: ignored
    }
    expect(all.filter(isPunch)).toHaveLength(1);
    expect(engine.debug().t).toBe(frames[frames.length - 1].t);
  });

  it('reset() clears state and impulses', () => {
    const engine = createGestureEngine(cal);
    for (const f of synth.sequence([synth.guard(300, { fps: FPS }), synth.jab('L', { fps: FPS })], FPS)) engine.push(f);
    expect(engine.drainImpulses() & BIT.JAB).toBe(BIT.JAB);
    for (const f of synth.jab('R', { fps: FPS })) engine.push({ ...f, t: f.t + 5000 });
    engine.reset();
    expect(engine.drainImpulses()).toBe(0);
    expect(engine.held()).toBe(0);
    expect(engine.debug().hands.L.state).toBe('IDLE');
    expect(engine.stance()).toBe('orthodox');
  });

  it('debug() reports extension and elbow angle', () => {
    const engine = createGestureEngine(cal);
    const frames = synth.sequence([synth.guard(300, { fps: FPS }), synth.jab('L', { fps: FPS, returnMs: 1 })], FPS);
    for (const f of frames) engine.push(f);
    const d = engine.debug();
    expect(d.valid).toBe(true);
    expect(d.hands.L.e).toBeGreaterThan(0.8);
    expect(d.hands.L.elbowAngle).toBeGreaterThan(100);   // ≈40° in guard; e = sin(elbow/2) for a 2-segment arm
    expect(d.hands.L.state).not.toBe('IDLE');
    expect(d.hands.R.e).toBeLessThan(0.45);
    expect(d.lastEvent?.type).toBe('JAB');
  });
});
