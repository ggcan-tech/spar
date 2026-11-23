import { describe, expect, it } from 'vitest';
import { BIT, INTRO_FRAMES, REST_SECONDS, ROUND_SECONDS } from '@spar/protocol';
import { sim, MS, PH, HD, METHOD, WIN_DRAW, ROUND_FRAMES, REST_FRAMES } from '../src';
import { fighting, run, runUntil, withFighter, withRange, kinds } from './helpers';

describe('stun', () => {
  it('≥250 damage within 120 frames → STUNNED 30 frames; hits on a stunned target do ×1.5', () => {
    // three rear hooks (110 each) held at range 300: accepted every 20 frames via the cancel window
    let s = withRange(fighting(), 300);
    const r = runUntil(s, 'STUN', BIT.REAR_HOOK, 0, 200);
    expect(r.found).toEqual({ frame: expect.any(Number), kind: 'STUN', who: 1 });
    const hits = r.events.filter((e) => e.kind === 'HIT');
    expect(hits).toHaveLength(3);
    expect(hits.map((e) => e.damage)).toEqual([110, 110, 110]);
    expect(hits[2].frame - hits[0].frame).toBeLessThan(120);
    s = r.state;
    expect(s.f[1].phase).toBe(PH.STUNNED);
    expect(s.f[1].phaseFrames).toBe(30);
    expect(s.f[1].hp).toBe(1000 - 330);
    expect(s.f[1].dmgLog).toEqual([]); // window reset

    // stunned: cannot punch, guard forced low, head forced center
    const st = sim.step(s, [0, BIT.JAB | BIT.GUARD_HIGH | BIT.SLIP_L]).state;
    expect(st.f[1].phase).toBe(PH.STUNNED);
    expect(st.f[1].thrown).toBe(0);
    expect(st.f[1].guardHigh).toBe(0);
    expect(st.f[1].head).toBe(HD.CENTER);

    // the 4th hook lands on the stunned target for 165
    const r2 = runUntil(s, 'HIT', BIT.REAR_HOOK, BIT.GUARD_HIGH, 60);
    expect(r2.found?.damage).toBe(165);
    expect(r2.state.f[1].phase).toBe(PH.STUNNED);

    // stun expires after 30 frames
    const out = run(s, 30).state;
    expect(out.f[1].phase).toBe(PH.IDLE);
    expect(run(s, 29).state.f[1].phase).toBe(PH.STUNNED);
  });

  it('two hits 120+ frames apart do not stun', () => {
    let s = withRange(fighting(), 300);
    let r = runUntil(sim.step(s, [BIT.REAR_HOOK, 0]).state, 'HIT');
    s = run(r.state, 121).state;
    s = withRange(s, 300);
    r = runUntil(sim.step(s, [BIT.REAR_UPPER, 0]).state, 'HIT'); // 110 + 120 = 230 < 250 anyway; and outside the window
    expect(r.found?.damage).toBe(120);
    expect(kinds(r.events)).not.toContain('STUN');
    expect(r.state.f[1].dmgLog).toHaveLength(2); // only the latest entry survived the prune
  });
});

