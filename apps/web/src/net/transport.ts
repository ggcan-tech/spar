import type { Transport } from '@spar/protocol';

/**
 * Wraps an (unordered, unreliable) RTCDataChannel as the netcode's abstract Transport.
 * Frames are copied into a fresh ArrayBuffer before sending so the caller may reuse its buffer.
 */
export function dataChannelTransport(ch: RTCDataChannel): Transport {
  ch.binaryType = 'arraybuffer';
  let handler: ((data: Uint8Array) => void) | null = null;

  ch.onmessage = (ev: MessageEvent) => {
    if (!handler) return;
    const d: unknown = ev.data;
    if (d instanceof ArrayBuffer) handler(new Uint8Array(d));
    else if (ArrayBuffer.isView(d)) handler(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  };

  return {
    send(data: Uint8Array): void {
      if (ch.readyState !== 'open') return;
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(data);
      try {
        ch.send(copy);
      } catch {
        /* channel closing under us: drop the packet, rollback will re-send inputs anyway */
      }
    },
    onMessage(cb: (data: Uint8Array) => void): void {
      handler = cb;
    },
  };
}
