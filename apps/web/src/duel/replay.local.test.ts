import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { playbackFrame, type RecordedSession } from "../pov/sessionLog";
import { createPovTracker } from "../pov/tracking";
import { createBodyScale } from "../box/real/body3d";
import { flatPose, laneOf, placeFigure, type FlatPose, type Side } from "./body";
import { DUEL_BOUNDS } from "./capture";
import { createSlingReader, defaultSetup } from "./sling";

/**
 * The founder's saved recording, played through the duel's own pipeline: the
 * wide tracker, the flat body and the sling reader. The file is a person's
 * movement and is never committed: put one at apps/web/public/_replay/session.json
 * and this runs; without one it is skipped.
 *
 * His first recording (14 Nov) is a boxing test: a guard, punches, a walk to the
 * laptop. Nobody slings in it, so a sling read from it is a false fire. The
 * camera critic found zero with these gates; this keeps it that way.
 */
const FILE = fileURLToPath(new URL("../../public/_replay/session.json", import.meta.url));

function poses(session: RecordedSession): FlatPose[] {
  const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative", bounds: DUEL_BOUNDS });
  const size = createBodyScale();
  const out: FlatPose[] = [];
  for (const rec of session.frames) {
    const frame = playbackFrame(rec);
    const result = tracker.update(frame, rec.at);
    const aspect = frame.imageAspect || 9 / 16;
    size.update(result, frame.world, { lm: frame.lm, aspect });
    const pose = flatPose(result, frame.motionT ?? frame.t, frame.capturedAt ?? frame.t, size.metres(), { lm: frame.lm, aspect, metresHigh: size.metresHigh() });
    if (pose) out.push(pose);
  }
  return out;
}

const session = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as RecordedSession) : null;
/** A recording saved from the duel's own pages (the probe's guided steps), not the boxing test room. */
const slingRecording = session?.meta?.game === "duel";

it.skipIf(!session || !slingRecording)("his sling recording: what the reader made of every flick", () => {
  const all = poses(session!);
  const report: string[] = [];
  for (const side of ["left", "right"] as Side[]) {
    const reader = createSlingReader(defaultSetup(side));
    const fired: { t: number; angle: number; power: number; readMs: number }[] = [];
    const refused: Record<string, number> = {};
    let topMin = Infinity;
    const wobble: number[] = [];
    for (const p of all) {
      const r = reader.update(p);
      if (r.shot) fired.push({ t: (p.t - all[0].t) / 1000, angle: r.shot.angle, power: r.shot.power, readMs: r.shot.readMs });
      if (r.refused) refused[r.refused.gate] = (refused[r.refused.gate] ?? 0) + 1;
      if (r.state === "ready" && r.handLine !== null) wobble.push(r.handLine);
      if (r.state !== "down" && r.edge) topMin = Math.min(topMin, r.edge.top);
    }
    const reads = fired.map((f) => f.readMs).sort((a, b) => a - b);
    const sd = wobble.length ? Math.sqrt(wobble.reduce((a, x) => a + (x - wobble.reduce((b, y) => b + y, 0) / wobble.length) ** 2, 0) / wobble.length) : NaN;
    report.push(
      `${side} sling: ${fired.length} fired (${fired.map((f) => `${f.t.toFixed(1)}s ${Math.round(f.angle)}° ${Math.round(f.power * 100)}%`).join(", ")})`,
      `  refused by gate: ${JSON.stringify(refused)}`,
      `  read delay median ${reads.length ? reads[reads.length >> 1].toFixed(0) : "–"} ms; hand line while ready spreads ${sd.toFixed(1)}°; least wrist-to-top margin ${(topMin * 100).toFixed(0)} cm`,
    );
  }
  console.log(report.join("\n"));
  expect(all.length).toBeGreaterThan(100);
});

it.skipIf(!session || slingRecording)("his boxing recording: the sling never fires, and the figure stays in its lane", () => {
  const all = poses(session!);
  expect(all.length).toBeGreaterThan(300);
  const report: string[] = [];
  for (const side of ["left", "right"] as Side[]) {
    for (const release of ["flick", "still"] as const) {
      const reader = createSlingReader(defaultSetup(side), { release });
      const fired: number[] = [];
      const refused: Record<string, number> = {};
      let nocks = 0,
        was = "down";
      for (const p of all) {
        const r = reader.update(p);
        if (r.shot) fired.push(Math.round((p.t - all[0].t) / 100) / 10);
        if (r.refused) refused[r.refused.reason] = (refused[r.refused.reason] ?? 0) + 1;
        if (r.state === "nocked" && was === "down") nocks++;
        was = r.state;
      }
      report.push(`${side} sling, ${release}: ${fired.length} fired ${fired.length ? `at ${fired.join(", ")} s` : ""}, ${nocks} nocks, refused ${JSON.stringify(refused)}`);
      // No sling in a boxing session.
      expect(fired.length).toBeLessThanOrEqual(release === "flick" ? 0 : 1);
    }
  }
  // The figure: hips stay inside a lane-and-a-bit, head above the chest, the drawn figure the standard size.
  const lane = laneOf("right");
  let worst = 0,
    headLow = 0,
    played = 0;
  const t0 = all[0].t;
  for (const p of all) {
    // After 35 s he walked to the laptop to save: not play.
    if ((p.t - t0) / 1000 > 35) break;
    played++;
    const f = placeFigure(p, lane);
    worst = Math.max(worst, Math.abs(f.hips.x - lane.middle));
    if (f.head.c.y < f.chest.y1 + 0.05) headLow++;
  }
  report.push(`hips furthest from the lane middle: ${worst.toFixed(2)} m; head at or under the chest top in ${headLow} of ${played} poses`);
  console.log(report.join("\n"));
  expect(worst).toBeLessThan(1.2);
  expect(headLow / played).toBeLessThan(0.02);
});
