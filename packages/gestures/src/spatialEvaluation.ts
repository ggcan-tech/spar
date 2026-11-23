/** Model-neutral metric benchmark. No alignment, scale fitting, or interpolation at scoring time. */
export const SPATIAL_JOINTS = ['root', 'nose', 'leftShoulder', 'rightShoulder', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle'] as const;
export type SpatialJoint = typeof SPATIAL_JOINTS[number];
export type Point3 = [number, number, number];
export type JointPositions = Partial<Record<SpatialJoint, Point3>>;
export interface SpatialSample {
  /** Synchronized capture timestamp, ms from clip start; never inference completion time. */
  tMs: number;
  /** In the same clock as tMs; omitted for offline results. */
  availableAtMs?: number;
  /** Last input capture used to estimate this sample. Exposes future-frame lookahead. */
  lastInputAtMs?: number;
  body?: JointPositions;
  world?: JointPositions;
}
export interface SpatialTrack {
  version: 1;
  clipId: string;
  subjectId: string;
  sessionId: string;
  source: 'human' | 'synthetic';
  producer: string;
  /** Same externally established axes/origin/scale for all tracks in a comparison. */
  coordinateFrameId: string;
  axes: 'x-right_y-up_z-toward-camera';
  units: 'metres';
  timing: 'live' | 'offline' | 'unknown';
  samples: SpatialSample[];
}
export interface Distribution { count: number; mean: number | null; p95: number | null; max: number | null }
const stats = (values: number[]): Distribution => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null };
};
const subtract = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const distance = (a: Point3, b: Point3) => Math.hypot(...subtract(a, b));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function parseSpatialTrack(input: unknown): SpatialTrack {
  if (!object(input) || input.version !== 1 || input.axes !== 'x-right_y-up_z-toward-camera' || input.units !== 'metres' ||
    !['human', 'synthetic'].includes(String(input.source)) || !['live', 'offline', 'unknown'].includes(String(input.timing)) ||
    !['clipId', 'subjectId', 'sessionId', 'producer', 'coordinateFrameId'].every(k => typeof input[k] === 'string' && (input[k] as string).trim()) ||
    !Array.isArray(input.samples) || input.samples.length === 0) throw new Error('Invalid spatial track metadata or empty samples.');
  let previous = -Infinity;
  for (const [index, sample] of input.samples.entries()) {
    if (!object(sample) || !finite(sample.tMs) || sample.tMs < 0 || sample.tMs <= previous) throw new Error(`Sample ${index}: capture times must strictly increase.`);
    previous = sample.tMs;
    for (const key of ['availableAtMs', 'lastInputAtMs']) {
      if (sample[key] !== undefined && (!finite(sample[key]) || (sample[key] as number) < sample.tMs)) throw new Error(`Sample ${index}: invalid ${key}.`);
    }
    if (finite(sample.availableAtMs) && finite(sample.lastInputAtMs) && sample.availableAtMs < sample.lastInputAtMs) throw new Error(`Sample ${index}: output predates its input.`);
    if (input.timing !== 'live' && sample.availableAtMs !== undefined) throw new Error('Only live synchronized measurements may declare availableAtMs.');
    for (const space of ['body', 'world']) {
      const points = sample[space];
      if (points === undefined) continue;
      if (!object(points)) throw new Error(`Sample ${index}: invalid ${space} positions.`);
      for (const [joint, point] of Object.entries(points)) {
        if (!(SPATIAL_JOINTS as readonly string[]).includes(joint) || !Array.isArray(point) || point.length !== 3 || !point.every(finite)) throw new Error(`Sample ${index}: invalid ${joint} position.`);
      }
    }
  }
  return input as unknown as SpatialTrack;
}

