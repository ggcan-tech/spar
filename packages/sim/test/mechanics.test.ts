import { describe, expect, it } from 'vitest';
import { BIT } from '@spar/protocol';
import { sim, PUNCH_TABLE, PH, HD, SIM_NUMBERS } from '../src';
import { fighting, run, runUntil, withFighter, withRange, kinds } from './helpers';

const JAB = PUNCH_TABLE.JAB;

describe('punch phases and the jab', () => {
  it('jab from 600: startup 3 → ACTIVE (HIT) on the 4th frame → recovery → idle; counters update', () => {
    let s = fighting();
    expect(s.range).toBe(600);

    // press on frame k
    let r = sim.step(s, [BIT.JAB, 0]);
    s = r.state;
    expect(s.f[0].phase).toBe(PH.STARTUP);
    expect(s.f[0].phaseFrames).toBe(3);
    expect(s.f[0].punch).toBe(0);
    expect(s.f[0].thrown).toBe(1);
    expect(s.f[0].stamina).toBe(1000 - JAB.stamina);
    expect(r.events).toEqual([]);

    // k+1, k+2: still startup
    r = sim.step(s, [0, 0]);
    s = r.state;
    expect(s.f[0].phase).toBe(PH.STARTUP);
    expect(s.f[0].phaseFrames).toBe(2);
    r = sim.step(s, [0, 0]);
    s = r.state;
    expect(s.f[0].phaseFrames).toBe(1);
    expect(s.f[1].hp).toBe(1000);

    // k+3: first ACTIVE frame → resolution
    r = sim.step(s, [0, 0]);
    s = r.state;
    expect(s.f[0].phase).toBe(PH.ACTIVE);
    expect(s.f[0].phaseFrames).toBe(JAB.active);
    expect(r.events).toEqual([{ frame: s.frame - 1, kind: 'HIT', who: 0, punch: 'JAB', body: false, damage: 40 }]);
    expect(s.f[1].hp).toBe(960);
    expect(s.f[0].landed).toBe(1);
    expect(s.range).toBe(640); // knockback

    // k+4: second active frame, k+5: recovery begins
    s = sim.step(s, [0, 0]).state;
    expect(s.f[0].phase).toBe(PH.ACTIVE);
    expect(s.f[0].phaseFrames).toBe(1);
    s = sim.step(s, [0, 0]).state;
    expect(s.f[0].phase).toBe(PH.RECOVERY);
    expect(s.f[0].phaseFrames).toBe(JAB.recovery);
    expect(s.f[0].punch).toBe(0); // still reported during recovery

    // recovery 6 frames, then idle; total cycle = 3 + 2 + 6 = 11 frames after the press
    s = run(s, JAB.recovery - 1).state;
    expect(s.f[0].phase).toBe(PH.RECOVERY);
    expect(s.f[0].phaseFrames).toBe(1);
    s = sim.step(s, [0, 0]).state;
    expect(s.f[0].phase).toBe(PH.IDLE);
    expect(s.f[0].punch).toBe(-1);
    expect(sim.view(s).fighters[0].punch).toBeNull();
  });

  it('a punch bit is ignored while busy, accepted in the 2-frame cancel window', () => {
    let s = fighting();
    s = sim.step(s, [BIT.JAB, 0]).state; // STARTUP 3
    s = sim.step(s, [BIT.CROSS, 0]).state; // busy → ignored
    expect(s.f[0].punch).toBe(0);
    expect(s.f[0].thrown).toBe(1);
    // advance to RECOVERY with 4 frames left (k+7)
    s = run(s, 6).state;
    expect(s.f[0].phase).toBe(PH.RECOVERY);
    expect(s.f[0].phaseFrames).toBe(4);
    s = sim.step(s, [BIT.CROSS, 0]).state; // ticks to 3 → not yet cancellable
    expect(s.f[0].punch).toBe(0);
    expect(s.f[0].phaseFrames).toBe(3);
    s = sim.step(s, [BIT.CROSS, 0]).state; // ticks to 2 → cancel window, accepted
    expect(s.f[0].punch).toBe(1);
    expect(s.f[0].phase).toBe(PH.STARTUP);
    expect(s.f[0].thrown).toBe(2);
  });

  it('simultaneous punch bits: JAB > CROSS > LEAD_HOOK > REAR_HOOK > LEAD_UPPER > REAR_UPPER', () => {
    const s = fighting();
    expect(sim.step(s, [BIT.REAR_UPPER | BIT.CROSS, 0]).state.f[0].punch).toBe(1);
    expect(sim.step(s, [BIT.REAR_UPPER | BIT.LEAD_UPPER, 0]).state.f[0].punch).toBe(4);
    expect(sim.step(s, [BIT.REAR_HOOK | BIT.LEAD_HOOK | BIT.REAR_UPPER, 0]).state.f[0].punch).toBe(2);
    expect(sim.step(s, [BIT.JAB | BIT.REAR_HOOK, 0]).state.f[0].punch).toBe(0);
  });

  it('BODY modifier: ×0.8 damage, +1 recovery, −50 max range', () => {
    let s = fighting();
    // (vs HIGH guard — a LOW guard blocks body shots 70%, covered below)
    const r = runUntil(sim.step(s, [BIT.JAB | BIT.BODY, BIT.GUARD_HIGH]).state, 'HIT', 0, BIT.GUARD_HIGH);
    expect(r.found).toMatchObject({ kind: 'HIT', who: 0, punch: 'JAB', body: true, damage: 32 });
    s = r.state;
    s = run(s, JAB.active).state; // → RECOVERY
    expect(s.f[0].phase).toBe(PH.RECOVERY);
    expect(s.f[0].phaseFrames).toBe(JAB.recovery + 1);

    // body jab max range 650: whiffs at 660 (drift moves it 3 closer by the active frame → 657)
    const miss = runUntil(sim.step(withRange(fighting(), 660), [BIT.JAB | BIT.BODY, 0]).state, 'MISS');
    expect(miss.found).toMatchObject({ kind: 'MISS', who: 0, punch: 'JAB', body: true });
  });
});

