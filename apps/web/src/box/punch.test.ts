import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@spar/protocol";
import { createArmRuler } from "../pov/body";
import { syntheticFrame, type SyntheticMotion } from "../pov/syntheticBody";
import { createPovTracker } from "../pov/tracking";
import { createPunchReader, type Punch, type PunchTuning } from "./punch";
import {
  AT_REST,
  boxDemoMotion,
  punchDuration,
  punchMotion,
  stance,
  type Hand,
  type PunchShape,
  type PunchStyle,
} from "./scriptedBoxer";

interface Pipeline {
  fps?: number;
  /** Share of true depth the pose model reports. */
  depthGain?: number;
  /** Seed for landmark noise: about 4 mm in the picture, 3 cm in reported depth. */
  noise?: number;
  /** Where the camera is: [metres above the floor, metres away], tipped to look at the chest. */
  camera?: [number, number];
  /** How the hands come up to the guard before the motion: seconds taken, and one hand only. */
  raise?: { seconds: number; hand?: "left" | "right" };
  /** A fault put into the frames while the player stands in the guard. */
  fault?: (frame: PoseFrame, index: number) => void;
  /** Landmark noise as a multiple of the usual: 1 is about 0.4 cm across the picture and 3 cm in depth at the player. */
  noiseScale?: number;
  /** The reader's settings, where they differ from the usual. */
  tuning?: Partial<PunchTuning>;
}
function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function noisy(frame: PoseFrame, random: () => number, k = 1): PoseFrame {
  const gauss = () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += random();
    return (sum - 3) * Math.SQRT2;
  };
  return {
    ...frame,
    lm: frame.lm.map((p) => ({
      ...p,
      x: p.x + gauss() * 0.0016 * k,
      y: p.y + gauss() * 0.0016 * k,
      z: p.z + gauss() * 0.012 * k,
    })),
    world: frame.world!.map((p) => ({
      ...p,
      x: p.x + gauss() * 0.004 * k,
      y: p.y + gauss() * 0.004 * k,
      z: p.z + gauss() * 0.03 * k,
    })),
  };
}
/**
 * The scripted boxer through the real tracker and the punch reader. `motion`
 * is given seconds since the guard was set; before that the person sets up and
 * stands in the guard for a second.
 */
