import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromCrop, handCrop } from "./handCrop";
import { createHandSource, type HandResponse } from "./hands";
import { syntheticFrame } from "./syntheticBody";

const W = 1280,
  H = 720;
describe("where to look for a hand", () => {
  it("cuts a square around the raised hand, many times larger than the hand was in the whole picture", () => {
    const frame = syntheticFrame(0, { rightHand: { x: 0.2, y: 0.35, z: 0.1 } });
    const focus = handCrop(frame.lm, "Right", W, H)!;
    expect(focus.side).toBe("Right");
    const wrist = { x: frame.lm[16].x * W, y: frame.lm[16].y * H },
      knuckle = { x: frame.lm[20].x * W, y: frame.lm[20].y * H };
    for (const p of [wrist, knuckle]) {
      expect(p.x).toBeGreaterThan(focus.sx);
      expect(p.x).toBeLessThan(focus.sx + focus.size);
      expect(p.y).toBeGreaterThan(focus.sy);
      expect(p.y).toBeLessThan(focus.sy + focus.size);
    }
    // At 2.6 m the hand is about 50 px of 720; the square is under a third of
    // the picture's height, so the hand fills three times as much of what the
    // finger model sees.
    expect(focus.size).toBeGreaterThanOrEqual(96);
    expect(focus.size).toBeLessThan(H / 3);
    // Inside the picture.
    expect(focus.sx).toBeGreaterThanOrEqual(0);
    expect(focus.sy).toBeGreaterThanOrEqual(0);
    expect(focus.sx + focus.size).toBeLessThanOrEqual(W);
    expect(focus.sy + focus.size).toBeLessThanOrEqual(H);
  });
  it("still finds the hand when the forearm points at the camera", () => {
    // A throw: the forearm shortens to almost nothing in the picture.
    const frame = syntheticFrame(0, { rightHand: { x: 0.02, y: 0.02, z: 0.5 } });
    const focus = handCrop(frame.lm, "Right", W, H)!;
    expect(focus.size).toBeGreaterThan(110);
  });
  it("gives nothing for a wrist that is not seen, and stays in a small picture", () => {
    const frame = syntheticFrame(0);
    frame.lm[15] = { ...frame.lm[15], v: 0.1 };
    expect(handCrop(frame.lm, "Left", W, H)).toBeNull();
    expect(handCrop(frame.lm, "Right", 0, 0)).toBeNull();
    const tiny = handCrop(frame.lm, "Right", 160, 120)!;
    expect(tiny.size).toBeLessThanOrEqual(120);
    expect(tiny.sx + tiny.size).toBeLessThanOrEqual(160);
  });
  it("puts a point found in the square back where it is in the whole picture", () => {
    const focus = { side: "Right" as const, sx: 400, sy: 100, size: 200 };
    expect(fromCrop({ x: 0.5, y: 0.5, z: 0.1 }, focus, W, H)).toEqual({
      x: 500 / W,
      y: 200 / H,
      z: (0.1 * 200) / W,
    });
  });
});

describe("the finger model looking at one hand at a time", () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((message: { data: HandResponse }) => void) | null = null;
    onerror: ((event: { preventDefault(): void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      FakeWorker.instances.push(this);
    }
    emit(data: HandResponse) {
      this.onmessage?.({ data });
    }
  }
  const hand = (confidence = 0.9) => ({
    // The model's own name for it, which the game does not rely on.
    side: "Left" as const,
    landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })),
    world: Array.from({ length: 21 }, (_, i) => ({ x: i / 100, y: 0, z: 0 })),
    confidence,
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close: vi.fn() })),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cuts the picture, names the hand by where it looked, and keeps the other hand for a moment", async () => {
    const video = {
      readyState: 4,
      videoWidth: W,
      videoHeight: H,
      currentTime: 1,
    } as HTMLVideoElement;
    const pending = createHandSource(video);
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit({ type: "ready" });
    const source = await pending;
    const right = { side: "Right" as const, sx: 400, sy: 100, size: 200 };
    source.setFocus!(right);
    await vi.advanceTimersByTimeAsync(17);
    expect(createImageBitmap).toHaveBeenLastCalledWith(video, 400, 100, 200, 200);
    worker.emit({
      type: "result",
      id: 1,
      inferenceMs: 9,
      frame: { t: performance.now() - 5, hands: [hand(0.4), hand(0.9)] },
    });
    let frame = source.latest()!;
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0].side).toBe("Right");
    expect(frame.hands[0].confidence).toBe(0.9);
    expect(frame.hands[0].landmarks[0]).toEqual({
      x: 500 / W,
      y: 200 / H,
      z: 0,
    });
    // Now the left hand: the right one, 60 ms old, is still there.
    source.setFocus!({ side: "Left", sx: 700, sy: 100, size: 200 });
    video.currentTime = 2;
    await vi.advanceTimersByTimeAsync(60);
    expect(createImageBitmap).toHaveBeenLastCalledWith(video, 700, 100, 200, 200);
    worker.emit({
      type: "result",
      id: 2,
      inferenceMs: 9,
      frame: { t: performance.now() - 5, hands: [hand()] },
    });
    frame = source.latest()!;
    expect(frame.hands.map((h) => h.side).sort()).toEqual(["Left", "Right"]);
    // Nothing in the square where the left hand was: it goes, the right stays.
    video.currentTime = 3;
    await vi.advanceTimersByTimeAsync(60);
    worker.emit({
      type: "result",
      id: 3,
      inferenceMs: 9,
      frame: { t: performance.now() - 5, hands: [] },
    });
    expect(source.latest()!.hands.map((h) => h.side)).toEqual(["Right"]);
    // Back to the whole picture: the model's own answer, as before.
    source.setFocus!(null);
    video.currentTime = 4;
    await vi.advanceTimersByTimeAsync(60);
    expect(createImageBitmap).toHaveBeenLastCalledWith(video);
    worker.emit({
      type: "result",
      id: 4,
      inferenceMs: 9,
      frame: { t: performance.now() - 5, hands: [hand()] },
    });
    expect(source.latest()!.hands.map((h) => h.side)).toEqual(["Left"]);
    source.stop();
  });
});
