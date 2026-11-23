import { expect, it } from 'vitest';
import type { PoseFrame } from '@spar/protocol';
import { mediaPipeSpatialBaseline, type BaselineMetadata } from '../src/spatialBaseline';
const meta: BaselineMetadata = { clipId: 'c', subjectId: 'p', sessionId: 's', source: 'synthetic', coordinateFrameId: 'a', clipStartTimestampMs: 900, producer: 'MediaPipe-lite-test' };
const frame = (): PoseFrame => ({ t: 1000, lm: Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: .1, v: 1 })), world: Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, v: 1 })) });
it('preserves clock offset, converts axes and never exports room position or guessed latency', () => {
  const f = frame(); f.world![15] = { x: .1, y: -.2, z: -.3, v: 1 };
  const out = mediaPipeSpatialBaseline([f], meta);
  expect(out.samples[0].tMs).toBe(100);
  expect(out.samples[0].body!.leftWrist).toEqual([.1, .2, .3]);
  expect(out.samples[0].world).toBeUndefined();
  expect(out.samples[0].availableAtMs).toBeUndefined();
});
it('never substitutes normalized landmarks for missing metric landmarks', () => {
  const f = frame(); f.world = [];
  expect(mediaPipeSpatialBaseline([f], meta).samples[0].body).toEqual({});
});
it('withholds hidden joints and a missing body origin', () => {
  const f = frame(); f.world![15].v = .1;
  expect(mediaPipeSpatialBaseline([f], meta).samples[0].body!.leftWrist).toBeUndefined();
  f.world![23].v = .1;
  expect(mediaPipeSpatialBaseline([f], meta).samples[0].body).toEqual({});
});
it('rejects guesses about synchronization and nonmonotonic recordings', () => {
  expect(() => mediaPipeSpatialBaseline([frame()], { ...meta, clipStartTimestampMs: NaN })).toThrow();
  expect(() => mediaPipeSpatialBaseline([frame(), frame()], meta)).toThrow('increase');
});