function run(
  motion: (seconds: number) => SyntheticMotion,
  seconds: number,
  pipeline: Pipeline = {},
) {
  const step = 1000 / (pipeline.fps ?? 30);
  const random = pipeline.noise === undefined ? null : seeded(pipeline.noise);
  const tracker = createPovTracker({ automatic: true, scaleMode: "body-relative" });
  const reader = createPunchReader(pipeline.tuning ?? {});
  const ruler = createArmRuler();
  const punches: (Punch & { at: number })[] = [];
  /** When each punch began to be read, seconds into the motion. */
  const starts: number[] = [];
  const view = pipeline.camera
    ? { height: pipeline.camera[0], distance: pipeline.camera[1], aim: 1.2 }
    : {};
  let t = 1000;
  let faultAt = -1;
  const feed = (m: SyntheticMotion, record: number | null) => {
    t += step;
    const frame = syntheticFrame(t, m, pipeline.depthGain, view);
    if (faultAt >= 0) pipeline.fault?.(frame, faultAt);
    const result = tracker.update(random ? noisy(frame, random, pipeline.noiseScale ?? 1) : frame, t);
    if (result.valid && result.joints && result.jointWeights)
      ruler.measure(result.joints, result.jointWeights, t);
    const read = reader.update(result, t, ruler.lengths());
    for (const punch of read.punches)
      if (record !== null) punches.push({ ...punch, at: record });
    for (const start of read.starts) if (record !== null && record >= 0) starts.push(record);
    return result;
  };
  // Setup with the arms down, as a player stands before a round.
  for (let i = 0; i < 45; i++) feed(AT_REST, null);
  // Hands come up to the guard and are held: any punch read here is a fault.
  const raise = pipeline.raise?.seconds ?? 0.35;
  const before: typeof punches = [];
  for (let s = 0; s < 1.4; s += step / 1000) {
    // The way people move: slow, fast, slow.
    const c = Math.min(1, s / raise);
    const k = c * c * c * (10 - 15 * c + 6 * c * c);
    const up = stance();
    const rest = { x: 0.05, y: -0.5, z: 0.08 };
    const blend = (hand: "leftHand" | "rightHand", side: number) => ({
      x: side * rest.x + (up[hand]!.x - side * rest.x) * k,
      y: rest.y + (up[hand]!.y - rest.y) * k,
      z: rest.z + (up[hand]!.z - rest.z) * k,
    });
    const count = punches.length;
    const only = pipeline.raise?.hand;
    feed(
      {
        leftHand: only === "right" ? { x: -rest.x, y: rest.y, z: rest.z } : blend("leftHand", -1),
        rightHand: only === "left" ? { x: rest.x, y: rest.y, z: rest.z } : blend("rightHand", 1),
      },
      -1,
    );
    before.push(...punches.splice(count));
  }
  let index = 0;
  for (let s = 0; s < seconds; s += step / 1000) {
    faultAt = index++;
    feed(motion(s), s);
  }
  return { punches, before, starts };
}
/** Hands go to a block and come back, over a quarter of a second each way, every 1.2 s. */
const blockInOut = (block: "high" | "low", s: number): SyntheticMotion => {
  const phase = s % 1.2;
  const k =
    phase < 0.25 ? phase / 0.25 : phase < 0.6 ? 1 : phase < 0.85 ? 1 - (phase - 0.6) / 0.25 : 0;
  const a = stance(),
    b = stance({ block });
  const mix = (p: { x: number; y: number; z: number }, q: typeof p) => ({
    x: p.x + (q.x - p.x) * k,
    y: p.y + (q.y - p.y) * k,
    z: p.z + (q.z - p.z) * k,
  });
  return {
    ...a,
    leftHand: mix(a.leftHand!, b.leftHand!),
    rightHand: mix(a.rightHand!, b.rightHand!),
  };
};
const one = (
  hand: Hand,
  shape: PunchShape,
  style: PunchStyle = {},
  pipeline: Pipeline = {},
) =>
  run(
    (s) => (s < 0.3 ? stance() : punchMotion(hand, shape, s - 0.3, style)),
    0.3 + punchDuration(style) + 0.5,
    pipeline,
  );

