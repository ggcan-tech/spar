import type { AttackKind } from "./boxer";
import { CALLS } from "./coach";
import type { FightEvent } from "./fight";
import type { FlowSound } from "./game";
import type { Hand, PunchShape } from "./punch";

/**
 * Sound for the ring, synthesised with WebAudio: no asset files. Sound is the
 * main channel for a player standing across the room: a punch that lands must
 * be heard to land, and a punch on its way must be heard coming, from its side.
 * The context must be unlocked by a tap or key press: call `resume()` from one.
 * Nobody has tuned these by ear yet.
 */
export interface BoxAudio {
  resume(): void;
  /** Everything the rules said happened. */
  event(e: FightEvent): void;
  /** A punch thrown, before it is known whether it lands. */
  swing(shape: PunchShape, hand: Hand): void;
  /** The round's own sounds: the count, the bell, a pause, a lesson done. */
  flow(sound: FlowSound): void;
  /** The hall, louder as the fight heats up; off when paused. */
  hall(on: boolean, heat?: number): void;
  /**
   * The coach's recorded calls, one after another, starting now. False when
   * they cannot be played (not loaded, sound locked, voice off, or another
   * call still sounding and this one can wait): the caller then speaks instead.
   */
  voice(names: readonly string[], must?: boolean): boolean;
  setVoice(on: boolean): void;
  /** How long sound takes to leave the device, as the browser reports it, ms; null when it does not say. */
  latencyMs(): number | null;
  /**
   * The opponent breathes out as a punch begins: short and high for its lead
   * hand, longer and lower for its rear. Laptop speakers cannot place a side,
   * so the breath itself says which hand. Heard at the first movement, it is
   * the earliest warning there is.
   */
  breath(lead: boolean, weight?: number): void;
  /** Its foot coming down as it steps in. */
  foot(): void;
  dispose(): void;
}