describe('range', () => {
  it('cross whiffs at 700 (MISS), STEP_IN then cross lands', () => {
    let s = withRange(fighting(), 700);
    let r = runUntil(sim.step(s, [BIT.CROSS, 0]).state, 'MISS');
    expect(r.found).toMatchObject({ kind: 'MISS', who: 0, punch: 'CROSS' });
    expect(r.state.f[1].hp).toBe(1000);
    expect(r.state.f[0].thrown).toBe(1);
    expect(r.state.f[0].landed).toBe(0);

    // let recovery finish, then step in and throw again
    s = run(r.state, 20).state;
    expect(s.f[0].phase).toBe(PH.IDLE);
    const before = s.range;
    const st = sim.step(s, [BIT.STEP_IN, 0]);
    expect(st.events).toEqual([{ frame: s.frame, kind: 'STEP', who: 0, detail: 'IN' }]);
    expect(st.state.range).toBe(before - 150 - 1); // −150 plus the 1-unit drift toward 600
    expect(st.state.f[0].stepCooldown).toBe(19);
    const hit = runUntil(sim.step(st.state, [BIT.CROSS, 0]).state, 'HIT');
    expect(hit.found).toMatchObject({ kind: 'HIT', who: 0, punch: 'CROSS', damage: 80 });
  });

  it('hooks miss at 600 and land at 500', () => {
    const miss = runUntil(sim.step(fighting(), [BIT.LEAD_HOOK, 0]).state, 'MISS');
    expect(miss.found).toMatchObject({ kind: 'MISS', punch: 'LEAD_HOOK' });
    // press frame + 6 startup frames = 7 drift steps (+7 toward 600): start at 493 so it is exactly 500 on resolution
    const s = withRange(fighting(), 493);
    const hit = runUntil(sim.step(s, [BIT.LEAD_HOOK, 0]).state, 'HIT');
    expect(hit.state.range).toBe(500 + 40);
    expect(hit.found).toMatchObject({ kind: 'HIT', punch: 'LEAD_HOOK', damage: 90 });
  });

  it('step cooldown is 20 frames and applies to every step kind; range clamps to [200, 1000]', () => {
    let s = withRange(fighting(), 300);
    s = sim.step(s, [BIT.STEP_IN, 0]).state;
    expect(s.range).toBe(200); // drift (301) then step (151) then clamp
    let r = run(s, 19, BIT.STEP_IN); // frames k+1 .. k+19: blocked
    expect(r.events.filter((e) => e.kind === 'STEP')).toHaveLength(0);
    s = r.state;
    expect(s.f[0].stepCooldown).toBe(0);
    r = sim.step(s, [BIT.STEP_OUT, 0]); // k+20 → allowed
    expect(r.events.map((e) => e.detail)).toEqual(['OUT']);
    s = withRange(r.state, 950);
    s = sim.step(s, [0, BIT.STEP_OUT]).state;
    expect(s.range).toBe(1000); // drift (951) then step (1101) then clamp
  });

  it('range drifts toward 600 by 1 per frame during FIGHTING', () => {
    expect(run(withRange(fighting(), 700), 10).state.range).toBe(690);
    expect(run(withRange(fighting(), 450), 10).state.range).toBe(460);
    expect(run(withRange(fighting(), 600), 10).state.range).toBe(600);
  });

  it('inside (< 300): straights ×0.5, hooks/uppers full', () => {
    const jab = runUntil(sim.step(withRange(fighting(), 250), [BIT.JAB, 0]).state, 'HIT');
    expect(jab.found?.damage).toBe(20);
    const hook = runUntil(sim.step(withRange(fighting(), 250), [BIT.REAR_HOOK, 0]).state, 'HIT');
    expect(hook.found?.damage).toBe(110);
  });

  it('STEP_L / STEP_R act as a half-slip for 10 frames: evades straights only, no counter window', () => {
    let s = fighting();
    // p1 steps L on the frame p0 presses jab; jab resolves 3 frames later, well inside the 10 frames
    let r = sim.step(s, [BIT.JAB, BIT.STEP_L]);
    expect(r.events).toEqual([{ frame: s.frame, kind: 'STEP', who: 1, detail: 'L' }]);
    expect(r.state.f[1].lateral).toBe(9);
    const ev = runUntil(r.state, 'EVADE');
    expect(ev.found).toMatchObject({ kind: 'EVADE', who: 1, punch: 'JAB' });
    expect(ev.state.f[1].counterWindow).toBe(0);
    expect(ev.state.f[1].hp).toBe(1000);

    // half-slip does not evade hooks
    s = withRange(fighting(), 450);
    r = sim.step(s, [BIT.LEAD_HOOK, BIT.STEP_R]);
    const hit = runUntil(r.state, 'HIT');
    expect(hit.found).toMatchObject({ kind: 'HIT', punch: 'LEAD_HOOK', damage: 90 });

    // and it expires: on the 11th frame after the step a straight lands
    s = fighting();
    s = sim.step(s, [0, BIT.STEP_L]).state; // lateral 10 on this frame, 9 after
    s = run(s, 7).state; // lateral 2
    expect(s.f[1].lateral).toBe(2);
    s = sim.step(s, [BIT.JAB, 0]).state; // lateral 1 (frame 9 of 10)
    const late = runUntil(s, 'HIT'); // resolves 3 frames later, lateral is 0
    expect(late.found).toMatchObject({ kind: 'HIT', punch: 'JAB', damage: 40 });
  });
});

