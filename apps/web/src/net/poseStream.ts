import type { Landmark, PoseFrame } from '@spar/protocol';
import { LANDMARK_COUNT, LEGACY_POSE_PACKET_BYTES, POSE_PACKET_BYTES } from '@spar/protocol';
import type { PoseStreamHandle } from './types';

/** Fixed-point scale for landmark coordinates on the wire (int16 = value × 10000). */
export const POSE_SCALE = 10000;
const HEADER_BYTES = 8;

function toInt16(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const s = Math.round(v * POSE_SCALE);
  return s > 32767 ? 32767 : s < -32768 ? -32768 : s;
}

/**
 * Encodes counter uint32 + image aspect float32 + 33 × (xyz int16 + visibility uint8).
 * Missing landmarks encode as zeros. Pass `out` to reuse a buffer.
 */
export function encodePose(frame: number, pose: PoseFrame, out?: ArrayBuffer): ArrayBuffer {
  const buf = out && out.byteLength === POSE_PACKET_BYTES ? out : new ArrayBuffer(POSE_PACKET_BYTES);
  const dv = new DataView(buf);
  dv.setUint32(0, frame >>> 0, true);
  const aspect = pose.imageAspect;
  dv.setFloat32(4, aspect && Number.isFinite(aspect) && aspect >= .1 && aspect <= 10 ? aspect : 0, true);
  let off = HEADER_BYTES;
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const lm = pose.lm[i];
    dv.setInt16(off, lm ? toInt16(lm.x) : 0, true);
    dv.setInt16(off + 2, lm ? toInt16(lm.y) : 0, true);
    dv.setInt16(off + 4, lm ? toInt16(lm.z) : 0, true);
    const usable = lm && [lm.x, lm.y, lm.z, lm.v].every(Number.isFinite);
    dv.setUint8(off + 6, usable ? Math.round(Math.max(0, Math.min(1, lm.v)) * 255) : 0);
    off += 7;
  }
  return buf;
}

export interface DecodedPose {
  frame: number;
  pose: PoseFrame;
}

/**
 * Accepts current and legacy packets. Legacy packets have unknown aspect and assumed visibility.
 * Metric world landmarks are never transmitted; `world` is empty. Malformed packets are dropped.
 */
export function decodePose(data: ArrayBuffer | ArrayBufferView, t: number = now()): DecodedPose | null {
  let dv: DataView;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength !== POSE_PACKET_BYTES && data.byteLength !== LEGACY_POSE_PACKET_BYTES) return null;
    dv = new DataView(data);
  } else {
    if (data.byteLength !== POSE_PACKET_BYTES && data.byteLength !== LEGACY_POSE_PACKET_BYTES) return null;
    dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  const legacy = dv.byteLength === LEGACY_POSE_PACKET_BYTES;
  const aspect = legacy ? 0 : dv.getFloat32(4, true);
  if (!Number.isFinite(aspect) || (aspect !== 0 && (aspect < .1 || aspect > 10))) return null;
  const frame = dv.getUint32(0, true);
  const lm: Landmark[] = new Array(LANDMARK_COUNT);
  let off = legacy ? 4 : HEADER_BYTES;
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const x = dv.getInt16(off, true) / POSE_SCALE;
    const y = dv.getInt16(off + 2, true) / POSE_SCALE;
    const z = dv.getInt16(off + 4, true) / POSE_SCALE;
    lm[i] = { x, y, z, v: legacy ? 1 : dv.getUint8(off + 6) / 255 };
    off += legacy ? 6 : 7;
  }
  return { frame, pose: { t, lm, world: [], imageAspect: aspect || undefined } };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Minimal channel surface used by the stream, so tests can pass a fake. */
export interface PoseChannelLike {
  readyState: RTCDataChannelState;
  binaryType: BinaryType;
  send(data: ArrayBuffer): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface PoseStream extends PoseStreamHandle {
  /** Frame counter of the last packet sent. */
  sentFrames(): number;
  /** Last accepted (in-order) remote frame counter, -1 before any. */
  lastRemoteFrame(): number;
  close(): void;
}

/**
 * Runs the cosmetic pose stream over an unordered DataChannel. Out-of-order packets are dropped
 * (the frame counter only moves forward) so the opponent's shadow never jumps backwards.
 */
export function createPoseStream(ch: PoseChannelLike): PoseStream {
  ch.binaryType = 'arraybuffer';
  const subs = new Set<(f: PoseFrame) => void>();
  const scratch = new ArrayBuffer(POSE_PACKET_BYTES);
  let counter = 0;
  let lastRemote = -1;
  let closed = false;

  ch.onmessage = (ev: MessageEvent) => {
    if (closed) return;
    const d: unknown = ev.data;
    const decoded =
      d instanceof ArrayBuffer ? decodePose(d) : ArrayBuffer.isView(d) ? decodePose(d) : null;
    if (!decoded) return;
    // uint32 counters won't wrap in a 3-minute match; simple monotonic gate is enough.
    if (decoded.frame <= lastRemote) return;
    lastRemote = decoded.frame;
    for (const cb of Array.from(subs)) {
      try {
        cb(decoded.pose);
      } catch (err) {
        console.error('[poseStream] subscriber threw', err);
      }
    }
  };

  return {
    send(f: PoseFrame): void {
      if (closed || ch.readyState !== 'open') return;
      counter = (counter + 1) >>> 0;
      encodePose(counter, f, scratch);
      // Copy: the channel may hold the buffer, and we reuse `scratch` next tick.
      const out = scratch.slice(0);
      try {
        ch.send(out);
      } catch {
        /* dropped: cosmetic stream, next packet supersedes it */
      }
    },
    onFrame(cb: (f: PoseFrame) => void): () => void {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    sentFrames: () => counter,
    lastRemoteFrame: () => lastRemote,
    close(): void {
      closed = true;
      subs.clear();
      ch.onmessage = null;
    },
  };
}
