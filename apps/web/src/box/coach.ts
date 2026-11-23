/**
 * A coach's voice, spoken by the browser. In a boxing class the voice is most
 * of the teaching: the player's eyes are on the gloves, across the room. Speech
 * from the browser starts late and unevenly, so it is used only for lines that
 * can be a moment late (what to practise, what went wrong, the result), never
 * for a call that must land on time: those stay as sounds and large words.
 *
 * One short line at a time, and not more often than every few seconds.
 */
export interface Coach {
  /** Say it, unless something was said too recently. `must` lines wait for nothing and cut in. */
  say(text: string, must?: boolean): void;
  setEnabled(on: boolean): void;
  stop(): void;
}
export function createCoach(gapMs = 4000): Coach {
  let enabled = true;
  let lastAt = -Infinity;
  let lastText = "";
  const synth =
    typeof window !== "undefined" && "speechSynthesis" in window
      ? window.speechSynthesis
      : null;
  return {
    say(text, must = false) {
      if (!enabled || !synth || !text) return;
      const now = performance.now();
      if (!must && (now - lastAt < gapMs || synth.speaking)) return;
      if (text === lastText && now - lastAt < 12000) return;
      try {
        if (must) synth.cancel();
        const line = new SpeechSynthesisUtterance(text);
        // The clips were made with this voice: where the device has it, the spoken lines match them.
        const same = synth.getVoices().find((v) => v.name.startsWith("Daniel") && v.lang.startsWith("en"));
        if (same) line.voice = same;
        line.rate = 1.08;
        line.pitch = 0.95;
        line.volume = 0.9;
        synth.speak(line);
        lastAt = now;
        lastText = text;
      } catch {
        // No voice on this device: the words on the stage carry it.
      }
    },
    setEnabled(on) {
      enabled = on;
      if (!on) synth?.cancel();
    },
    stop() {
      try {
        synth?.cancel();
      } catch {
        // Nothing was speaking.
      }
    },
  };
}
/**
 * A line for the coach. `call` names recorded clips to play one after another,
 * exactly on time; where they have not loaded, `text` is spoken instead.
 * `must` lines cut in; the rest are dropped when something was said a moment ago.
 */
export interface Line {
  text: string;
  must?: boolean;
  call?: string[];
}
/** The recorded calls, in `public/box/voice/`: what must land on time, and the short words said while punches fly. */
export const CALLS = [
  "slip",
  "duck",
  "elbow",
  "glove-up",
  "hands-up",
  "hit-back",
  "breathe",
  "go-low",
  "go-high",
  "wait",
  "other-hand",
  "nice",
  "good",
  "ten",
  "thirty",
  "one",
  "two",
  "three",
  "four",
  "down",
  "faster",
  "jab",
  "move",
  "break",
  "seconds-out",
] as const;
/**
 * What the coach says for a word that has just gone up on the stage: three
 * words at most while punches are flying. Longer lines (a lesson's task, the
 * corner between rounds, the result) are written where they are decided.
 */
export const SPOKEN: Record<string, Line> = {
  "NOW FIGHT": { text: "Good. Now fight." },
  "TOO EARLY": { text: "Wait for it.", call: ["wait"] },
  "HANDS UP": { text: "Hands up.", call: ["hands-up"] },
  BREATHE: { text: "Breathe.", call: ["breathe"] },
  "CAUGHT!": { text: "Don't trade." },
  "GO LOW": { text: "Go low.", call: ["go-low"] },
  "GO HIGH": { text: "Go high.", call: ["go-high"] },
  "HIT BACK": { text: "Hit back.", call: ["hit-back"] },
  "COUNTER!": { text: "Nice.", call: ["nice"] },
  "PARRY!": { text: "Hit back.", call: ["hit-back"] },
  "KNOCKDOWN!": { text: "Down it goes.", call: ["down"] },
  "ON YOUR FEET": { text: "Hands up.", call: ["hands-up"] },
  "10 SECONDS": { text: "Ten seconds.", call: ["ten"] },
  "OTHER HAND": { text: "Other hand.", call: ["other-hand"] },
  GOOD: { text: "Good.", call: ["good"] },
};
