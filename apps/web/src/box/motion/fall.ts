import { createFight, type Foe } from "../fight";
import { foePose } from "../opponentPose";
import type { FallHook, MotionDown } from "./types";

/**
 * The fall and the get-up. The recordings have nobody falling, so the
 * present formula fall in opponentPose.ts is used as it is: this is the hook
 * that hands it to the motion player, not a copy of it.
 *
 *   createMotionPlayer(pack, { fall: formulaFall })
 *
 * `foePose` reads the old rules' `Foe`; only the few fields the fall looks
 * at are filled in.
 */
const standing: Foe = createFight("contender").foe;

export const formulaFall: FallHook = (down: MotionDown, time: number) => {
  const foe: Foe = {
    ...standing,
    phase: down.out ? "out" : "down",
    since: down.since,
    until: down.until,
    hp: 0,
    // It tips the way the punch was going.
    struck: down.by ? { at: down.since, hand: down.by.hand, shape: down.by.shape, target: "head", power: 1, damage: 12 } : null,
  };
  // The target only matters to a punch; none is thrown from the floor.
  return foePose(foe, time, time, { x: 0, y: 1.65, z: 1.3 });
};
