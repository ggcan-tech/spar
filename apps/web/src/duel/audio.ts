/**
 * The duel's sounds, made in the browser (no files): a rubber-band thwip, a
 * whistle that rises toward arrival, a wet splorch, a bright zing on a close
 * call, a hum whose pitch shows the fan band. Every sound has a visual twin on
 * the stage, so the game plays the same with the sound off.
 */
import type { Fan } from "./flight";

export function createDuelAudio() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let hum: { osc: OscillatorNode; gain: GainNode } | null = null;
  let muted = false;
  const ready = () => {
    if (muted) return null;
    if (!ctx) {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  };
  const noise = (c: AudioContext, seconds: number) => {
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    return src;
  };
  const tone = (freq: number, to: number, seconds: number, type: OscillatorType, level: number, at = 0) => {
    const c = ready();
    if (!c || !master) return;
    const t = c.currentTime + at;
    const o = c.createOscillator(),
      g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + seconds);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + seconds + 0.02);
  };
  return {
    /** Wake the audio on a user gesture (browsers need one). */
    unlock: () => void ready(),
    setMuted(m: boolean) {
      muted = m;
      if (m) this.hum(null);
    },
    thwip() {
      tone(900, 180, 0.12, "triangle", 0.35);
      const c = ready();
      if (!c || !master) return;
      const n = noise(c, 0.06),
        f = c.createBiquadFilter(),
        g = c.createGain();
      f.type = "bandpass";
      f.frequency.value = 2500;
      g.gain.value = 0.15;
      n.connect(f).connect(g).connect(master);
      n.start();
    },
    /** A whistle that rises over the flight. */
    whistle(seconds: number, quiet = false) {
      tone(500, 1400, Math.max(0.3, seconds), "sine", quiet ? 0.04 : 0.08);
    },
    splorch() {
      const c = ready();
      if (!c || !master) return;
      const n = noise(c, 0.35),
        f = c.createBiquadFilter(),
        g = c.createGain();
      f.type = "lowpass";
      f.frequency.setValueAtTime(1800, c.currentTime);
      f.frequency.exponentialRampToValueAtTime(200, c.currentTime + 0.3);
      g.gain.setValueAtTime(0.6, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.33);
      n.connect(f).connect(g).connect(master);
      n.start();
      tone(160, 60, 0.25, "sine", 0.5);
    },
    zing() {
      tone(1800, 2600, 0.18, "sine", 0.18);
      tone(2600, 3400, 0.12, "sine", 0.1, 0.06);
    },
    /** A short low tick: a flick refused. */
    tick() {
      tone(220, 180, 0.06, "square", 0.08);
    },
    bell() {
      tone(880, 870, 0.9, "sine", 0.25);
      tone(1320, 1300, 0.6, "sine", 0.1);
    },
    squeeze() {
      tone(140, 110, 0.5, "sawtooth", 0.12);
    },
    /** The fan's hum while a draw is held; null stops it. */
    hum(band: Fan | null) {
      const c = ready();
      if (!c || !master) return;
      if (!band) {
        if (hum) {
          hum.gain.gain.setTargetAtTime(0, c.currentTime, 0.05);
          const h = hum;
          setTimeout(() => h.osc.stop(), 300);
          hum = null;
        }
        return;
      }
      const freq = band === "flat" ? 150 : band === "middle" ? 210 : 290;
      if (!hum) {
        const osc = c.createOscillator(),
          gain = c.createGain();
        osc.type = "triangle";
        gain.gain.value = 0;
        osc.connect(gain).connect(master);
        osc.start();
        hum = { osc, gain };
      }
      hum.osc.frequency.setTargetAtTime(freq, c.currentTime, 0.04);
      hum.gain.gain.setTargetAtTime(0.06, c.currentTime, 0.05);
    },
    close() {
      this.hum(null);
      void ctx?.close();
      ctx = null;
    },
  };
}
export type DuelAudio = ReturnType<typeof createDuelAudio>;