describe("reading punches from one camera", () => {
  it("reads each punch once, with the right hand and shape", () => {
    for (const hand of ["left", "right"] as const)
      for (const shape of ["straight", "hook", "uppercut"] as const) {
        const { punches, before } = one(hand, shape);
        expect(before, "raising the guard").toEqual([]);
        expect(
          punches.map((p) => `${p.hand} ${p.shape}`),
          `${hand} ${shape}`,
        ).toEqual([`${hand} ${shape}`]);
      }
  });

  it("calls it early: before the fist is fully out", () => {
    for (const shape of ["straight", "hook", "uppercut"] as const) {
      const { punches } = one("left", shape, { extend: 0.2 });
      // The punch starts 0.3 s in and is fully out 0.2 s later.
      const { starts } = one("left", shape, { extend: 0.2 });
      // The punch starts 0.3 s in and is fully out 0.2 s later.
      const began = starts[0] - 0.3,
        confirmed = punches[0].at - 0.3;
      console.log(
        `${shape}: glove sent ${(began * 1000).toFixed(0)} ms after the fist started, hit confirmed at ${(confirmed * 1000).toFixed(0)} ms`,
      );
      expect(began).toBeLessThan(0.17);
      expect(confirmed).toBeLessThan(0.22);
    }
  });

  it("tells a punch at the head from one at the body", () => {
    expect(one("left", "straight").punches[0].target).toBe("head");
    expect(one("left", "straight", { body: true }).punches[0].target).toBe("body");
    expect(one("right", "hook", { body: true }).punches[0].target).toBe("body");
    expect(one("right", "uppercut").punches[0].target).toBe("head");
  });

  it("gives a harder punch more power", () => {
    const soft = one("right", "straight", { extend: 0.32 }).punches[0],
      hard = one("right", "straight", { extend: 0.12 }).punches[0];
    expect(hard.power).toBeGreaterThanOrEqual(soft.power);
    // Kept narrow: nothing stops a fist thrown at air, so the hardest must not pay much more.
    expect(hard.power).toBeLessThanOrEqual(1.15);
    expect(soft.power).toBeGreaterThanOrEqual(0.85);
  });

  it("still reads punches when the camera reports half the depth, a quarter, or none", () => {
    for (const depthGain of [0.5, 0.25, 0])
      for (const shape of ["straight", "hook", "uppercut"] as const) {
        const { punches } = one("left", shape, {}, { depthGain });
        expect(punches.length, `${shape} at depth ×${depthGain}`).toBe(1);
      }
  });

  it("reads a quick one-two and a double jab as two punches each", () => {
    const oneTwo = run((s) => {
      if (s < 0.3) return stance();
      if (s < 0.3 + 0.34) return punchMotion("left", "straight", s - 0.3, { back: 0.16 });
      return punchMotion("right", "straight", s - 0.64);
    }, 1.6);
    expect(oneTwo.punches.map((p) => p.hand)).toEqual(["left", "right"]);
    const double = run((s) => {
      if (s < 0.3) return stance();
      const second = 0.3 + punchDuration({ back: 0.18 });
      return s < second
        ? punchMotion("left", "straight", s - 0.3, { back: 0.18 })
        : punchMotion("left", "straight", s - second);
    }, 1.6);
    expect(double.punches.map((p) => p.hand)).toEqual(["left", "left"]);
  });

  it("does not punch for a slip, a duck, a block, a step, or standing in the guard", () => {
    const moves: [string, (s: number) => SyntheticMotion][] = [
      ["guard", () => stance()],
      ["slip", (s) => stance({ lean: 0.16 * Math.sin(s * 5) })],
      ["duck", (s) => stance({ crouch: 0.13 * (1 - Math.cos(s * 5)) })],
      ["step", (s) => stance({ step: 0.2 * Math.sin(s * 3) })],
      ["high block", (s) => blockInOut("high", s)],
      ["low block", (s) => blockInOut("low", s)],
    ];
    for (const [name, motion] of moves)
      for (const noise of [undefined, 4]) {
        const { punches, before } = run(motion, 6, { noise });
        expect(before, "raising the guard").toEqual([]);
        expect(
          punches.map((p) => `${p.hand} ${p.shape} at ${p.at.toFixed(2)}`),
          `${name}${noise ? " with noise" : ""}`,
        ).toEqual([]);
      }
  });

  it("does not read a half-hearted poke as a punch", () => {
    expect(one("left", "straight", { reach: 0.3, extend: 0.3 }).punches).toEqual([]);
  });

  it("with landmark noise: reads nearly every punch and invents almost none", () => {
    let thrown = 0,
      read = 0,
      wrongHand = 0,
      wrongShape = 0;
    for (let seed = 1; seed <= 12; seed++)
      for (const hand of ["left", "right"] as const)
        for (const shape of ["straight", "hook", "uppercut"] as const) {
          const { punches } = one(
            hand,
            shape,
            { extend: 0.14 + (seed % 4) * 0.04 },
            { noise: seed, depthGain: seed % 2 ? 1 : 0.5, fps: seed % 3 ? 30 : 24 },
          );
          thrown++;
          if (punches.length >= 1) read++;
          if (punches.length > 1 || punches.some((p) => p.hand !== hand)) wrongHand++;
          if (punches[0] && punches[0].shape !== shape) wrongShape++;
        }
    // Two minutes of guard, slips and ducks with noise: punches that never were.
    let invented = 0;
    for (let seed = 21; seed <= 24; seed++)
      invented += run(
        (s) =>
          stance({
            lean: 0.14 * Math.sin(s * 2.3),
            crouch: 0.1 * Math.max(0, Math.sin(s * 1.1)),
          }),
        30,
        { noise: seed },
      ).punches.length;
    console.log(
      `punches read ${read}/${thrown}, extra or wrong-hand ${wrongHand}, wrong shape ${wrongShape}; invented in 2 min of movement: ${invented}`,
    );
    expect(read / thrown).toBeGreaterThanOrEqual(0.95);
    expect(wrongHand).toBeLessThanOrEqual(2);
    expect(wrongShape / thrown).toBeLessThanOrEqual(0.15);
    expect(invented).toBeLessThanOrEqual(2);
  });

  it("reads the same at 24, 30 and 60 poses a second, and only calls later as landmarks get noisier", () => {
    const lines: string[] = [];
    const rows: { line: string; share: number; extra: number; invented: number; noiseScale: number }[] = [];
    for (const noiseScale of [1, 2, 3])
      for (const fps of [24, 30, 60]) {
        let thrown = 0,
          read = 0,
          extra = 0,
          shapes = 0;
        for (let seed = 1; seed <= 6; seed++)
          for (const hand of ["left", "right"] as const)
            for (const shape of ["straight", "hook", "uppercut"] as const) {
              const { punches } = one(hand, shape, { extend: 0.14 + (seed % 4) * 0.04 }, { noise: seed, noiseScale, fps });
              thrown++;
              if (punches.length >= 1) read++;
              if (punches.length > 1 || punches.some((p) => p.hand !== hand)) extra++;
              if (punches[0] && punches[0].shape !== shape) shapes++;
            }
        // A minute of guard, slips and ducks: punches that never were.
        let invented = 0;
        for (let seed = 21; seed <= 22; seed++)
          invented += run(
            (s) => stance({ lean: 0.14 * Math.sin(s * 2.3), crouch: 0.1 * Math.max(0, Math.sin(s * 1.1)) }),
            30,
            { noise: seed, noiseScale, fps },
          ).punches.length;
        lines.push(
          `noise ×${noiseScale}, ${fps} poses a second: read ${read}/${thrown}, doubled or wrong hand ${extra}, wrong shape ${shapes}, invented in a minute ${invented}`,
        );
        rows.push({ line: lines.at(-1)!, share: read / thrown, extra, invented, noiseScale });
      }
    console.log(lines.join("\n"));
    // The usual noise (about 0.4 cm across the picture, 3 cm in depth): all of them, at any
    // rate. Twice that: nine in ten. Three times: two in three, read later. Before the
    // reader worked in time and scaled itself to the jitter, 60 poses a second lost a
    // third of them and twice the noise lost nearly all.
    for (const row of rows) {
      expect(row.share, row.line).toBeGreaterThanOrEqual(row.noiseScale === 1 ? 0.94 : row.noiseScale === 2 ? 0.85 : 0.6);
      expect(row.extra, row.line).toBeLessThanOrEqual(row.noiseScale === 1 ? 2 : 4);
      expect(row.invented, row.line).toBeLessThanOrEqual(row.noiseScale === 3 ? 2 : 1);
    }
  });

  it("reads the demo round's punches", () => {
    // From the still start: setup, guard up, then one loop of the routine.
    const { punches } = run((s) => boxDemoMotion(s + 4), 16);
    expect(punches.map((p) => `${p.hand[0]}${p.shape[0]}${p.target[0]}`).join(" ")).toBe(
      "lsh lsh rsh lhh ruh lsb rsh lsh rsh lhh rhb",
    );
  });
});

