import { describe, expect, it } from 'vitest';
import type { ActionEvent, ActionType } from '@spar/protocol';
import { evaluateActions, type ExpectedActionSegment } from '../src/evaluation';

const segment = (type: ActionType, startMs = 100, endMs = 300): ExpectedActionSegment => ({ type, startMs, endMs });
const event = (type: ActionType, t = 200): ActionEvent => ({ type, t, confidence: 0.9 });

describe('annotation-based action evaluation', () => {
  it('counts wrong classes as a false positive and a missed expected class', () => {
    const result = evaluateActions([segment('JAB')], [event('CROSS')], 1000);
    expect(result.totals).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(result.perClass.JAB).toMatchObject({ tp: 0, fp: 0, fn: 1, recall: 0, precision: null });
    expect(result.perClass.CROSS).toMatchObject({ tp: 0, fp: 1, fn: 0, precision: 0, recall: null });
    expect(result.confusionMatrix.JAB?.CROSS).toBe(1);
    expect(result.falseActionsPerMinute).toBe(60);
    expect(result.detectionDelayMs.values).toEqual([]);
  });

  it('reserves same-class matches before assigning earlier wrong-class predictions', () => {
    const result = evaluateActions([segment('JAB')], [event('CROSS', 120), event('JAB', 220)], 1000);
    expect(result.totals).toEqual({ tp: 1, fp: 1, fn: 0 });
    expect(result.matches[0].observedIndex).toBe(1);
    expect(result.confusionMatrix.NONE?.CROSS).toBe(1);
  });

  it('counts duplicate predictions once each, without increasing recall', () => {
    const result = evaluateActions([segment('JAB')], [event('JAB', 100), event('JAB', 200), event('JAB', 300)], 1000);
    expect(result.totals).toEqual({ tp: 1, fp: 2, fn: 0 });
    expect(result.duplicateCount).toBe(2);
    expect(result.perClass.JAB?.precision).toBeCloseTo(1 / 3);
    expect(result.perClass.JAB?.recall).toBe(1);
    expect(result.confusionMatrix.NONE?.JAB).toBe(2);
  });

  it('keeps out-of-window predictions unmatched and reports absent predictions', () => {
    const result = evaluateActions([segment('JAB'), segment('CROSS', 400, 500)], [event('JAB', 99)], 1000);
    expect(result.totals).toEqual({ tp: 0, fp: 1, fn: 2 });
    expect(result.confusionMatrix.JAB?.NONE).toBe(1);
    expect(result.confusionMatrix.CROSS?.NONE).toBe(1);
    expect(result.confusionMatrix.NONE?.JAB).toBe(1);
    expect(result.duplicateCount).toBe(0);
  });

  it('uses earliest-ending windows to match overlapping same-class actions one-to-one', () => {
    const result = evaluateActions([segment('JAB', 0, 400), segment('JAB', 100, 200)],
      [event('JAB', 150), event('JAB', 350)], 1000);
    expect(result.totals).toEqual({ tp: 2, fp: 0, fn: 0 });
    expect(result.matches.map((m) => m.expectedIndex)).toEqual([1, 0]);
  });

  it('reports annotation-relative delays in timestamp order with reproducible statistics', () => {
    const expected = [segment('JAB', 0, 100), segment('CROSS', 200, 400)];
    const observed = [event('CROSS', 350), event('JAB', 50)];
    const before = JSON.stringify({ expected, observed });
    const result = evaluateActions(expected, observed, 1000);
    expect(result.matches.map((m) => m.observedIndex)).toEqual([1, 0]);
    expect(result.detectionDelayMs).toEqual({ values: [50, 150], mean: 100, median: 100, p95: 150 });
    expect(evaluateActions(expected, observed, 1000)).toEqual(result);
    const reversed = evaluateActions([...expected].reverse(), [...observed].reverse(), 1000);
    expect(reversed.totals).toEqual(result.totals);
    expect(reversed.confusionMatrix).toEqual(result.confusionMatrix);
    expect(reversed.detectionDelayMs).toEqual(result.detectionDelayMs);
    expect(JSON.stringify({ expected, observed })).toBe(before);
  });

  it('handles empty recordings without inventing accuracy or delay', () => {
    const result = evaluateActions([], [], 60_000);
    expect(result.totals).toEqual({ tp: 0, fp: 0, fn: 0 });
    expect(result.falseActionsPerMinute).toBe(0);
    expect(result.perClass).toEqual({});
    expect(result.detectionDelayMs).toEqual({ values: [], mean: null, median: null, p95: null });
  });

  it('accepts recording boundaries and instantaneous annotation windows', () => {
    expect(evaluateActions([segment('JAB', 0, 0), segment('CROSS', 1000, 1000)],
      [event('JAB', 0), event('CROSS', 1000)], 1000).totals.tp).toBe(2);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid recording duration %s', (duration) => {
    expect(() => evaluateActions([], [], duration)).toThrow(RangeError);
  });

  it.each([
    segment('JAB', -1, 100), segment('JAB', 200, 100), segment('JAB', 0, 1001),
    segment('JAB', NaN, 100), segment('JAB', 0, Infinity), segment('INVALID' as ActionType),
  ])('rejects invalid annotation %#', (bad) => {
    expect(() => evaluateActions([bad], [], 1000)).toThrow(RangeError);
  });

  it.each([
    event('JAB', -1), event('JAB', NaN), event('JAB', Infinity), event('JAB', 1001),
    { ...event('JAB'), confidence: NaN }, { ...event('JAB'), confidence: -0.1 },
    { ...event('JAB'), confidence: 1.1 }, event('INVALID' as ActionType),
  ])('rejects invalid prediction %#', (bad) => {
    expect(() => evaluateActions([], [bad], 1000)).toThrow(RangeError);
  });
});
