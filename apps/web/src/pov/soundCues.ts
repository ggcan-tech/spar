import type { DuelEvent } from "./duel";

/**
 * Which sound to play when. The player stands a few metres from the screen, so
 * sound is the main way they learn that something changed: the ball is theirs,
 * a throw left, a ball is coming, tracking was lost. This module only decides;
 * povAudio.ts makes the noise, so the decisions can be tested without audio.
 */
export type SoundCue =
  | { kind: "setup-locked" }
  | { kind: "your-ball" }
  | { kind: "windup" }
  | { kind: "release"; power: number }
  | { kind: "hit-self"; event: DuelEvent }
  | { kind: "hit-opponent"; event: DuelEvent }
  | { kind: "dodged" }
  | { kind: "missed" }
  | { kind: "caught" }
  | { kind: "dud" }
  | { kind: "lock" }
  | { kind: "tracking-lost" }
  | { kind: "tracking-back" }
  | { kind: "round-won" }
  | { kind: "round-lost" };

export interface SoundFacts {
  /** Which seat is the local player. */
  me: 0 | 1;
  /** Automatic setup has a saved neutral position. */
  calibrated: boolean;
  /** The round is running and the body is tracked. */
  active: boolean;
  /** The round was started and not paused by the player. */
  running: boolean;
  /** The local player holds the ball. */
  ownsBall: boolean;
  /** The opponent is winding up a throw. */
  windup: boolean;
  /** Hand speed of a throw released on this frame, or null. */
  released: number | null;
  events: readonly DuelEvent[];
  hp: readonly [number, number];
}

/** Turns successive snapshots of the game into the sounds that mark each change, once each. */
export function createSoundDirector() {
  let previous: SoundFacts | null = null;
  const heard = new Set<number>();
  let over = false;
  return {
    reset() {
      previous = null;
      heard.clear();
      over = false;
    },
    update(now: SoundFacts): SoundCue[] {
      const cues: SoundCue[] = [];
      const was = previous;
      previous = { ...now, events: [], hp: [now.hp[0], now.hp[1]] };
      if (!was) return cues;
      if (now.calibrated && !was.calibrated)
        cues.push({ kind: "setup-locked" });
      // Tracking only matters to the ear while a round is being played.
      const ended = now.hp.some((hp) => hp <= 0);
      if (now.running && was.running && now.calibrated && !ended) {
        if (was.active && !now.active) cues.push({ kind: "tracking-lost" });
        if (!was.active && now.active) cues.push({ kind: "tracking-back" });
      }
      for (const event of now.events) {
        if (heard.has(event.id)) continue;
        heard.add(event.id);
        const mine = event.target === now.me;
        if (event.kind === "hit")
          cues.push({ kind: mine ? "hit-self" : "hit-opponent", event });
        else if (event.kind === "catch")
          cues.push({ kind: mine ? "caught" : "missed" });
        else cues.push({ kind: mine ? "dodged" : "missed" });
      }
      if (now.windup && !was.windup) cues.push({ kind: "windup" });
      if (now.released !== null)
        cues.push({ kind: "release", power: now.released });
      if (ended && !over)
        cues.push({ kind: now.hp[now.me] > 0 ? "round-won" : "round-lost" });
      over = ended;
      if (!ended && now.active && now.ownsBall && !(was.ownsBall && was.active))
        cues.push({ kind: "your-ball" });
      // A new round: the same ball ids will come round again.
      if (!ended && was.hp.some((hp) => hp <= 0)) heard.clear();
      return cues;
    },
  };
}

/**
 * How close an incoming ball is, for the approach sound: 0 when it leaves the
 * opponent's hand, 1 at the player's head. `pan` is -1 (player's left) to 1.
 * Positions are in the player's own frame.
 */
export function approach(
  ball: { x: number; z: number },
  head: { x: number; z: number },
  courtLength: number,
): { closeness: number; pan: number } {
  const distance = Math.max(0, ball.z - head.z);
  return {
    closeness: Math.max(0, Math.min(1, 1 - distance / courtLength)),
    pan: Math.max(-1, Math.min(1, (ball.x - head.x) / 0.6)),
  };
}
