import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createArmRuler } from "../../pov/body";
import { playbackFrame, type RecordedSession } from "../../pov/sessionLog";
import { createPovTracker } from "../../pov/tracking";
import { createRangeReader } from "../read";
import { bodyOf, createBodyScale, type Me3D } from "./body3d";
import { createRealGame } from "./game";

/**
 * A real person's saved recording (the test room's "Save what the camera
 * saw"), played back through the tracker, the body and the game. The file is
 * a person's movement and is never committed: put one at
 * apps/web/public/_replay/session.json and this runs; without one it is
 * skipped. The numbers it holds are what the first recording (14 Nov) showed
 * once the body was rebuilt on it.
 */
const FILE = fileURLToPath(new URL("../../../public/_replay/session.json", import.meta.url));
it.skipIf(!existsSync(FILE))("a real recording: the body is the right size, the arms go out their length, and punches reach him", () => {
  const session = JSON.parse(readFileSync(FILE, "utf8")) as RecordedSession;
  const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative", hiddenHeadFromShoulders: true });
  const ruler = createArmRuler(), ranger = createRangeReader(), scale = createBodyScale();
  const game = createRealGame({ boxer: "beginner", seed: 3, rounds: 1, clock: 3600, stakes: "touch", range: false, still: true });
  let wasCal = false, body: Me3D | null = null, started = false;
  const t0 = session.frames[0].at;
  const rows: string[] = [];
  let lastRow = -1;
  const peaks: string[] = [];
  const track = [0, 1].map(() => ({ max: 0, at: 0, up: false, info: "" }));
  const outcomes: Record<string, number> = {};
  const touchRows: string[] = [];
  const guardFwd: number[] = [], eyeY: number[] = [];
  for (const rec of session.frames) {
    const frame = playbackFrame(rec);
    const result = tracker.update(frame, rec.at);
    const s = (rec.at - t0) / 1000;
    if (result.calibrated && !wasCal) ranger.rehome();
    wasCal = result.calibrated;
    const range = result.calibrated ? ranger.update(frame, frame.motionT ?? frame.t) : null;
    if (!(result.valid && result.units !== "normalized" && result.joints && result.jointWeights)) continue;
    const t = frame.motionT ?? frame.t;
    ruler.measure(result.joints, result.jointWeights, frame.t);
    const picture = { lm: frame.lm, aspect: frame.imageAspect || 9 / 16 };
    scale.update(result, frame.world, picture);
    body = bodyOf(result, { t, away: range && range.ready ? range.away : 0, arms: ruler.lengths(), previous: body && t - body.t < 400 ? body : null, world: frame.world, metres: scale.metres(), tilt: scale.tilt(), bones: scale.bones(), picture: { ...picture, metresHigh: scale.metresHigh() } });
    if (!body) continue;
    if (s > 35) break; // he walked to the laptop
    for (const now of [rec.at, rec.at + 16]) {
      const view = game.frame(now, { tracking: result, pose: null, valid: true, calibrated: result.calibrated, poseT: t, poseAge: now - rec.at + 20, arms: ruler.lengths(), keys: null, body, start: !started && s > 9 });
      if (view.phase === "count") started = true;
      for (const tch of view.touches) touchRows.push(`  ${s.toFixed(1)} s ${tch.hand} met its ${tch.what} at ${tch.speed.toFixed(1)} m/s, glove at z ${tch.at.z.toFixed(2)} y ${tch.at.y.toFixed(2)} x ${tch.at.x.toFixed(2)}`);
      for (const e of view.events) if (e.kind === "mine") outcomes[`${e.shape}:${e.outcome}`] = (outcomes[`${e.shape}:${e.outcome}`] ?? 0) + 1;
    }
    if (s > 9) eyeY.push(body.head.y);
    for (let i = 0; i < 2; i++) {
      const fwd = body.gloves[i].z - body.shoulders[i].z;
      if (s > 9) guardFwd.push(fwd);
      const k = track[i];
      if (fwd > 0.45 && fwd > k.max) { k.max = fwd; k.at = s; k.up = true; k.info = `glove at z ${body.gloves[i].z.toFixed(2)} y ${body.gloves[i].y.toFixed(2)} x ${body.gloves[i].x.toFixed(2)} · stood ${(-body.hips.z).toFixed(2)} back`; }
      if (k.up && fwd < 0.36) { peaks.push(`  ${i ? "R" : "L"} out to ${k.max.toFixed(2)} in front of the shoulder at ${k.at.toFixed(1)} s · ${k.info}`); k.max = 0; k.up = false; }
    }
    if (Math.floor(s) !== lastRow && s >= 5) {
      lastRow = Math.floor(s);
      const f = (i: number) => `${(body!.gloves[i].z - body!.shoulders[i].z).toFixed(2)}${body!.seen[i] ? "" : "?"}`;
      rows.push(`${s.toFixed(0).padStart(3)} s  he stands ${game.frame(rec.at + 17, { tracking: result, pose: null, valid: true, calibrated: result.calibrated, poseT: t, poseAge: 37, arms: ruler.lengths(), keys: null, body }).distance.toFixed(2)}  metres/unit ${scale.metres().toFixed(2)} tilt ${(scale.tilt() * 57.3).toFixed(0)}°  eyes (${body.head.x.toFixed(2)}, ${body.head.y.toFixed(2)}, ${body.head.z.toFixed(2)})  shoulders y ${body.shoulders[0].y.toFixed(2)}  arm ${(body.bones.upperArm + body.bones.foreArm).toFixed(2)}  fists in front L ${f(0)} R ${f(1)}  fists y ${body.gloves[0].y.toFixed(2)}/${body.gloves[1].y.toFixed(2)}`);
    }
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
  console.log(`REPLAY eyes height 10/50/90%: ${q(eyeY, 0.1).toFixed(2)} ${q(eyeY, 0.5).toFixed(2)} ${q(eyeY, 0.9).toFixed(2)}; fists in front of the shoulder 10/50/90/99%: ${q(guardFwd, 0.1).toFixed(2)} ${q(guardFwd, 0.5).toFixed(2)} ${q(guardFwd, 0.9).toFixed(2)} ${q(guardFwd, 0.99).toFixed(2)}`);
  console.log("REPLAY outcomes " + JSON.stringify(outcomes));
  console.log("REPLAY rows\n" + rows.join("\n"));
  console.log("REPLAY peaks (" + peaks.length + ")\n" + peaks.slice(0, 30).join("\n"));
  console.log("REPLAY touches (" + touchRows.length + ")\n" + touchRows.slice(0, 30).join("\n"));
  // The player is a person's size: eyes between 1.5 and 1.9 m (the first build of this had them at 1.95 and above).
  expect(q(eyeY, 0.5)).toBeGreaterThan(1.5);
  expect(q(eyeY, 0.5)).toBeLessThan(1.9);
  // The fists rest well inside the arm's length and go out to nearly all of it.
  expect(q(guardFwd, 0.5)).toBeLessThan(0.45);
  expect(q(guardFwd, 0.99)).toBeGreaterThan(0.5);
  // Most strokes meet him or his guard; before, nearly every one met air.
  const all = Object.values(outcomes).reduce((n, x) => n + x, 0);
  const air = Object.entries(outcomes).reduce((n, [k, x]) => n + (k.endsWith(":short") ? x : 0), 0);
  expect(all).toBeGreaterThan(20);
  expect(air / all).toBeLessThan(0.45);
});
