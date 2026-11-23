/**
 * Every tunable number in @spar/gestures. Values come from docs/DESIGN.md "Gesture numbers";
 * any deviation from the doc is marked with a `// TUNING:` comment explaining why.
 */
export const DEFAULTS = {
  /** image height / width. Normalized MediaPipe coords are anisotropic; the app should pass videoHeight/videoWidth. */
  aspect: 1,
  /** landmarks with visibility below this are "missing": the detector that needs them holds its state. */
  visibilityMin: 0.5,
  /** a gap longer than this between frames resets filters and velocity estimates (tab hidden, camera stall). */
  maxGapMs: 500,

  /**
   * One-Euro per landmark, applied to image-normalized coordinates.
   * TUNING: DESIGN.md says beta 0.05, which is the usual value for *pixel* units (speeds of ~10³ px/s).
   * In normalized units a punch moves a wrist at only ~2 units/s, so beta 0.05 adds ~0.1 Hz to the
   * 1.5 Hz floor: the filter never opens up, a 150 ms jab is smeared to ~1.6 Hz and lags ~90 ms
   * (measured: JAB recall 8/20, hooks and uppers 0/20 at 30 fps). beta is scaled for unit speeds
   * (see filter sweep in the test suite): ramp lag drops to a few ms while idle jitter is still cut ~55%.
   */
  filter: { minCutoff: 1.5, beta: 10, dCutoff: 1.0 },

  punch: {
    /** enter EXTENDING when ė > extendEdot (/s) and e > extendE */
    extendE: 0.45,
    extendEdot: 3.0,
    /** early fire when e ≥ earlyE and ė > earlyEdot */
    earlyE: 0.65,
    earlyEdot: 4.0,
    earlyConfidence: 0.8,
    /**
     * peak fire when e ≥ peakE and ė crosses ≤ 0.
     * TUNING: DESIGN.md says 0.80. With a two-segment arm e = sin(elbow/2), so 0.80 needs an elbow of
     * ≥106°: it excludes the tighter half of the doc's own hook range (60–140°, a "≈90°" hook is e≈0.71)
     * and hooks have low *radial* speed so the early rule rarely catches them (measured 15/20 at e_peak
     * 0.84 with noise). 0.72 ≈ a 92° elbow keeps tight hooks while a feint stopping at 70% reach still
     * does not fire.
     */
    peakE: 0.72,
    peakConfidence: 0.95,
    /** hand re-arms (RETRACTING → IDLE) when e drops below this */
    rearmE: 0.55,
    /** a re-extension from RETRACTING needs e to have dropped at least this much first (double jab) */
    reextendDrop: 0.15,
    /** an extension that neither fires nor retracts within this time is abandoned */
    maxExtendMs: 400,
    /** classification */
    straightElbowMin: 150,
    straightLateralMax: 0.35,
    /** Forward wrist travel within the trajectory window. Supports early straights
     * before the elbow opens fully; depth evidence must dominate lateral travel. */
    straightForwardMin: 0.35,
    hookElbowMin: 60,
    hookElbowMax: 140,
    hookLateralMin: 0.35,
    /** upper: peak upward wrist velocity below this (/s, image y grows downward) with elbow bent and wrist above shoulder line */
    upperVyMax: -2.5,
    upperElbowMax: 140,
    upperEndYMax: 0.15,
    /** BODY when wrist y at fire time is below the shoulder line by more than this (units) */
    bodyDy: 0.25,
    /** history window for lateral-travel / midline-crossing measures (ms) */
    lateralWindowMs: 250,
    /** min ms between events of the same hand */
    sameHandGapMs: 120,
    /** if both hands fire within this window keep the higher confidence */
    bothHandsGapMs: 60,
  },

  head: {
    /** nose x offset from (calibrated) center, body units */
    slipEnter: 0.35,
    slipExit: 0.2,
    /** nose y drop below calibrated neutral (units of shoulder width, image space) */
    duckDrop: 0.35,
    duckExitDrop: 0.2,
    /** knee angle must be below this (deg) — only checked when knees are visible */
    duckKneeMax: 160,
  },

  guard: {
    /** chin box: center (0, chinY) with chinY = neutral nose y + chinOffset; half extents in units */
    chinOffset: 0.25,
    halfW: 0.6,
    halfH: 0.45,
    /**
     * a wrist also has to be close to the body (extension e below this) to count as guarding: the chin
     * box is 2-D, and a straight thrown toward the camera stays inside it in x/y while fully extended.
     */
    maxE: 0.55,
    debounceMs: 100,
  },

  step: {
    /** hip center moves > lateralDist (units) within lateralWindowMs → STEP_L/R */
    lateralDist: 0.6,
    lateralWindowMs: 400,
    /** the return move within this many ms after a lateral step is ignored */
    recenterMs: 600,
    /** shoulder px width ratio vs baseline */
    inRatio: 1.12,
    outRatio: 0.89,
    /** re-arm when ratio is back within 1 ± rearmBand */
    rearmBand: 0.04,
    cooldownMs: 500,
  },

  getUp: { holdMs: 300 },

  /** slow baseline tracking so the engine keeps working when the player drifts (0 disables). */
  adapt: {
    /** image nose-y neutral (DUCK reference) — adapts only while not ducking */
    noseTauMs: 3000,
    /** shoulder width baseline (STEP_IN/OUT reference) — adapts outside step cooldown */
    shoulderTauMs: 10000,
    /** wrist rest position (lateral-travel reference) — adapts while the hand is IDLE */
    restTauMs: 250,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type GestureOptions = DeepPartial<typeof DEFAULTS>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `opts` over a copy of `base` (one object per top-level key). */
export function mergeOptions<T extends object>(base: T, opts?: DeepPartial<T>): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(base) as (keyof T & string)[]) {
    const b = base[k];
    const o = opts ? (opts as Record<string, unknown>)[k] : undefined;
    if (isObj(b)) out[k] = mergeOptions(b as object, isObj(o) ? (o as object) : undefined);
    else out[k] = o === undefined ? b : o;
  }
  return out as T;
}
