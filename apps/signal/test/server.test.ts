import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { request } from 'node:http';
import type { ClientMsg, InputBits, MatchView, ReplayResult, ServerMsg } from '@spar/protocol';
import { createSignalServer, elo, MAX_RESULT_FRAMES, MAX_MESSAGE_BYTES, MESSAGE_BURST, type SignalServer } from '../src/server';

// ───────── fake replayer: hash = FNV-1a over seed + inputs, winner chosen by a marker input ─────────
function fnv(words: number[]): number {
  let h = 0x811c9dc5;
  for (const w of words) {
    h ^= w & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (w >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function fakeHash(seed: number, log: [InputBits[], InputBits[]]): number {
  return fnv([seed, log[0].length, ...log[0], 7, log[1].length, ...log[1]]);
}
function view(winner: MatchView['winner']): MatchView {
  const f = () => ({
    hp: 500, stamina: 500, guardHigh: false, head: 'CENTER' as const, phase: 'IDLE' as const, punch: null, body: false,
    phaseFrames: 0, counterWindow: 0, knockdowns: 0, stance: 'orthodox' as const, landed: 0, thrown: 0,
  });
  return { frame: 0, state: 'OVER', round: 3, roundFrame: 0, clockSec: 0, range: 600, fighters: [f(), f()], scores: [[], []], winner, method: winner === null ? null : 'DECISION' };
}
/** Winner = whoever has the most JAB (bit 0) inputs; equal → DRAW. */
const fakeReplayer = {
  replay(seed: number, log: [InputBits[], InputBits[]]): ReplayResult {
    const jabs = (l: InputBits[]) => l.filter((x) => x & 1).length;
    const j0 = jabs(log[0]);
    const j1 = jabs(log[1]);
    const winner: MatchView['winner'] = j0 === j1 ? 'DRAW' : j0 > j1 ? 0 : 1;
    return { hash: fakeHash(seed, log), view: view(winner), frames: Math.min(log[0].length, log[1].length) };
  },
};

// ───────── ws test client ─────────
type MsgOf<T extends ServerMsg['type']> = Extract<ServerMsg, { type: T }>;
class Client {
  readonly inbox: ServerMsg[] = [];
  private waiters: { type: string; resolve: (m: ServerMsg) => void }[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMsg;
      const i = this.waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.inbox.push(m);
    });
  }
  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(new Client(ws)));
      ws.once('error', reject);
    });
  }
  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }
  next<T extends ServerMsg['type']>(type: T, timeoutMs = 3000): Promise<MsgOf<T>> {
    const i = this.inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as MsgOf<T>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`timeout waiting for ${type}; inbox=${JSON.stringify(this.inbox)}`));
      }, timeoutMs);
      const done = (m: ServerMsg) => {
        clearTimeout(timer);
        resolve(m as MsgOf<T>);
      };
      this.waiters.push({ type, resolve: done });
    });
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function matched(port: number, nameA = 'alice', nameB = 'bob') {
  const a = await Client.connect(port);
  const b = await Client.connect(port);
  const wa = await a.next('welcome');
  const wb = await b.next('welcome');
  a.send({ type: 'hello', name: nameA });
  b.send({ type: 'hello', name: nameB });
  a.send({ type: 'queue' });
  await a.next('queued');
  b.send({ type: 'queue' });
  const ma = await a.next('match');
  const mb = await b.next('match');
  return { a, b, wa, wb, ma, mb };
}

