/**
 * One-Euro filter (Casiez, Roussel, Vogel 2012) — adaptive low-pass:
 * a low cutoff kills jitter while the landmark is still, and the cutoff rises with speed so
 * fast motion (a punch) passes with little lag.
 *
 * Units: `beta` multiplies the estimated speed in (value units)/s, so it is unit-dependent.
 */
export interface OneEuroParams {
  minCutoff: number; // Hz
  beta: number;      // per (unit/s)
  dCutoff: number;   // Hz, cutoff for the derivative estimate
}

function alphaFor(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export class OneEuro {
  private xHat = 0;
  private dxHat = 0;
  private tPrev = 0;
  private initialized = false;

  constructor(
    public minCutoff = 1.5,
    public beta = 0.05,
    public dCutoff = 1.0,
  ) {}

  /** Feed one sample at time `tMs`; returns the filtered value. */
  filter(x: number, tMs: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.xHat = x;
      this.dxHat = 0;
      this.tPrev = tMs;
      return x;
    }
    const dt = (tMs - this.tPrev) / 1000;
    if (!(dt > 0)) return this.xHat; // non-increasing timestamp: hold
    this.tPrev = tMs;
    const dx = (x - this.xHat) / dt;
    const aD = alphaFor(this.dCutoff, dt);
    this.dxHat = aD * dx + (1 - aD) * this.dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    const a = alphaFor(cutoff, dt);
    this.xHat = a * x + (1 - a) * this.xHat;
    return this.xHat;
  }

  /** Last filtered value (0 before the first sample). */
  get value(): number { return this.xHat; }
  /** Last filtered speed estimate in units/s. */
  get speed(): number { return this.dxHat; }
  get ready(): boolean { return this.initialized; }

  reset(): void {
    this.initialized = false;
    this.xHat = 0;
    this.dxHat = 0;
    this.tPrev = 0;
  }
}

/** Three One-Euro filters, one per axis, for a {x,y,z} point. */
export class OneEuroPoint {
  readonly fx: OneEuro;
  readonly fy: OneEuro;
  readonly fz: OneEuro;

  constructor(minCutoff = 1.5, beta = 0.05, dCutoff = 1.0) {
    this.fx = new OneEuro(minCutoff, beta, dCutoff);
    this.fy = new OneEuro(minCutoff, beta, dCutoff);
    this.fz = new OneEuro(minCutoff, beta, dCutoff);
  }

  filter(p: { x: number; y: number; z: number }, tMs: number): { x: number; y: number; z: number } {
    return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs), z: this.fz.filter(p.z, tMs) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}