export function evaluateSpatial(referenceInput: SpatialTrack, predictionInput: SpatialTrack, maxSkewMs = 20) {
  const reference = parseSpatialTrack(referenceInput);
  const prediction = parseSpatialTrack(predictionInput);
  if (!finite(maxSkewMs) || maxSkewMs < 0) throw new Error('maxSkewMs must be finite and nonnegative.');
  for (const key of ['clipId', 'subjectId', 'sessionId', 'source', 'coordinateFrameId', 'axes', 'units'] as const) {
    if (reference[key] !== prediction[key]) throw new Error(`Tracks disagree on ${key}; perform verified coordinate/time conversion before scoring.`);
  }
  // Monotone one-to-one temporal matching. No time-warp or future pose interpolation.
  const pairs: { ref: SpatialSample; pred: SpatialSample; index: number }[] = [];
  let next = 0;
  for (const ref of reference.samples) {
    while (next < prediction.samples.length && prediction.samples[next].tMs < ref.tMs - maxSkewMs) next++;
    if (next === prediction.samples.length || prediction.samples[next].tMs > ref.tMs + maxSkewMs) continue;
    const index = next++;
    pairs.push({ ref, pred: prediction.samples[index], index });
  }
  const spaces = Object.fromEntries((['body', 'world'] as const).map(space => [space, Object.fromEntries(SPATIAL_JOINTS.map(joint => {
    const eligible = reference.samples.filter(s => s[space]?.[joint]).length;
    const errors: number[] = [], depthErrors: number[] = [];
    for (const { ref, pred } of pairs) {
      const a = ref[space]?.[joint], b = pred[space]?.[joint];
      if (!a || !b) continue;
      errors.push(distance(a, b) * 100);
      depthErrors.push(Math.abs(a[2] - b[2]) * 100);
    }
    return [joint, { referenceSamples: eligible, coverage: eligible ? errors.length / eligible : null,
      positionErrorCm: stats(errors), depthErrorCm: stats(depthErrors) }];
  }))])) as Record<'body' | 'world', Record<SpatialJoint, { referenceSamples: number; coverage: number | null; positionErrorCm: Distribution; depthErrorCm: Distribution }>>;
  const reach = Object.fromEntries((['left', 'right'] as const).map(side => {
    const wrist = `${side}Wrist` as SpatialJoint, shoulder = `${side}Shoulder` as SpatialJoint;
    const eligible = reference.samples.filter(s => s.body?.[wrist] && s.body?.[shoulder]).length;
    const errors: number[] = [];
    for (const { ref, pred } of pairs) {
      const rw = ref.body?.[wrist], rs = ref.body?.[shoulder], pw = pred.body?.[wrist], ps = pred.body?.[shoulder];
      if (rw && rs && pw && ps) errors.push(Math.abs(distance(rw, rs) - distance(pw, ps)) * 100);
    }
    return [side, { coverage: eligible ? errors.length / eligible : null, radialReachErrorCm: stats(errors) }];
  }));
  const roots = pairs.filter(p => p.ref.world?.root && p.pred.world?.root);
  const displacementErrors: number[] = [], velocityErrors: number[] = [];
  if (roots.length) {
    const first = roots[0];
    for (const pair of roots) displacementErrors.push(distance(subtract(pair.ref.world!.root!, first.ref.world!.root!), subtract(pair.pred.world!.root!, first.pred.world!.root!)) * 100);
    for (let i = 1; i < roots.length; i++) {
      const a = roots[i - 1], b = roots[i];
      const rt = (b.ref.tMs - a.ref.tMs) / 1000, pt = (b.pred.tMs - a.pred.tMs) / 1000;
      // Do not bridge a tracking outage and describe it as instant velocity.
      if (rt > .1 || pt > .1) continue;
      const rv = subtract(b.ref.world!.root!, a.ref.world!.root!).map(v => v / rt) as Point3;
      const pv = subtract(b.pred.world!.root!, a.pred.world!.root!).map(v => v / pt) as Point3;
      velocityErrors.push(distance(rv, pv));
    }
  }
  return {
    version: 1, clipId: reference.clipId, source: reference.source, reference: reference.producer, model: prediction.producer,
    matchedFrames: pairs.length, referenceFrames: reference.samples.length, predictionFrames: prediction.samples.length,
    unmatchedPredictionFrames: prediction.samples.length - pairs.length,
    temporalCoverage: pairs.length / reference.samples.length,
    timestampSkewMs: stats(pairs.map(p => Math.abs(p.ref.tMs - p.pred.tMs))),
    spaces, reach,
    rootDisplacementErrorCm: stats(displacementErrors), rootVelocityErrorMetresPerSecond: stats(velocityErrors),
    // Include ALL emitted samples, not only accurate/matched ones; no survivorship filtering.
    captureToResultMs: stats(prediction.samples.flatMap(p => p.availableAtMs === undefined ? [] : [p.availableAtMs - p.tMs])),
    latencyCoverage: prediction.samples.filter(p => p.availableAtMs !== undefined).length / prediction.samples.length,
    lookaheadMs: stats(prediction.samples.flatMap(p => p.lastInputAtMs === undefined ? [] : [p.lastInputAtMs - p.tMs])),
    timingMode: prediction.timing,
    note: 'Errors are conditional on reported coverage. Missing metrics are null, never zero. No fitted alignment. Synthetic data tests the evaluator, not human accuracy. Radial reach alone does not prove correct punch direction.',
  };
}