describe('signal server', () => {
  let server: SignalServer;
  const clients: Client[] = [];
  const track = (...cs: Client[]) => {
    clients.push(...cs);
    return cs;
  };

  beforeEach(async () => {
    server = createSignalServer({ port: 0, replayer: fakeReplayer, resultTimeoutMs: 100 });
    await server.ready;
    expect(server.port).toBeGreaterThan(0);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) if (c.ws.readyState === WebSocket.OPEN) await c.close();
    await server.close();
  });

  it('(1) two queued clients get a match with complementary roles and the same seed', async () => {
    const { a, b, wa, wb, ma, mb } = await matched(server.port);
    track(a, b);
    expect(wa.id).not.toBe(wb.id);
    expect(ma.matchId).toBe(mb.matchId);
    expect(ma.seed).toBe(mb.seed);
    expect(ma.seed).toBeGreaterThanOrEqual(0);
    expect(ma.seed).toBeLessThan(2 ** 32);
    expect(ma.role).toBe('offer');
    expect(ma.player).toBe(0);
    expect(mb.role).toBe('answer');
    expect(mb.player).toBe(1);
    expect(ma.peerId).toBe(wb.id);
    expect(mb.peerId).toBe(wa.id);
    expect(ma.peerName).toBe('bob');
    expect(mb.peerName).toBe('alice');
    expect(server.state()).toEqual({ queue: 0, matches: 1, players: 2 });
  });

  it('(2) signal messages are relayed between matched peers only', async () => {
    const { a, b, wa, wb } = await matched(server.port);
    track(a, b);
    a.send({ type: 'signal', to: wb.id, data: { kind: 'sdp', description: { type: 'offer', sdp: 'offer-blob' } } });
    const s = await b.next('signal');
    expect(s).toEqual({ type: 'signal', from: wa.id, data: { kind: 'sdp', description: { type: 'offer', sdp: 'offer-blob' } } });
    b.send({ type: 'signal', to: wa.id, data: { kind: 'ice', candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } } });
    expect(await a.next('signal')).toEqual({ type: 'signal', from: wb.id, data: { kind: 'ice', candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } } });

    // a third client is not a peer
    const [c] = track(await Client.connect(server.port));
    const wc = await c.next('welcome');
    c.send({ type: 'signal', to: wa.id, data: 'x' });
    expect((await c.next('error')).message).toMatch(/peer/);
    a.send({ type: 'signal', to: wc.id, data: 'x' });
    expect((await a.next('error')).message).toMatch(/peer/);
    expect(a.inbox.filter((m) => m.type === 'signal')).toHaveLength(0);
  });

  it('(3) results from both sides verify ok with updated Elo; a bad hash fails', async () => {
    const { a, b, ma } = await matched(server.port);
    track(a, b);
    // player 0 jabs more → winner 0
    const log: [InputBits[], InputBits[]] = [[0, 0, 1, 1, 1], [0, 0, 1, 0, 0]];
    const hash = fakeHash(ma.seed, log);
    a.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log, hash });
    b.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log, hash });
    const va = await a.next('verified');
    const vb = await b.next('verified');
    expect(va).toEqual({ type: 'verified', matchId: ma.matchId, ok: true, winner: 0, ratings: [1216, 1184] });
    expect(vb).toEqual(va);
    expect(server.state().matches).toBe(0);
    expect(elo(1200, 1200, 1)).toEqual([1216, 1184]);
    expect(elo(1200, 1200, 0.5)).toEqual([1200, 1200]);

    // rematch: bob submits a wrong hash → ok:false, ratings untouched
    a.send({ type: 'queue' });
    await a.next('queued');
    b.send({ type: 'queue' });
    const m2 = await a.next('match');
    await b.next('match');
    a.send({ type: 'result', matchId: m2.matchId, seed: m2.seed, log, hash: fakeHash(m2.seed, log) });
    b.send({ type: 'result', matchId: m2.matchId, seed: m2.seed, log, hash: 12345 });
    const v2 = await a.next('verified');
    expect(v2.ok).toBe(false);
    expect(v2.winner).toBeNull();
    expect(v2.ratings).toEqual([1216, 1184]);
    expect((await b.next('verified')).ok).toBe(false);
  });

  it('(3b) one uncorroborated result fails closed after timeout; disagreeing logs also fail', async () => {
    const { a, b, ma } = await matched(server.port, 'carol', 'dave');
    track(a, b);
    const log: [InputBits[], InputBits[]] = [[0, 0, 0], [0, 1, 1]]; // player 1 wins
    b.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log, hash: fakeHash(ma.seed, log) });
    const vb = await b.next('verified', 2000);
    expect(vb.ok).toBe(false);
    expect(vb.winner).toBeNull();
    expect(vb.ratings).toEqual([1200, 1200]);
    expect(await a.next('verified')).toEqual(vb);

    // logs that disagree on the common prefix fail verification
    a.send({ type: 'queue' });
    await a.next('queued');
    b.send({ type: 'queue' });
    const m2 = await a.next('match');
    await b.next('match');
    const logA: [InputBits[], InputBits[]] = [[0, 1], [0, 0]];
    const logB: [InputBits[], InputBits[]] = [[0, 0], [0, 0]];
    a.send({ type: 'result', matchId: m2.matchId, seed: m2.seed, log: logA, hash: fakeHash(m2.seed, logA) });
    b.send({ type: 'result', matchId: m2.matchId, seed: m2.seed, log: logB, hash: fakeHash(m2.seed, logB) });
    expect((await a.next('verified')).ok).toBe(false);
    await b.next('verified');
  });

  it('(4) /leaderboard lists the players, /health reports state, CORS is open', async () => {
    const { a, b, ma } = await matched(server.port, 'erin', 'frank');
    track(a, b);
    const log: [InputBits[], InputBits[]] = [[1, 1], [0, 0]];
    const hash = fakeHash(ma.seed, log);
    a.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log, hash });
    b.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log, hash });
    await a.next('verified');
    await b.next('verified');

    const res = await fetch(`http://127.0.0.1:${server.port}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const board = (await res.json()) as { name: string; rating: number; wins: number; losses: number }[];
    expect(board.map((e) => e.name)).toEqual(['erin', 'frank']);
    expect(board[0]).toMatchObject({ name: 'erin', rating: 1216, wins: 1, losses: 0 });
    expect(board[1]).toMatchObject({ name: 'frank', rating: 1184, wins: 0, losses: 1 });

    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await health.json()).toEqual({ ok: true, queue: 0, matches: 0, players: 2 });
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
    const preflight = await fetch(`http://127.0.0.1:${server.port}/leaderboard`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
  });

  it('(5) a disconnect notifies the peer and clears the queue', async () => {
    const { a, b } = await matched(server.port);
    track(a, b);
    await a.close();
    const left = await b.next('peer_left');
    expect(left).toEqual({ type: 'peer_left' });

    // queued client that leaves is removed from the queue
    const [c] = track(await Client.connect(server.port));
    await c.next('welcome');
    c.send({ type: 'queue' });
    await c.next('queued');
    expect(server.state().queue).toBe(1);
    c.send({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.state().queue).toBe(0);
    await c.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(server.state().players).toBe(1);
  });

  it('ping → pong, bad messages → error', async () => {
    const [c] = track(await Client.connect(server.port));
    await c.next('welcome');
    c.send({ type: 'ping', t: 42 });
    expect(await c.next('pong')).toEqual({ type: 'pong', t: 42 });
    c.ws.send('not json');
    expect((await c.next('error')).message).toMatch(/json/);
    c.ws.send(JSON.stringify({ type: 'bogus' }));
    expect((await c.next('error')).message).toMatch(/unknown/);
    c.send({ type: 'result', matchId: 'nope', seed: 1, log: [[], []], hash: 0 });
    expect((await c.next('error')).message).toMatch(/match/);
  });

  it('fails closed without a replayer even when both hashes and logs agree', async () => {
    await server.close();
    server = createSignalServer({ port: 0, resultTimeoutMs: 100 });
    await server.ready;
    const { a, b, ma } = await matched(server.port);
    track(a, b);
    const log: [number[], number[]] = [[1], [0]];
    const result = { type: 'result' as const, matchId: ma.matchId, seed: ma.seed, log, hash: fakeHash(ma.seed, log) };
    a.send(result); b.send(result);
    expect(await a.next('verified')).toMatchObject({ ok: false, winner: null, ratings: [1200, 1200] });
    expect(await b.next('verified')).toMatchObject({ ok: false, winner: null });
  });

  it('rejects malformed bounded logs and unsigned fields before replay, then accepts a valid retry', async () => {
    const { a, b, ma } = await matched(server.port);
    track(a, b);
    const log: [number[], number[]] = [[1], [0]];
    const result = { type: 'result' as const, matchId: ma.matchId, seed: ma.seed, log, hash: fakeHash(ma.seed, log) };
    const malformed: Record<string, unknown>[] = [
      { log: [[], []] }, { log: [[1], []] }, { log: [[1], [0, 0]] },
      { log: [[65536], [0]] }, { log: [[1.5], [0]] }, { log: [[-1], [0]] },
      { log: [Array(MAX_RESULT_FRAMES + 1).fill(0), Array(MAX_RESULT_FRAMES + 1).fill(0)] },
      { hash: -1 }, { hash: 2 ** 32 }, { hash: 1.5 }, { hash: null },
      { seed: -1 }, { seed: 2 ** 32 }, { seed: 1.5 }, { seed: null },
    ];
    for (const patch of malformed) {
      a.ws.send(JSON.stringify({ ...result, ...patch }));
      expect((await a.next('error')).message).toMatch(/malformed result/);
    }
    a.send(result); b.send(result);
    expect(await a.next('verified')).toMatchObject({ ok: true, winner: 0 });
    await b.next('verified');
  });

  it('does not turn an unfinished common-prefix submission into a verified completed match', async () => {
    await server.close();
    server = createSignalServer({ port: 0, resultTimeoutMs: 100, replayer: {
      replay(seed, log) {
        const result = fakeReplayer.replay(seed, log);
        if (log[0].length < 3) result.view = { ...result.view, state: 'FIGHTING', winner: null, method: null };
        return result;
      },
    } });
    await server.ready;
    const { a, b, ma } = await matched(server.port);
    track(a, b);
    const short: [number[], number[]] = [[1], [0]];
    const long: [number[], number[]] = [[1, 1, 1], [0, 0, 0]];
    a.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log: short, hash: fakeHash(ma.seed, short) });
    b.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log: long, hash: fakeHash(ma.seed, long) });
    expect(await a.next('verified')).toMatchObject({ ok: false, winner: null, ratings: [1200, 1200] });
    await b.next('verified');
  });

  it('rejects mismatched outcomes despite agreeing input prefixes', async () => {
    const { a, b, ma } = await matched(server.port);
    track(a, b);
    const short: [number[], number[]] = [[1], [0]];
    const long: [number[], number[]] = [[1, 0, 0], [0, 1, 1]];
    a.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log: short, hash: fakeHash(ma.seed, short) });
    b.send({ type: 'result', matchId: ma.matchId, seed: ma.seed, log: long, hash: fakeHash(ma.seed, long) });
    expect(await a.next('verified')).toMatchObject({ ok: false, winner: null, ratings: [1200, 1200] });
    await b.next('verified');
  });

  it('validates signaling payloads and prevents renaming within a match', async () => {
    const { a, b, wb } = await matched(server.port);
    track(a, b);
    a.send({ type: 'signal', to: wb.id, data: { kind: 'sdp', description: { type: 'rollback', sdp: 'x' } } });
    expect((await a.next('error')).message).toMatch(/malformed signal/);
    a.send({ type: 'signal', to: wb.id, data: { kind: 'ice', candidate: { candidate: 42 } } });
    expect((await a.next('error')).message).toMatch(/malformed signal/);
    a.send({ type: 'hello', name: 'another-player' });
    expect((await a.next('error')).message).toMatch(/cannot rename/);
    a.ws.send(JSON.stringify({ type: 'ping', t: 'not-a-number' }));
    expect((await a.next('error')).message).toMatch(/malformed ping/);
    expect(b.inbox.filter(m => m.type === 'signal')).toHaveLength(0);
  });

  it('closes an oversized message before parsing it', async () => {
    const [c] = track(await Client.connect(server.port));
    await c.next('welcome');
    const closed = new Promise<number>(resolve => c.ws.once('close', resolve));
    c.ws.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);
  });

  it('closes a flood of small messages instead of processing them without bound', async () => {
    const [c] = track(await Client.connect(server.port));
    await c.next('welcome');
    const closed = new Promise<number>(resolve => c.ws.once('close', resolve));
    for (let i = 0; i < MESSAGE_BURST * 2; i++) c.send({ type: 'ping', t: i });
    expect(await closed).toBe(1008);
  });

  it('rejects binary messages on the JSON signaling channel', async () => {
    const [c] = track(await Client.connect(server.port));
    await c.next('welcome');
    const closed = new Promise<number>(resolve => c.ws.once('close', resolve));
    c.ws.send(Buffer.from('{"type":"queue"}'));
    expect(await closed).toBe(1003);
  });


  it('rejects a malformed HTTP request target without crashing the server', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.port, method: 'GET', path: 'http://[' }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
  });

});
