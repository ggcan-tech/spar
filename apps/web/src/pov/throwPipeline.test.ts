import { describe, expect, it } from "vitest";
import { LM, type PoseFrame } from "@spar/protocol";
import { AIM, createThrowControl, type AimMarker } from "./aim";
import type { ThrowTuning } from "./autoThrow";
import {
  COURT_DISTANCE,
  FIXED_STEP,
  createRally,
  launchBall,
  neutralPose,
  stepDuel,
  type ThrowInput,
} from "./duel";
import { stepBall } from "./physics";
import { trackedAvatar } from "./input";
import {
  demoMotion,
  syntheticFrame,
  throwMotion,
  throwReleaseAt,
  type SyntheticMotion,
  type ThrowStyle,
} from "./syntheticBody";
import { createPovTracker } from "./tracking";

interface Pipeline {
  /** Camera poses per second. */
  fps?: number;
  /** Milliseconds from a frame's timestamp until its pose reaches the game. */
  delay?: number;
  /** Share of true depth the pose model reports. */
  depthGain?: number;
  /** Seed for landmark noise: about 4 mm in the image, 3 cm in reported depth. */
  noise?: number;
  /** Poses (counted from the start of the drive) in which the wrist is not seen. */
  dropWrist?: number[];
  /** Poses (counted from the start of the drive) in which a hip is not seen, so the body pose fails. */
  dropBody?: number[];
  /** Milliseconds from the start during which the ball is held but may not be released yet. */
  lockedFor?: number;
}

function noisy(frame: PoseFrame, random: () => number): PoseFrame {
  const gauss = () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += random();
    return (sum - 3) * Math.SQRT2;
  };
  return {
    ...frame,
    lm: frame.lm.map((p) => ({
      ...p,
      x: p.x + gauss() * 0.0016,
      y: p.y + gauss() * 0.0016,
      z: p.z + gauss() * 0.012,
    })),
    world: frame.world!.map((p) => ({
      ...p,
      x: p.x + gauss() * 0.004,
      y: p.y + gauss() * 0.004,
      z: p.z + gauss() * 0.03,
    })),
  };
}
function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * The scripted person moves through the real tracker, the same pose mapping
 * and the same throw call the screen makes, drawn at 60 frames a second.
 */
