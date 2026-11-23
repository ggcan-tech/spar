import type { ActionEvent, ActionType } from '@spar/protocol';

/** One annotated action opportunity, with an inclusive acceptable detection window. */
export interface ExpectedActionSegment {
  type: ActionType;
  startMs: number;
  endMs: number;
}

export interface ActionClassMetrics {
  tp: number;
  fp: number;
  fn: number;
  /** Null when there are no predictions / annotations, respectively. */
  precision: number | null;
  recall: number | null;
}

export interface ActionMatch {
  expectedIndex: number;
  observedIndex: number;
  expectedType: ActionType;
  observedType: ActionType;
  correct: boolean;
  /** Time from annotated action-window start, NOT camera or inference latency. */
  detectionDelayMs: number;
}

export type ConfusionLabel = ActionType | 'NONE';
export interface ActionEvaluation {
  durationMs: number;
  totals: { tp: number; fp: number; fn: number };
  perClass: Partial<Record<ActionType, ActionClassMetrics>>;
  /** Rows = annotation, columns = prediction; NONE denotes an unmatched item. */
  confusionMatrix: Partial<Record<ConfusionLabel, Partial<Record<ConfusionLabel, number>>>>;
  matches: ActionMatch[];
  unmatchedExpectedIndices: number[];
  unmatchedObservedIndices: number[];
  /** Extra same-type predictions inside an already correctly matched window. Included in FP. */
  duplicateCount: number;
  /** All incorrect predictions (including wrong-class matches and duplicates) per minute. */
  falseActionsPerMinute: number;
  /** Correct matches only. Measures annotation-relative detection delay, NOT pipeline latency. */
  detectionDelayMs: { values: number[]; mean: number | null; median: number | null; p95: number | null };
}

const ACTION_TYPES: readonly ActionType[] = [
  'JAB', 'CROSS', 'LEAD_HOOK', 'REAR_HOOK', 'LEAD_UPPER', 'REAR_UPPER',
  'SLIP_L', 'SLIP_R', 'DUCK', 'HEAD_CENTER', 'GUARD_HIGH', 'GUARD_LOW',
  'STEP_IN', 'STEP_OUT', 'STEP_L', 'STEP_R', 'GET_UP',
];

function validType(type: ActionType): boolean { return ACTION_TYPES.includes(type); }
function boundedTime(t: number, durationMs: number): boolean {
  return Number.isFinite(t) && t >= 0 && t <= durationMs;
}

/**
 * Evaluate predictions against supplied annotations; this does not establish annotation quality
 * or real-world accuracy. Match one prediction to at most one annotation. Reserve same-class
 * matches first, then pair remaining in-window predictions as classification errors. Each pass
 * consumes predictions in timestamp order and chooses the eligible window ending first, so
 * overlapping windows cannot unnecessarily steal a later prediction's only available window.
 * Ties use start time, class name, then original index. Inputs are never mutated.
 */