describe('slip / duck / guard', () => {
  it('slip evades a straight and opens a 12-frame counter window; the next landed punch does ×1.5 with COUNTER', () => {
    let s = fighting();
    // p0 jabs, p1 holds SLIP_L
    let r = run(sim.step(s, [BIT.JAB, BIT.SLIP_L]).state, 3, 0, BIT.SLIP_L);
    expect(kinds(r.events)).toEqual(['EVADE']);
    expect(r.events[0]).toMatchObject({ kind: 'EVADE', who: 1, punch: 'JAB' });
    s = r.state;
    expect(s.f[1].counterWindow).toBe(12);
    expect(sim.view(s).fighters[1].counterWindow).toBe(12);
    expect(s.f[1].hp).toBe(1000);
    expect(s.f[1].roundPts).toBe(SIM_NUMBERS.W_EVADE);

    // p1 answers with a jab right away: resolves 4 frames later, inside the window
    const c = runUntil(sim.step(s, [0, BIT.JAB]).state, 'HIT', 0, 0);
    expect(c.found).toMatchObject({ kind: 'HIT', who: 1, punch: 'JAB', damage: 60 });
    expect(kinds(c.events)).toEqual(['HIT', 'COUNTER']);
    expect(c.events[1]).toMatchObject({ kind: 'COUNTER', who: 1, punch: 'JAB', damage: 60 });
    expect(c.state.f[1].counterWindow).toBe(0); // consumed
    expect(c.state.f[0].hp).toBe(940);
    expect(c.state.f[1].roundPts).toBe(SIM_NUMBERS.W_EVADE + 15); // evade 5 + straight 10 × 1.5
  });

  it('counter window boundary: ACTIVE 12 frames after the evade counters, 13 frames after does not', () => {
    const evaded = run(sim.step(fighting(), [BIT.JAB, BIT.SLIP_R]).state, 3, 0, BIT.SLIP_R).state; // evade on frame E
    // press jab 9 frames later → ACTIVE at E+12
    let s = run(evaded, 8).state;
    expect(s.f[1].counterWindow).toBe(4);
    let r = runUntil(sim.step(s, [0, BIT.JAB]).state, 'HIT');
    expect(r.frames).toBe(3);
    expect(r.found?.damage).toBe(60);
    expect(kinds(r.events)).toContain('COUNTER');
    // press jab 10 frames later → ACTIVE at E+13
    s = run(evaded, 9).state;
    expect(s.f[1].counterWindow).toBe(3);
    r = runUntil(sim.step(s, [0, BIT.JAB]).state, 'HIT');
    expect(r.found?.damage).toBe(40);
    expect(kinds(r.events)).not.toContain('COUNTER');
  });

  it('slip vs hook: LEAD_HOOK punishes SLIP_R and REAR_HOOK punishes SLIP_L (×1.5); the other way is a plain hit', () => {
    const at = (bits0: number, bits1: number) =>
      runUntil(sim.step(withRange(fighting(), 450), [bits0, bits1]).state, 'HIT', 0, bits1).found;
    expect(at(BIT.LEAD_HOOK, BIT.SLIP_R)).toMatchObject({ punch: 'LEAD_HOOK', damage: 135 });
    expect(at(BIT.LEAD_HOOK, BIT.SLIP_L)).toMatchObject({ punch: 'LEAD_HOOK', damage: 90 });
    expect(at(BIT.REAR_HOOK, BIT.SLIP_L)).toMatchObject({ punch: 'REAR_HOOK', damage: 165 });
    expect(at(BIT.REAR_HOOK, BIT.SLIP_R)).toMatchObject({ punch: 'REAR_HOOK', damage: 110 });
  });

  it('duck evades a hook (costs 30 stamina on entry) but an uppercut on a ducking target does ×2', () => {
    let s = withRange(fighting(), 450);
    let r = run(sim.step(s, [BIT.LEAD_HOOK, BIT.DUCK]).state, 6, 0, BIT.DUCK);
    expect(r.events).toEqual([{ frame: s.frame + 6, kind: 'EVADE', who: 1, punch: 'LEAD_HOOK', body: false }]);
    expect(r.state.f[1].counterWindow).toBe(12);
    // entry cost 30 paid once; idle + low guard regens +1 on each of the 7 frames → 977
    expect(r.state.f[1].stamina).toBe(1000 - 30 + 7);
    expect(r.state.f[1].head).toBe(HD.DUCK);

    s = withRange(fighting(), 350);
    const up = runUntil(sim.step(s, [BIT.REAR_UPPER, BIT.DUCK]).state, 'HIT', 0, BIT.DUCK);
    expect(up.found).toMatchObject({ kind: 'HIT', punch: 'REAR_UPPER', damage: 240 });
    expect(up.state.f[1].hp).toBe(760);
  });

  it('duck evades straights too; the entry cost is charged once per entry', () => {
    let s = fighting();
    const r = run(sim.step(s, [BIT.JAB, BIT.DUCK]).state, 3, 0, BIT.DUCK);
    expect(kinds(r.events)).toEqual(['EVADE']);
    // leave duck (free), re-enter → charged again
    s = sim.step(r.state, [0, 0]).state;
    const stam = s.f[1].stamina;
    s = sim.step(s, [0, BIT.DUCK]).state;
    expect(s.f[1].stamina).toBe(stam - 30 + 1); // +1 idle low-guard regen after the cost
  });

  it('head priority SLIP_L > SLIP_R > DUCK; guard from GUARD_HIGH bit', () => {
    const s = fighting();
    expect(sim.step(s, [BIT.SLIP_L | BIT.SLIP_R | BIT.DUCK, 0]).state.f[0].head).toBe(HD.SLIP_L);
    expect(sim.step(s, [BIT.SLIP_R | BIT.DUCK, 0]).state.f[0].head).toBe(HD.SLIP_R);
    expect(sim.step(s, [BIT.DUCK, 0]).state.f[0].head).toBe(HD.DUCK);
    expect(sim.step(s, [BIT.GUARD_HIGH, 0]).state.f[0].guardHigh).toBe(1);
    expect(sim.step(s, [0, 0]).state.f[0].guardHigh).toBe(0);
  });

  it('high guard blocks a straight with 15% chip; body punch ignores high guard and drains stamina 2×', () => {
    let s = fighting();
    let r = runUntil(sim.step(s, [BIT.JAB, BIT.GUARD_HIGH]).state, 'BLOCK', 0, BIT.GUARD_HIGH);
    expect(r.found).toEqual({ frame: s.frame + 3, kind: 'BLOCK', who: 0, punch: 'JAB', body: false, damage: 6 });
    expect(r.state.f[1].hp).toBe(994);
    expect(r.state.f[0].landed).toBe(0);
    expect(r.state.range).toBe(600); // no knockback on a block

    // hooks are blocked 50%, uppers 40%
    r = runUntil(sim.step(withRange(fighting(), 450), [BIT.REAR_HOOK, BIT.GUARD_HIGH]).state, 'BLOCK', 0, BIT.GUARD_HIGH);
    expect(r.found?.damage).toBe(55);
    r = runUntil(sim.step(withRange(fighting(), 350), [BIT.REAR_UPPER, BIT.GUARD_HIGH]).state, 'BLOCK', 0, BIT.GUARD_HIGH);
    expect(r.found?.damage).toBe(72);

    // body jab vs high guard: full body damage (32) and 64 stamina drained
    s = fighting();
    r = runUntil(sim.step(s, [BIT.JAB | BIT.BODY, BIT.GUARD_HIGH]).state, 'HIT', 0, BIT.GUARD_HIGH);
    expect(r.found).toMatchObject({ kind: 'HIT', who: 0, punch: 'JAB', body: true, damage: 32 });
    expect(r.state.f[1].hp).toBe(968);
    const drained = 1000 - r.state.f[1].stamina;
    expect(drained).toBeGreaterThanOrEqual(63); // 64 minus at most one frame of regen
    expect(drained).toBeLessThanOrEqual(64);
  });

  it('body punch vs LOW guard is blocked 70% (chip still drains 2×)', () => {
    const s = fighting();
    const r = runUntil(sim.step(s, [BIT.JAB | BIT.BODY, 0]).state, 'BLOCK');
    expect(r.found).toMatchObject({ kind: 'BLOCK', who: 0, punch: 'JAB', body: true, damage: 9 });
    expect(r.state.f[1].hp).toBe(991);
    expect(1000 - r.state.f[1].stamina).toBeGreaterThanOrEqual(17); // 18 minus ≤1 regen
  });

  it('guard requires head CENTER: a slipped fighter with guard up still eats hooks', () => {
    const r = runUntil(
      sim.step(withRange(fighting(), 450), [BIT.LEAD_HOOK, BIT.GUARD_HIGH | BIT.SLIP_L]).state,
      'HIT',
      0,
      BIT.GUARD_HIGH | BIT.SLIP_L,
    );
    expect(r.found).toMatchObject({ kind: 'HIT', punch: 'LEAD_HOOK', damage: 90 });
  });
});