describe('knockdown, GET_UP, KO, TKO', () => {
  it('hp ≤ 0 → KNOCKDOWN with a 600-frame count; GET_UP restores hp 300 and stamina ≥ 400', () => {
    let s = withFighter(fighting(), 1, { hp: 30, stamina: 100 });
    const r = runUntil(sim.step(s, [BIT.JAB, 0]).state, 'KNOCKDOWN');
    expect(kinds(r.events)).toEqual(['HIT', 'KNOCKDOWN']);
    expect(r.found).toMatchObject({ kind: 'KNOCKDOWN', who: 1 });
    s = r.state;
    expect(s.f[1].hp).toBe(0);
    expect(s.f[1].phase).toBe(PH.KNOCKDOWN);
    expect(s.f[1].phaseFrames).toBe(600);
    expect(s.f[1].knockdowns).toBe(1);
    expect(sim.view(s).fighters[1].phase).toBe('KNOCKDOWN');

    // punches on a downed fighter are ignored (no event, no damage); the downed fighter cannot punch/step
    const idle = run(s, 12).state;
    expect(idle.f[0].phase).toBe(PH.IDLE);
    const ignored = runUntil(sim.step(idle, [BIT.JAB, BIT.JAB | BIT.STEP_IN]).state, 'HIT', 0, 0, 12);
    expect(ignored.found).toBeNull();
    expect(ignored.events.filter((e) => e.kind !== 'GET_UP')).toEqual([]);
    expect(ignored.state.f[1].hp).toBe(0);
    expect(ignored.state.f[1].thrown).toBe(0);
    expect(ignored.state.f[0].thrown).toBe(2);
    expect(ignored.state.range).toBe(idle.range - 13); // 13 frames of drift, no knockback from the ignored punch

    const up = sim.step(run(s, 10).state, [0, BIT.GET_UP]);
    expect(up.events).toEqual([{ frame: s.frame + 10, kind: 'GET_UP', who: 1 }]);
    expect(up.state.f[1].phase).toBe(PH.IDLE);
    expect(up.state.f[1].hp).toBe(300);
    expect(up.state.f[1].stamina).toBe(400 + 1); // max(100, 400), then the usual +1 idle regen on the get-up frame
    expect(up.state.f[1].knockdowns).toBe(1);

    // stamina above 400 is kept
    const s2 = withFighter(fighting(), 1, { hp: 30, stamina: 900 });
    const kd2 = runUntil(sim.step(s2, [BIT.JAB, 0]).state, 'KNOCKDOWN').state;
    expect(sim.step(kd2, [0, BIT.GET_UP]).state.f[1].stamina).toBeGreaterThanOrEqual(900); // (+ idle regen ticks)
  });

  it('no GET_UP within 600 frames → KO with MATCH_END; GET_UP on the 600th frame still works', () => {
    const s = withFighter(fighting(), 1, { hp: 30 });
    const kd = runUntil(sim.step(s, [BIT.JAB, 0]).state, 'KNOCKDOWN').state;

    const almost = run(kd, 599).state;
    expect(almost.state).toBe(MS.FIGHTING);
    expect(almost.f[1].phase).toBe(PH.KNOCKDOWN);
    expect(almost.f[1].phaseFrames).toBe(1);

    const saved = sim.step(almost, [0, BIT.GET_UP]);
    expect(kinds(saved.events)).toEqual(['GET_UP']);
    expect(saved.state.state).toBe(MS.FIGHTING);

    const ko = sim.step(almost, [0, 0]);
    expect(ko.events).toEqual([{ frame: almost.frame, kind: 'MATCH_END', who: 0, detail: 'KO' }]);
    expect(ko.state.state).toBe(MS.OVER);
    expect(ko.state.winner).toBe(0);
    expect(ko.state.method).toBe(METHOD.KO);
    const v = sim.view(ko.state);
    expect(v.state).toBe('OVER');
    expect(v.winner).toBe(0);
    expect(v.method).toBe('KO');

    // after OVER, steps are inert
    const after = sim.step(ko.state, [BIT.JAB, BIT.JAB]);
    expect(after.events).toEqual([]);
    expect(after.state.f[0].thrown).toBe(1);
    expect(after.state.frame).toBe(ko.state.frame + 1);
  });

  it('three knockdowns in a round → TKO', () => {
    let s = fighting();
    const knock = (st: typeof s) => runUntil(sim.step(withFighter(st, 1, { hp: 30 }), [BIT.JAB, 0]).state, 'KNOCKDOWN');
    let r = knock(s);
    expect(r.state.f[1].knockdowns).toBe(1);
    s = sim.step(r.state, [0, BIT.GET_UP]).state;
    s = run(s, 12).state; // let p0 recover
    r = knock(s);
    expect(r.state.f[1].knockdowns).toBe(2);
    expect(r.state.state).toBe(MS.FIGHTING);
    s = sim.step(r.state, [0, BIT.GET_UP]).state;
    s = run(s, 12).state;
    r = knock(s);
    expect(kinds(r.events)).toEqual(['HIT', 'KNOCKDOWN', 'MATCH_END']);
    expect(r.events[2]).toMatchObject({ kind: 'MATCH_END', who: 0, detail: 'TKO' });
    expect(r.state.state).toBe(MS.OVER);
    expect(r.state.method).toBe(METHOD.TKO);
    expect(sim.view(r.state).method).toBe('TKO');
    expect(sim.view(r.state).fighters[1].knockdowns).toBe(3);
  });

  it('knockdowns reset per round; the count continues past the bell (round waits for the count)', () => {
    // knock p1 down 10 frames before the round ends
    let s = fighting();
    s = run(s, ROUND_FRAMES - 20).state;
    s = withFighter(s, 1, { hp: 30 });
    const kd = runUntil(sim.step(s, [BIT.JAB, 0]).state, 'KNOCKDOWN').state;
    let r = run(kd, 40);
    expect(r.state.state).toBe(MS.FIGHTING); // clock is at 0 but the count is running
    expect(r.state.roundFrame).toBeGreaterThan(ROUND_FRAMES);
    expect(sim.view(r.state).clockSec).toBe(0);
    expect(kinds(r.events)).toEqual([]);
    r = sim.step(r.state, [0, BIT.GET_UP]);
    expect(kinds(r.events)).toEqual(['GET_UP', 'BELL', 'ROUND_END']);
    expect(r.state.state).toBe(MS.REST);
    expect(r.state.scores).toEqual([[10], [8]]); // lost the round and was knocked down
    expect(r.state.f[1].knockdowns).toBe(1); // still shown during rest
    const next = run(r.state, REST_FRAMES).state;
    expect(next.state).toBe(MS.INTRO);
    expect(next.round).toBe(2);
    expect(next.f[1].knockdowns).toBe(0);
    expect(next.f[1].hp).toBe(300); // hp is not restored between rounds
  });
});

