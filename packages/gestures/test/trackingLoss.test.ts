import { describe, expect, it } from 'vitest';
import { BIT, LM, type PoseFrame } from '@spar/protocol';
import { createGestureEngine, synth } from '../src/index';
import { noisyCalibration } from './helpers';

const hide = (f: PoseFrame, t: number, indices: number[]): PoseFrame => ({ ...f, t, lm: f.lm.map((p, i) => indices.includes(i) ? { ...p, v: 0 } : p) });

describe('independent tracking expiry', () => {
  it('holds guard through a brief dropout then clears once while head remains observed', () => {
    const engine = createGestureEngine(noisyCalibration());
    const frames = synth.guard(500);
    frames.forEach(f => engine.push(f));
    expect(engine.held() & BIT.GUARD_HIGH).toBeTruthy();
    const last = frames[frames.length - 1];
    expect(engine.push(hide(last, last.t + 100, [LM.L_WRIST]))).toEqual([]);
    expect(engine.held() & BIT.GUARD_HIGH).toBeTruthy();
    expect(engine.push(hide(last, last.t + 300, [LM.L_WRIST])).map(e => e.type)).toContain('GUARD_LOW');
    expect(engine.held() & BIT.GUARD_HIGH).toBe(0);
    expect(engine.push(hide(last, last.t + 350, [LM.L_WRIST])).filter(e => e.type === 'GUARD_LOW')).toEqual([]);
  });

  it('expires an occluded slip independently without clearing a visible guard', () => {
    const engine = createGestureEngine(noisyCalibration());
    let slipped: PoseFrame | undefined;
    for (const f of synth.sequence([synth.guard(500), synth.slip('L')])) {
      engine.push(f);
      if (engine.held() & BIT.SLIP_L) { slipped = f; break; }
    }
    expect(slipped).toBeDefined();
    const f = slipped!;
    engine.push(hide(f, f.t + 100, [LM.NOSE]));
    expect(engine.held() & BIT.SLIP_L).toBeTruthy();
    const events = engine.push(hide(f, f.t + 300, [LM.NOSE]));
    expect(events.map(e => e.type)).toContain('HEAD_CENTER');
    expect(engine.held() & (BIT.SLIP_L | BIT.SLIP_R | BIT.DUCK)).toBe(0);
    expect(engine.held() & BIT.GUARD_HIGH).toBeTruthy();
  });

  it('does not count an invisible interval toward getting up', () => {
    const engine = createGestureEngine(noisyCalibration());
    const pose = synth.getUp().find(f => f.lm[LM.L_WRIST].y < f.lm[LM.NOSE].y && f.lm[LM.R_WRIST].y < f.lm[LM.NOSE].y)!;
    expect(pose).toBeDefined();
    engine.push({ ...pose, t: 0 });
    engine.push({ ...pose, t: 100 });
    engine.push(hide(pose, 200, [LM.L_WRIST]));
    engine.push(hide(pose, 300, [LM.L_WRIST]));
    expect(engine.push({ ...pose, t: 400 }).filter(e => e.type === 'GET_UP')).toEqual([]);
    expect(engine.push({ ...pose, t: 550 }).filter(e => e.type === 'GET_UP')).toEqual([]);
    expect(engine.push({ ...pose, t: 710 }).map(e => e.type)).toContain('GET_UP');
  });

  it('clears hand trajectory immediately and long-gap queued input before recovery', () => {
    const engine = createGestureEngine(noisyCalibration());
    const frames = synth.sequence([synth.guard(500), synth.jab('L')]);
    let fired: PoseFrame | undefined;
    for (const f of frames) if (engine.push(f).some(e => e.type === 'JAB')) { fired = f; break; }
    expect(fired).toBeDefined();
    const f = fired!;
    engine.push(hide(f, f.t + 30, [LM.L_WRIST]));
    expect(engine.debug().hands.L.state).toBe('IDLE');
    expect(engine.debug().hands.L.lateral).toBe(0);
    engine.push(hide(f, f.t + 1000, [LM.L_SHOULDER]));
    expect(engine.sampleInput()).toBe(0);
    const recovery = engine.push({ ...f, t: f.t + 1030 });
    expect(recovery.filter(e => /JAB|CROSS|HOOK|UPPER/.test(e.type))).toEqual([]);
  });
});
