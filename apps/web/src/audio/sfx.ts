/**
 * WebAudio-synthesized fight sounds. No asset files: noise bursts through filters + low sine
 * thumps with short envelopes. The AudioContext is created lazily and must be unlocked by a
 * user gesture: call `resume()` from a click/keydown handler.
 */
export interface Sfx {
  /** Create/resume the AudioContext. Safe to call repeatedly; no-op where WebAudio is missing. */
  resume(): Promise<void>;
  hit(damage: number): void;
  block(): void;
  whiff(): void;
  bell(): void;
  /** Crowd bed level 0..1 (smoothly ramped). 0 fades it out. */
  crowd(level: number): void;
  knockdown(): void;
  countdownTick(): void;
  setVolume(v: number): void;
  volume(): number;
  readonly unlocked: boolean;
  dispose(): void;
}

const NOISE_SECONDS = 2;

export function createSfx(initialVolume = 0.8): Sfx {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let crowdNodes: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  let crowdTarget = 0;
  let vol = clamp01(initialVolume);
  let disposed = false;

  function getCtx(): AudioContext | null {
    if (disposed) return null;
    if (ctx) return ctx;
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return null;
    ctx = new Ctor();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    master = ctx.createGain();
    master.gain.value = vol;
    master.connect(comp);
    comp.connect(ctx.destination);
    return ctx;
  }

  function ready(): AudioContext | null {
    const c = getCtx();
    return c && c.state === 'running' ? c : null;
  }

  function noise(c: AudioContext): AudioBuffer {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(c.sampleRate * NOISE_SECONDS);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }

  /** Filtered noise burst with an exponential decay envelope. */
  function burst(o: {
    dur: number;
    gain: number;
    type: BiquadFilterType;
    freq: number;
    freqEnd?: number;
    q?: number;
    attack?: number;
    delay?: number;
  }): void {
    const c = ready();
    if (!c || !master) return;
    const t0 = c.currentTime + (o.delay ?? 0);
    const src = c.createBufferSource();
    src.buffer = noise(c);
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.type;
    f.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + o.dur);
    f.Q.value = o.q ?? 1;
    const g = c.createGain();
    const atk = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + o.dur + 0.05);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  /** Sine/triangle thump with a pitch drop. */
  function thump(o: {
    freq: number;
    freqEnd: number;
    dur: number;
    gain: number;
    type?: OscillatorType;
    delay?: number;
  }): void {
    const c = ready();
    if (!c || !master) return;
    const t0 = c.currentTime + (o.delay ?? 0);
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  /** Inharmonic partials for the bell. */
  function ring(freq: number, dur: number, gain: number, delay = 0): void {
    const c = ready();
    if (!c || !master) return;
    const t0 = c.currentTime + delay;
    const partials: Array<[number, number, number]> = [
      [1, 1, dur],
      [2.01, 0.55, dur * 0.7],
      [2.98, 0.35, dur * 0.5],
      [4.21, 0.22, dur * 0.35],
      [5.4, 0.12, dur * 0.25],
    ];
    for (const [ratio, amp, d] of partials) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain * amp, t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + d + 0.02);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    }
    // strike transient
    burst({ dur: 0.03, gain: gain * 0.6, type: 'highpass', freq: 3000, delay });
  }

  function ensureCrowd(c: AudioContext): { src: AudioBufferSourceNode; gain: GainNode } | null {
    if (!master) return null;
    if (crowdNodes) return crowdNodes;
    const src = c.createBufferSource();
    src.buffer = noise(c);
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.4;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.6;
    // slow LFO on the band-pass gives the murmur some movement
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.23;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);
    lfo.start();
    const gain = c.createGain();
    gain.gain.value = 0;
    src.connect(lp);
    lp.connect(bp);
    bp.connect(gain);
    gain.connect(master);
    src.start();
    crowdNodes = { src, gain };
    return crowdNodes;
  }

  return {
    get unlocked() {
      return !!ctx && ctx.state === 'running';
    },
    async resume(): Promise<void> {
      const c = getCtx();
      if (!c) return;
      if (c.state !== 'running') {
        try {
          await c.resume();
        } catch {
          /* still locked; next gesture will retry */
        }
      }
      if (c.state === 'running' && crowdTarget > 0) {
        const cr = ensureCrowd(c);
        cr?.gain.gain.setTargetAtTime(crowdTarget * 0.35, c.currentTime, 0.4);
      }
    },
    hit(damage: number): void {
      const d = clamp01(damage / 160);
      thump({ freq: 110 + 40 * d, freqEnd: 38, dur: 0.16 + 0.12 * d, gain: 0.55 + 0.45 * d });
      burst({ dur: 0.07 + 0.05 * d, gain: 0.35 + 0.3 * d, type: 'bandpass', freq: 1400, freqEnd: 500, q: 0.8 });
      if (d > 0.5) thump({ freq: 60, freqEnd: 30, dur: 0.35, gain: 0.5, type: 'triangle', delay: 0.01 });
    },
    block(): void {
      burst({ dur: 0.05, gain: 0.3, type: 'highpass', freq: 2200, q: 0.7 });
      thump({ freq: 320, freqEnd: 180, dur: 0.07, gain: 0.25, type: 'triangle' });
    },
    whiff(): void {
      burst({ dur: 0.14, gain: 0.18, type: 'bandpass', freq: 700, freqEnd: 2600, q: 1.2, attack: 0.03 });
    },
    bell(): void {
      ring(880, 1.6, 0.5);
    },
    crowd(level: number): void {
      crowdTarget = clamp01(level);
      const c = ready();
      if (!c) return;
      const cr = ensureCrowd(c);
      if (!cr) return;
      cr.gain.gain.setTargetAtTime(crowdTarget * 0.35, c.currentTime, crowdTarget > 0 ? 0.25 : 0.8);
    },
    knockdown(): void {
      thump({ freq: 90, freqEnd: 28, dur: 0.5, gain: 0.9 });
      thump({ freq: 50, freqEnd: 24, dur: 0.7, gain: 0.7, type: 'triangle', delay: 0.03 });
      burst({ dur: 0.25, gain: 0.5, type: 'lowpass', freq: 1200, freqEnd: 200, q: 0.5 });
      // crowd roar swell
      const c = ready();
      const cr = c ? ensureCrowd(c) : null;
      if (c && cr) {
        const now = c.currentTime;
        cr.gain.gain.cancelScheduledValues(now);
        cr.gain.gain.setTargetAtTime(0.6, now, 0.08);
        cr.gain.gain.setTargetAtTime(crowdTarget * 0.35, now + 1.2, 0.8);
      }
    },
    countdownTick(): void {
      thump({ freq: 1000, freqEnd: 700, dur: 0.045, gain: 0.3, type: 'square' });
      burst({ dur: 0.02, gain: 0.15, type: 'highpass', freq: 4000 });
    },
    setVolume(v: number): void {
      vol = clamp01(v);
      if (master && ctx) master.gain.setTargetAtTime(vol, ctx.currentTime, 0.02);
    },
    volume: () => vol,
    dispose(): void {
      disposed = true;
      try {
        crowdNodes?.src.stop();
      } catch {
        /* not started */
      }
      crowdNodes = null;
      const c = ctx;
      ctx = null;
      master = null;
      noiseBuf = null;
      c?.close().catch(() => {});
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