describe('stamina', () => {
  it('punches cost stamina on startup entry; stamina never goes below 0', () => {
    let s = fighting();
    s = sim.step(s, [BIT.REAR_UPPER, 0]).state;
    expect(s.f[0].stamina).toBe(1000 - PUNCH_TABLE.REAR_UPPER.stamina);
    s = withFighter(fighting(), 0, { stamina: 10 });
    s = sim.step(s, [BIT.CROSS, 0]).state;
    expect(s.f[0].stamina).toBe(0);
    expect(s.f[0].phase).toBe(PH.STARTUP);
  });

  it('regen: +1/frame idle with guard low, +1 every other frame with guard high, 0 while punching', () => {
    let s = withFighter(fighting(), 0, { stamina: 500 });
    expect(run(s, 100).state.f[0].stamina).toBe(600);
    expect(run(s, 100, BIT.GUARD_HIGH).state.f[0].stamina).toBe(550);
    // 11-frame jab cycle: no regen during it
    s = withFighter(fighting(), 0, { stamina: 500 });
    s = sim.step(s, [BIT.JAB, 0]).state;
    expect(run(s, 10).state.f[0].stamina).toBe(475);
  });

  it('fatigue below 300: guard forced LOW, startup +2, damage ×0.7', () => {
    let s = withFighter(fighting(), 0, { stamina: 290 });
    s = sim.step(s, [BIT.GUARD_HIGH, 0]).state;
    expect(s.f[0].guardHigh).toBe(0);
    expect(sim.view(s).fighters[0].guardHigh).toBe(false);

    s = withFighter(fighting(), 0, { stamina: 290 });
    let r = sim.step(s, [BIT.JAB, 0]);
    expect(r.state.f[0].phaseFrames).toBe(JAB.startup + 2);
    const hit = runUntil(r.state, 'HIT');
    expect(hit.frames).toBe(JAB.startup + 2);
    expect(hit.found?.damage).toBe(28);

    // guard comes back once stamina regens to 300
    s = withFighter(fighting(), 0, { stamina: 295 });
    s = run(s, 4, BIT.GUARD_HIGH).state;
    expect(s.f[0].guardHigh).toBe(0);
    expect(s.f[0].stamina).toBe(299);
    s = run(s, 2, BIT.GUARD_HIGH).state;
    expect(s.f[0].stamina).toBe(300);
    expect(s.f[0].guardHigh).toBe(1);
  });
});
