import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BIT, FRAME_MS, type ClientMsg, type ServerMsg } from '@spar/protocol';
import { replay, sim } from '@spar/sim';
import { createLoopbackPair, createRollbackSession } from '../../../packages/netcode/src';
import { createSignalServer, type SignalServer } from '../src/server';

class Peer {
  private inbox: ServerMsg[] = [];
  private listeners: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', raw => {
      this.inbox.push(JSON.parse(String(raw)) as ServerMsg);
      for (const cb of [...this.listeners]) cb();
    });
  }
  send(msg: ClientMsg) { this.ws.send(JSON.stringify(msg)); }
  next<T extends ServerMsg['type']>(type: T): Promise<Extract<ServerMsg, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error(`Missing ${type}`)); }, 3000);
      const remove = () => { clearTimeout(timer); this.listeners = this.listeners.filter(cb => cb !== check); };
      const check = () => {
        const i = this.inbox.findIndex(msg => msg.type === type);
        if (i >= 0) { remove(); resolve(this.inbox.splice(i, 1)[0] as Extract<ServerMsg, { type: T }>); }
      };
      this.listeners.push(check); check();
    });
  }
}

let server: SignalServer;
const peers: Peer[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.ws.terminate();
  await server?.close();
});
async function matched() {
  server = createSignalServer({ port: 0, replayer: { replay }, resultTimeoutMs: 1000 });
  await server.ready;
  for (let i = 0; i < 2; i++) {
    const peer = new Peer(new WebSocket(`ws://127.0.0.1:${server.port}`));
    peers.push(peer); await peer.next('welcome');
    peer.send({ type: 'hello', name: `player${i}` });
    peer.send({ type: 'queue' }); await peer.next('queued');
  }
  const ma = await peers[0].next('match');
  const mb = await peers[1].next('match');
  expect(ma.seed).toBe(mb.seed);
  return ma;
}

describe('real simulation result verification', () => {
  it.each([0, 1] as const)('completes a lossy rollback match won by player %i and verifies both replays through WebSocket', async (attacker) => {
    const match = await matched();
    const net = createLoopbackPair({ latencyMs: 50, jitterMs: 25, loss: 0.08, seed: 791 });
    const sessions = [0, 1].map(p => createRollbackSession({ sim, transport: p === 0 ? net.a : net.b, localPlayer: p as 0 | 1, seed: match.seed, now: net.clock.now }));
    let complete = false;
    for (let tick = 0; tick < 8000; tick++) {
      for (let p = 0; p < 2; p++) {
        const frame = sessions[p].frame;
        sessions[p].tick(p === attacker ? (frame % 24 === 0 ? BIT.JAB : 0) | (frame % 90 === 0 ? BIT.STEP_IN : 0) : 0);
      }
      net.clock.advance(FRAME_MS);
      if (sessions.every(s => s.confirmed().view.state === 'OVER')) { complete = true; break; }
    }
    expect(complete).toBe(true);
    expect(sessions.reduce((n, s) => n + s.stats().rollbacksTotal, 0)).toBeGreaterThan(0);
    const confirmations = sessions.map(s => s.confirmed());
    for (let i = 0; i < 2; i++) {
      const log = sessions[i].inputLog();
      const confirmed = confirmations[i];
      const authoritative = replay(match.seed, log);
      expect(authoritative.hash).toBe(confirmed.hash);
      expect(authoritative.frames).toBe(confirmed.frame);
      expect(authoritative.view.winner).toBe(attacker);
      expect(authoritative.view.method).toBe('KO');
      peers[i].send({ type: 'result', matchId: match.matchId, seed: match.seed, log, hash: confirmed.hash });
    }
    const results = await Promise.all(peers.map(p => p.next('verified')));
    expect(results[0]).toMatchObject({ ok: true, winner: attacker, ratings: attacker === 0 ? [1216, 1184] : [1184, 1216] });
    expect(results[1]).toEqual(results[0]);
    expect(server.state().matches).toBe(0);
    sessions.forEach(s => s.close());
  });

  it('does not verify an unfinished replay as a completed result even with matching hashes', async () => {
    const match = await matched();
    const log: [number[], number[]] = [Array(150).fill(0), Array(150).fill(0)];
    const hash = replay(match.seed, log).hash;
    for (const peer of peers) peer.send({ type: 'result', matchId: match.matchId, seed: match.seed, log, hash });
    const results = await Promise.all(peers.map(p => p.next('verified')));
    expect(results[0]).toMatchObject({ ok: false, winner: null, ratings: [1200, 1200] });
    expect(results[1]).toEqual(results[0]);
  });
});