function run(
  motion: (seconds: number) => SyntheticMotion,
  seconds: number,
  pipeline: Pipeline = {},
  driveStartsAt = Infinity,
  opponent = neutralPose(),
  tuning: Partial<ThrowTuning> = {},
) {
  const step = 1000 / (pipeline.fps ?? 28),
    delay = pipeline.delay ?? 45;
  const random = pipeline.noise === undefined ? null : seeded(pipeline.noise);
  const tracker = createPovTracker({
    automatic: true,
    scaleMode: "body-relative",
  });
  const control = createThrowControl(tuning);
  const observe = (t: number, m: SyntheticMotion) => {
    const frame = syntheticFrame(t, m, pipeline.depthGain);
    return random ? noisy(frame, random) : frame;
  };
  let t = 1000;
  // Stand still until setup completes; jittery landmarks can make that take a while.
  for (let i = 0, settled = 0; i < 600 && settled < 10; i++, t += step)
    if (tracker.update(observe(t, motion(0)), t + delay).calibrated) settled++;
  expect(tracker.sample(t - step + delay).calibrated).toBe(true);
  const start = t;
  const shots: { at: number; shot: ThrowInput }[] = [];
  const markers: { at: number; marker: AimMarker | null }[] = [];
  const hints: string[] = [];
  // After a throw the ball is away: the game does not ask for another one until
  // it has flown and the opponent has had their turn.
  let lockedUntil = -Infinity;
  let driveIndex = 0;
  for (; t < start + seconds * 1000; t += step) {
    const s = (t - start) / 1000;
    const frame = observe(t, motion(s));
    if (s >= driveStartsAt) {
      if (pipeline.dropWrist?.includes(driveIndex))
        frame.lm[LM.R_WRIST] = { ...frame.lm[LM.R_WRIST], v: 0.1 };
      if (pipeline.dropBody?.includes(driveIndex))
        frame.lm[LM.L_HIP] = { ...frame.lm[LM.L_HIP], v: 0.1 };
      driveIndex++;
    }
    const arrival = t + delay;
    tracker.update(frame, arrival);
    for (let now = arrival; now < arrival + step; now += 1000 / 60) {
      const sample = tracker.sample(now);
      if (!sample.valid || now < lockedUntil) {
        control.reset();
        continue;
      }
      const result = control.update(
        sample,
        { ...trackedAvatar(sample, 1.8), t: frame.t },
        now,
        opponent,
        now - start >= (pipeline.lockedFor ?? 0),
      );
      markers.push({ at: now - start, marker: result.marker });
      if (result.hint) hints.push(result.hint);
      if (result.shot) {
        shots.push({ at: now - start, shot: result.shot });
        lockedUntil = now + 1200;
      }
    }
  }
  return { shots, markers, hints };
}
const play = (...args: Parameters<typeof run>) => run(...args).shots;
/** One throw; when it fired relative to the hand's full extension reaching the game. */
function throwOnce(
  style: ThrowStyle,
  pipeline: Pipeline = {},
  opponent = neutralPose(),
) {
  const driveStart = throwReleaseAt(style) - (style.drive ?? 0.15);
  const { shots, markers } = run(
    (s) => throwMotion(s, style),
    1.6,
    pipeline,
    driveStart,
    opponent,
  );
  const delay = pipeline.delay ?? 45;
  const extension = throwReleaseAt(style) * 1000 + delay;
  // The marker on screen as the hand starts its drive.
  const aimed =
    markers.filter((m) => m.at <= driveStart * 1000 + delay).at(-1)?.marker ??
    null;
  return {
    shots,
    markers,
    aimed,
    lateBy: shots.length ? shots[0].at - extension : null,
  };
}
const speedOf = (shot: ThrowInput) =>
  Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z);
/** Where a shot crosses the opponent's side, flown with the real ball physics. */
function landing(shot: ThrowInput) {
  let ball = {
    position: shot.origin,
    velocity: shot.velocity,
    spin: shot.spin,
    radius: 0.11,
  };
  for (let i = 0; i < 400 && ball.position.z < COURT_DISTANCE; i++)
    ball = stepBall(ball, FIXED_STEP);
  return ball.position;
}
/** The demo routine without its throws. */
const scriptedRoutine = (s: number) => demoMotion(s, false);
const quick: ThrowStyle = { drive: 0.15, twist: true };
const push: ThrowStyle = { drive: 0.4 };

