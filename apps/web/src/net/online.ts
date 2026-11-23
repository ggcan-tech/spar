import type { InputBits, RollbackSessionLike, SimLike } from '@spar/protocol';
import { createRollbackSession } from '@spar/netcode';
import type { InputSource } from '../input/InputSource';
import { createSignaling, type SignalingClient } from './signaling';
import { connectPeer, type PeerChannels } from './webrtc';
import { dataChannelTransport } from './transport';
import { createPoseStream } from './poseStream';
import type { MatchMsg, OnlineHandles, OnlineStatus, VerifiedMsg } from './types';

export type StatusCb = (s: OnlineStatus, detail?: string) => void;

export interface StartOnlineOpts<S> {
  name: string;
  sim: SimLike<S>;
  /** Reserved for stance/pose hints at matchmaking time; the fight itself samples it via the loop. */
  input: InputSource;
  /** Override the signaling URL (defaults to `signalUrl()`). */
  url?: string;
  inputDelay?: number;
  maxRollback?: number;
}

export interface OnlineStarter {
  /** Abort at any stage before `ready` resolves (leaves the queue, closes sockets). */
  cancel(): void;
  onStatus(cb: StatusCb): () => void;
  ready: Promise<OnlineHandles>;
}

/** Grace period before a transient 'disconnected' ICE state counts as the peer leaving. */
const DISCONNECT_GRACE_MS = 6000;

/**
 * hello → queue → match → connectPeer → createRollbackSession → OnlineHandles.
 * Status callbacks fire in order: connecting, queued, matched, connecting-peer, ready (or error).
 */
export function startOnline<S>({
  name,
  sim,
  input,
  url,
  inputDelay = 2,
  maxRollback = 8,
}: StartOnlineOpts<S>): OnlineStarter {
  void input;
  const statusSubs = new Set<StatusCb>();
  let lastStatus: [OnlineStatus, string | undefined] | null = null;
  const cancelHooks: Array<() => void> = [];
  let cancelled = false;
  let pc: RTCPeerConnection | null = null;
  let session: RollbackSessionLike | null = null;

  const signaling: SignalingClient = createSignaling(url);

  function status(s: OnlineStatus, detail?: string): void {
    lastStatus = [s, detail];
    for (const cb of Array.from(statusSubs)) {
      try {
        cb(s, detail);
      } catch (err) {
        console.error('[online] status listener threw', err);
      }
    }
  }

  function throwIfCancelled(): void {
    if (cancelled) throw new Error('cancelled');
  }

  function waitForMatch(): Promise<{ match: MatchMsg; peer: Promise<PeerChannels> }> {
    return new Promise((resolve, reject) => {
      const offs: Array<() => void> = [];
      const cleanup = () => offs.splice(0).forEach((f) => f());
      offs.push(
        signaling.once('match', (m) => {
          // Start the handshake *inside* the handler so no early SDP/ICE from the peer is missed.
          const peer = connectPeer({ signaling, peerId: m.peerId, role: m.role });
          peer.catch(() => {
            /* surfaced by the awaiting caller */
          });
          cleanup();
          resolve({ match: m, peer });
        }),
        signaling.on('queued', (size) =>
          status('queued', size > 1 ? `${size} in queue` : 'waiting for an opponent'),
        ),
        signaling.on('close', (code) => {
          cleanup();
          reject(new Error(cancelled ? 'cancelled' : `signaling closed (${code})`));
        }),
        signaling.on('error', (message) => {
          cleanup();
          reject(new Error(message));
        }),
      );
      cancelHooks.push(() => {
        cleanup();
        reject(new Error('cancelled'));
      });
    });
  }

  async function run(): Promise<OnlineHandles> {
    status('connecting', signaling.url);
    await signaling.connect();
    throwIfCancelled();
    signaling.hello(name);
    signaling.queue();
    status('queued', 'waiting for an opponent');

    const { match, peer } = await waitForMatch();
    throwIfCancelled();
    status('matched', match.peerName);
    status('connecting-peer', match.role === 'offer' ? 'offering' : 'answering');

    const channels = await peer;
    pc = channels.pc;
    if (cancelled) {
      pc.close();
      throw new Error('cancelled');
    }

    const transport = dataChannelTransport(channels.inputs);
    const rollback = createRollbackSession({
      sim,
      transport,
      localPlayer: match.player,
      seed: match.seed,
      inputDelay,
      maxRollback,
    });
    session = rollback;
    const poseStream = createPoseStream(channels.pose);

    // ── peer-left detection: server notice, ICE failure, or the inputs channel closing ──
    const leftSubs = new Set<(reason: string) => void>();
    let leftFired = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const firePeerLeft = (reason: string) => {
      if (leftFired) return;
      leftFired = true;
      for (const cb of Array.from(leftSubs)) {
        try {
          cb(reason);
        } catch (err) {
          console.error('[online] peer-left listener threw', err);
        }
      }
    };
    const offPeerLeft = signaling.on('peer_left', () => firePeerLeft(`${match.peerName} left the match`));
    channels.pc.onconnectionstatechange = () => {
      const st = channels.pc.connectionState;
      if (st === 'failed' || st === 'closed') firePeerLeft(`connection ${st}`);
      else if (st === 'disconnected') {
        if (graceTimer === null) {
          graceTimer = setTimeout(() => firePeerLeft('connection lost'), DISCONNECT_GRACE_MS);
        }
      } else if (st === 'connected' && graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };
    channels.inputs.addEventListener('close', () => firePeerLeft('input channel closed'), { once: true });

    let closed = false;
    const handles: OnlineHandles = {
      session: rollback,
      localPlayer: match.player,
      seed: match.seed,
      matchId: match.matchId,
      peerName: match.peerName,
      poseStream,
      stats: () => ({ rttMs: signaling.rttMs }),
      submitResult(hash: number, log: [InputBits[], InputBits[]]): void {
        signaling.result(match.matchId, match.seed, log, hash);
      },
      onVerified(cb: (m: VerifiedMsg) => void): () => void {
        return signaling.on('verified', (m) => {
          if (m.matchId === match.matchId) cb(m);
        });
      },
      onPeerLeft(cb: (reason: string) => void): () => void {
        leftSubs.add(cb);
        return () => {
          leftSubs.delete(cb);
        };
      },
      close(): void {
        if (closed) return;
        closed = true;
        leftFired = true; // don't report our own teardown as the peer leaving
        if (graceTimer !== null) clearTimeout(graceTimer);
        offPeerLeft();
        poseStream.close();
        try {
          rollback.close();
        } catch {
          /* ignore */
        }
        try {
          channels.pc.close();
        } catch {
          /* ignore */
        }
        signaling.close();
      },
    };
    status('ready');
    return handles;
  }

  const ready = run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== 'cancelled') status('error', message);
    throw err instanceof Error ? err : new Error(message);
  });
  // Nobody may be listening after cancel(); keep that from surfacing as an unhandled rejection.
  ready.catch(() => {});

  return {
    ready,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const hook of cancelHooks.splice(0)) hook();
      try {
        signaling.leave();
      } catch {
        /* socket may be gone */
      }
      session?.close();
      pc?.close();
      signaling.close();
    },
    onStatus(cb: StatusCb): () => void {
      statusSubs.add(cb);
      if (lastStatus) cb(lastStatus[0], lastStatus[1]);
      return () => {
        statusSubs.delete(cb);
      };
    },
  };
}