/** Where a laptop, a monitor, a television or a shelf puts the camera: [name, height, distance]. */
const CAMERAS: [string, number, number][] = [
  ["a laptop on a low table", 0.5, 1.8],
  ["a laptop on a desk", 0.75, 2.0],
  ["chest height", 1.0, 2.6],
  ["a monitor's webcam", 1.3, 2.2],
  ["the top of a television", 1.6, 2.4],
  ["a shelf", 2.0, 2.4],
];

describe("straight punches from wherever the camera is", () => {
  /** Where a punch thrown at the camera, not level, ends against the shoulder. */
  const atCamera = (height: number, distance: number) =>
    (0.5 * (height - 1.41)) / Math.hypot(distance, height - 1.41);
  it("reads a level straight at the head from every camera, with the depth at full, half and a quarter", () => {
    const failed: string[] = [];
    for (const [name, height, distance] of CAMERAS)
      for (const depthGain of [1, 0.5, 0.25])
        for (const hand of ["left", "right"] as const) {
          const { punches } = one(hand, "straight", {}, { camera: [height, distance], depthGain });
          const got = punches.map((p) => `${p.hand} ${p.shape} ${p.target}`).join(", ");
          if (got !== `${hand} straight head`) failed.push(`${name} ×${depthGain} ${hand}: ${got || "missed"}`);
        }
    expect(failed).toEqual([]);
  });
  it("reads one thrown at the camera itself, and a short one", () => {
    const failed: string[] = [];
    for (const [name, height, distance] of CAMERAS)
      for (const depthGain of [1, 0.5]) {
        const aimed = one("left", "straight", { endUp: atCamera(height, distance) }, { camera: [height, distance], depthGain });
        if (aimed.punches.length !== 1 || aimed.punches[0].shape !== "straight")
          failed.push(`at the camera, ${name} ×${depthGain}: ${aimed.punches.map((p) => p.shape).join(",") || "missed"}`);
        const short = one("left", "straight", { reach: 0.7 }, { camera: [height, distance], depthGain });
        if (short.punches.length !== 1) failed.push(`70% reach, ${name} ×${depthGain}: ${short.punches.length} read`);
      }
    expect(failed).toEqual([]);
  });
  it("still reads hooks and uppercuts from every camera", () => {
    const failed: string[] = [];
    for (const [name, height, distance] of CAMERAS)
      for (const shape of ["hook", "uppercut"] as const) {
        const { punches } = one("right", shape, {}, { camera: [height, distance], depthGain: 0.5 });
        if (punches.length !== 1) failed.push(`${shape}, ${name}: ${punches.map((p) => p.shape).join(",") || "missed"}`);
      }
    expect(failed).toEqual([]);
  });
});

