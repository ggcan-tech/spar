/**
 * getUserMedia wrapper with a typed error so the UI can say *why* the camera failed.
 */
export type CameraErrorCode =
  | 'denied' // user (or policy) refused permission
  | 'not-found' // no camera device
  | 'in-use' // another app / tab holds the camera
  | 'insecure-context' // http:// on a non-localhost host — browsers hide getUserMedia
  | 'unsupported' // browser has no mediaDevices
  | 'unknown';

export class CameraError extends Error {
  readonly code: CameraErrorCode;
  override readonly cause?: unknown;
  constructor(code: CameraErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

export interface CameraOptions {
  /** Ask for 50+ frames a second before resolution, falling back to `width`/`height`/`frameRate`. */
  preferFrameRate?: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  signal?: AbortSignal;
}

function toCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = (e as { message?: string } | null)?.message ?? String(e);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', 'Camera permission denied. Allow camera access for this site and try again.', e);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not-found', 'No camera found.', e);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('in-use', 'Camera is busy — another app or tab is probably using it.', e);
    default:
      return new CameraError('unknown', `Camera error: ${msg}`, e);
  }
}

/**
 * Open the user-facing camera, attach it to `video`, and resolve once frames are flowing
 * (metadata loaded + play() resolved). Rejects with a `CameraError`.
 */
export async function startCamera(video: HTMLVideoElement, opts: CameraOptions = {}): Promise<MediaStream> {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const frameRate = opts.frameRate ?? 30;
  const signal = opts.signal;
  const checkCancelled = () => {
    if (signal?.aborted) throw new DOMException('Camera startup cancelled.', 'AbortError');
  };
  checkCancelled();

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
    throw new CameraError(
      insecure ? 'insecure-context' : 'unsupported',
      insecure ? 'Camera needs a secure context (https:// or localhost).' : 'This browser does not support camera capture.',
    );
  }

  const asked: MediaTrackConstraints = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate }, facingMode: 'user' };
  // With every constraint "ideal", a browser may pick 720p at 30 fps over a
  // smaller picture at 60. A body tracker looks at about 256 pixels, so the
  // frame rate is worth far more than the resolution: ask for the rate first
  // and only then fall back to whatever the camera offers.
  const ladder: (MediaTrackConstraints | true)[] = opts.preferFrameRate
    ? [
        { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { min: 50, ideal: 60 }, facingMode: 'user' },
        { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { min: 50, ideal: 60 }, facingMode: 'user' },
        asked,
        true,
      ]
    : [asked, true];
  let stream: MediaStream | undefined;
  for (let i = 0; i < ladder.length && !stream; i++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: ladder[i] });
    } catch (e) {
      checkCancelled();
      const err = toCameraError(e);
      // Too strict for this camera? Try the next rung; anything else is final.
      if (err.code !== 'not-found' || i === ladder.length - 1) throw err;
    }
  }
  if (!stream) throw new CameraError('not-found', 'No camera found.');

  // getUserMedia itself is not abortable. A late permission grant must release
  // its stream immediately, even if the preview element has already been removed.
  if (signal?.aborted) {
    stopCamera(stream);
    checkCancelled();
  }

  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', done);
        signal?.removeEventListener('abort', aborted);
      };
      const done = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(new DOMException('Camera startup cancelled.', 'AbortError')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Camera did not deliver video. Try another camera or close other camera apps.')); }, 10_000);
      video.addEventListener('loadedmetadata', done);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      else if (video.readyState >= 1 && video.videoWidth > 0) done();
    });
    checkCancelled();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new DOMException('Camera startup cancelled.', 'AbortError'));
      signal?.addEventListener('abort', aborted, { once: true });
      video.play().then(resolve, reject).finally(() => signal?.removeEventListener('abort', aborted));
      if (signal?.aborted) aborted();
    });
    checkCancelled();
  } catch (e) {
    stopCamera(stream);
    if (video.srcObject === stream) video.srcObject = null;
    if (signal?.aborted) throw e;
    throw new CameraError('unknown', `Could not start video playback: ${(e as Error)?.message ?? e}`, e);
  }
  return stream;
}

export function stopCamera(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}