describe('round flow and judging', () => {
  it('INTRO → FIGHTING → REST → INTRO → … → OVER by DECISION with BELL/ROUND_END/MATCH_END', () => {
    let s = sim.init(7);
    expect(s.state).toBe(MS.INTRO);
    expect(s.stateFrames).toBe(INTRO_FRAMES);
    let v = sim.view(s);
    expect(v.state).toBe('INTRO');
    expect(v.round).toBe(1);
    expect(v.clockSec).toBe(ROUND_SECONDS);
    expect(v.scores).toEqual([[], []]);
    expect(v.winner).toBeNull();
    expect(v.method).toBeNull();

    // inputs are ignored during INTRO (no punch accepted, no stamina spent)
    let r = run(s, INTRO_FRAMES - 1, BIT.JAB, BIT.STEP_IN);
    expect(r.state.state).toBe(MS.INTRO);
    expect(r.state.f[0].thrown).toBe(0);
    expect(r.state.range).toBe(600);
    expect(r.events).toEqual([]);
    r = sim.step(r.state, [0, 0]);
    expect(r.events).toEqual([{ frame: INTRO_FRAMES - 1, kind: 'BELL', who: 0, detail: 'START' }]);
    s = r.state;
    expect(s.state).toBe(MS.FIGHTING);
    expect(s.frame).toBe(INTRO_FRAMES);
    expect(s.roundFrame).toBe(0);

    // round 1: only p0 lands (a handful of jabs), p1 does nothing
    r = run(s, 100, BIT.JAB, 0);
    const landed = r.events.filter((e) => e.kind === 'HIT').length;
    expect(landed).toBeGreaterThan(3);
    r = run(r.state, ROUND_FRAMES - 100 - 1);
    expect(r.state.state).toBe(MS.FIGHTING);
    expect(sim.view(r.state).clockSec).toBe(1);
    r = sim.step(r.state, [0, 0]);
    expect(kinds(r.events)).toEqual(['BELL', 'ROUND_END']);
    expect(r.events[0].detail).toBe('END');
    expect(r.events[1]).toMatchObject({ kind: 'ROUND_END', who: 0, detail: '10-9' });
    s = r.state;
    expect(s.state).toBe(MS.REST);
    expect(s.scores).toEqual([[10], [9]]);
    expect(s.stateFrames).toBe(REST_SECONDS * 60);
    v = sim.view(s);
    expect(v.state).toBe('REST');
    expect(v.clockSec).toBe(REST_SECONDS);
    expect(v.roundFrame).toBe(ROUND_FRAMES);
    expect(v.fighters[0].landed).toBe(landed);
    expect(v.fighters[0].thrown).toBeGreaterThanOrEqual(landed);

    // rest: inputs ignored, stamina refills
    r = run(s, REST_FRAMES - 1, BIT.JAB, BIT.JAB);
    expect(r.state.state).toBe(MS.REST);
    expect(r.state.f[0].thrown).toBe(v.fighters[0].thrown);
    r = sim.step(r.state, [0, 0]);
    expect(r.events).toEqual([]);
    s = r.state;
    expect(s.state).toBe(MS.INTRO);
    expect(s.round).toBe(2);
    expect(s.f[0].stamina).toBe(1000);

    // rounds 2 and 3 with nobody landing → 10-10 each
    s = run(s, INTRO_FRAMES).state;
    expect(s.state).toBe(MS.FIGHTING);
    r = run(s, ROUND_FRAMES);
    expect(kinds(r.events)).toEqual(['BELL', 'ROUND_END']);
    expect(r.events[1].detail).toBe('10-10');
    s = run(r.state, REST_FRAMES + INTRO_FRAMES).state;
    expect(s.state).toBe(MS.FIGHTING);
    expect(s.round).toBe(3);
    r = run(s, ROUND_FRAMES);
    expect(kinds(r.events)).toEqual(['BELL', 'ROUND_END', 'MATCH_END']);
    expect(r.events[2]).toEqual({ frame: r.state.frame - 1, kind: 'MATCH_END', who: 0, detail: 'DECISION' });
    s = r.state;
    expect(s.state).toBe(MS.OVER);
    expect(s.scores).toEqual([[10, 10, 10], [9, 10, 10]]);
    v = sim.view(s);
    expect(v.state).toBe('OVER');
    expect(v.winner).toBe(0);
    expect(v.method).toBe('DECISION');
    expect(v.scores[0]).toHaveLength(3);
    expect(v.scores[1]).toHaveLength(3);
    expect(v.clockSec).toBe(0);
    expect(s.frame).toBe(3 * INTRO_FRAMES + 3 * ROUND_FRAMES + 2 * REST_FRAMES);
  });

  it('a match where nobody scores is a DRAW', () => {
    const s = run(sim.init(3), 3 * INTRO_FRAMES + 3 * ROUND_FRAMES + 2 * REST_FRAMES).state;
    expect(s.state).toBe(MS.OVER);
    expect(s.winner).toBe(WIN_DRAW);
    expect(s.scores).toEqual([[10, 10, 10], [10, 10, 10]]);
    const v = sim.view(s);
    expect(v.winner).toBe('DRAW');
    expect(v.method).toBe('DECISION');
  });

  it('judging formula: hooks outweigh jabs, evades count, knockdowns dominate', () => {
    // p0 lands two jabs (20), p1 lands one rear hook (14) plus two evades (10) → p1 wins 24-20
    let s = withRange(fighting(), 300);
    let r = runUntil(sim.step(s, [0, BIT.REAR_HOOK]).state, 'HIT');
    expect(r.found?.who).toBe(1);
    s = run(r.state, 30).state;
    r = runUntil(sim.step(s, [BIT.JAB, BIT.SLIP_L]).state, 'EVADE', 0, BIT.SLIP_L);
    s = run(r.state, 30).state;
    r = runUntil(sim.step(s, [BIT.JAB, BIT.SLIP_L]).state, 'EVADE', 0, BIT.SLIP_L);
    s = run(r.state, 30).state;
    r = runUntil(sim.step(s, [BIT.JAB, 0]).state, 'HIT');
    s = run(r.state, 30).state;
    r = runUntil(sim.step(s, [BIT.JAB, 0]).state, 'HIT');
    s = r.state;
    expect(s.f[0].roundPts).toBe(20);
    expect(s.f[1].roundPts).toBe(24);
    const end = runUntil(s, 'ROUND_END');
    expect(end.found?.detail).toBe('9-10');
    expect(end.state.scores).toEqual([[9], [10]]);
  });

  it('view() is fresh and cheap; state stays plain JSON', () => {
    const s = fighting();
    const a = sim.view(s);
    const b = sim.view(s);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.fighters).not.toBe(b.fighters);
    expect(a.scores[0]).not.toBe(b.scores[0]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const v = sim.view(s);
    expect(v.fighters[0]).toEqual({
      hp: 1000, stamina: 1000, guardHigh: false, head: 'CENTER', phase: 'IDLE', punch: null, body: false,
      phaseFrames: 0, counterWindow: 0, knockdowns: 0, stance: 'orthodox', landed: 0, thrown: 0,
    });
  });
});
