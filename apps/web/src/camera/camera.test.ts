import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCamera } from './camera';

const video = (ready = true) => Object.assign(new EventTarget(), {
  readyState: ready ? 1 : 0, videoWidth: ready ? 1280 : 0, srcObject: null,
  muted: false, autoplay: false, playsInline: false, play: vi.fn(async () => {}),
}) as unknown as HTMLVideoElement;
const stream = () => {
  const stop = vi.fn();
  return { stop, value: { getTracks: () => [{ stop }] } as unknown as MediaStream };
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('camera cancellation', () => {
  it('releases a permission grant that arrives after cancellation, without attaching it', async () => {
    let grant!: (stream: MediaStream) => void;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }) } });
    const control = new AbortController();
    const v = video();
    const s = stream();
    const opening = startCamera(v, { signal: control.signal });
    control.abort();
    grant(s.value);
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.stop).toHaveBeenCalledTimes(1);
    expect(v.srcObject).toBeNull();
    expect(v.play).not.toHaveBeenCalled();
  });

  it('cancels waiting for video metadata and releases the stream', async () => {
    const s = stream();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => s.value } });
    const control = new AbortController();
    const v = video(false);
    const opening = startCamera(v, { signal: control.signal });
    await Promise.resolve();
    expect(v.srcObject).toBe(s.value);
    control.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.stop).toHaveBeenCalledTimes(1);
    expect(v.srcObject).toBeNull();
  });

  it('times out a camera that grants permission but never delivers metadata', async () => {
    vi.useFakeTimers();
    const s = stream();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => s.value } });
    const opening = startCamera(video(false));
    const rejected = expect(opening).rejects.toThrow(/did not deliver video/);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(s.stop).toHaveBeenCalledTimes(1);
  });

  it('returns a live stream when metadata and playback are ready', async () => {
    const s = stream();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => s.value } });
    const v = video();
    expect(await startCamera(v)).toBe(s.value);
    expect(v.play).toHaveBeenCalledTimes(1);
    expect(s.stop).not.toHaveBeenCalled();
  });
  it('asks for a high frame rate before resolution, and steps down when the camera cannot do it', async () => {
    const s = stream();
    const requests: unknown[] = [];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          requests.push(constraints.video);
          // This camera cannot do 50 frames a second at any size.
          const video = constraints.video as MediaTrackConstraints | true;
          if (video !== true && (video.frameRate as ConstrainDoubleRange)?.min) {
            const error = new Error('too strict'); error.name = 'OverconstrainedError'; throw error;
          }
          return s.value;
        },
      },
    });
    expect(await startCamera(video(), { preferFrameRate: true, frameRate: 60 })).toBe(s.value);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ frameRate: { min: 50 }, width: { ideal: 960 } });
    expect(requests[1]).toMatchObject({ frameRate: { min: 50 }, width: { ideal: 640 } });
    expect(requests[2]).toMatchObject({ frameRate: { ideal: 60 }, width: { ideal: 1280 } });
  });
  it('keeps the single request for callers that did not ask for frame rate first', async () => {
    const s = stream();
    const requests: unknown[] = [];
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async (c: MediaStreamConstraints) => { requests.push(c.video); return s.value; } } });
    await startCamera(video());
    expect(requests).toHaveLength(1);
  });
});