describe("throw through the whole camera pipeline", () => {
  const throws: [string, ThrowStyle, Pipeline][] = [
    ["slow push, square shoulders", push, {}],
    ["slow push, shoulders turning", { ...push, twist: true }, {}],
    ["quick throw, square shoulders", { drive: 0.15 }, {}],
    ["quick throw, shoulders turning", quick, {}],
    ["very quick throw", { drive: 0.1, twist: true }, {}],
    ["no pause before the drive", { ...quick, hold: 0 }, {}],
    ["model reports half the depth", quick, { depthGain: 0.5 }],
    ["model reports a quarter of the depth", quick, { depthGain: 0.25 }],
    ["model reports no depth", quick, { depthGain: 0 }],
    ["slow push, half the depth", push, { depthGain: 0.5 }],
    ["15 poses a second", quick, { fps: 15 }],
    ["20 poses a second", quick, { fps: 20 }],
    ["60 poses a second", quick, { fps: 60 }],
    ["110 ms pipeline delay", quick, { delay: 110 }],
    ["150 ms pipeline delay", quick, { delay: 150 }],
    ["wrist lost for two poses mid-drive", quick, { dropWrist: [1, 2] }],
    ["wrist lost for three poses mid-drive", quick, { dropWrist: [1, 2, 3] }],
    ["body pose lost for one pose mid-drive", quick, { dropBody: [2] }],
    ["body pose lost for two poses mid-drive", quick, { dropBody: [1, 2] }],
    ["body pose lost as the hand follows through", quick, { dropBody: [4, 5] }],
  ];
  it.each(throws)(
    "%s throws once, near full extension",
    (_name, style, pipeline) => {
      const { shots, lateBy } = throwOnce(style, pipeline);
      expect(shots.length).toBe(1);
      expect(lateBy).toBeGreaterThan(-200);
      expect(lateBy).toBeLessThan(260);
    },
  );

  it("still throws with landmark noise, at real depth and at half depth", () => {
    let fired = 0,
      attempts = 0;
    for (const depthGain of [1, 0.5])
      for (const style of [quick, push])
        for (let seed = 1; seed <= 10; seed++) {
          attempts++;
          if (throwOnce(style, { depthGain, noise: seed }).shots.length === 1)
            fired++;
        }
    expect(fired).toBe(attempts);
  });

  it("does not throw while the hand is only raised, held or waved", () => {
    const raiseAndHold = (s: number) => throwMotion(Math.min(s, 0.4), quick);
    expect(play(raiseAndHold, 3).length).toBe(0);
    let falseThrows = 0;
    for (let seed = 1; seed <= 10; seed++)
      for (const depthGain of [1, 0.5])
        falseThrows += play(raiseAndHold, 6, { noise: seed, depthGain }).length;
    expect(falseThrows).toBe(0);
    // Wave, arms out, crouch, foot lift, jump, sidestep and head tilt.
    expect(play(scriptedRoutine, 24).length).toBe(0);
    for (let seed = 1; seed <= 10; seed++)
      falseThrows += play(scriptedRoutine, 24, { noise: seed }).length;
    expect(falseThrows).toBe(0);
  });

  it("does not throw from dodging with the hand up", () => {
    const dodge = (s: number): SyntheticMotion => ({
      ...throwMotion(Math.min(s, 0.4), {}),
      sway: 0.16 * Math.sin(s * 5),
      lean: 0.12 * Math.sin(s * 5),
      crouch: 0.15 * Math.max(0, Math.sin(s * 3)),
    });
    expect(play(dodge, 4).length).toBe(0);
    expect(play(dodge, 4, { noise: 5 }).length).toBe(0);
  });

  it("throws a quick throw faster than a slow push", () => {
    const fast = throwOnce(quick).shots[0].shot,
      slow = throwOnce(push).shots[0].shot;
    expect(speedOf(fast)).toBeGreaterThan(speedOf(slow));
  });
});

describe("hints for a throw that did not register", () => {
  const hintsIn = (
    motion: (s: number) => SyntheticMotion,
    seconds: number,
    pipeline: Pipeline = {},
  ) => run(motion, seconds, pipeline).hints;
  it("tells a player whose throw fell just short to throw harder", () => {
    // Raise, hold, then a short sharp push that stops a quarter of the way out.
    const short = (s: number): SyntheticMotion => {
      const cocked = throwMotion(0.4, quick).rightHand!,
        out = throwMotion(throwReleaseAt(quick), quick).rightHand!;
      if (s < 0.5)
        return { rightHand: throwMotion(Math.min(s, 0.4), quick).rightHand };
      const k = Math.min(1, (s - 0.5) / 0.1) * 0.27;
      return {
        rightHand: {
          x: cocked.x + (out.x - cocked.x) * k,
          y: cocked.y + (out.y - cocked.y) * k,
          z: cocked.z + (out.z - cocked.z) * k,
        },
      };
    };
    const { shots, hints } = run(short, 2.5);
    expect(shots.length).toBe(0);
    expect(hints).toEqual(["too-soft"]);
  });
  it("does not nag through ordinary movement with the ball", () => {
    // Wave, arms out, crouch, jump, sidestep, head tilt; and standing with the hand up.
    let hints = hintsIn(scriptedRoutine, 24).length;
    for (let seed = 1; seed <= 4; seed++)
      hints += hintsIn(scriptedRoutine, 24, { noise: seed }).length;
    console.log(`hints in 2 minutes of non-throw movement: ${hints}`);
    expect(hints).toBeLessThanOrEqual(6);
    expect(
      hintsIn((s) => throwMotion(Math.min(s, 0.4), quick), 6, { noise: 2 }),
    ).toEqual([]);
  });
});