describe("things that are not punches", () => {
  it("is not fooled by hands coming up to the guard the way people move, both or one", () => {
    const failed: string[] = [];
    for (const seconds of [0.18, 0.25, 0.35])
      for (const hand of [undefined, "left", "right"] as const) {
        const { before } = run(() => stance(), 0.5, { raise: { seconds, hand } });
        if (before.length) failed.push(`${seconds}s ${hand ?? "both"}: ${before.map((p) => `${p.hand} ${p.shape}`).join(", ")}`);
      }
    expect(failed).toEqual([]);
  });
  it("is not fooled by one hand dropping to parry and coming back, or both back from a low block out of step", () => {
    const eased = (k: number) => {
      const c = Math.max(0, Math.min(1, k));
      return c * c * c * (10 - 15 * c + 6 * c * c);
    };
    const failed: string[] = [];
    for (const seconds of [0.18, 0.25, 0.4]) {
      // One hand to the ribs and straight back.
      const parry = run((s) => {
        const phase = (s - 0.4) / seconds;
        const k = phase < 0 || phase > 2 ? 0 : phase < 1 ? eased(phase) : 1 - eased(phase - 1);
        const up = stance(),
          low = stance({ block: "low" });
        return {
          ...up,
          rightHand: {
            x: up.rightHand!.x + (low.rightHand!.x - up.rightHand!.x) * k,
            y: up.rightHand!.y + (low.rightHand!.y - up.rightHand!.y) * k,
            z: up.rightHand!.z + (low.rightHand!.z - up.rightHand!.z) * k,
          },
        };
      }, 1.6);
      if (parry.punches.length) failed.push(`parry ${seconds}s: ${parry.punches.map((p) => `${p.hand} ${p.shape}`).join(", ")}`);
      // Both hands held low, then back up, the left 60 ms behind the right.
      const back = run((s) => {
        const up = stance(),
          low = stance({ block: "low" });
        const k = (lag: number) => (s < 0.3 ? eased(s / 0.25) : 1 - eased((s - 0.9 - lag) / seconds));
        const mix = (a: { x: number; y: number; z: number }, b: typeof a, q: number) => ({
          x: a.x + (b.x - a.x) * q,
          y: a.y + (b.y - a.y) * q,
          z: a.z + (b.z - a.z) * q,
        });
        return { ...up, leftHand: mix(up.leftHand!, low.leftHand!, k(0.06)), rightHand: mix(up.rightHand!, low.rightHand!, k(0)) };
      }, 2);
      if (back.punches.length) failed.push(`back from low ${seconds}s: ${back.punches.map((p) => `${p.hand} ${p.shape}`).join(", ")}`);
    }
    expect(failed).toEqual([]);
  });
  it("is not fooled by two bad frames from the body model", () => {
    const faults: [string, (frame: PoseFrame) => void][] = [
      ["wrists swapped", (f) => {
        [f.lm[15], f.lm[16]] = [f.lm[16], f.lm[15]];
        [f.world![15], f.world![16]] = [f.world![16], f.world![15]];
      }],
      ["both wrists on one fist", (f) => {
        f.lm[15] = { ...f.lm[16] };
        f.world![15] = { ...f.world![16] };
      }],
      ["a wrist's depth 35 cm out", (f) => {
        f.lm[15] = { ...f.lm[15], z: f.lm[15].z - 0.08 };
        f.world![15] = { ...f.world![15], z: f.world![15].z - 0.35 };
      }],
      ["an elbow on the line from shoulder to wrist", (f) => {
        for (const set of [f.lm, f.world!]) set[13] = { ...set[13], x: (set[11].x + set[15].x) / 2, y: (set[11].y + set[15].y) / 2, z: (set[11].z + set[15].z) / 2 };
      }],
    ];
    const failed: string[] = [];
    for (const [name, fault] of faults) {
      const { punches } = run(() => stance(), 1.5, { fault: (frame, index) => (index === 20 || index === 21 ? fault(frame) : undefined) });
      if (punches.length) failed.push(`${name}: ${punches.map((p) => `${p.hand} ${p.shape}`).join(", ")}`);
    }
    expect(failed).toEqual([]);
  });
});

