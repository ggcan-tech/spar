import { useSyncExternalStore } from 'react';
import { CameraError, startCamera, stopCamera } from './camera';
import { createPoseSource, type PoseSource } from './pose';

/**
 * One camera + one pose detector for the whole app. Owned here (not by a React screen) so the
 * stream keeps running when the Dojo unmounts and the fight starts. The inference video is a
 * tiny element pinned in the viewport; screens that want a preview attach the same MediaStream
 * to their own <video>.
 */
export interface CameraSession {
  stream: MediaStream;
  /** Hidden element the detector reads from. */
  video: HTMLVideoElement;
  pose: PoseSource;
  width: number;
  height: number;
}

export type CameraSessionState =
  | { status: 'off' }
  | { status: 'starting'; step: 'camera' | 'model' }
  | { status: 'live'; session: CameraSession }
  | { status: 'error'; error: CameraError | Error };

type Listener = () => void;

let state: CameraSessionState = { status: 'off' };
let inflight: Promise<CameraSession> | null = null;
let generation = 0;
let cancelPending: (() => void) | null = null;

function cancelled(): Error {
  const error = new Error('Camera startup was cancelled.');
  error.name = 'AbortError';
  return error;
}

function releaseVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  // startCamera may already have attached a stream while waiting for metadata/playback.
  stopCamera(video.srcObject as MediaStream | null);
  try { video.pause(); } catch { /* Detached video or browser teardown. */ }
  video.srcObject = null;
  video.remove();
}

function releasePose(pose: PoseSource | null): void {
  try { pose?.stop(); } catch { /* Still release the camera if detector teardown fails. */ }
}
const listeners = new Set<Listener>();

function setState(next: CameraSessionState) {
  state = next;
  for (const l of listeners) l();
}

function makeHiddenVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  v.setAttribute('aria-hidden', 'true');
  // Kept inside the viewport (not display:none) so the browser keeps presenting frames to it.
  Object.assign(v.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '2px',
    height: '2px',
    opacity: '0.02',
    pointerEvents: 'none',
    zIndex: '-1',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(v);
  return v;
}

export const cameraSession = {
  state: (): CameraSessionState => state,
  current: (): CameraSession | null => (state.status === 'live' ? state.session : null),
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Idempotent within a generation. stop() allows an immediate, independent retry. */
  start(): Promise<CameraSession> {
    if (state.status === 'live') return Promise.resolve(state.session);
    if (inflight) return inflight;
    const mine = ++generation;
    const controller = new AbortController();
    let video: HTMLVideoElement | null = null;
    let stream: MediaStream | null = null;
    let pose: PoseSource | null = null;
    const assertCurrent = () => { if (mine !== generation) throw cancelled(); };
    const cleanup = () => {
      controller.abort();
      releasePose(pose);
      pose = null;
      // Do not stop the same stream twice when it is still attached to the video.
      if (stream && stream !== video?.srcObject) stopCamera(stream);
      stream = null;
      releaseVideo(video);
    };
    cancelPending = cleanup;
    // Schedule work after assigning inflight: a synchronous state listener can safely call
    // start() or stop(), including before the browser permission request has begun.
    const promise = Promise.resolve().then(async (): Promise<CameraSession> => {
      try {
        assertCurrent();
        video = makeHiddenVideo();
        stream = await startCamera(video, { width: 1280, height: 720, signal: controller.signal });
        assertCurrent();
        setState({ status: 'starting', step: 'model' });
        assertCurrent();
        pose = await createPoseSource(video, { signal: controller.signal });
        assertCurrent();
        const session: CameraSession = { stream, video, pose, width: video.videoWidth, height: video.videoHeight };
        setState({ status: 'live', session });
        // A listener may stop the session during the live notification.
        assertCurrent();
        return session;
      } catch (e) {
        cleanup();
        // An obsolete permission/model result must never change a newer session's state.
        const error = mine !== generation ? cancelled() : e instanceof Error ? e : new Error(String(e));
        if (mine === generation) setState({ status: 'error', error });
        throw error;
      } finally {
        if (mine === generation) {
          inflight = null;
          cancelPending = null;
        }
      }
    });
    inflight = promise;
    setState({ status: 'starting', step: 'camera' });
    return promise;
  },
  stop(): void {
    ++generation;
    inflight = null;
    const cleanup = cancelPending;
    cancelPending = null;
    if (cleanup) cleanup();
    else if (state.status === 'live') {
      const { pose, stream, video } = state.session;
      releasePose(pose);
      if (stream !== video.srcObject) stopCamera(stream);
      releaseVideo(video);
    }
    if (state.status !== 'off') setState({ status: 'off' });
  },
};

export function useCameraSession(): CameraSessionState {
  return useSyncExternalStore(cameraSession.subscribe, cameraSession.state, cameraSession.state);
}