describe("a throw made before the ball may be released", () => {
  // The scripted quick throw registers about 690 ms after the start.
  it("leaves the hand on the first frame it may when it was up to 250 ms early", () => {
    const { shots, aimed } = throwOnce(quick, { lockedFor: 800 });
    expect(shots.length).toBe(1);
    expect(shots[0].at).toBeGreaterThanOrEqual(800);
    expect(shots[0].at).toBeLessThan(800 + 1000 / 60 + 1);
    // Still goes to the ring that was showing before the drive.
    const at = landing(shots[0].shot);
    expect(
      Math.hypot(at.x - aimed!.point.x, at.y - aimed!.point.y),
    ).toBeLessThan(0.08);
  });
  it("does not throw later for a throw that was far too early", () => {
    expect(throwOnce(quick, { lockedFor: 1100 }).shots.length).toBe(0);
  });
  it("lets the player throw again after a throw that was too early", () => {
    const twice = (s: number) =>
      s < 1.3 ? throwMotion(s, quick) : throwMotion(s - 1.3, quick);
    const shots = play(twice, 3, { lockedFor: 1100 });
    expect(shots.length).toBe(1);
    expect(shots[0].at).toBeGreaterThan(1700);
  });
});

describe("aim marker through the whole camera pipeline", () => {
  const aims = [
    { x: 0, y: 0 },
    { x: -0.12, y: 0 },
    { x: 0.12, y: 0 },
    { x: 0, y: 0.1 },
    { x: 0, y: -0.1 },
    { x: 0.1, y: 0.08 },
  ];
  const off = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  it("lands the ball on the marker that was showing before the throw", () => {
    for (const style of [quick, push])
      for (const aim of aims) {
        const { shots, aimed } = throwOnce({ ...style, aim });
        expect(aimed).not.toBeNull();
        expect(aimed!.locked).toBe(false);
        expect(off(landing(shots[0].shot), aimed!.point)).toBeLessThan(0.08);
      }
  });

  it("moves the landing point with the held hand, about three times as far", () => {
    const at = (aim: { x: number; y: number }) =>
      landing(throwOnce({ ...quick, aim }).shots[0].shot);
    const centre = at({ x: 0, y: 0 });
    // Close to the centre of the court at torso height for the usual hand spot.
    expect(Math.abs(centre.x)).toBeLessThan(0.2);
    expect(Math.abs(centre.y - AIM.height)).toBeLessThan(0.25);
    const left = at({ x: -0.12, y: 0 }),
      right = at({ x: 0.12, y: 0 }),
      up = at({ x: 0, y: 0.1 }),
      down = at({ x: 0, y: -0.1 });
    // 12 cm of hand is about 13 game units, times the gain.
    expect(right.x - centre.x).toBeGreaterThan(0.28);
    expect(right.x - centre.x).toBeLessThan(0.5);
    expect(centre.x - left.x).toBeGreaterThan(0.28);
    expect(centre.x - left.x).toBeLessThan(0.5);
    expect(up.y - centre.y).toBeGreaterThan(0.22);
    expect(centre.y - down.y).toBeGreaterThan(0.22);
    expect(Math.abs(up.x - centre.x)).toBeLessThan(0.06);
    expect(Math.abs(left.y - centre.y)).toBeLessThan(0.06);
  });

  it("shows the marker only for a raised hand and locks it during the drive", () => {
    const { markers, shots } = throwOnce(quick);
    expect(markers[0].marker).toBeNull();
    const fired = shots[0].at;
    const before = markers.filter((m) => m.at < fired && m.marker);
    expect(before.length).toBeGreaterThan(10);
    expect(before.at(-1)!.marker!.locked).toBe(true);
    expect(before[0].marker!.locked).toBe(false);
    // Gone once the ball is away.
    expect(markers.find((m) => m.at === fired)!.marker).toBeNull();
  });

  it("keeps the marker steady for a held hand and repeatable between throws, with noise", () => {
    const held = run((s) => throwMotion(Math.min(s, 0.4), quick), 3, {
      noise: 4,
    }).markers.filter((m) => m.at > 800 && m.marker);
    const xs = held.map((m) => m.marker!.point.x),
      ys = held.map((m) => m.marker!.point.y);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    console.log(
      `held marker spread over 2 s with noise: x ${spread(xs).toFixed(3)}, y ${spread(ys).toFixed(3)}`,
    );
    expect(spread(xs)).toBeLessThan(0.15);
    expect(spread(ys)).toBeLessThan(0.15);
    const landings = [];
    for (let seed = 1; seed <= 10; seed++)
      landings.push(landing(throwOnce(quick, { noise: seed }).shots[0].shot));
    console.log(
      `landing spread over 10 noisy throws: x ${spread(landings.map((p) => p.x)).toFixed(3)}, y ${spread(landings.map((p) => p.y)).toFixed(3)}`,
    );
    expect(spread(landings.map((p) => p.x))).toBeLessThan(0.2);
    expect(spread(landings.map((p) => p.y))).toBeLessThan(0.2);
  });

  it("takes the aim from the wind-up when the throw has no pause", () => {
    for (const aim of aims) {
      const held = landing(throwOnce({ ...quick, aim }).shots[0].shot),
        fluid = landing(throwOnce({ ...quick, hold: 0, aim }).shots[0].shot);
      expect(off(held, fluid)).toBeLessThan(0.25);
    }
  });

  it("hits an opponent standing on the marker and misses one standing away from it", () => {
    const { shots, aimed } = throwOnce({ ...quick, aim: { x: 0.12, y: 0 } });
    const outcome = (opponentX: number) => {
      const opponent = neutralPose();
      opponent.root.x = opponent.head.x = opponentX;
      const mine = neutralPose();
      mine.rightHand = { ...shots[0].shot.origin };
      let state = createRally(0, 0);
      state = { ...state, poses: [mine, opponent], previous: [mine, opponent] };
      state = launchBall(state, 0, shots[0].shot);
      expect(state.balls.length).toBe(1);
      for (let i = 0; i < 240 && state.balls.length; i++)
        state = stepDuel(state, state.poses);
      return state.hp[1];
    };
    // The opponent's own x runs the other way from the thrower's.
    expect(outcome(-aimed!.point.x)).toBe(4);
    expect(outcome(-aimed!.point.x + 0.8)).toBe(5);
  });
});

