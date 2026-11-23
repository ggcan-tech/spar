import { describe, expect, it, vi } from "vitest";
import { createWakeLock } from "./wakeLock";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fakes() {
  const listeners = new Set<() => void>();
  const released: Array<() => void> = [];
  const sentinels: { release: ReturnType<typeof vi.fn> }[] = [];
  const doc = {
    visibilityState: "visible",
    addEventListener: (_type: string, listener: () => void) =>
      void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      void listeners.delete(listener),
  };
  const nav = {
    wakeLock: {
      request: vi.fn(async () => {
        const sentinel = {
          release: vi.fn(async () => {}),
          addEventListener: (_type: "release", listener: () => void) =>
            void released.push(listener),
        };
        sentinels.push(sentinel);
        return sentinel;
      }),
    },
  };
  const visible = (state: string) => {
    doc.visibilityState = state;
    for (const listener of listeners) listener();
  };
  return { doc, nav, visible, released, sentinels, listeners };
}

describe("keeping the screen awake during camera play", () => {
  it("takes the lock when asked and gives it back when done", async () => {
    const { doc, nav, sentinels, listeners } = fakes();
    const lock = createWakeLock(nav, doc);
    lock.acquire();
    await flush();
    expect(nav.wakeLock.request).toHaveBeenCalledWith("screen");
    expect(lock.held()).toBe(true);
    lock.release();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(lock.held()).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("asks again when the page comes back after the browser dropped the lock", async () => {
    const { doc, nav, visible, released } = fakes();
    const lock = createWakeLock(nav, doc);
    lock.acquire();
    await flush();
    // The page is hidden: the browser releases the lock itself.
    visible("hidden");
    released[0]();
    expect(lock.held()).toBe(false);
    await flush();
    expect(nav.wakeLock.request).toHaveBeenCalledTimes(1);
    visible("visible");
    await flush();
    expect(nav.wakeLock.request).toHaveBeenCalledTimes(2);
    expect(lock.held()).toBe(true);
  });

  it("does nothing where the browser has no wake lock, or refuses it", async () => {
    const none = createWakeLock({}, { visibilityState: "visible" });
    none.acquire();
    await flush();
    expect(none.held()).toBe(false);
    none.release();
    const refusing = createWakeLock(
      { wakeLock: { request: async () => Promise.reject(new Error("no")) } },
      { visibilityState: "visible" },
    );
    refusing.acquire();
    await flush();
    expect(refusing.held()).toBe(false);
  });

  it("gives back a lock that arrives after it is no longer wanted", async () => {
    const { doc, nav, sentinels } = fakes();
    const lock = createWakeLock(nav, doc);
    lock.acquire();
    lock.release();
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(lock.held()).toBe(false);
  });
});
