import { describe, expect, it } from 'vitest';
import { OneEuro, OneEuroPoint, DEFAULTS, synth } from '../src/index';

const std = (a: number[]) => {
  const m = a.reduce((p, q) => p + q, 0) / a.length;
  return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length);
};
const gaussian = (seed: number) => {
  const r = synth.rng(seed);
  return () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
};

describe('OneEuro', () => {
  const { minCutoff, beta, dCutoff } = DEFAULTS.filter;

  it('reduces jitter on a noisy constant', () => {
    const g = gaussian(3);
    const f = new OneEuro(minCutoff, beta, dCutoff);
    const raw: number[] = [], out: number[] = [];
    for (let i = 0; i < 900; i++) {
      const x = 0.5 + g() * 0.004;
      raw.push(x);
      out.push(f.filter(x, (i * 1000) / 30));
    }
    expect(std(out)).toBeLessThan(0.65 * std(raw));
    expect(Math.abs(out.reduce((a, b) => a + b, 0) / out.length - 0.5)).toBeLessThan(0.001);
  });

  it('tracks a ramp with small lag', () => {
    const f = new OneEuro(minCutoff, beta, dCutoff);
    const speed = 2; // units/s — wrist speed during a punch in normalized image units
    let lagMs = 0;
    for (let i = 0; i <= 15; i++) {
      const t = (i * 1000) / 30;
      const y = f.filter((speed * t) / 1000, t);
      lagMs = ((speed * t) / 1000 - y) / speed * 1000;
    }
    expect(lagMs).toBeLessThan(15);
  });

  it('the doc value beta=0.05 lags ~90 ms on the same ramp (why beta was retuned)', () => {
    const f = new OneEuro(1.5, 0.05, 1.0);
    let lagMs = 0;
    for (let i = 0; i <= 15; i++) {
      const t = (i * 1000) / 30;
      const y = f.filter((2 * t) / 1000, t);
      lagMs = ((2 * t) / 1000 - y) / 2 * 1000;
    }
    expect(lagMs).toBeGreaterThan(60);
  });

  it('holds on non-increasing timestamps and restarts after reset()', () => {
    const f = new OneEuro(minCutoff, beta, dCutoff);
    expect(f.filter(1, 0)).toBe(1);
    const a = f.filter(2, 33);
    expect(f.filter(100, 33)).toBe(a); // same timestamp → held
    expect(f.filter(100, 10)).toBe(a); // earlier timestamp → held
    f.reset();
    expect(f.filter(7, 0)).toBe(7);    // first sample after reset passes through
  });

  it('OneEuroPoint filters x, y, z independently', () => {
    const p = new OneEuroPoint(minCutoff, beta, dCutoff);
    expect(p.filter({ x: 1, y: 2, z: 3 }, 0)).toEqual({ x: 1, y: 2, z: 3 });
    const q = p.filter({ x: 1, y: 2, z: 3.5 }, 33);
    expect(q.x).toBe(1);
    expect(q.y).toBe(2);
    expect(q.z).toBeGreaterThan(3);
    expect(q.z).toBeLessThan(3.5);
  });
});
