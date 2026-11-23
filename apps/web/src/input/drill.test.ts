import { BIT, type ActionEvent } from '@spar/protocol';
import { createDrill, drillSummary, DRILL_PROMPTS } from './drill';

const ev = (type: ActionEvent['type'], t: number): ActionEvent => ({ type, t, confidence: 1 });

describe('createDrill', () => {
  it('walks the prompt list, measuring latency from prompt to matching event', () => {
    const d = createDrill();
    d.start(1000);
    expect(d.state().status).toBe('running');
    expect(DRILL_PROMPTS[d.state().index].type).toBe('JAB');
    expect(d.feed([ev('JAB', 1120)], 0, 1125)).toBe(true);
    const s = d.state();
    expect(s.lastResult).toMatchObject({ type: 'JAB', ok: true, latencyMs: 120 });
    expect(s.tallies[0]).toMatchObject({ hits: 1, misses: 0, latencies: [120] });
    expect(s.holdUntil).not.toBeNull();
    // Still holding: events are ignored, no advance yet.
    expect(d.feed([ev('CROSS', 1200)], 0, 1200)).toBe(false);
    expect(d.state().index).toBe(0);
    // Hold elapsed → next prompt.
    expect(d.feed([], 0, 2000)).toBe(true);
    expect(d.state().index).toBe(1);
    expect(d.state().promptedAt).toBe(2000);
    expect(d.state().lastResult).toBeNull();
  });

  it('counts a wrong action of the same class as a miss and keeps the prompt', () => {
    const d = createDrill();
    d.start(0);
    expect(d.feed([ev('CROSS', 50)], 0, 50)).toBe(true);
    expect(d.state().lastResult).toMatchObject({ type: 'JAB', ok: false, got: 'CROSS' });
    expect(d.state().tallies[0].misses).toBe(1);
    d.feed([], 0, 5000);
    expect(d.state().index).toBe(0); // keep teaching until the move is recognized
    expect(d.state().holdUntil).toBeNull();
    expect(d.feed([ev('JAB', 5100)], 0, 5100)).toBe(true);
    expect(d.state().tallies[0]).toMatchObject({ hits: 1, misses: 1 });
    d.feed([], 0, 5800);
    expect(d.state().index).toBe(1);
    expect(d.state().lastResult).toBeNull();
  });

  it('ignores stale events and unrelated classes', () => {
    const d = createDrill();
    d.start(1000);
    expect(d.feed([ev('JAB', 800)], 0, 1001)).toBe(false); // fired before the prompt
    expect(d.feed([ev('HEAD_CENTER', 1100), ev('GUARD_LOW', 1100), ev('SLIP_L', 1100)], 0, 1100)).toBe(false);
    expect(d.state().tallies[0]).toMatchObject({ hits: 0, misses: 0 });
  });

  it('satisfies held prompts via a bit transition, requiring the bit to be off first', () => {
    const d = createDrill();
    d.start(0);
    d.feed([], BIT.GUARD_HIGH, 1); // guard is up the whole time
    // Skip to "Guard up" (index 9).
    for (let i = 0; i < 9; i++) {
      d.skip(i * 10);
    }
    expect(DRILL_PROMPTS[d.state().index].type).toBe('GUARD_HIGH');
    // Guard already up when the prompt appeared: must drop and raise.
    expect(d.feed([], BIT.GUARD_HIGH, 100)).toBe(false);
    expect(d.feed([], 0, 200)).toBe(false);
    expect(d.feed([], BIT.GUARD_HIGH, 300)).toBe(true);
    expect(d.state().lastResult).toMatchObject({ type: 'GUARD_HIGH', ok: true });
    expect(d.state().tallies[9].hits).toBe(1);
  });

  it('skip tallies and finishes with a summary', () => {
    const d = createDrill();
    d.start(0);
    for (let i = 0; i < DRILL_PROMPTS.length; i++) d.skip(i);
    expect(d.state().status).toBe('done');
    const s = drillSummary(d.state());
    expect(s.skips).toBe(DRILL_PROMPTS.length);
    expect(s.hits).toBe(0);
    expect(s.meanLatencyMs).toBeNull();
    d.reset();
    expect(d.state().status).toBe('idle');
  });
});


describe('drill recognition boundaries', () => {
  it('accepts the requested action when another classification shares the batch', () => {
    const d = createDrill();
    d.start(100);
    d.feed([ev('CROSS', 200), ev('JAB', 205)], 0, 210);
    expect(d.state().lastResult).toMatchObject({ ok: true });
    expect(d.state().tallies[0].misses).toBe(0);
  });

  it('does not accept an event from just before the prompt', () => {
    const d = createDrill();
    d.start(100);
    expect(d.feed([ev('JAB', 99)], 0, 101)).toBe(false);
  });

  it('keeps a head prompt retryable after a different head movement', () => {
    const d = createDrill(DRILL_PROMPTS.filter((p) => p.type === 'SLIP_L'));
    d.start(100);
    d.feed([ev('SLIP_R', 200)], BIT.SLIP_R, 200);
    expect(d.state().lastResult).toMatchObject({ ok: false, got: 'SLIP_R' });
    d.feed([], 0, 250);
    d.feed([], BIT.SLIP_L, 300);
    expect(d.state().lastResult).toMatchObject({ ok: true });
    d.feed([], BIT.SLIP_L, 1000);
    expect(d.state().status).toBe('done');
  });

  it('requires a fresh held transition on consecutive prompts', () => {
    const guard = DRILL_PROMPTS.find((p) => p.type === 'GUARD_HIGH')!;
    const d = createDrill([guard, guard]);
    d.start(0);
    d.feed([], BIT.GUARD_HIGH, 100);
    d.feed([], BIT.GUARD_HIGH, 800);
    expect(d.state().index).toBe(1);
    expect(d.state().lastResult).toBeNull();
    expect(d.feed([], BIT.GUARD_HIGH, 900)).toBe(false);
    d.feed([], 0, 1000);
    expect(d.feed([], BIT.GUARD_HIGH, 1100)).toBe(true);
  });

  it('teaches both lateral steps', () => {
    expect(DRILL_PROMPTS.filter((p) => p.type === 'STEP_L' || p.type === 'STEP_R')).toHaveLength(2);
    expect(DRILL_PROMPTS.every((p) => p.instruction && p.cue)).toBe(true);
  });
});
