/**
 * Keeps the screen on while the camera is in use. The player stands across
 * the room and does not touch the device, so after a minute or two a phone or
 * laptop dims or locks, the camera stops, and the game appears to have died.
 *
 * A wake lock is dropped by the browser whenever the page is hidden, so it is
 * asked for again each time the page comes back. Where the browser has no
 * wake lock, this does nothing.
 */
type Sentinel = {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
};
type Nav = { wakeLock?: { request(type: "screen"): Promise<Sentinel> } };
type Doc = {
  visibilityState?: string;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
};

export function createWakeLock(
  nav: Nav | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as unknown as Nav),
  doc: Doc | undefined = typeof document === "undefined"
    ? undefined
    : (document as unknown as Doc),
) {
  let wanted = false;
  let sentinel: Sentinel | null = null;
  let asking = false;
  const request = async () => {
    if (!wanted || sentinel || asking || !nav?.wakeLock) return;
    if (doc?.visibilityState !== undefined && doc.visibilityState !== "visible")
      return;
    asking = true;
    try {
      const held = await nav.wakeLock.request("screen");
      if (!wanted) {
        void held.release().catch(() => {});
        return;
      }
      sentinel = held;
      held.addEventListener?.("release", () => {
        if (sentinel === held) sentinel = null;
      });
    } catch {
      // Refused (low battery, no permission): play goes on without it.
    } finally {
      asking = false;
    }
  };
  const onVisibility = () => void request();
  return {
    acquire() {
      if (wanted) return;
      wanted = true;
      doc?.addEventListener?.("visibilitychange", onVisibility);
      void request();
    },
    release() {
      wanted = false;
      doc?.removeEventListener?.("visibilitychange", onVisibility);
      const held = sentinel;
      sentinel = null;
      void held?.release().catch(() => {});
    },
    /** Whether the lock is currently held. */
    held: () => sentinel !== null,
  };
}
