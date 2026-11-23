import { describe, expect, it } from 'vitest';
import { BIT } from '@spar/protocol';
import { sim, PH, PK } from '../src';
import { fighting, withFighter } from './helpers';

describe('simultaneous impact fairness', () => {
  it('preserves a body jab already in flight when the other punch knocks its attacker down', () => {
    let state = fighting();
    state = withFighter(state, 0, { phase: PH.STARTUP, phaseFrames: 1, punch: PK.JAB, body: 0 });
    state = withFighter(state, 1, { phase: PH.STARTUP, phaseFrames: 1, punch: PK.JAB, body: 1, hp: 1 });
    const result = sim.step(state, [BIT.GUARD_HIGH, 0]);
    const hit = result.events.find(e => e.kind === 'HIT' && e.who === 1);
    expect(hit).toMatchObject({ punch: 'JAB', body: true, damage: 32 });
    expect(result.state.f[1].phase).toBe(PH.KNOCKDOWN);
    // Swapping player indices cannot change scoring or stamina drain from simultaneous punches.
    const swapped = sim.step({ ...state, f: [state.f[1], state.f[0]] }, [0, BIT.GUARD_HIGH]);
    expect(result.state.f[0]).toEqual(swapped.state.f[1]);
    expect(result.state.f[1]).toEqual(swapped.state.f[0]);
  });
});
