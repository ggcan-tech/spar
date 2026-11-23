/**
 * @spar/sim — public surface.
 *   sim         SimLike<SimState>: init / step / hash / view
 *   replay      run an input log from a seed → { hash, view, frames }
 *   createBot   deterministic seeded policy over MatchView
 *   PUNCH_TABLE the punch table as data (plus BODY_MOD and SIM_NUMBERS)
 */
export {
  sim,
  replay,
  PUNCH_TABLE,
  PUNCH_KINDS,
  BODY_MOD,
  SIM_NUMBERS,
  ROUND_FRAMES,
  REST_FRAMES,
  MS,
  PH,
  HD,
  PK,
  METHOD,
  WIN_DRAW,
  WIN_NONE,
} from './sim';
export type { SimState, FighterState, PunchSpec } from './sim';
export { createBot } from './bot';
