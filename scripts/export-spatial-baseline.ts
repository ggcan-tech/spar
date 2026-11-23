import { readFile } from 'node:fs/promises';
import { parseRecording } from '../apps/web/src/recorder/recorder';
import { mediaPipeSpatialBaseline } from '../packages/gestures/src/spatialBaseline';
async function main() {
  const [recordingPath, metadataPath] = process.argv.slice(2);
  if (!recordingPath || !metadataPath) throw new Error('Usage: pnpm spatial:baseline recording.json metadata.json > prediction.json');
  const recording = parseRecording(await readFile(recordingPath, 'utf8'));
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  console.log(JSON.stringify(mediaPipeSpatialBaseline(recording.frames, metadata), null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
