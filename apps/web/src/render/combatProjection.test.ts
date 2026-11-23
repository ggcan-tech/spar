import { describe, expect, it } from 'vitest';
import { PUNCH_TABLE, BODY_MOD } from '@spar/sim';
import type { PunchKind } from '@spar/protocol';
import { combatDistance, contactReach } from './combatProjection';
describe('combat visual distance', () => {
  it('places every head and body punch at contact at its authoritative maximum range', () => {
    for (const punch of Object.keys(PUNCH_TABLE) as PunchKind[]) for (const body of [false, true]) {
      const range = PUNCH_TABLE[punch].maxRange + (body ? BODY_MOD.maxRange : 0);
      expect(contactReach({ punch, body }) + .27).toBeCloseTo(combatDistance(range));
      expect(contactReach({ punch, body }, true) + .14).toBeCloseTo(combatDistance(range));
      expect(combatDistance(range + 50)).toBeGreaterThan(contactReach({ punch, body }) + .27);
    }
  });
  it('keeps closer steps monotonic, continuous at jab range and bounded inside the ring', () => {
    expect(combatDistance(700)).toBeCloseTo(1.3);
    expect(combatDistance(701) - combatDistance(700)).toBeLessThan(.01);
    expect(combatDistance(-100)).toBe(combatDistance(200));
    expect(combatDistance(5000)).toBe(combatDistance(1000));
    for (let r = 200; r < 1000; r += 10) expect(combatDistance(r + 10)).toBeGreaterThan(combatDistance(r));
  });
});
