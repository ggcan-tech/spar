import { JOINT } from "../pov/body";
import type { FlatPose } from "./body";

/**
 * Answers given with the body, so the player never walks to the laptop
 * (DUEL.md 11): after a hit or a shot the page waits a few seconds.
 * - Nothing within 3 s: "mine".
 * - Both hands on the head for half a second: "not mine" (the game's fault).
 * - One arm straight out to the side for half a second: "I guessed wrong".
 * Keys M, G and W give the same answers.
 */
export type Answer = "mine" | "not mine" | "guessed wrong";

export function createAnswerReader(o: { waitMs?: number; holdMs?: number; guess?: boolean } = {}) {
  const wait = o.waitMs ?? 3000,
    hold = o.holdMs ?? 500;
  let asked: number | null = null;
  let since: { kind: Answer; t: number } | null = null;
  return {
    /** Start waiting for an answer. */
    ask(now: number) {
      asked = now;
      since = null;
    },
    waiting: () => asked !== null,
    cancel() {
      asked = null;
      since = null;
    },
    /** Give an answer from the keyboard. */
    key(k: string): Answer | null {
      if (asked === null) return null;
      const a = k === "m" ? "mine" : k === "g" ? "not mine" : k === "w" && o.guess ? "guessed wrong" : null;
      if (a) asked = null;
      return a;
    },
    /** Feed poses; returns the answer once given, or "mine" when the wait runs out. */
    update(pose: FlatPose | null, now: number): Answer | null {
      if (asked === null) return null;
      if (pose) {
        const j = pose.j;
        const head = j[JOINT.NOSE];
        const near = (k: number) => Math.hypot(j[k].x - head.x, j[k].y - head.y) < 0.28 && j[k].y > head.y - 0.12;
        const handsUp = near(JOINT.L_WRIST) && near(JOINT.R_WRIST);
        const armOut = (L: boolean) => {
          const s = j[L ? JOINT.L_SHOULDER : JOINT.R_SHOULDER],
            w = j[L ? JOINT.L_WRIST : JOINT.R_WRIST];
          return Math.abs(w.x - s.x) > 0.42 && Math.abs(w.y - s.y) < 0.18;
        };
        const kind: Answer | null = handsUp ? "not mine" : o.guess && (armOut(true) !== armOut(false)) ? "guessed wrong" : null;
        if (kind) {
          if (!since || since.kind !== kind) since = { kind, t: now };
          else if (now - since.t >= hold) {
            asked = null;
            return kind;
          }
        } else since = null;
      }
      if (now - asked >= wait && !since) {
        asked = null;
        return "mine";
      }
      return null;
    },
  };
}
