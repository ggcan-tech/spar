import type { SignalingClient } from './signaling';

export interface PeerChannels {
  inputs: RTCDataChannel;
  pose: RTCDataChannel;
  pc: RTCPeerConnection;
}

export interface ConnectPeerOpts {
  signaling: SignalingClient;
  peerId: string;
  role: 'offer' | 'answer';
  /** Give up after this long without both channels open. Default 20 s. */
  timeoutMs?: number;
  iceServers?: RTCIceServer[];
}

/** What we relay through the signaling server's `signal` message. */
export type SignalPayload =
  | { kind: 'sdp'; description: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Both game channels are unordered + zero retransmits: rollback tolerates loss, not latency. */
const CHANNEL_INIT: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };

function isSignalPayload(d: unknown): d is SignalPayload {
  if (!d || typeof d !== 'object') return false;
  const kind = (d as { kind?: unknown }).kind;
  return kind === 'sdp' || kind === 'ice';
}

/**
 * Opens a peer connection with two DataChannels (`inputs`, `pose`). The 'offer' role creates the
 * channels and the offer; the 'answer' role waits for them. SDP/ICE are exchanged through the
 * signaling client's `signal` messages. The `signal` listener is attached synchronously so it is
 * safe to call from inside the `match` handler.
 */
export function connectPeer({
  signaling,
  peerId,
  role,
  timeoutMs = 20_000,
  iceServers = DEFAULT_ICE_SERVERS,
}: ConnectPeerOpts): Promise<PeerChannels> {
  return new Promise<PeerChannels>((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers });
    const chans: { inputs?: RTCDataChannel; pose?: RTCDataChannel } = {};
    const pendingIce: RTCIceCandidateInit[] = [];
    let remoteSet = false;
    let done = false;

    const timer = setTimeout(() => fail(new Error('peer connection timed out')), timeoutMs);

    const offSignal = signaling.on('signal', (from, data) => {
      if (from !== peerId || !isSignalPayload(data)) return;
      if (data.kind === 'sdp') {
        onRemoteSdp(data.description).catch(fail);
      } else if (remoteSet) {
        pc.addIceCandidate(data.candidate).catch(() => {
          /* stale candidate: harmless */
        });
      } else {
        pendingIce.push(data.candidate);
      }
    });

    function finish(): void {
      offSignal();
      clearTimeout(timer);
    }

    function fail(err: unknown): void {
      if (done) return;
      done = true;
      finish();
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function maybeSucceed(): void {
      if (done) return;
      if (chans.inputs?.readyState === 'open' && chans.pose?.readyState === 'open') {
        done = true;
        finish();
        resolve({ inputs: chans.inputs, pose: chans.pose, pc });
      }
    }

    function adopt(ch: RTCDataChannel): void {
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'inputs') chans.inputs = ch;
      else if (ch.label === 'pose') chans.pose = ch;
      else return;
      if (ch.readyState === 'open') maybeSucceed();
      else ch.addEventListener('open', maybeSucceed, { once: true });
      ch.addEventListener('error', () => fail(new Error(`data channel "${ch.label}" errored`)), { once: true });
    }

    function sendSignal(data: SignalPayload): void {
      signaling.signal(peerId, data);
    }

    async function onRemoteSdp(description: RTCSessionDescriptionInit): Promise<void> {
      await pc.setRemoteDescription(description);
      remoteSet = true;
      for (const c of pendingIce.splice(0)) {
        await pc.addIceCandidate(c).catch(() => {
          /* ignore */
        });
      }
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const local = pc.localDescription ?? answer;
        sendSignal({ kind: 'sdp', description: { type: local.type, sdp: local.sdp } });
      }
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal({ kind: 'ice', candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail(new Error('peer connection failed (ICE)'));
    };
    pc.ondatachannel = (ev) => adopt(ev.channel);

    if (role === 'offer') {
      adopt(pc.createDataChannel('inputs', CHANNEL_INIT));
      adopt(pc.createDataChannel('pose', CHANNEL_INIT));
      (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const local = pc.localDescription ?? offer;
        sendSignal({ kind: 'sdp', description: { type: local.type, sdp: local.sdp } });
      })().catch(fail);
    }
  });
}
