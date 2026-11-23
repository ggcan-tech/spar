import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { TrackingResult } from "./tracking";
import { LM, type PoseFrame } from "@spar/protocol";

// Exercise the real frame/effect code with a detector result at its provider
// boundary. No camera image or successful human recognition is simulated.
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  frames: [] as FrameRequestCallback[],
  states: [] as unknown[],
  cameraMode: true,
  realTracker: false,
  realGate: false,
  poseAge: 0,
  trackerReset: vi.fn(),
  trackerRecenter: vi.fn(() => true),
  running: false,
  live: false,
  hudOverride: {} as Record<string, unknown>,
  setRunning: vi.fn(),
  onBodyFrame: null as ((frame: PoseFrame) => void) | null,
  result: null as TrackingResult | null,
  sample: vi.fn(),
  present: vi.fn(),
  render: vi.fn(),
  hud: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    h.states.push(initial);
    let value =
      h.cameraMode && (initial === "preview" || initial === "camera")
        ? "camera"
        : initial;
    if (h.states.length === 3) value = h.running;
    if (initial === "off" && h.live) value = "live";
    if (initial && typeof initial === "object" && "gate" in initial)
      value = { ...initial, ...h.hudOverride };
    return [
      value,
      typeof initial === "object" && initial && "gate" in initial
        ? h.hud
        : h.states.length === 3
          ? h.setRunning
          : vi.fn(),
    ];
  },
  useEffect: (setup: () => void | (() => void)) => h.effects.push(setup),
}));
// The start count is tested on its own (startGate.test.ts). Here the clock runs
// as soon as a round is started, unless a test asks for the real gate.
vi.mock("./startGate", async (original) => {
  const actual = await original<typeof import("./startGate")>();
  return {
    ...actual,
    createStartGate: () => {
      const real = actual.createStartGate();
      return {
        reset: real.reset,
        update: (facts: Parameters<typeof real.update>[0]) =>
          h.realGate
            ? real.update(facts)
            : {
                live: facts.running && !facts.over,
                phase: "live" as const,
                count: null,
                cue: null,
              },
      };
    },
  };
});
// The opponent's varied timing and aim are tested on their own (botMind.test.ts).
// Here it throws as it always did: 0.6 s after getting the ball, at the head.
vi.mock("./botMind", async (original) => {
  const actual = await original<typeof import("./botMind")>();
  const { TRAINING_PACE } = await import("./duel");
  return {
    ...actual,
    createBotMind: () => ({
      next: (pace: keyof typeof TRAINING_PACE) => ({
        windup: 0.6,
        target: "head" as const,
        lead: 0,
        error: { x: 0, y: 0 },
        flight: TRAINING_PACE[pace].flight,
        fake: 0,
      }),
      dodge: () => null,
      report: () => {},
      form: () => 0,
      reset: () => {},
    }),
  };
});
vi.mock("./scene", () => ({
  createPovScene: () => ({ render: h.render, dispose: vi.fn() }),
}));
vi.mock("./tracking", async (original) => {
  const actual = await original<typeof import("./tracking")>();
  return {
    ...actual,
    createPovTracker: (
      options: Parameters<typeof actual.createPovTracker>[0],
    ) =>
      h.realTracker
        ? actual.createPovTracker(options)
        : {
            sample: h.sample,
            present: h.present,
            // The screen draws from predict(); the same stub stands in for it.
            predict: h.present,
            poseAge: () => h.poseAge,
            reset: h.trackerReset,
            recenter: h.trackerRecenter,
            calibrate: vi.fn(),
            update: vi.fn(),
          },
  };
});
vi.mock("../camera/session", () => ({ cameraSession: { stop: vi.fn() } }));
vi.mock("../input/store", () => ({ inputStore: { resetToKeyboard: vi.fn() } }));
vi.mock("../camera/camera", () => ({
  CameraError: class CameraError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  startCamera: vi.fn(async () => ({})),
  stopCamera: vi.fn(),
}));
vi.mock("../camera/pose", () => ({
  createPoseSource: vi.fn(async () => ({
    onFrame: (cb: (frame: PoseFrame) => void) => {
      h.onBodyFrame = cb;
    },
    stop: vi.fn(),
    fps: () => 25,
    stats: () => ({ pipelineP95Ms: 20 }),
  })),
}));
vi.mock("./hands", () => ({
  createHandSource: vi.fn(async () => ({
    latest: () => null,
    stop: vi.fn(),
    stats: () => ({ fps: 0 }),
  })),
}));

