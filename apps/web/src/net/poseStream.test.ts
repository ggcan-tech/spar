import { describe, expect, it } from 'vitest';
import type { PoseFrame } from '@spar/protocol';
import { LANDMARK_COUNT, LEGACY_POSE_PACKET_BYTES, POSE_PACKET_BYTES } from '@spar/protocol';
import { createPoseStream, decodePose, encodePose, type PoseChannelLike } from './poseStream';

function makePose(seed = 1): PoseFrame {
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const lm = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: rnd(), y: rnd(), z: rnd() * 2 - 1, v: rnd(),
  }));
  return { t: 123, imageAspect: .75, lm, world: lm.map((l) => ({ ...l })) };
}

describe('pose packet encode/decode', () => {
  it('roundtrips 33 landmarks at 1e-4 precision in exactly POSE_PACKET_BYTES', () => {
    const pose = makePose(7);
    const buf = encodePose(42, pose);
    expect(buf.byteLength).toBe(POSE_PACKET_BYTES);
    expect(POSE_PACKET_BYTES).toBe(8 + 33 * 7);
    expect(decodePose(buf)!.pose.imageAspect).toBe(.75);

    const out = decodePose(buf, 999);
    expect(out).not.toBeNull();
    expect(out!.frame).toBe(42);
    expect(out!.pose.t).toBe(999);
    expect(out!.pose.lm).toHaveLength(LANDMARK_COUNT);
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      expect(out!.pose.lm[i].x).toBeCloseTo(pose.lm[i].x, 4);
      expect(out!.pose.lm[i].y).toBeCloseTo(pose.lm[i].y, 4);
      expect(out!.pose.lm[i].z).toBeCloseTo(pose.lm[i].z, 4);
      expect(Math.abs(out!.pose.lm[i].v - pose.lm[i].v)).toBeLessThanOrEqual(1 / 255);
    }
    // Normalized wire coordinates must never masquerade as metric measurements.
    expect(out!.pose.world).toEqual([]);
  });

  it('accepts a Uint8Array view and rejects wrong-sized packets', () => {
    const pose = makePose(3);
    const buf = encodePose(1, pose);
    const view = new Uint8Array(buf);
    expect(decodePose(view)!.frame).toBe(1);
    expect(decodePose(new ArrayBuffer(10))).toBeNull();
    expect(decodePose(new Uint8Array(POSE_PACKET_BYTES + 1))).toBeNull();
  });

  it('clamps out-of-range values, zero-fills missing landmarks and keeps uint32 frames', () => {
    const pose: PoseFrame = { t: 0, lm: [{ x: 5, y: -5, z: NaN, v: 1 }], world: [] };
    const out = decodePose(encodePose(0xfffffffe, pose))!;
    expect(out.frame).toBe(0xfffffffe);
    expect(out.pose.lm[0].x).toBeCloseTo(3.2767, 4);
    expect(out.pose.lm[0].y).toBeCloseTo(-3.2768, 4);
    expect(out.pose.lm[0].z).toBe(0);
    expect(out.pose.lm[1]).toEqual({ x: 0, y: 0, z: 0, v: 0 });
  });

  it('preserves legacy compatibility without inventing its camera aspect', () => {
    const packet = new ArrayBuffer(LEGACY_POSE_PACKET_BYTES);
    new DataView(packet).setUint32(0, 19, true);
    const decoded = decodePose(packet)!;
    expect(decoded.frame).toBe(19);
    expect(decoded.pose.imageAspect).toBeUndefined();
    expect(decoded.pose.world).toEqual([]);
  });

  it('rejects corrupt aspects and suppresses nonfinite joints', () => {
    const pose = makePose(); pose.lm[0].x = NaN;
    const packet = encodePose(1, pose);
    expect(decodePose(packet)!.pose.lm[0].v).toBe(0);
    new DataView(packet).setFloat32(4, NaN, true);
    expect(decodePose(packet)).toBeNull();
  });

  it('reuses the caller-provided buffer', () => {
    const scratch = new ArrayBuffer(POSE_PACKET_BYTES);
    expect(encodePose(5, makePose(), scratch)).toBe(scratch);
    expect(encodePose(5, makePose(), new ArrayBuffer(3))).not.toBe(scratch);
  });
});

function fakeChannel(): PoseChannelLike & { sent: ArrayBuffer[]; deliver(buf: ArrayBuffer): void } {
  const ch = {
    readyState: 'open' as RTCDataChannelState,
    binaryType: 'blob' as BinaryType,
    onmessage: null as ((ev: MessageEvent) => void) | null,
    sent: [] as ArrayBuffer[],
    send(data: ArrayBuffer) {
      ch.sent.push(data);
    },
    deliver(buf: ArrayBuffer) {
      ch.onmessage?.({ data: buf } as MessageEvent);
    },
  };
  return ch;
}

describe('createPoseStream', () => {
  it('sends numbered packets and delivers decoded frames to subscribers', () => {
    const a = fakeChannel();
    const b = fakeChannel();
    const tx = createPoseStream(a);
    const rx = createPoseStream(b);
    expect(a.binaryType).toBe('arraybuffer');

    const got: PoseFrame[] = [];
    const off = rx.onFrame((f) => got.push(f));
    const pose = makePose(11);
    tx.send(pose);
    tx.send(pose);
    expect(a.sent).toHaveLength(2);
    expect(tx.sentFrames()).toBe(2);
    expect(decodePose(a.sent[0])!.frame).toBe(1);
    expect(decodePose(a.sent[1])!.frame).toBe(2);
    expect(a.sent[0]).not.toBe(a.sent[1]); // scratch buffer is copied per packet

    b.deliver(a.sent[0]);
    b.deliver(a.sent[1]);
    expect(got).toHaveLength(2);
    expect(got[1].lm[5].x).toBeCloseTo(pose.lm[5].x, 4);
    expect(rx.lastRemoteFrame()).toBe(2);

    off();
    b.deliver(encodePose(3, pose));
    expect(got).toHaveLength(2);
  });

  it('drops out-of-order and duplicate packets on the unordered channel', () => {
    const b = fakeChannel();
    const rx = createPoseStream(b);
    const frames: number[] = [];
    rx.onFrame(() => frames.push(rx.lastRemoteFrame()));
    const pose = makePose();
    b.deliver(encodePose(5, pose));
    b.deliver(encodePose(3, pose)); // late
    b.deliver(encodePose(5, pose)); // dup
    b.deliver(encodePose(6, pose));
    expect(frames).toEqual([5, 6]);
    b.deliver(new ArrayBuffer(7)); // garbage
    expect(frames).toEqual([5, 6]);
  });

  it('does not send on a channel that is not open, and stops after close()', () => {
    const a = fakeChannel();
    a.readyState = 'connecting';
    const tx = createPoseStream(a);
    tx.send(makePose());
    expect(a.sent).toHaveLength(0);
    a.readyState = 'open';
    tx.send(makePose());
    expect(a.sent).toHaveLength(1);
    tx.close();
    tx.send(makePose());
    expect(a.sent).toHaveLength(1);
    expect(a.onmessage).toBeNull();
  });
});
