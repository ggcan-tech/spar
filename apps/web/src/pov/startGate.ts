import { LM, type Landmark } from "@spar/protocol";

/**
 * When the round clock may run. The player stands across the room and cannot
 * touch the screen, so play must not begin the instant tracking is valid: they
 * may still be walking to their spot. The clock starts only after they have
 * stood in place and heard a count, and after a real interruption it comes
 * back with a short count instead of dropping them straight into a flight.
 *
 * Durations are design choices, not measurements.
 */
export const START_GATE = {
  /** Standing in place this long begins the count. */
  settleMs: 600,
  countMs: 600,
  /** Count before a round, and before resuming after an interruption. */
  counts: 3,
  resumeSettleMs: 400,
  resumeCounts: 2,
  /** A loss shorter than this resumes without ceremony. */
  graceMs: 400,
} as const;

export interface GateFacts {
  now: number;
  /** The round has been started and not paused by the player. */
  running: boolean;
  /** The round has ended. */
  over: boolean;
  /** The body is tracked. */
  valid: boolean;
  /** Tracked, inside the court and the camera frame, near the middle. */
  inPlace: boolean;
}
export interface GateState {
  /** The round clock may run. */
  live: boolean;
  phase: "idle" | "get-in-place" | "counting" | "live";
  /** The number to show during the count. */
  count: number | null;
  /** A sound to play on this frame. */
  cue: "tick" | "go" | null;
}

export function createStartGate() {
  let live = false;
  let entered = false;
  let settledSince = -1;
  let countStart = -1;
  let ticked = 0;
  let lostSince = -1;
  function reset() {
    live = entered = false;
    settledSince = countStart = lostSince = -1;
    ticked = 0;
  }
  return {
    reset,
    update(f: GateFacts): GateState {
      if (!f.running || f.over) {
        reset();
        return { live: false, phase: "idle", count: null, cue: null };
      }
      if (live) {
        if (f.valid) lostSince = -1;
        else {
          if (lostSince < 0) lostSince = f.now;
          if (f.now - lostSince > START_GATE.graceMs) {
            live = false;
            settledSince = countStart = -1;
            ticked = 0;
          }
        }
        if (live) return { live: true, phase: "live", count: null, cue: null };
      }
      if (!f.inPlace) {
        settledSince = countStart = -1;
        ticked = 0;
        return { live: false, phase: "get-in-place", count: null, cue: null };
      }
      const settle = entered ? START_GATE.resumeSettleMs : START_GATE.settleMs,
        counts = entered ? START_GATE.resumeCounts : START_GATE.counts;
      if (settledSince < 0) settledSince = f.now;
      if (f.now - settledSince < settle)
        return { live: false, phase: "get-in-place", count: null, cue: null };
      if (countStart < 0) countStart = f.now;
      const step = Math.floor((f.now - countStart) / START_GATE.countMs);
      if (step >= counts) {
        live = entered = true;
        lostSince = -1;
        return { live: true, phase: "live", count: null, cue: "go" };
      }
      const cue = step >= ticked ? "tick" : null;
      if (cue) ticked = step + 1;
      return { live: false, phase: "counting", count: counts - step, cue };
    },
  };
}

/**
 * A raised hand as "start": either wrist held above the nose. Fires once per
 * raise; the hand must come down before it can fire again. Uses the raw image
 * landmarks, where smaller y is higher.
 */
export function createRaiseHand(holdMs = 800) {
  let since = -1;
  let fired = false;
  return {
    reset() {
      since = -1;
      fired = false;
    },
    update(lm: readonly Landmark[] | undefined, now: number): boolean {
      const nose = lm?.[LM.NOSE];
      const up =
        !!nose &&
        nose.v >= 0.6 &&
        [LM.L_WRIST, LM.R_WRIST].some((i) => {
          const wrist = lm![i];
          return !!wrist && wrist.v >= 0.6 && wrist.y < nose.y - 0.03;
        });
      if (!up) {
        since = -1;
        fired = false;
        return false;
      }
      if (since < 0) since = now;
      if (fired || now - since < holdMs) return false;
      fired = true;
      return true;
    },
  };
}