export function createBoxAudio(volume = 0.8): BoxAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let room: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  let disposed = false;
  // The coach's recorded calls, fetched once the sound is unlocked.
  const clips = new Map<string, AudioBuffer>();
  let clipsAsked = false,
    voiceOn = true,
    voiceUntil = 0;
  function loadClips(c: AudioContext) {
    if (clipsAsked || typeof fetch !== "function") return;
    clipsAsked = true;
    const base = `${import.meta.env?.BASE_URL ?? "/"}box/voice/`;
    for (const name of CALLS)
      void fetch(`${base}${name}.wav`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((data) => c.decodeAudioData(data))
        .then((buffer) => void clips.set(name, buffer))
        .catch(() => {
          // That call is spoken by the browser instead.
        });
  }
  function context(): AudioContext | null {
    if (disposed) return null;
    if (ctx) return ctx;
    const Ctor: typeof AudioContext | undefined =
      typeof window === "undefined"
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext);
    if (!Ctor) return null;
    ctx = new Ctor();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    master = ctx.createGain();
    master.gain.value = Math.max(0, Math.min(1, volume));
    master.connect(limiter);
    limiter.connect(ctx.destination);
    return ctx;
  }
  const ready = () => {
    const c = context();
    return c && c.state === "running" && master ? c : null;
  };
  function noise(c: AudioContext): AudioBuffer {
    if (noiseBuffer) return noiseBuffer;
    const buffer = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return (noiseBuffer = buffer);
  }
  /** Where a sound sits between the ears: -1 the player's left, 1 their right. */
  function out(c: AudioContext, pan: number): AudioNode {
    if (!pan || typeof c.createStereoPanner !== "function") return master!;
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(master!);
    return p;
  }
  function tone(o: {
    freq: number;
    to?: number;
    dur: number;
    gain: number;
    type?: OscillatorType;
    delay?: number;
    pan?: number;
  }) {
    const c = ready();
    if (!c) return;
    const t0 = c.currentTime + (o.delay ?? 0);
    const osc = c.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(out(c, o.pan ?? 0));
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }
  function burst(o: {
    freq: number;
    to?: number;
    dur: number;
    gain: number;
    type?: BiquadFilterType;
    q?: number;
    attack?: number;
    delay?: number;
    pan?: number;
  }) {
    const c = ready();
    if (!c) return;
    const t0 = c.currentTime + (o.delay ?? 0);
    const source = c.createBufferSource();
    source.buffer = noise(c);
    source.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = o.type ?? "bandpass";
    filter.Q.value = o.q ?? 1;
    filter.frequency.setValueAtTime(o.freq, t0);
    if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    source.connect(filter);
    filter.connect(g);
    g.connect(out(c, o.pan ?? 0));
    source.start(t0);
    source.stop(t0 + o.dur + 0.05);
  }
  const bell = (delay = 0) => {
    for (const [f, g] of [
      [830, 0.5],
      [1245, 0.3],
      [2075, 0.18],
      [2905, 0.1],
    ])
      tone({ freq: f, dur: 1.4, gain: g, delay });
  };
  /** A glove on a body: a low thud under a leathery slap, heavier with power. */
  function thwack(shape: PunchShape, target: "head" | "body", power: number, counter: boolean, pan: number) {
    // Heard when the glove gets there, a twentieth of a second after the punch is read.
    const delay = 0.05;
    const p = Math.max(0.6, Math.min(1.4, 0.4 + power * 0.6)) * (counter ? 1.25 : 1);
    const low = target === "body" ? 70 : shape === "straight" ? 120 : 95;
    tone({ freq: low * 1.9, to: low * 0.6, dur: 0.11 + 0.06 * p, gain: 0.55 * p, pan, delay });
    // A body the laptop's small speakers can carry: the thud alone is too low for them.
    tone({ freq: target === "body" ? 380 : 560, to: 240, dur: 0.07, gain: 0.3 * p, type: "triangle", pan, delay });
    burst({
      freq: target === "body" ? 500 : shape === "hook" ? 1500 : 2100,
      to: 300,
      dur: 0.07 + 0.03 * p,
      gain: 0.5 * p,
      q: 0.7,
      type: "lowpass",
      pan,
      delay,
    });
    if (shape !== "straight" || counter) burst({ freq: 3200, dur: 0.035, gain: 0.3 * p, q: 0.5, pan, delay });
    if (counter) {
      tone({ freq: 660, dur: 0.12, gain: 0.25, type: "triangle", delay: delay + 0.03 });
      tone({ freq: 990, dur: 0.2, gain: 0.25, type: "triangle", delay: delay + 0.1 });
    }
  }
  /** What a punch on its way sounds like, for each kind. */
  const coming: Record<AttackKind, (pan: number) => void> = {
    jab: (pan) => burst({ freq: 900, to: 2400, dur: 0.16, gain: 0.2, attack: 0.1, pan }),
    cross: (pan) => burst({ freq: 500, to: 2000, dur: 0.24, gain: 0.26, attack: 0.16, pan }),
    hook: (pan) => {
      burst({ freq: 350, to: 1500, dur: 0.3, gain: 0.26, attack: 0.2, pan });
      tone({ freq: 300, to: 520, dur: 0.26, gain: 0.1, type: "triangle", pan });
    },
    body: (pan) => {
      burst({ freq: 240, to: 800, dur: 0.26, gain: 0.26, attack: 0.18, pan });
      tone({ freq: 190, to: 120, dur: 0.24, gain: 0.14, type: "triangle", pan });
    },
  };

  return {
    resume() {
      const c = context();
      if (c && c.state !== "running") void c.resume().catch(() => {});
      if (c) loadClips(c);
    },
    voice(names, must = false) {
      const c = ready();
      if (!c || !voiceOn || !names.length || !names.every((n) => clips.has(n))) return false;
      // One voice at a time: a call that can wait is dropped, not queued; it would be late.
      if (!must && c.currentTime < voiceUntil) return true;
      let at = Math.max(c.currentTime + 0.005, must ? 0 : voiceUntil);
      for (const name of names) {
        const buffer = clips.get(name)!;
        const source = c.createBufferSource();
        source.buffer = buffer;
        const g = c.createGain();
        g.gain.value = 0.95;
        source.connect(g);
        g.connect(master!);
        source.start(at);
        // Numbers run together as a coach says them.
        at += buffer.duration - (names.length > 1 ? 0.04 : 0);
      }
      voiceUntil = at + 0.15;
      return true;
    },
    setVoice(on) {
      voiceOn = on;
    },
    breath(lead, weight = 1) {
      const k = Math.max(0.5, Math.min(1.4, weight));
      if (lead) burst({ freq: 2600, to: 1700, dur: 0.07, gain: 0.16 * k, attack: 0.012, q: 1.4 });
      else {
        burst({ freq: 1300, to: 700, dur: 0.14, gain: 0.2 * k, attack: 0.03, q: 0.9 });
        tone({ freq: 150, to: 110, dur: 0.1, gain: 0.07 * k, type: "triangle" });
      }
    },
    foot() {
      tone({ freq: 95, to: 55, dur: 0.07, gain: 0.34 });
      burst({ freq: 420, to: 180, dur: 0.05, gain: 0.2, q: 0.7, type: "lowpass" });
    },
    latencyMs() {
      const c = ctx as (AudioContext & { outputLatency?: number }) | null;
      if (!c) return null;
      const seconds = (c.outputLatency ?? 0) + (c.baseLatency ?? 0);
      return seconds > 0 ? seconds * 1000 : null;
    },
    swing(shape, hand) {
      const pan = hand === "left" ? -0.35 : 0.35;
      // A short snap of cloth, pitched, so a hiss always means a punch coming at the player.
      tone({
        freq: shape === "straight" ? 420 : 320,
        to: shape === "straight" ? 180 : 140,
        dur: shape === "straight" ? 0.05 : 0.08,
        gain: 0.13,
        type: "triangle",
        pan,
      });
    },
    flow(sound) {
      switch (sound) {
        case "count":
          tone({ freq: 620, dur: 0.1, gain: 0.3, type: "triangle" });
          break;
        case "bell":
          bell();
          bell(0.28);
          break;
        case "setup-done":
          tone({ freq: 880, dur: 0.4, gain: 0.3 });
          tone({ freq: 1320, dur: 0.5, gain: 0.22, delay: 0.1 });
          break;
        // A pause falls, coming back rises: neither is the bell.
        case "pause":
          tone({ freq: 520, dur: 0.14, gain: 0.26, type: "triangle" });
          tone({ freq: 390, dur: 0.2, gain: 0.26, type: "triangle", delay: 0.11 });
          break;
        case "resume":
          tone({ freq: 390, dur: 0.12, gain: 0.24, type: "triangle" });
          tone({ freq: 520, dur: 0.18, gain: 0.24, type: "triangle", delay: 0.1 });
          break;
        case "tick":
          tone({ freq: 1000, dur: 0.05, gain: 0.22, type: "square" });
          break;
        // Wood on wood, twice: a gym's ten-second warning.
        case "knock":
          for (const delay of [0, 0.16]) {
            tone({ freq: 760, to: 520, dur: 0.07, gain: 0.4, type: "triangle", delay });
            burst({ freq: 1800, to: 700, dur: 0.05, gain: 0.3, q: 1.5, delay });
          }
          break;
        // The ropes take a body's weight: a low creak, twice, behind the player.
        case "ropes":
          for (const delay of [0, 0.22]) {
            burst({ freq: 240, to: 150, dur: 0.2, gain: 0.3, q: 9, attack: 0.03, delay });
            tone({ freq: 96, to: 74, dur: 0.22, gain: 0.22, type: "sawtooth", delay });
          }
          break;
        case "lesson-step":
          tone({ freq: 660, dur: 0.1, gain: 0.25, type: "triangle" });
          tone({ freq: 990, dur: 0.18, gain: 0.25, type: "triangle", delay: 0.09 });
          break;
        case "lesson-done":
          for (const [i, f] of [523, 659, 784].entries())
            tone({ freq: f, dur: 0.22, gain: 0.22, type: "triangle", delay: i * 0.11 });
          break;
      }
    },
    hall(on, heat = 0) {
      const c = ready();
      if (!c) return;
      if (!room) {
        const source = c.createBufferSource();
        source.buffer = noise(c);
        source.loop = true;
        const filter = c.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 520;
        filter.Q.value = 0.35;
        const gain = c.createGain();
        gain.gain.value = 0;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(master!);
        source.start();
        room = { source, gain };
      }
      room.gain.gain.setTargetAtTime(
        on ? 0.03 + 0.07 * Math.max(0, Math.min(1, heat)) : 0,
        c.currentTime,
        on ? 0.35 : 0.12,
      );
    },
    event(e) {
      switch (e.kind) {
        case "landed":
          thwack(e.shape, e.target, e.power, e.counter, e.hand === "left" ? -0.25 : 0.25);
          if (e.combo >= 3 && !e.counter)
            tone({ freq: 520 + 70 * Math.min(e.combo, 8), dur: 0.08, gain: 0.14, type: "triangle", delay: 0.02 });
          break;
        case "blocked":
          // Leather on leather: flat, no weight.
          // A hard two-part clack, at contact.
          burst({ freq: 1100, to: 500, dur: 0.06, gain: 0.3, q: 1.2, pan: e.hand === "left" ? -0.25 : 0.25, delay: 0.05 });
          tone({ freq: 420, dur: 0.04, gain: 0.2, type: "square", delay: 0.05 });
          tone({ freq: 300, dur: 0.05, gain: 0.16, type: "square", delay: 0.09 });
          break;
        case "gassed":
          burst({ freq: 700, to: 300, dur: 0.4, gain: 0.16, attack: 0.15, type: "lowpass" });
          break;
        case "guard-broken":
          burst({ freq: 2600, to: 400, dur: 0.22, gain: 0.5, q: 0.5 });
          tone({ freq: 440, to: 880, dur: 0.2, gain: 0.25, type: "triangle" });
          break;
        case "stopped":
          tone({ freq: 880, dur: 0.07, gain: 0.25, type: "square" });
          tone({ freq: 1320, dur: 0.14, gain: 0.25, type: "triangle", delay: 0.06 });
          break;
        case "telegraph":
          // The opponent's left hand is on the player's right.
          coming[e.attack](e.hand === "left" ? 0.6 : -0.6);
          break;
        case "dodged":
          burst({ freq: 1800, to: 500, dur: 0.22, gain: 0.3, attack: 0.03, q: 0.8 });
          tone({ freq: 1040, dur: 0.08, gain: 0.14, delay: 0.05 });
          break;
        case "blocked-me":
          burst({ freq: 900, to: 300, dur: 0.1, gain: 0.5, q: 0.8, type: "lowpass" });
          tone({ freq: 140, to: 80, dur: 0.12, gain: 0.4 });
          break;
        case "hit-me": {
          const pan = e.hand === "left" ? 0.5 : -0.5;
          tone({ freq: 110, to: 34, dur: 0.34, gain: 1, pan });
          burst({ freq: 1000, to: 160, dur: 0.16, gain: 0.6, type: "lowpass", pan });
          // The ears ring for a moment.
          tone({ freq: 3900, dur: 0.5, gain: 0.03 + e.damage * 0.003 });
          break;
        }
        case "foe-down":
        case "me-down":
          tone({ freq: 70, to: 30, dur: 0.5, gain: 0.9, delay: 0.25 });
          burst({ freq: 300, to: 80, dur: 0.4, gain: 0.5, type: "lowpass", delay: 0.25 });
          burst({ freq: 900, dur: 1.4, gain: e.kind === "foe-down" ? 0.3 : 0.12, attack: 0.5, q: 0.3 });
          break;
        case "foe-up":
        case "me-up":
          tone({ freq: 520, dur: 0.1, gain: 0.2, type: "triangle" });
          tone({ freq: 700, dur: 0.14, gain: 0.2, type: "triangle", delay: 0.09 });
          break;
        case "over":
          bell();
          bell(0.25);
          bell(0.5);
          if (e.winner === 0) {
            burst({ freq: 1000, dur: 2.2, gain: 0.35, attack: 0.6, q: 0.3 });
            for (const [i, f] of [523, 659, 784, 1047].entries())
              tone({ freq: f, dur: 0.3, gain: 0.22, type: "triangle", delay: 0.8 + i * 0.14 });
          } else {
            tone({ freq: 392, dur: 0.4, gain: 0.25, type: "triangle", delay: 0.8 });
            tone({ freq: 262, dur: 0.7, gain: 0.25, type: "triangle", delay: 1.1 });
          }
          break;
        case "feint":
          break;
      }
    },
    dispose() {
      disposed = true;
      try {
        room?.source.stop();
      } catch {
        // Already stopped.
      }
      room = null;
      void ctx?.close().catch(() => {});
      ctx = null;
      master = null;
    },
  };
}
