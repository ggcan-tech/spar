import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandSource, type HandResponse } from "./hands";
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
const makeVideo = () =>
  ({
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 1,
  }) as HTMLVideoElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
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
async function boot(video = makeVideo(), signal?: AbortSignal) {
  const pending = createHandSource(video, { signal });
  const worker = FakeWorker.instances.at(-1)!;
  worker.emit({ type: "ready" });
  return { source: await pending, worker, video };
}
describe("optional hand source", () => {
  it("captures the next fresh frame once its rate limit allows, without waiting on a missed polling interval", async () => {
    const { source, worker, video } = await boot();
    await vi.advanceTimersByTimeAsync(17);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    video.currentTime = 2;
    worker.emit({
      type: "result",
      id: 1,
      inferenceMs: 17,
      frame: { t: 16, hands: [] },
    });
    // Fingers are a visual extra, capped at about 20 a second so the body
    // model keeps the device: nothing new until 45 ms after the last start.
    await vi.advanceTimersByTimeAsync(1);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    // The loop polls every 16 ms, so the next start is on the first poll past the limit.
    await vi.advanceTimersByTimeAsync(50);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    source.stop();
  });
  it("rests while it is not needed and resumes when asked", async () => {
    const { source, worker, video } = await boot();
    await vi.advanceTimersByTimeAsync(17);
    worker.emit({
      type: "result",
      id: 1,
      inferenceMs: 17,
      frame: { t: 16, hands: [] },
    });
    source.setActive!(false);
    video.currentTime = 2;
    await vi.advanceTimersByTimeAsync(300);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    source.setActive!(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    source.stop();
  });
  it("never queues captures while a worker result is outstanding; expires stale hands", async () => {
    const { source, worker, video } = await boot();
    await vi.advanceTimersByTimeAsync(33);
    video.currentTime = 2;
    await vi.advanceTimersByTimeAsync(99);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    worker.emit({
      type: "result",
      id: 1,
      inferenceMs: 8,
      frame: { t: 33, hands: [] },
    });
    expect(source.latest()).toEqual({ t: 33, hands: [] });
    await vi.advanceTimersByTimeAsync(102);
    expect(source.latest()).toBeNull();
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes late capture bitmaps after abort and never posts them", async () => {
    let resolve!: (bitmap: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockReturnValueOnce(
      new Promise<ImageBitmap>((yes) => {
        resolve = yes;
      }),
    );
    const controller = new AbortController();
    const { source, worker } = await boot(makeVideo(), controller.signal);
    await vi.advanceTimersByTimeAsync(33);
    controller.abort();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    resolve(bitmap);
    await flush();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(source.stats().execution).toBe("unavailable");
    source.stop();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds initialization and frame stalls", async () => {
    const pending = createHandSource(makeVideo());
    const rejected = expect(pending).rejects.toThrow(
      "initialization timed out",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const { source, worker } = await boot();
    await vi.advanceTimersByTimeAsync(10_016);
    expect(source.latest()).toBeNull();
    expect(source.stats().execution).toBe("unavailable");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects abort during initialization and unsupported workers without starting a camera", async () => {
    const controller = new AbortController();
    const pending = createHandSource(makeVideo(), {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("Worker", undefined);
    await expect(createHandSource(makeVideo())).rejects.toThrow("unavailable");
  });
  it("ignores out-of-order results and stops after a worker failure", async () => {
    const { source, worker } = await boot();
    await vi.advanceTimersByTimeAsync(33);
    worker.emit({
      type: "result",
      id: 999,
      inferenceMs: 1,
      frame: { t: 33, hands: [] },
    });
    expect(source.latest()).toBeNull();
    worker.emit({ type: "error", message: "inference failed" });
    expect(source.stats().execution).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