describe("combinations", () => {
  it("reads the cross of a one-two however soon it follows the jab", () => {
    const failed: string[] = [];
    for (const gap of [0.12, 0.16, 0.2, 0.3]) {
      const { punches } = run((s) => {
        if (s < 0.3) return stance();
        const jab = punchMotion("left", "straight", s - 0.3),
          cross = punchMotion("right", "straight", s - 0.3 - gap);
        return { ...jab, rightHand: cross.rightHand, twist: (jab.twist ?? 0) + (cross.twist ?? 0) };
      }, 1.6);
      if (punches.map((p) => p.hand).join(" ") !== "left right") failed.push(`${gap}s: ${punches.map((p) => `${p.hand} ${p.shape}`).join(", ") || "none"}`);
    }
    expect(failed).toEqual([]);
  });
  it("reads a double jab whose first punch comes only part of the way back", () => {
    const { punches } = run((s) => {
      if (s < 0.3) return stance();
      // Out, half-way back, out again.
      const first = punchMotion("left", "straight", Math.min(s - 0.3, 0.18 + 0.04 + 0.11));
      const again = s - 0.3 - 0.33;
      if (again <= 0) return first;
      const full = punchMotion("left", "straight", 0.2),
        half = punchMotion("left", "straight", 0.33);
      const k = Math.min(1, again / 0.14);
      const lerp = (a: number, b: number) => a + (b - a) * k;
      return again < 0.3
        ? { ...full, leftHand: { x: lerp(half.leftHand!.x, full.leftHand!.x), y: lerp(half.leftHand!.y, full.leftHand!.y), z: lerp(half.leftHand!.z, full.leftHand!.z) } }
        : punchMotion("left", "straight", 0.22 + (again - 0.3));
    }, 1.8);
    expect(punches.map((p) => `${p.hand} ${p.shape}`)).toEqual(["left straight", "left straight"]);
  });
});

