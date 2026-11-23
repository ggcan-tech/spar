import type { FighterView } from '@spar/protocol';
import { BODY_MOD, PUNCH_TABLE } from '@spar/sim';

/** Artistic distance units calibrated to the simulation's striking ranges, not measured metres. */
export function combatDistance(range: number): number {
  const r = Math.max(200, Math.min(1000, range));
  return r <= 700 ? .65 + (r - 200) * .0013 : 1.3 + (r - 700) * .004;
}
/** Centre of the glove at contact; allowance includes glove and target surface thickness. */
export function contactReach(f: Pick<FighterView, 'punch' | 'body'>, opponentAttacking = false): number {
  if (!f.punch) return .45;
  const range = PUNCH_TABLE[f.punch].maxRange + (f.body ? BODY_MOD.maxRange : 0);
  return combatDistance(range) - (opponentAttacking ? .14 : .27);
}
