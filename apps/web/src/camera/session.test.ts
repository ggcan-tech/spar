import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoseSource } from './pose';

vi.mock('./camera', () => ({
  CameraError: class CameraError extends Error {},
  startCamera: vi.fn(),
  stopCamera: vi.fn((stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop())),
}));
vi.mock('./pose', () => ({ createPoseSource: vi.fn() }));

import { startCamera } from './camera';
import { createPoseSource } from './pose';
import { cameraSession } from './session';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const makeStream = () => {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
};
const makePose = () => ({ stop: vi.fn() } as unknown as PoseSource);
let videos: HTMLVideoElement[];

beforeEach(() => {
  cameraSession.stop();
  vi.clearAllMocks();
  videos = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const video = { style: {}, setAttribute: vi.fn(), remove: vi.fn(), pause: vi.fn(), srcObject: null, videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;
      videos.push(video);
      return video;
    },
    body: { appendChild: vi.fn() },
  });
});
afterEach(() => { cameraSession.stop(); vi.unstubAllGlobals(); });

function cameraResolves(stream: MediaStream) {
  vi.mocked(startCamera).mockImplementationOnce(async (video) => { video.srcObject = stream; return stream; });
}

describe('camera session lifecycle', () => {
  it('shares concurrent startup and releases a live session', async () => {
    const { stream, stop } = makeStream();
    const pose = makePose();
    cameraResolves(stream);
    vi.mocked(createPoseSource).mockResolvedValueOnce(pose);
    const first = cameraSession.start();
    expect(cameraSession.start()).toBe(first);
    const live = await first;
    expect(await cameraSession.start()).toBe(live);
    expect(startCamera).toHaveBeenCalledTimes(1);
    cameraSession.stop();
    expect(cameraSession.state()).toEqual({ status: 'off' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pose.stop).toHaveBeenCalledTimes(1);
    expect(videos[0].srcObject).toBeNull();
    expect(videos[0].remove).toHaveBeenCalled();
  });

  it('does not open the camera if stopped before startup runs', async () => {
    const pending = cameraSession.start();
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    cameraSession.stop();
    await result;
    expect(startCamera).not.toHaveBeenCalled();
    expect(cameraSession.state()).toEqual({ status: 'off' });
  });

  it('disposes a permission result arriving after stop without loading the model', async () => {
    const permission = deferred<MediaStream>();
    const { stream, stop } = makeStream();
    vi.mocked(startCamera).mockImplementationOnce(async (video) => {
      const granted = await permission.promise;
      video.srcObject = granted;
      return granted;
    });
    const pending = cameraSession.start();
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    cameraSession.stop();
    permission.resolve(stream);
    await result;
    expect(stop).toHaveBeenCalled();
    expect(createPoseSource).not.toHaveBeenCalled();
    expect(videos[0].srcObject).toBeNull();
    expect(cameraSession.state()).toEqual({ status: 'off' });
  });

  it('releases an attached stream immediately while playback is still pending', async () => {
    const playback = deferred<MediaStream>();
    const { stream, stop } = makeStream();
    vi.mocked(startCamera).mockImplementationOnce((video) => { video.srcObject = stream; return playback.promise; });
    const pending = cameraSession.start();
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    cameraSession.stop();
    expect(stop).toHaveBeenCalled();
    expect(videos[0].srcObject).toBeNull();
    playback.resolve(stream);
    await result;
  });

  it('closes a detector that finishes loading after stop', async () => {
    const model = deferred<PoseSource>();
    const { stream, stop } = makeStream();
    const pose = makePose();
    cameraResolves(stream);
    vi.mocked(createPoseSource).mockReturnValueOnce(model.promise);
    const pending = cameraSession.start();
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(cameraSession.state()).toEqual({ status: 'starting', step: 'model' });
    cameraSession.stop();
    expect(stop).toHaveBeenCalled();
    model.resolve(pose);
    await result;
    expect(pose.stop).toHaveBeenCalledTimes(1);
    expect(cameraSession.state()).toEqual({ status: 'off' });
  });

  it('does not let obsolete failure clear the new inflight promise or state', async () => {
    const oldPermission = deferred<MediaStream>();
    const newPermission = deferred<MediaStream>();
    vi.mocked(startCamera).mockReturnValueOnce(oldPermission.promise).mockReturnValueOnce(newPermission.promise);
    const old = cameraSession.start();
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    cameraSession.stop();
    const next = cameraSession.start();
    await flush();
    oldPermission.reject(new Error('Permission denied for obsolete request'));
    await rejected;
    expect(cameraSession.start()).toBe(next);
    expect(cameraSession.state()).toEqual({ status: 'starting', step: 'camera' });
    const { stream } = makeStream();
    vi.mocked(createPoseSource).mockResolvedValueOnce(makePose());
    newPermission.resolve(stream);
    expect(cameraSession.current()).toBeNull();
    const session = await next;
    expect(cameraSession.current()).toBe(session);
  });

  it('does not let an old model completion replace or stop a newer live session', async () => {
    const oldModel = deferred<PoseSource>();
    const oldCamera = makeStream();
    const newCamera = makeStream();
    const oldPose = makePose();
    const newPose = makePose();
    cameraResolves(oldCamera.stream);
    vi.mocked(createPoseSource).mockReturnValueOnce(oldModel.promise);
    const old = cameraSession.start();
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    cameraSession.stop();
    cameraResolves(newCamera.stream);
    vi.mocked(createPoseSource).mockResolvedValueOnce(newPose);
    const next = await cameraSession.start();
    oldModel.resolve(oldPose);
    await rejected;
    expect(cameraSession.current()).toBe(next);
    expect(oldPose.stop).toHaveBeenCalledTimes(1);
    expect(newPose.stop).not.toHaveBeenCalled();
    expect(newCamera.stop).not.toHaveBeenCalled();
  });

  it('releases camera resources on model failure and permits retry', async () => {
    const { stream, stop } = makeStream();
    cameraResolves(stream);
    const error = new Error('Model unavailable');
    vi.mocked(createPoseSource).mockRejectedValueOnce(error);
    await expect(cameraSession.start()).rejects.toBe(error);
    expect(cameraSession.state()).toEqual({ status: 'error', error });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(videos[0].srcObject).toBeNull();
    cameraResolves(makeStream().stream);
    vi.mocked(createPoseSource).mockResolvedValueOnce(makePose());
    await cameraSession.start();
    expect(cameraSession.state().status).toBe('live');
  });

  it('honors a synchronous stop from a startup subscriber', async () => {
    const unsubscribe = cameraSession.subscribe(() => {
      if (cameraSession.state().status === 'starting') cameraSession.stop();
    });
    try {
      await expect(cameraSession.start()).rejects.toMatchObject({ name: 'AbortError' });
      expect(cameraSession.state()).toEqual({ status: 'off' });
      expect(startCamera).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
