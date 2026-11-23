import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { playbackFrame, type RecordedSession } from "./sessionLog";
import { createPovTracker } from "./tracking";
import { MOVE, trackedPose } from "./input";
import { useWideCourt } from "./duel";

/**
 * The founder's saved recording through the stage-1 movement curve (CORE.md
 * bar M3). Personal data: skipped when the file is not there; never committed.
 */
const FILE = fileURLToPath(new URL("../../public/_replay/session.json", import.meta.url));
it.skipIf(!existsSync(FILE))("his recording on the wide lane: where the figure stands, and how still it is", () => {
  const session = JSON.parse(readFileSync(FILE, "utf8")) as RecordedSession;
  useWideCourt(true);
  const report: string[] = [];
  for (const mode of ["A", "B"] as const) {
    MOVE.mode = mode;
    const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative", bounds: { x: 1.0, y: 1.2, z: 0.25 } });
    const xs: number[] = [];
    let prev: number | null = null;
    const steps: number[] = [];
    const t0 = session.frames[0].at;
    for (const rec of session.frames) {
      if ((rec.at - t0) / 1000 > 35) break;
      const r = tracker.update(playbackFrame(rec), rec.at);
      if (!r.valid || r.units === "normalized") continue;
      const x = trackedPose(r, 1.8).root.x;
      xs.push(x);
      if (prev !== null) steps.push(Math.abs(x - prev));
      prev = x;
    }
    const sorted = [...steps].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    report.push(`${mode}: hips from ${Math.min(...xs).toFixed(2)} to ${Math.max(...xs).toFixed(2)} m on the lane; frame-to-frame move p95 ${(p95 * 100).toFixed(1)} cm over ${xs.length} poses`);
    expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(1.6);
  }
  MOVE.mode = "classic";
  useWideCourt(false);
  console.log(report.join("\n"));
});
