import { readFile } from 'node:fs/promises';
import { evaluateActions, type ExpectedActionSegment } from '../packages/gestures/src/index';
import type { ActionType } from '../packages/protocol/src/index';
import { parseRecording, createRecordingEngine } from '../apps/web/src/recorder/recorder';

/** Local-only evaluation. Annotation time is relative to the first recorded frame. */
async function main() {
  const [recordingPath, annotationPath] = process.argv.slice(2);
  if (!recordingPath || !annotationPath) throw new Error('Usage: pnpm eval:motion recording.json annotations.json');
  const recording = parseRecording(await readFile(recordingPath, 'utf8'));
  const labels = JSON.parse(await readFile(annotationPath, 'utf8')) as {
    version: number; source: 'human' | 'synthetic'; evaluatedTypes: ActionType[]; segments: ExpectedActionSegment[];
  };
  if (labels.version !== 1 || !['human', 'synthetic'].includes(labels.source) ||
    !Array.isArray(labels.evaluatedTypes) || labels.evaluatedTypes.length === 0 || !Array.isArray(labels.segments)) {
    throw new Error('Annotations require version: 1, source: human|synthetic, evaluatedTypes, and segments.');
  }
  if (labels.segments.some(s => !labels.evaluatedTypes.includes(s.type))) throw new Error('Every annotated class must be in evaluatedTypes.');
  const t0 = recording.frames[0].t;
  const duration = recording.frames[recording.frames.length - 1].t - t0;
  const aspect = recording.frames[0].imageAspect ?? recording.meta?.aspect;
  if (!aspect) throw new Error('This recording has no camera aspect ratio. Add verified meta.aspect (height / width); do not guess it.');
  // Validate the type list too, including idle clips with no annotations/events.
  evaluateActions(labels.evaluatedTypes.map(type => ({ type, startMs: 0, endMs: 0 })), [], Math.max(1, duration));
  const engine = createRecordingEngine(recording);
  const observed = recording.frames.flatMap(f => engine.push(f))
    .filter(e => labels.evaluatedTypes.includes(e.type)).map(e => ({ ...e, t: e.t - t0 }));
  const report = evaluateActions(labels.segments, observed, duration);
  console.log(JSON.stringify({
    source: labels.source,
    evaluatedTypes: labels.evaluatedTypes,
    setup: recording.calibration ? 'saved measurements' : 'automatic from recording',
    note: 'Annotation-relative delay is not inference latency. Synthetic clips do not establish human accuracy. Results cover only evaluatedTypes.',
    ...report,
  }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
