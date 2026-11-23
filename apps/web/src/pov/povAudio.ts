import type { SoundCue } from "./soundCues";

/**
 * Sounds for the duel, synthesised with WebAudio: no asset files. The context
 * must be unlocked by a tap or key press, so call `resume()` from one. Every
 * method is a no-op until then, and where WebAudio does not exist.
 */
export interface PovAudio {
  resume(): void;
  play(cue: SoundCue): void;
  /** Countdown tick; `last` is the "go" tone. */
  tick(last?: boolean): void;
  /** A ball striking the floor or a wall at `speed`. */
  bounce(speed: number): void;
  /** The hall's own quiet hum, on while play is live: silence means paused. */
  room(on: boolean): void;
  /** Approach sound for a ball coming at the player, or null when none is. */
  incoming(state: { closeness: number; pan: number } | null): void;
  dispose(): void;
}

export function createPovAudio(volume = 0.8): PovAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let approach: {
    source: AudioBufferSourceNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    pan: StereoPannerNode | null;
  } | null = null;
  let disposed = false;
  let hall: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  let hallOn = false;

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
    limiter.threshold.value = -12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
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
  /** A pitched tone with a fast attack and an exponential decay. */
  function tone(o: {
    freq: number;
    to?: number;
    dur: number;
    gain: number;
    type?: OscillatorType;
    delay?: number;
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
    g.connect(master!);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }
  /** A burst of filtered noise: air, cloth, impact. */
  function burst(o: {
    freq: number;
    to?: number;
    dur: number;
    gain: number;
    type?: BiquadFilterType;
    q?: number;
    attack?: number;
    delay?: number;
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
    g.connect(master!);
    source.start(t0);
    source.stop(t0 + o.dur + 0.05);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      g.disconnect();
    };
  }
  const bell = (freq: number, delay = 0, gain = 0.3) => {
    tone({ freq, dur: 0.5, gain, delay });
    tone({ freq: freq * 1.5, dur: 0.3, gain: gain * 0.4, delay });
  };

  function play(cue: SoundCue) {
    switch (cue.kind) {
      case "setup-locked":
        bell(880);
        bell(1320, 0.09, 0.2);
        break;
      case "your-ball":
        tone({ freq: 660, dur: 0.11, gain: 0.3, type: "triangle" });
        tone({
          freq: 990,
          dur: 0.16,
          gain: 0.3,
          type: "triangle",
          delay: 0.09,
        });
        break;
      case "windup":
        burst({ freq: 300, to: 1300, dur: 0.4, gain: 0.16, attack: 0.25 });
        break;
      case "release": {
        const power = Math.max(0, Math.min(8, cue.power));
        burst({
          freq: 700,
          to: 1500 + power * 260,
          dur: 0.2,
          gain: 0.22 + power * 0.04,
          q: 0.8,
        });
        tone({ freq: 150, to: 70, dur: 0.1, gain: 0.25 });
        break;
      }
      case "hit-self":
        tone({ freq: 95, to: 36, dur: 0.3, gain: 0.95 });
        burst({ freq: 900, to: 200, dur: 0.14, gain: 0.5, type: "lowpass" });
        break;
      case "hit-opponent":
        burst({ freq: 1900, dur: 0.07, gain: 0.5, q: 0.7 });
        tone({ freq: 520, to: 250, dur: 0.13, gain: 0.4, type: "triangle" });
        bell(1320, 0.04, 0.22);
        break;
      case "dodged":
        burst({ freq: 1100, to: 380, dur: 0.24, gain: 0.26, attack: 0.05 });
        tone({ freq: 1040, dur: 0.07, gain: 0.12, delay: 0.05 });
        break;
      case "missed":
        tone({ freq: 170, to: 90, dur: 0.15, gain: 0.28 });
        break;
      case "caught":
        // Two palms closing on a ball: a slap, then a rising pair of notes.
        burst({ freq: 2400, to: 900, dur: 0.06, gain: 0.6, q: 0.6 });
        tone({ freq: 240, to: 150, dur: 0.09, gain: 0.5 });
        bell(990, 0.05, 0.26);
        bell(1485, 0.14, 0.24);
        break;
      case "lock":
        tone({ freq: 1500, dur: 0.045, gain: 0.16, type: "triangle" });
        break;
      case "dud":
        // A throw that did not register: short, flat, low.
        tone({ freq: 210, dur: 0.07, gain: 0.2, type: "square" });
        tone({ freq: 170, dur: 0.1, gain: 0.2, type: "square", delay: 0.08 });
        break;
      case "tracking-lost":
        tone({ freq: 520, dur: 0.12, gain: 0.22, type: "triangle" });
        tone({
          freq: 390,
          dur: 0.18,
          gain: 0.22,
          type: "triangle",
          delay: 0.1,
        });
        break;
      case "tracking-back":
        tone({ freq: 390, dur: 0.1, gain: 0.2, type: "triangle" });
        tone({
          freq: 520,
          dur: 0.16,
          gain: 0.2,
          type: "triangle",
          delay: 0.09,
        });
        break;
      case "round-won":
        bell(660);
        bell(880, 0.14);
        bell(1320, 0.28);
        break;
      case "round-lost":
        tone({ freq: 392, dur: 0.3, gain: 0.3, type: "triangle" });
        tone({ freq: 262, dur: 0.5, gain: 0.3, type: "triangle", delay: 0.22 });
        break;
    }
  }

  return {
    resume() {
      const c = context();
      if (c && c.state !== "running") void c.resume().catch(() => {});
    },
    play,
    tick(last = false) {
      tone({
        freq: last ? 1320 : 880,
        dur: last ? 0.35 : 0.09,
        gain: last ? 0.35 : 0.28,
        type: "triangle",
      });
    },
    bounce(speed) {
      const hard = Math.max(0, Math.min(1, speed / 10));
      tone({
        freq: 150 + 90 * hard,
        to: 70,
        dur: 0.11,
        gain: 0.08 + 0.3 * hard,
      });
      burst({ freq: 700, dur: 0.05, gain: 0.04 + 0.12 * hard, q: 0.6 });
    },
    room(on) {
      const c = ready();
      if (!c || (on === hallOn && hall)) return;
      hallOn = on;
      if (!hall) {
        // Air in a large room: low, steady, just above nothing.
        const source = c.createBufferSource();
        source.buffer = noise(c);
        source.loop = true;
        const filter = c.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 280;
        filter.Q.value = 0.4;
        const gain = c.createGain();
        gain.gain.value = 0;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(master!);
        source.start();
        hall = { source, gain };
      }
      hall.gain.gain.setTargetAtTime(
        on ? 0.05 : 0,
        c.currentTime,
        on ? 0.5 : 0.12,
      );
    },
    incoming(state) {
      const c = ready();
      if (!c) return;
      if (!state) {
        approach?.gain.gain.setTargetAtTime(0, c.currentTime, 0.03);
        return;
      }
      if (!approach) {
        const source = c.createBufferSource();
        source.buffer = noise(c);
        source.loop = true;
        const filter = c.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 1.4;
        const gain = c.createGain();
        gain.gain.value = 0;
        const pan =
          typeof c.createStereoPanner === "function"
            ? c.createStereoPanner()
            : null;
        source.connect(filter);
        filter.connect(gain);
        if (pan) {
          gain.connect(pan);
          pan.connect(master!);
        } else gain.connect(master!);
        source.start();
        approach = { source, filter, gain, pan };
      }
      // Louder and brighter as the ball closes: an audible time-to-impact.
      const k = Math.max(0, Math.min(1, state.closeness));
      approach.gain.gain.setTargetAtTime(0.42 * k * k, c.currentTime, 0.02);
      approach.filter.frequency.setTargetAtTime(
        500 + 2100 * k,
        c.currentTime,
        0.02,
      );
      approach.pan?.pan.setTargetAtTime(
        Math.max(-1, Math.min(1, state.pan)),
        c.currentTime,
        0.03,
      );
    },
    dispose() {
      disposed = true;
      try {
        approach?.source.stop();
      } catch {
        // Already stopped.
      }
      approach = null;
      try {
        hall?.source.stop();
      } catch {
        // Already stopped.
      }
      hall = null;
      void ctx?.close().catch(() => {});
      ctx = null;
      master = null;
    },
  };
}