describe("slow and short punches", () => {
  it("reads a punch that takes most of a second to go out, and a hook or an uppercut at half reach; a straight needs six tenths of its reach", () => {
    // Why there is no "easy punches" switch: speed is not what the reader asks for.
    for (const shape of ["straight", "hook", "uppercut"] as const) expect(one("left", shape, { extend: 0.7 }).punches, shape).toHaveLength(1);
    expect(one("left", "hook", { reach: 0.5, extend: 0.3 }).punches).toHaveLength(1);
    expect(one("left", "uppercut", { reach: 0.5, extend: 0.3 }).punches).toHaveLength(1);
    expect(one("left", "straight", { reach: 0.6, extend: 0.3 }).punches).toHaveLength(1);
    expect(one("left", "straight", { reach: 0.5, extend: 0.3 }).punches).toHaveLength(0);
  });
});

describe("restless hands", () => {
  /** Both fists drifting about the guard in all three directions, each on its own: up to `amp` metres either way. */
  const wander = (amp: number) => (s: number): SyntheticMotion => {
    const m = stance();
    const w = (k: number) => amp * (0.625 * Math.sin(s * 5.3 + k) + 0.375 * Math.sin(s * 11 + 2 * k));
    return {
      ...m,
      leftHand: { x: m.leftHand!.x + w(0), y: m.leftHand!.y + w(1), z: m.leftHand!.z + w(2) },
      rightHand: { x: m.rightHand!.x + w(3), y: m.rightHand!.y + w(4), z: m.rightHand!.z + w(5) },
    };
  };
  it("invents nothing from fists that drift 2 cm, and little from 4 cm seen level; from a desk below, drifting fists still read as punches (the contact reader rates most of those as touches)", () => {
    const lines: string[] = [];
    const count = (amp: number, camera: [number, number] | null, fps: number, tuning: Partial<PunchTuning> = {}) =>
      run(wander(amp), 30, { fps, noise: 5, noiseScale: 0.33, tuning, ...(camera ? { camera } : {}) }).punches.length;
    for (const amp of [0.02, 0.04, 0.06])
      for (const camera of [null, [0.75, 1.9] as [number, number]]) {
        const now = [30, 60].map((fps) => count(amp, camera, fps));
        const before = [30, 60].map((fps) => count(amp, camera, fps, { strayTimes: 0, strayMost: 0.1 }));
        lines.push(`fists drifting ±${amp * 100} cm for 30 s, camera ${camera ? "on a desk below" : "level"}: ${now.join(" / ")} punches invented at 30 / 60 poses a second (${before.join(" / ")} before the hand's own straying was allowed for)`);
        if (amp === 0.02) expect(Math.max(...now)).toBe(0);
        if (amp === 0.04 && !camera) expect(Math.max(...now)).toBeLessThanOrEqual(6);
        // Never worse than without it.
        expect(now[0] + now[1]).toBeLessThanOrEqual(before[0] + before[1] + 2);
      }
    console.log(lines.join("\n"));
  });
  it("still reads a real punch thrown by restless hands, and no later", () => {
    let read = 0,
      of = 0;
    for (const hand of ["left", "right"] as const)
      for (const extend of [0.15, 0.25, 0.4])
        for (const camera of [null, [0.75, 1.9] as [number, number]]) {
          const w = wander(0.04);
          // Three seconds of drifting, then the punch, the other hand drifting on.
          const r = run(
            (s) => {
              if (s < 3) return w(s);
              const p = punchMotion(hand, "straight", s - 3, { extend });
              const still = w(s);
              return hand === "left" ? { ...p, rightHand: still.rightHand } : { ...p, leftHand: still.leftHand };
            },
            3 + extend + 0.5,
            { noise: 4, noiseScale: 0.33, ...(camera ? { camera } : {}) },
          );
          of++;
          if (r.punches.some((p) => p.at >= 3 && p.at <= 3 + extend * 1.15 && p.hand === hand)) read++;
        }
    expect(read).toBeGreaterThanOrEqual(of - 1);
  });
});
