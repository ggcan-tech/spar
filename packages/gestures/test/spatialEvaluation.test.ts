import { describe, expect, it } from 'vitest';
import { evaluateSpatial, parseSpatialTrack, type SpatialTrack } from '../src/spatialEvaluation';
const track = (): SpatialTrack => ({ version: 1, clipId: 'clip', subjectId: 'person', sessionId: 'session', source: 'synthetic', producer: 'fixture', coordinateFrameId: 'camera-A-floor', axes: 'x-right_y-up_z-toward-camera', units: 'metres', timing: 'offline', samples: [0, 50, 100].map(tMs => ({ tMs, world: { root: [0, 1, tMs / 1000] }, body: { leftShoulder: [0, 0, 0], leftWrist: [0, 0, .5] } })) });
describe('spatial measurement benchmark', () => {
  it('exposes fixed position bias without fitting it away', () => {
    const ref = track(), pred = track();
    pred.samples.forEach(s => s.world!.root![2] += .2);
    const result = evaluateSpatial(ref, pred);
    expect(result.spaces.world.root.positionErrorCm.mean).toBeCloseTo(20);
    expect(result.rootDisplacementErrorCm.mean).toBeCloseTo(0);
    expect(result.captureToResultMs.mean).toBeNull();
  });
  it('detects lost backward movement and velocity even with a perfect body pose', () => {
    const ref = track(), pred = track();
    pred.samples.forEach(s => s.world!.root![2] = 0);
    const result = evaluateSpatial(ref, pred);
    expect(result.spaces.body.leftWrist.positionErrorCm.mean).toBe(0);
    expect(result.rootDisplacementErrorCm.max).toBeCloseTo(10);
    expect(result.rootVelocityErrorMetresPerSecond.mean).toBeCloseTo(1);
  });
  it('cannot turn hip-relative pose into a room tracking result', () => {
    const ref = track(), pred = track();
    pred.samples.forEach(s => delete s.world);
    const result = evaluateSpatial(ref, pred);
    expect(result.spaces.world.root.coverage).toBe(0);
    expect(result.spaces.world.root.positionErrorCm.mean).toBeNull();
    expect(result.rootDisplacementErrorCm.mean).toBeNull();
  });
  it('reports missing joints as lost coverage, not successful zero error', () => {
    const ref = track(), pred = track();
    delete pred.samples[1].body!.leftWrist;
    const result = evaluateSpatial(ref, pred);
    expect(result.spaces.body.leftWrist.coverage).toBeCloseTo(2 / 3);
    expect(result.reach.left.coverage).toBeCloseTo(2 / 3);
  });
  it('distinguishes radial reach from a fist pointing in the wrong direction', () => {
    const ref = track(), pred = track();
    pred.samples.forEach(s => s.body!.leftWrist = [.5, 0, 0]);
    const result = evaluateSpatial(ref, pred);
    expect(result.reach.left.radialReachErrorCm.mean).toBe(0);
    expect(result.spaces.body.leftWrist.positionErrorCm.mean).toBeCloseTo(Math.sqrt(.5) * 100);
  });
  it('never reuses one prediction for multiple reference samples', () => {
    const ref = track(), pred = track();
    pred.samples = [pred.samples[1]];
    expect(evaluateSpatial(ref, pred, 100).matchedFrames).toBe(1);
  });
  it('does not align a stale or differently clocked stream automatically', () => {
    const ref = track(), pred = track();
    pred.samples.forEach(s => s.tMs += 1000);
    const result = evaluateSpatial(ref, pred);
    expect(result.temporalCoverage).toBe(0);
    expect(result.spaces.world.root.positionErrorCm.mean).toBeNull();
  });
  it('includes unmatched slow outputs in latency and exposes future context', () => {
    const ref = track(), pred = track();
    pred.timing = 'live';
    pred.samples.push({ tMs: 1000 });
    pred.samples.forEach(s => { s.availableAtMs = s.tMs + 200; s.lastInputAtMs = s.tMs + 100; });
    const result = evaluateSpatial(ref, pred);
    expect(result.captureToResultMs.count).toBe(4);
    expect(result.captureToResultMs.p95).toBe(200);
    expect(result.lookaheadMs.mean).toBe(100);
  });
  it('does not compute velocity across an outage', () => {
    const ref = track(), pred = track();
    ref.samples[2].tMs = pred.samples[2].tMs = 1000;
    expect(evaluateSpatial(ref, pred).rootVelocityErrorMetresPerSecond.count).toBe(1);
  });
  it.each(['clipId', 'subjectId', 'sessionId', 'coordinateFrameId', 'source'] as const)('rejects incompatible %s', key => {
    const ref = track(), pred = track();
    Object.assign(pred, { [key]: key === 'source' ? 'human' : 'other' });
    expect(() => evaluateSpatial(ref, pred)).toThrow(key);
  });
  it('rejects malformed coordinates, clocks and misleading offline latency', () => {
    const bad = track(); bad.samples[0].body!.leftWrist![0] = NaN;
    expect(() => parseSpatialTrack(bad)).toThrow('position');
    const duplicate = track(); duplicate.samples[1].tMs = 0;
    expect(() => parseSpatialTrack(duplicate)).toThrow('increase');
    const offline = track(); offline.samples[0].availableAtMs = 10;
    expect(() => parseSpatialTrack(offline)).toThrow('live');
    const early = track(); early.timing = 'live'; early.samples[0].availableAtMs = 10; early.samples[0].lastInputAtMs = 20;
    expect(() => parseSpatialTrack(early)).toThrow('predates');
  });
});