import { POVScreen } from "./POVScreen";

let cleanup: Array<void | (() => void)> = [];
beforeEach(() => {
  vi.clearAllMocks();
  h.effects = [];
  h.frames = [];
  h.states = [];
  h.cameraMode = true;
  h.realTracker = false;
  h.realGate = false;
  h.poseAge = 0;
  h.running = h.live = false;
  h.hudOverride = {};
  h.onBodyFrame = null;
  h.result = {
    valid: true,
    calibrated: true,
    confidence: 0.95,
    units: "meters",
    head: { x: 0.2, y: 0, z: 0 },
    root: { x: 0.2, y: 0, z: 0 },
    headRelativeTorso: { x: 0, y: 0, z: 0 },
    leftHand: { x: -0.25, y: 0.35, z: 0.65 },
    rightHand: { x: 0.25, y: 0.35, z: 0.65 },
    outOfBounds: false,
    depthValid: true,
    reason: null,
  };
  h.sample.mockImplementation(() => h.result);
  h.present.mockImplementation(() => h.result);
  vi.spyOn(performance, "now").mockReturnValue(1000);
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    h.frames.push(cb);
    return h.frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup.forEach((fn) => fn?.());
  cleanup = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const tree = POVScreen({ onBack: vi.fn() });
  cleanup = h.effects.map((fn) => fn());
  return tree;
}
function textOf(element: unknown): string {
  if (typeof element === "string") return element;
  if (Array.isArray(element)) return element.map(textOf).join(" ");
  return element && typeof element === "object" && "props" in element
    ? textOf((element as ReactElement).props.children)
    : "";
}
function elements(element: unknown): ReactElement[] {
  if (Array.isArray(element)) return element.flatMap(elements);
  if (!element || typeof element !== "object" || !("props" in element))
    return [];
  const node = element as ReactElement;
  return [node, ...elements(node.props.children)];
}
function detectedBody(t: number, x = 0): PoseFrame {
  const lm = Array.from({ length: 33 }, () => ({
    x: 0.5 + x,
    y: 0.5,
    z: 0,
    v: 0.95,
  }));
  for (const [index, px, y] of [
    [LM.NOSE, 0.5, 0.2],
    [LM.L_SHOULDER, 0.6, 0.35],
    [LM.R_SHOULDER, 0.4, 0.35],
    [LM.L_HIP, 0.56, 0.65],
    [LM.R_HIP, 0.44, 0.65],
    [LM.L_WRIST, 0.65, 0.45],
    [LM.R_WRIST, 0.35, 0.45],
  ])
    lm[index] = { x: px + x, y, z: 0, v: 0.95 };
  return { t, lm, world: [], imageAspect: 2 / 3 };
}
describe("POV camera integration", () => {
  it("automatically equips the reply and throws from camera wrist motion without finger input or a screen action", async () => {
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    const nodes = elements(mount());
    const video = nodes.find(
      (node) => node.type === "video" && node.props["aria-hidden"] !== "true",
    )!;
    (video as ReactElement & { ref: { current: unknown } }).ref.current = {
      srcObject: null,
    };
    nodes
      .find(
        (node) => node.type === "button" && textOf(node) === "Restart camera",
      )!
      .props.onClick();
    await vi.waitFor(() => expect(h.onBodyFrame).not.toBeNull());
    let sawEquipped = false;
    for (let i = 1; i <= 234; i++) {
      const seconds = i / 60,
        now = 1000 + seconds * 1000;
      const z =
        seconds < 3.5
          ? 0.65
          : seconds < 3.65
            ? 0.25
            : Math.min(0.8, 0.25 + (seconds - 3.65) * 3);
      h.result!.rightHand.z = z;
      vi.mocked(performance.now).mockReturnValue(now);
      h.onBodyFrame!(detectedBody(now));
      h.frames.shift()!(now);
      const call = h.render.mock.calls.at(-1)!;
      if (
        call[0].rally?.turn === 0 &&
        call[0].rally.phase === "ready" &&
        call[2]
      )
        sawEquipped = true;
    }
    const state = h.render.mock.calls.at(-1)![0];
    expect(sawEquipped).toBe(true);
    expect(state.nextId).toBe(3);
    expect(state.rally).toMatchObject({ turn: 0, phase: "flight" });
    expect(state.balls[0].owner).toBe(0);
    expect(h.hud.mock.calls.at(-1)![0].handTracked).toBe(false);
  });
  it("locks sensitivity during a rally and makes it available between rounds", () => {
    h.running = true;
    let slider = elements(mount()).find(
      (node) => node.props["aria-label"] === "Dodge sensitivity",
    )!;
    expect(slider.props.disabled).toBe(true);
    cleanup.forEach((fn) => fn?.());
    cleanup = [];
    h.effects = [];
    h.states = [];
    h.hudOverride = { hp: [0, 5] };
    slider = elements(mount()).find(
      (node) => node.props["aria-label"] === "Dodge sensitivity",
    )!;
    expect(slider.props.disabled).toBe(false);
  });
  it("applies compact motion to collision physics as well as the player's view", () => {
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    mount();
    for (let i = 1; i <= 216; i++) {
      const seconds = i / 60;
      h.result!.root.x = h.result!.head.x =
        0.2 * Math.max(0, Math.min(1, (seconds - 2.42) / 0.16));
      const now = 1000 + seconds * 1000;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
    }
    const state = h.render.mock.calls.at(-1)![0];
    expect(state.nextId).toBe(2);
    expect(state.poses[0].head.x).toBeCloseTo(0.36);
    expect(state.hp).toEqual([5, 5]);
    expect(state.misses).toBe(1);
  });
  it("draws a flying ball at an even speed when frame times are uneven", () => {
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    mount();
    let now = 1000;
    const flight: { t: number; z: number }[] = [];
    for (let i = 0; i < 260; i++) {
      // A 60 Hz display never delivers perfectly even frames.
      now += i % 2 ? 17.3 : 16;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
      const ball = h.render.mock.calls.at(-1)![0].balls[0];
      if (ball?.owner === 1) flight.push({ t: now, z: ball.position.z });
    }
    expect(flight.length).toBeGreaterThan(20);
    const speeds = flight
      .slice(1)
      .map((f, i) => (f.z - flight[i].z) / (f.t - flight[i].t));
    // Whole physics steps alone change speed by 8% from frame to frame here.
    expect(
      Math.max(...speeds.slice(1).map((v, i) => Math.abs(v / speeds[i] - 1))),
    ).toBeLessThan(0.02);
  });
  it("draws a ball coming at the player one pose-age ahead, and their own throw where it is", () => {
    const incomingAt = (poseAge: number, frames: number) => {
      cleanup.forEach((fn) => fn?.());
      cleanup = [];
      h.effects = [];
      h.frames = [];
      h.states = [];
      h.render.mockClear();
      h.poseAge = poseAge;
      h.live = h.running = true;
      h.result!.root.x = h.result!.head.x = 0;
      // Both runs must start their clocks at the same instant.
      vi.mocked(performance.now).mockReturnValue(1000);
      mount();
      for (let i = 1; i <= frames; i++) {
        const now = 1000 + (i * 1000) / 60;
        vi.mocked(performance.now).mockReturnValue(now);
        h.frames.shift()!(now);
      }
      return h.render.mock.calls
        .at(-1)![0]
        .balls.find((ball: { owner: number }) => ball.owner === 1);
    };
    // 2.75 s in: the bot's first ball has been flying for more than the 150 ms
    // over which the lead eases in.
    const plain = incomingAt(0, 165),
      led = incomingAt(110, 165);
    expect(plain.age).toBeGreaterThan(0.2);
    expect(plain).toBeDefined();
    expect(led).toBeDefined();
    // Seat 0 looks down -z, so a ball coming at them has growing z.
    const ahead = led.position.z - plain.position.z;
    const speed = Math.abs(plain.velocity.z);
    expect(ahead).toBeGreaterThan(speed * 0.09);
    expect(ahead).toBeLessThan(speed * 0.125);
  });
  it("answers a hit on the player with a camera jolt and a short hold of the simulation", () => {
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    mount();
    let now = 1000;
    const frame = () => {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
      return h.render.mock.calls.at(-1)!;
    };
    // Stand still: the bot's first ball lands.
    let call = frame();
    for (let i = 0; i < 400 && call[0].hp[0] === 5; i++) call = frame();
    expect(call[0].hp[0]).toBe(4);
    expect(call[5].kick.back).toBeGreaterThan(0.05);
    const hitTime = call[0].time,
      hitAt = now;
    // The simulation holds for about 90 ms while the jolt decays.
    while (now - hitAt < 80) call = frame();
    expect(call[0].time).toBe(hitTime);
    expect(call[5].kick.back).toBeLessThan(0.05);
    while (now - hitAt < 200) call = frame();
    expect(call[0].time).toBeGreaterThan(hitTime);
    while (now - hitAt < 700) call = frame();
    expect(call[5].kick).toEqual({ back: 0, roll: 0 });
  });
  it("holds the round clock until the player has stood in place through the count", () => {
    h.realGate = true;
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0.5;
    mount();
    let now = 1000;
    const frame = () => {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
      return h.render.mock.calls.at(-1)![0];
    };
    // Off to the side: tracked, but not in place. Nothing starts.
    for (let i = 0; i < 180; i++) frame();
    expect(frame().time).toBe(0);
    expect(h.hud.mock.calls.at(-1)![0].gate).toContain("middle");
    // In the middle: 0.6 s to settle, then 3-2-1.
    h.result!.root.x = h.result!.head.x = 0;
    const counts: number[] = [];
    for (let i = 0; i < 140; i++) {
      expect(frame().time).toBe(0);
      const count = h.hud.mock.calls.at(-1)![0].countdown;
      if (count !== null && counts.at(-1) !== count) counts.push(count);
    }
    expect(counts).toEqual([3, 2, 1]);
    for (let i = 0; i < 30; i++) frame();
    expect(frame().time).toBeGreaterThan(0);
    expect(h.hud.mock.calls.at(-1)![0].countdown).toBeNull();
  });
  it("starts a round from a hand held above the head, without a tap", async () => {
    h.live = true;
    const nodes = elements(mount());
    const video = nodes.find(
      (node) => node.type === "video" && node.props["aria-hidden"] !== "true",
    )!;
    (video as ReactElement & { ref: { current: unknown } }).ref.current = {
      srcObject: null,
    };
    nodes
      .find(
        (node) => node.type === "button" && textOf(node) === "Restart camera",
      )!
      .props.onClick();
    await vi.waitFor(() => expect(h.onBodyFrame).not.toBeNull());
    let now = 1000;
    const frame = (wristY: number) => {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      const body = detectedBody(now);
      body.lm[LM.R_WRIST] = { x: 0.35, y: wristY, z: 0, v: 0.95 };
      h.onBodyFrame!(body);
      h.frames.shift()!(now);
    };
    // Hand at chest height for a second: nothing.
    for (let i = 0; i < 60; i++) frame(0.45);
    expect(h.setRunning).not.toHaveBeenCalledWith(true);
    // Hand above the head for a second: the round is asked for.
    for (let i = 0; i < 60; i++) frame(0.1);
    expect(h.setRunning).toHaveBeenCalledWith(true);
  });
  it("takes the centre again, on the spot, when the player stands still out of place before a round", async () => {
    h.live = true;
    const nodes = elements(mount());
    const video = nodes.find(
      (node) => node.type === "video" && node.props["aria-hidden"] !== "true",
    )!;
    (video as ReactElement & { ref: { current: unknown } }).ref.current = {
      srcObject: null,
    };
    nodes
      .find(
        (node) => node.type === "button" && textOf(node) === "Restart camera",
      )!
      .props.onClick();
    await vi.waitFor(() => expect(h.onBodyFrame).not.toBeNull());
    h.trackerReset.mockClear();
    h.trackerRecenter.mockClear();
    let now = 1000;
    const frame = (shift = 0, wristY = 0.45) => {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      const body = detectedBody(now, shift);
      body.lm[LM.R_WRIST] = { ...body.lm[LM.R_WRIST], y: wristY };
      h.onBodyFrame!(body);
      h.frames.shift()!(now);
    };
    // In place: nothing to correct, however long they stand.
    h.result!.root.x = h.result!.head.x = 0;
    for (let i = 0; i < 120; i++) frame();
    expect(h.trackerRecenter).not.toHaveBeenCalled();
    // Out of place but still walking: wait.
    h.result!.root.x = h.result!.head.x = 0.5;
    for (let i = 0; i < 120; i++) frame(i * 0.002);
    expect(h.trackerRecenter).not.toHaveBeenCalled();
    // Standing still but with a hand up (asking to start): not now.
    for (let i = 0; i < 100; i++) frame(0.24, 0.1);
    expect(h.trackerRecenter).not.toHaveBeenCalled();
    // Out of place, arms down, still for more than 1.2 s: the centre moves to them.
    for (let i = 0; i < 80; i++) frame(0.24);
    expect(h.trackerRecenter).toHaveBeenCalledTimes(1);
    // It never sends the player back through setup.
    expect(h.trackerReset).not.toHaveBeenCalled();
  });
  it("takes the centre again when the body is in the middle but outside the court in depth", async () => {
    h.live = true;
    const nodes = elements(mount());
    const video = nodes.find(
      (node) => node.type === "video" && node.props["aria-hidden"] !== "true",
    )!;
    (video as ReactElement & { ref: { current: unknown } }).ref.current = {
      srcObject: null,
    };
    nodes
      .find(
        (node) => node.type === "button" && textOf(node) === "Restart camera",
      )!
      .props.onClick();
    await vi.waitFor(() => expect(h.onBodyFrame).not.toBeNull());
    h.trackerRecenter.mockClear();
    h.result!.root.x = h.result!.head.x = 0;
    h.result!.outOfBounds = true;
    let now = 1000;
    for (let i = 0; i < 90; i++) {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      h.onBodyFrame!(detectedBody(now));
      h.frames.shift()!(now);
    }
    expect(h.trackerRecenter).toHaveBeenCalledTimes(1);
  });
  it("lets a round start from the edge of the picture or with depth out of range", () => {
    h.realGate = true;
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    h.result!.outOfBounds = true;
    mount();
    let now = 1000;
    let state = h.render.mock.calls.at(-1)?.[0];
    for (let i = 0; i < 220; i++) {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
      state = h.render.mock.calls.at(-1)![0];
    }
    expect(state.time).toBeGreaterThan(0);
  });
  it("passes the ball to the opponent when the player holds it past the shot clock", () => {
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    // Hand down: the player never throws.
    h.result!.rightHand = { x: 0.25, y: 0, z: 0.1 };
    mount();
    let now = 1000;
    const frame = () => {
      now += 1000 / 60;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
      return h.render.mock.calls.at(-1)![0];
    };
    // The bot's first ball lands; the ball is now the player's.
    let state = frame();
    for (let i = 0; i < 400 && state.rally.turn !== 0; i++) state = frame();
    expect(state.rally).toMatchObject({ turn: 0, phase: "ready" });
    const got = state.time;
    // Nine seconds in: still theirs, and the stage is counting down.
    while (state.time - got < 8.5) state = frame();
    expect(state.rally.turn).toBe(0);
    expect(h.hud.mock.calls.at(-1)![0].banner).toMatchObject({
      text: "THROW NOW",
    });
    // Past ten seconds at practice pace: it goes to the opponent.
    while (state.time - got < 10.8 && state.rally.turn === 0) state = frame();
    expect(state.rally.turn).toBe(1);
    expect(state.hp).toEqual([4, 5]);
  });
  it("does not simulate a long hitch as one leap", () => {
    h.live = h.running = true;
    h.result!.root.x = h.result!.head.x = 0;
    mount();
    let now = 1000;
    const frame = (ms: number) => {
      now += ms;
      vi.mocked(performance.now).mockReturnValue(now);
      h.frames.shift()!(now);
      return h.render.mock.calls.at(-1)![0];
    };
    for (let i = 0; i < 60; i++) frame(16.7);
    const before = frame(16.7).time;
    // 200 ms is under the 250 ms "view paused" limit, so the round keeps running.
    expect(frame(200).time - before).toBeLessThan(0.04);
  });
  it("keeps the ball and match moving at the bounded edge of the play area", () => {
    h.live = h.running = true;
    h.result!.outOfBounds = true;
    h.result!.root.x = 0.6;
    h.result!.head.x = 0.85;
    mount();
    vi.mocked(performance.now).mockReturnValue(1016);
    h.frames.shift()!(1016);
    expect(h.render.mock.calls.at(-1)![0].time).toBeGreaterThan(0);
    expect(h.hud.mock.calls.at(-1)![0].gate).toContain("edge");
  });
  it("explains which body parts block setup and why the opponent is waiting", async () => {
    h.live = h.realTracker = true;
    const nodes = elements(mount());
    const video = nodes.find(
      (node) => node.type === "video" && node.props["aria-hidden"] !== "true",
    )!;
    (video as ReactElement & { ref: { current: unknown } }).ref.current = {
      srcObject: null,
    };
    nodes
      .find(
        (node) => node.type === "button" && textOf(node) === "Restart camera",
      )!
      .props.onClick();
    await vi.waitFor(() => expect(h.onBodyFrame).not.toBeNull());
    const f = detectedBody(1000);
    f.lm[LM.L_HIP].y = 1.2;
    f.lm[LM.R_HIP].v = 0.1;
    h.onBodyFrame!(f);
    vi.mocked(performance.now).mockReturnValue(1016);
    h.frames.shift()!(1016);
    expect(h.hud.mock.calls.at(-1)![0]).toMatchObject({
      bodySeen: true,
      bodyComplete: false,
      calibrated: false,
      opponentStatus: "Waiting for camera setup",
      gate: expect.stringContaining("clear view of your hips"),
    });
    expect(h.render.mock.calls.at(-1)![0].balls).toHaveLength(0);
  });
  it("launches the opponent ball after 2.2 seconds of active camera play without finger tracking", () => {
    h.live = h.running = true;
    mount();
    for (let i = 1; i <= 140; i++) {
      const t = 1000 + i * (1000 / 60);
      vi.mocked(performance.now).mockReturnValue(t);
      h.frames.shift()!(t);
    }
    const state = h.render.mock.calls.at(-1)![0];
    expect(state.time).toBeGreaterThan(2.2);
    expect(
      state.balls.some((ball: { owner: number }) => ball.owner === 1),
    ).toBe(true);
    expect(h.hud.mock.calls.at(-1)![0].opponentStatus).toBe("Ball incoming");
  });
  it("does not spend the bot countdown while body tracking is paused", () => {
    h.live = h.running = true;
    h.result!.valid = false;
    mount();
    for (let i = 1; i <= 180; i++) {
      const t = 1000 + i * (1000 / 60);
      vi.mocked(performance.now).mockReturnValue(t);
      h.frames.shift()!(t);
    }
    let state = h.render.mock.calls.at(-1)![0];
    expect(state.time).toBe(0);
    expect(state.balls).toHaveLength(0);
    expect(h.hud.mock.calls.at(-1)![0].opponentStatus).toBe(
      "Paused until tracking returns",
    );
    h.result!.valid = true;
    for (let i = 181; i <= 320; i++) {
      const t = 1000 + i * (1000 / 60);
      vi.mocked(performance.now).mockReturnValue(t);
      h.frames.shift()!(t);
    }
    state = h.render.mock.calls.at(-1)![0];
    expect(
      state.balls.some((ball: { owner: number }) => ball.owner === 1),
    ).toBe(true);
  });
  it("waits on lost body input after Start and begins when observed body tracking recovers", () => {
    h.live = h.running = true;
    h.result!.valid = false;
    mount();
    vi.mocked(performance.now).mockReturnValue(1016);
    h.frames.shift()!(1016);
    expect(h.render.mock.calls.at(-1)![0].time).toBe(0);
    h.result!.valid = true;
    vi.mocked(performance.now).mockReturnValue(1050);
    h.frames.shift()!(1050);
    expect(h.render.mock.calls.at(-1)![0].time).toBeGreaterThan(0);
  });
  it("accepts Start after calibration even during a temporary body dropout, and waits before advancing", () => {
    h.live = true;
    h.hudOverride = {
      calibrated: true,
      bodyTracked: false,
      handTracked: false,
    };
    h.result!.valid = false;
    const tree = mount();
    const start = elements(tree).find(
      (node) => node.type === "button" && textOf(node) === "Start round",
    );
    expect(start).toBeDefined();
    expect(start!.props.disabled).toBeFalsy();
    start!.props.onClick();
    expect(h.setRunning).toHaveBeenCalledWith(true);
    vi.mocked(performance.now).mockReturnValue(1016);
    h.frames.shift()!(1016);
    expect(h.render.mock.calls.at(-1)![0].time).toBe(0);
  });
  it("allows Start with calibrated body tracking even without finger detection", () => {
    h.live = true;
    h.hudOverride = { calibrated: true, bodyTracked: true, handTracked: false };
    const tree = mount();
    const start = elements(tree).find(
      (node) => node.type === "button" && textOf(node) === "Start round",
    );
    expect(start).toBeDefined();
    expect(start!.props.disabled).toBeFalsy();
    start!.props.onClick();
    expect(h.setRunning).toHaveBeenCalledWith(true);
  });
  it("advances a started round with body tracking while missing fingers only disable throwing", () => {
    h.live = h.running = true;
    mount();
    vi.mocked(performance.now).mockReturnValue(1016);
    h.frames.shift()!(1016);
    expect(h.render.mock.calls.at(-1)![0].time).toBeGreaterThan(0);
    expect(h.hud.mock.calls.at(-1)![0].canThrow).toBe(false);
  });
  it("calibrates from camera callbacks and renders movement without any measurement or calibration click", async () => {
    h.realTracker = true;
    const tree = mount();
    expect(textOf(tree)).toContain("Setup is automatic");
    expect(textOf(tree)).not.toContain("Calibrate my space");
    expect(textOf(tree)).not.toContain("Shoulder width");
    expect(textOf(tree)).not.toContain("Camera distance");
    const nodes = elements(tree);
    const video = nodes.find(
      (node) => node.type === "video" && node.props["aria-hidden"] !== "true",
    )!;
    (video as ReactElement & { ref: { current: unknown } }).ref.current = {
      srcObject: null,
    };
    nodes
      .find(
        (node) => node.type === "button" && textOf(node) === "Enable camera",
      )!
      .props.onClick();
    await vi.waitFor(() => expect(h.onBodyFrame).not.toBeNull());
    for (let i = 0; i <= 9; i++) {
      const t = 100 + i * 40;
      vi.mocked(performance.now).mockReturnValue(t);
      h.onBodyFrame!(detectedBody(t));
    }
    h.frames.shift()!(460);
    expect(h.hud.mock.calls.at(-1)![0]).toMatchObject({
      calibrated: false,
      calibrating: true,
    });
    expect(h.hud.mock.calls.at(-1)![0].calibrationProgress).toBeGreaterThan(
      0.4,
    );
    for (let i = 10; i <= 18; i++) {
      const t = 100 + i * 40;
      vi.mocked(performance.now).mockReturnValue(t);
      h.onBodyFrame!(detectedBody(t));
    }
    vi.mocked(performance.now).mockReturnValue(860);
    h.onBodyFrame!(detectedBody(860, -0.05));
    h.frames.shift()!(860);
    expect(h.hud.mock.calls.at(-1)![0]).toMatchObject({
      calibrated: true,
      bodyTracked: true,
      handTracked: false,
    });
    expect(h.render.mock.calls.at(-1)![0].poses[0].head.x).toBeGreaterThan(
      0.05,
    );
    expect(h.render.mock.calls.at(-1)![0].time).toBe(0);
  });
  it("shows real body movement even when the detailed hand detector is missing", () => {
    mount();
    h.frames.shift()!(1000);
    const state = h.render.mock.calls.at(-1)![0];
    expect(state.poses[0].head.x).toBeCloseTo(0.36);
    expect(state.poses[0].root.x).toBeCloseTo(0.36);
    expect(state.time).toBe(0); // Readiness still protects the match.
    expect(h.hud.mock.calls.at(-1)![0].canThrow).toBe(false);
  });
  it("never substitutes a detected pose when the body result is invalid", () => {
    h.result!.valid = false;
    h.result!.reason = "stale";
    mount();
    h.frames.shift()!(1000);
    expect(h.render.mock.calls.at(-1)![0].poses[0].head.x).toBe(0);
  });
  it("samples with the current clock, not an animation timestamp preceding detector completion", () => {
    mount();
    h.frames.shift()!(984);
    expect(h.sample).toHaveBeenLastCalledWith(1000);
    expect(h.present).toHaveBeenLastCalledWith(1000);
  });
  it("opens camera setup and provides a camera action before a match can start", () => {
    h.cameraMode = false;
    const tree = mount();
    expect(h.states[0]).toBe("camera");
    expect(textOf(tree)).toContain("Enable camera");
    expect(textOf(tree)).not.toContain("Start round");
  });
});