describe.skipIf(!process.env.SWEEP)("tuning sweep", () => {
  it("prints recall and false throws per setting", () => {
    const rows: Record<string, string | number>[] = [];
    for (const driveTravel of [0.16, 0.2, 0.25, 0.3])
      for (const driveSpeed of [1.5, 2, 2.5]) {
        const tuning = { driveTravel, driveSpeed };
        const recall = (style: ThrowStyle, depthGain: number) => {
          let ok = 0;
          for (let seed = 1; seed <= 20; seed++) {
            const start = throwReleaseAt(style) - (style.drive ?? 0.15);
            if (
              play(
                (s) => throwMotion(s, style),
                1.6,
                { noise: seed, depthGain },
                start,
                neutralPose(),
                tuning,
              ).length === 1
            )
              ok++;
          }
          return ok;
        };
        let held = 0,
          routine = 0;
        for (let seed = 1; seed <= 20; seed++)
          held += play(
            (s) => throwMotion(Math.min(s, 0.4), quick),
            6,
            { noise: seed, depthGain: seed % 2 ? 1 : 0.5 },
            Infinity,
            neutralPose(),
            tuning,
          ).length;
        for (let seed = 1; seed <= 10; seed++)
          routine += play(
            scriptedRoutine,
            24,
            { noise: seed },
            Infinity,
            neutralPose(),
            tuning,
          ).length;
        rows.push({
          travel: driveTravel,
          speed: driveSpeed,
          "quick d1": recall(quick, 1),
          "quick d.5": recall(quick, 0.5),
          "quick d.25": recall(quick, 0.25),
          "quick d0": recall(quick, 0),
          "push d1": recall(push, 1),
          "push d.5": recall(push, 0.5),
          "push d.25": recall(push, 0.25),
          "false held/2min": held,
          "false routine/4min": routine,
        });
      }
    console.table(rows);
  });
});
