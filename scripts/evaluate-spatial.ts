import { readFile } from 'node:fs/promises';
import { evaluateSpatial, parseSpatialTrack } from '../packages/gestures/src/spatialEvaluation';

async function main() {
  const [referencePath, predictionPath, skew = '20'] = process.argv.slice(2);
  if (!referencePath || !predictionPath) throw new Error('Usage: pnpm eval:spatial reference.json prediction.json [maxSkewMs=20]');
  const [reference, prediction] = await Promise.all([referencePath, predictionPath].map(async path => parseSpatialTrack(JSON.parse(await readFile(path, 'utf8')))));
  console.log(JSON.stringify(evaluateSpatial(reference, prediction, Number(skew)), null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
