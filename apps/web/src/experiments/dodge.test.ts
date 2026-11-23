import { describe, it, expect } from 'vitest';
import { BIT } from '@spar/protocol';
import { newDodge, stepDodge, DODGE_FRAMES } from './dodge';

describe('dodge control study', () => {
  it('commits the incoming target at release; a later slip escapes', () => {
    let s = newDodge();
    for (let i = 0; i < 80; i++) s = stepDodge(s, 0);
    expect(s.incoming[0].lane).toBe(0);
    for (let i = 0; i < 60; i++) s = stepDodge(s, BIT.SLIP_L);
    expect(s.hp).toBe(8); expect(s.dodges).toBe(1);
  });
  it('does not let holding duck evade every future attack', () => {
    let s = newDodge();
    for (let i = 0; i < 140; i++) s = stepDodge(s, BIT.DUCK);
    expect(s.hp).toBe(7); expect(s.received).toBe(1);
  });
  it('resolves a collision exactly once and never mutates the prior state', () => {
    const s = newDodge(); s.incoming = [{ id: 1, lane: 0, low: false, born: 0, arrives: 1 }];
    const next = stepDodge(s, 0);
    expect(s.hp).toBe(8); expect(s.incoming).toHaveLength(1);
    expect(next.hp).toBe(7); expect(stepDodge(next, 0).hp).toBe(7);
  });
  it('enforces shot cooldown and commits the shot lane', () => {
    const a = stepDodge(newDodge(), BIT.JAB | BIT.SLIP_R);
    const b = stepDodge(a, BIT.JAB | BIT.SLIP_L);
    expect(b.shots).toBe(1); expect(b.outgoing[0].lane).toBe(1);
  });
  it('replays deterministically and stops at the time limit', () => {
    let a = newDodge(123), b = newDodge(123);
    for (let i = 0; i < 240; i++) {
      const input = i % 80 < 40 ? BIT.SLIP_L : BIT.SLIP_R;
      a = stepDodge(a, input); b = stepDodge(b, input);
    }
    expect(a).toEqual(b);
    a = { ...a, frame: DODGE_FRAMES - 1, incoming: [], nextRivalShot: DODGE_FRAMES + 1 };
    a = stepDodge(a, 0); expect(a.over).toBe(true);
    expect(stepDodge(a, BIT.JAB)).toBe(a);
  });
});
