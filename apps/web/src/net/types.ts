import type { InputBits, PoseFrame, RollbackSessionLike, ServerMsg } from '@spar/protocol';

export type VerifiedMsg = Extract<ServerMsg, { type: 'verified' }>;
export type MatchMsg = Extract<ServerMsg, { type: 'match' }>;

/** Cosmetic landmark stream over its own unreliable DataChannel. */
export interface PoseStreamHandle {
  send(f: PoseFrame): void;
  onFrame(cb: (f: PoseFrame) => void): () => void;
}

export type OnlineStatus = 'connecting' | 'queued' | 'matched' | 'connecting-peer' | 'ready' | 'error';

/**
 * Everything FightScreen / OnlineScreen need once a peer is connected. Created by `startOnline`.
 * `onPeerLeft` is an addition to the spec'd surface so the screen can react to a disconnect.
 */
export interface OnlineHandles {
  session: RollbackSessionLike;
  localPlayer: 0 | 1;
  seed: number;
  matchId: string;
  peerName: string;
  poseStream: PoseStreamHandle;
  stats(): { rttMs: number };
  submitResult(hash: number, log: [InputBits[], InputBits[]]): void;
  onVerified(cb: (m: VerifiedMsg) => void): () => void;
  onPeerLeft(cb: (reason: string) => void): () => void;
  close(): void;
}