export function evaluateActions(
  expected: readonly ExpectedActionSegment[],
  observed: readonly ActionEvent[],
  durationMs: number,
): ActionEvaluation {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new RangeError('durationMs must be positive and finite');
  expected.forEach((segment, index) => {
    if (!validType(segment.type) || !boundedTime(segment.startMs, durationMs) ||
      !boundedTime(segment.endMs, durationMs) || segment.startMs > segment.endMs) {
      throw new RangeError(`Invalid expected segment at index ${index}`);
    }
  });
  observed.forEach((event, index) => {
    if (!validType(event.type) || !boundedTime(event.t, durationMs) ||
      !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) {
      throw new RangeError(`Invalid observed event at index ${index}`);
    }
  });

  const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const segments = expected.map((segment, index) => ({ ...segment, index })).sort((a, b) =>
    a.endMs - b.endMs || a.startMs - b.startMs || byText(a.type, b.type) || a.index - b.index);
  const predictions = observed.map((event, index) => ({ ...event, index })).sort((a, b) =>
    a.t - b.t || byText(a.type, b.type) || a.index - b.index);
  const usedExpected = new Set<number>();
  const usedObserved = new Set<number>();
  const matches: ActionMatch[] = [];
  for (const correctOnly of [true, false]) {
    for (const event of predictions) {
      if (usedObserved.has(event.index)) continue;
      const segment = segments.find((candidate) => !usedExpected.has(candidate.index) &&
        event.t >= candidate.startMs && event.t <= candidate.endMs &&
        (!correctOnly || candidate.type === event.type));
      if (!segment) continue;
      usedExpected.add(segment.index);
      usedObserved.add(event.index);
      matches.push({
        expectedIndex: segment.index, observedIndex: event.index,
        expectedType: segment.type, observedType: event.type, correct: segment.type === event.type,
        detectionDelayMs: event.t - segment.startMs,
      });
    }
  }
  matches.sort((a, b) => observed[a.observedIndex].t - observed[b.observedIndex].t ||
    byText(a.observedType, b.observedType) || a.observedIndex - b.observedIndex);

  const perClass: ActionEvaluation['perClass'] = {};
  for (const type of ACTION_TYPES) {
    if (expected.some((s) => s.type === type) || observed.some((e) => e.type === type)) {
      perClass[type] = { tp: 0, fp: 0, fn: 0, precision: null, recall: null };
    }
  }
  const confusionMatrix: ActionEvaluation['confusionMatrix'] = {};
  const addConfusion = (truth: ConfusionLabel, prediction: ConfusionLabel) => {
    const row = confusionMatrix[truth] ?? (confusionMatrix[truth] = {});
    row[prediction] = (row[prediction] ?? 0) + 1;
  };
  for (const match of matches) {
    addConfusion(match.expectedType, match.observedType);
    if (match.correct) perClass[match.expectedType]!.tp++;
    else {
      perClass[match.expectedType]!.fn++;
      perClass[match.observedType]!.fp++;
    }
  }
  const unmatchedExpectedIndices = segments.filter((s) => !usedExpected.has(s.index)).map((s) => s.index);
  const unmatchedObservedIndices = predictions.filter((e) => !usedObserved.has(e.index)).map((e) => e.index);
  for (const index of unmatchedExpectedIndices) {
    perClass[expected[index].type]!.fn++;
    addConfusion(expected[index].type, 'NONE');
  }
  for (const index of unmatchedObservedIndices) {
    perClass[observed[index].type]!.fp++;
    addConfusion('NONE', observed[index].type);
  }
  const totals = { tp: 0, fp: 0, fn: 0 };
  for (const metrics of Object.values(perClass)) {
    totals.tp += metrics.tp; totals.fp += metrics.fp; totals.fn += metrics.fn;
    metrics.precision = metrics.tp + metrics.fp ? metrics.tp / (metrics.tp + metrics.fp) : null;
    metrics.recall = metrics.tp + metrics.fn ? metrics.tp / (metrics.tp + metrics.fn) : null;
  }
  const duplicateCount = unmatchedObservedIndices.filter((index) => matches.some((match) => {
    const segment = expected[match.expectedIndex];
    const event = observed[index];
    return match.correct && segment.type === event.type && event.t >= segment.startMs && event.t <= segment.endMs;
  })).length;
  const values = matches.filter((m) => m.correct).map((m) => m.detectionDelayMs);
  const sortedDelays = [...values].sort((a, b) => a - b);
  const n = sortedDelays.length;
  return {
    durationMs, totals, perClass, confusionMatrix, matches,
    unmatchedExpectedIndices, unmatchedObservedIndices, duplicateCount,
    falseActionsPerMinute: totals.fp / (durationMs / 60_000),
    detectionDelayMs: {
      values,
      mean: n ? values.reduce((sum, value) => sum + value, 0) / n : null,
      median: n ? (sortedDelays[Math.floor((n - 1) / 2)] + sortedDelays[Math.floor(n / 2)]) / 2 : null,
      p95: n ? sortedDelays[Math.ceil(n * 0.95) - 1] : null,
    },
  };
}
