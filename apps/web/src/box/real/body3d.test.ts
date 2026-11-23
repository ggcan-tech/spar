import { describe, expect, it } from "vitest";
import type { SyntheticMotion } from "../../pov/syntheticBody";
import { CAMS, M, runWithSetup, throwsOf, type Thrown } from "../read/rig";
import { punchMotion, stance } from "../scriptedBoxer";
import { bodyOf, type Me3D } from "./body3d";

const NOISE = { sigma: 0.005, depth: 0.03 };
/** The scripted person's true wrist against its shoulder, in game units, [left, right]. */
const truth = (m: SyntheticMotion) => [m.leftHand!, m.rightHand!].map((p) => ({ x: p.x / M, y: p.y / M, z: p.z / M }));
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const rel = (me: Me3D, i: number) => ({ x: me.wrists[i].x - me.shoulders[i].x, y: me.wrists[i].y - me.shoulders[i].y, z: me.wrists[i].z - me.shoulders[i].z });
const punches = (extend: number): Thrown[] => [
  { at: 0.4, hand: "left", shape: "straight", style: { extend } },
  { at: 1.5, hand: "right", shape: "straight", style: { extend } },
  { at: 2.6, hand: "left", shape: "hook", style: { extend } },
  { at: 3.7, hand: "right", shape: "uppercut", style: { extend } },
  { at: 4.8, hand: "left", shape: "straight", style: { extend, body: true } },
];
/** The bodies the game would have, pose by pose, for a motion; `aim` false leaves the set-up out. */
function bodies(motion: (s: number) => SyntheticMotion, seconds: number, cam: number, o: { aim?: boolean; fps?: number; noise?: boolean } = {}) {
  const out: { s: number; me: Me3D }[] = [];
  let previous: Me3D | null = null;
  runWithSetup(motion, seconds, { cam: CAMS[cam][1], fps: o.fps ?? 30, ...(o.noise === false ? {} : { noise: { seed: 7, ...NOISE } }) }, (p) => {
    if (p.s < 0) return;
    const me = bodyOf(p.result, { t: p.t, away: p.range.ready ? p.range.away : 0, setup: o.aim === false ? null : p.setup, range: p.range.units, arms: p.arms, previous });
    if (!me) return;
    previous = me;
    out.push({ s: p.s, me });
  });
  return out;
}

describe("the player's body, one to one", () => {
  it("puts the fist where it is: how far out, how far across, how high", () => {
    const lines: string[] = [];
    for (const cam of [1, 2, 4]) {
      for (const aim of [true, false]) {
        const motion = throwsOf(punches(0.2));
        const all = bodies(motion, 6, cam, { aim });
        const err: number[] = [],
          fwd: number[] = [],
          outErr: number[] = [];
        for (const { s, me } of all) {
          const t = truth(motion(s));
          for (let i = 0; i < 2; i++) {
            const r = rel(me, i);
            err.push(dist(r, t[i]) * 100);
            fwd.push(Math.abs(r.z - t[i].z) * 100);
            // The moments that matter: the arm more than three quarters out.
            if (Math.hypot(t[i].x, t[i].y, t[i].z) > 0.45) outErr.push(dist(r, t[i]) * 100);
          }
        }
        const mid = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
        const worst = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.95)];
        lines.push(
          `${CAMS[cam][0]}, ${aim ? "arms solved in real distances" : "from the picture alone"}: wrist off by ${mid(err).toFixed(1)} cm in the middle, ${worst(err).toFixed(1)} at worst (19 in 20); depth alone ${mid(fwd).toFixed(1)} / ${worst(fwd).toFixed(1)}; with the arm out ${outErr.length ? mid(outErr).toFixed(1) : "-"} / ${outErr.length ? worst(outErr).toFixed(1) : "-"}`,
        );
        if (aim) {
          expect(mid(err)).toBeLessThan(6);
          expect(mid(outErr)).toBeLessThan(6);
        }
      }
    }
    console.log(lines.join("\n"));
  });
  it("keeps every arm on its bones, whatever the camera says", () => {
    const all = bodies(throwsOf(punches(0.15)), 6, 1);
    for (const { me } of all)
      for (let i = 0; i < 2; i++) {
        expect(dist(me.shoulders[i], me.elbows[i])).toBeCloseTo(me.bones.upperArm, 3);
        expect(dist(me.elbows[i], me.wrists[i])).toBeCloseTo(me.bones.foreArm, 3);
      }
  });
  it("is drawn as the camera saw it: carrying a fist on along its speed puts it no nearer to where it really is", () => {
    // Why nothing is predicted. The delay is real: this is how far behind a moving fist is drawn, and what guessing ahead does to that.
    const lines: string[] = [];
    type V = { x: number; y: number; z: number };
    const plus = (a: V, b: V, k: number): V => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
    const minus = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    for (const [fps, delay] of [
      [30, 0.12],
      [60, 0.08],
    ] as const) {
      const motion = throwsOf(punches(0.2));
      const all = bodies(motion, 6, 1, { fps });
      const dt = 1 / fps;
      const seen: number[] = [],
        carried: number[] = [];
      let n = 0;
      for (let now = 0.2; now < 5.8; now += 1 / 60) {
        while (n < all.length && all[n].s + delay - dt <= now) n++;
        if (n < 2) continue;
        const t = truth(motion(now));
        for (let i = 0; i < 2; i++) {
          if (dist(t[i], truth(motion(now - 0.05))[i]) <= 0.02 && dist(t[i], truth(motion(now + 0.05))[i]) <= 0.02) continue;
          const a = rel(all[n - 1].me, i),
            b = rel(all[n - 2].me, i);
          seen.push(dist(a, t[i]) * 100);
          // Carried on along its last step for as long as the pose is old, and kept within an arm's length.
          let ahead = plus(a, minus(a, b), (now - all[n - 1].s) / dt);
          const reach = all[n - 1].me.bones.upperArm + all[n - 1].me.bones.foreArm;
          const far = Math.hypot(ahead.x, ahead.y, ahead.z);
          if (far > reach) ahead = plus({ x: 0, y: 0, z: 0 }, ahead, reach / far);
          carried.push(dist(ahead, t[i]) * 100);
        }
      }
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      lines.push(
        `${fps} poses a second, each ${Math.round((delay - dt) * 1000)}–${delay * 1000} ms old when drawn: a moving fist is drawn ${mean(seen).toFixed(1)} cm from where it is; carried on along its speed, ${mean(carried).toFixed(1)} cm`,
      );
      expect(mean(carried)).toBeGreaterThan(mean(seen) * 0.9);
    }
    // What does help is a younger pose: sixty pictures a second against thirty.
    console.log(lines.join("\n"));
  });
});
