/**
 * @spar/signal — WebSocket matchmaking / signaling / result-verification server.
 *
 * One port serves both:
 *   • WebSocket (ws): welcome → hello/queue/leave/signal/ping/result (see ClientMsg / ServerMsg)
 *   • HTTP: GET /health → { ok, queue, matches, players }, GET /leaderboard → top 50, CORS *.
 *
 * Verification: when both results of a match are in (or `resultTimeoutMs` after the first one),
 * the replayer re-runs both bounded input logs. A result is ok only when both peers submit, both
 * replays complete with matching outcome, each hash matches its own replay, and both logs agree
 * on their common prefix. A missing peer or replayer fails closed. Ratings are
 * Elo (K = 32, start 1200, draw = 0.5), kept in memory and keyed by player name.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, InputBits, MatchView, ReplayResult, ServerMsg } from '@spar/protocol';

export interface Replayer {
  replay(seed: number, log: [InputBits[], InputBits[]]): ReplayResult;
}

export interface SignalServerOptions {
  port: number;
  replayer?: Replayer;
  log?: (msg: string) => void;
  /** How long to wait for the second result before rejecting an uncorroborated result. Default 5000 ms. */
  resultTimeoutMs?: number;
}

export interface SignalServerState {
  queue: number;
  matches: number;
  players: number;
}

export interface LeaderboardEntry {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface SignalServer {
  close(): Promise<void>;
  /** Bound port (equals opts.port unless 0 was given; then valid once `ready` resolves). */
  readonly port: number;
  /** Resolves once the server is listening. */
  readonly ready: Promise<void>;
  state(): SignalServerState;
  leaderboard(): LeaderboardEntry[];
}

export const ELO_K = 32;
export const ELO_START = 1200;
export const LEADERBOARD_SIZE = 50;
const DEFAULT_RESULT_TIMEOUT_MS = 5000;
const MAX_NAME_LENGTH = 24;
/** Ten minutes at 60Hz; includes all round/rest/knockdown time and a generous tail. */
export const MAX_RESULT_FRAMES = 60 * 60 * 10;
/** A worst-case bounded log is <433kB; reject larger messages before JSON parsing. */
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const MESSAGE_BURST = 120;
const MESSAGE_RATE_PER_SECOND = 12;
const BYTE_BURST = 1024 * 1024;
const BYTE_RATE_PER_SECOND = 100 * 1024;
const MAX_SIGNAL_BYTES = 64 * 1024;
const isUint32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSignal(data: unknown): boolean {
  if (!isRecord(data) || Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_SIGNAL_BYTES) return false;
  if (data.kind === 'sdp') {
    const d = data.description;
    return isRecord(d) && (d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string';
  }
  if (data.kind === 'ice') {
    const c = data.candidate;
    return isRecord(c) && typeof c.candidate === 'string' &&
      (c.sdpMid == null || typeof c.sdpMid === 'string') &&
      (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && Number(c.sdpMLineIndex) >= 0));
  }
  return false;
}

interface Player {
  id: string;
  name: string;
  ws: WebSocket;
  matchId: string | null;
}

interface Submission {
  seed: number;
  log: [InputBits[], InputBits[]];
  hash: number;
}

interface Match {
  id: string;
  seed: number;
  playerIds: [string, string];
  names: [string, string];
  results: [Submission | null, Submission | null];
  timer: NodeJS.Timeout | null;
  done: boolean;
}

interface Rating extends LeaderboardEntry {}

/** Elo update: returns the new ratings given player 0's score (1 win, 0.5 draw, 0 loss). */
export function elo(r0: number, r1: number, score0: number, k = ELO_K): [number, number] {
  const e0 = 1 / (1 + Math.pow(10, (r1 - r0) / 400));
  const e1 = 1 - e0;
  return [Math.round(r0 + k * (score0 - e0)), Math.round(r1 + k * (1 - score0 - e1))];
}

function logFrames(log: [InputBits[], InputBits[]]): number {
  return Math.min(log[0].length, log[1].length);
}

function logsAgree(a: [InputBits[], InputBits[]], b: [InputBits[], InputBits[]]): boolean {
  for (let p = 0; p < 2; p++) {
    const n = Math.min(a[p].length, b[p].length);
    for (let f = 0; f < n; f++) if (a[p][f] !== b[p][f]) return false;
  }
  return true;
}

function sameLog(a: [InputBits[], InputBits[]], b: [InputBits[], InputBits[]]): boolean {
  return a[0].length === b[0].length && a[1].length === b[1].length && logsAgree(a, b);
}

function isInputLog(v: unknown): v is [InputBits[], InputBits[]] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Array.isArray(v[0]) && Array.isArray(v[1]) &&
    v[0].length > 0 && v[0].length <= MAX_RESULT_FRAMES && v[0].length === v[1].length &&
    v.every((arr) => Array.isArray(arr) && arr.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffff))
  );
}

export function createSignalServer(opts: SignalServerOptions): SignalServer {
  const log = opts.log ?? (() => {});
  const replayer = opts.replayer;
  const resultTimeoutMs = opts.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;

  const players = new Map<string, Player>();
  const queue: Player[] = [];
  const matches = new Map<string, Match>();
  const ratings = new Map<string, Rating>();
  let boundPort = opts.port;

  const state = (): SignalServerState => ({ queue: queue.length, matches: matches.size, players: players.size });

  const leaderboard = (): LeaderboardEntry[] =>
    [...ratings.values()]
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, LEADERBOARD_SIZE)
      .map((r) => ({ ...r }));

  function ratingFor(name: string): Rating {
    let r = ratings.get(name);
    if (!r) {
      r = { name, rating: ELO_START, wins: 0, losses: 0, draws: 0 };
      ratings.set(name, r);
    }
    return r;
  }

  function send(p: Player | undefined, msg: ServerMsg): void {
    if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
  }

  function peerOf(m: Match, p: Player): Player | undefined {
    const otherId = m.playerIds[0] === p.id ? m.playerIds[1] : m.playerIds[0];
    return players.get(otherId);
  }

  function dequeue(p: Player): void {
    const i = queue.indexOf(p);
    if (i >= 0) queue.splice(i, 1);
  }

  // ── matchmaking ──
  function enqueue(p: Player): void {
    if (p.matchId) {
      send(p, { type: 'error', message: 'already in a match' });
      return;
    }
    if (!queue.includes(p)) queue.push(p);
    send(p, { type: 'queued', size: queue.length });
    log(`queue ${p.name}(${p.id}) size=${queue.length}`);
    while (queue.length >= 2) {
      const p0 = queue.shift() as Player;
      const p1 = queue.shift() as Player;
      createMatch(p0, p1);
    }
  }

  function createMatch(p0: Player, p1: Player): void {
    const m: Match = {
      id: 'm_' + randomBytes(6).toString('hex'),
      seed: randomInt(0, 0x100000000),
      playerIds: [p0.id, p1.id],
      names: [p0.name, p1.name],
      results: [null, null],
      timer: null,
      done: false,
    };
    matches.set(m.id, m);
    p0.matchId = m.id;
    p1.matchId = m.id;
    send(p0, { type: 'match', matchId: m.id, peerId: p1.id, role: 'offer', seed: m.seed, player: 0, peerName: p1.name });
    send(p1, { type: 'match', matchId: m.id, peerId: p0.id, role: 'answer', seed: m.seed, player: 1, peerName: p0.name });
    log(`match ${m.id} ${p0.name} vs ${p1.name} seed=${m.seed}`);
  }

  // ── results & verification ──
  function scheduleFinish(m: Match): void {
    if (m.done || m.timer) return;
    m.timer = setTimeout(() => {
      m.timer = null;
      finish(m);
    }, resultTimeoutMs);
  }

  function dropMatch(m: Match): void {
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    m.done = true;
    matches.delete(m.id);
    for (const id of m.playerIds) {
      const p = players.get(id);
      if (p && p.matchId === m.id) p.matchId = null;
    }
  }

  /** Called when the wait for results is over: verify if anything was submitted, else just drop. */
  function finish(m: Match): void {
    if (m.done) return;
    if (m.results[0] || m.results[1]) verify(m);
    else dropMatch(m);
  }

  function verify(m: Match): void {
    if (m.done) return;
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    m.done = true;

    const [a, b] = m.results;
    let ok = Boolean(a && b && replayer);
    let winner: MatchView['winner'] = null;
    let detail = !a || !b ? 'both player submissions are required' : !replayer ? 'replayer unavailable' : '';
    if (ok && a && b && replayer) {
      if (a.seed !== m.seed || b.seed !== m.seed || !logsAgree(a.log, b.log)) {
        ok = false;
        detail = 'seed or input logs disagree';
      } else {
        try {
          const ra = replayer.replay(m.seed, a.log);
          const rb = sameLog(a.log, b.log) ? ra : replayer.replay(m.seed, b.log);
          // Different confirmed tail lengths are normal with rollback. Both must independently
          // finish; a matching prefix never upgrades an unfinished replay to a finished match.
          const complete = (r: ReplayResult) => r.view.state === 'OVER' &&
            (r.view.winner === 0 || r.view.winner === 1 || r.view.winner === 'DRAW') &&
            (r.view.method === 'KO' || r.view.method === 'TKO' || r.view.method === 'DECISION');
          ok = ra.hash === a.hash && rb.hash === b.hash &&
            ra.frames === a.log[0].length && rb.frames === b.log[0].length &&
            complete(ra) && complete(rb) && ra.view.winner === rb.view.winner &&
            ra.view.method === rb.view.method && JSON.stringify(ra.view.scores) === JSON.stringify(rb.view.scores);
          if (ok) winner = ra.view.winner;
          else detail = 'replays must both complete with matching outcome and valid hashes';
        } catch (err) {
          ok = false;
          detail = `replay failed: ${(err as Error)?.message ?? err}`;
        }
      }
    }

    const r0 = ratingFor(m.names[0]);
    const r1 = ratingFor(m.names[1]);
    if (ok && winner !== null) {
      const score0 = winner === 0 ? 1 : winner === 1 ? 0 : 0.5;
      const [n0, n1] = elo(r0.rating, r1.rating, score0);
      r0.rating = n0;
      r1.rating = n1;
      if (winner === 0) {
        r0.wins++;
        r1.losses++;
      } else if (winner === 1) {
        r1.wins++;
        r0.losses++;
      } else {
        r0.draws++;
        r1.draws++;
      }
    }
    log(`verified ${m.id} ok=${ok} winner=${winner} ratings=${r0.rating}/${r1.rating}${detail ? ' ' + detail : ''}`);
    const msg: ServerMsg = { type: 'verified', matchId: m.id, ok, winner, ratings: [r0.rating, r1.rating] };
    for (const id of m.playerIds) send(players.get(id), msg);
    dropMatch(m);
  }

  function onResult(p: Player, msg: Extract<ClientMsg, { type: 'result' }>): void {
    const m = matches.get(msg.matchId);
    const idx = m ? m.playerIds.indexOf(p.id) : -1;
    if (!m || idx < 0 || m.done) {
      send(p, { type: 'error', message: 'unknown match' });
      return;
    }
    if (!isInputLog(msg.log) || !isUint32(msg.hash) || !isUint32(msg.seed)) {
      send(p, { type: 'error', message: 'malformed result' });
      return;
    }
    if (m.results[idx]) {
      send(p, { type: 'error', message: 'result already submitted' });
      return;
    }
    m.results[idx] = { seed: msg.seed, log: msg.log, hash: msg.hash >>> 0 };
    log(`result ${m.id} from ${p.name} frames=${logFrames(msg.log)} hash=${msg.hash >>> 0}`);
    if (m.results[0] && m.results[1]) verify(m);
    else scheduleFinish(m);
  }

  // ── leaving / disconnecting ──
  function leaveMatch(p: Player, reason: string): void {
    if (!p.matchId) return;
    const m = matches.get(p.matchId);
    p.matchId = null;
    if (!m || m.done) return;
    const peer = peerOf(m, p);
    log(`${reason} ${p.name} left ${m.id}`);
    send(peer, { type: 'peer_left' });
    const peerPresent = peer !== undefined && peer.matchId === m.id;
    if (!peerPresent && !m.results[0] && !m.results[1]) dropMatch(m);
    else scheduleFinish(m); // give the remaining side a chance to submit its result
  }

  // ── message dispatch ──
  function onMessage(p: Player, raw: unknown): void {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      send(p, { type: 'error', message: 'invalid json' });
      return;
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') {
      send(p, { type: 'error', message: 'invalid message' });
      return;
    }
    switch (msg.type) {
      case 'hello': {
        if (typeof msg.name !== 'string' || msg.name.length > MAX_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(msg.name)) {
          send(p, { type: 'error', message: 'invalid name' });
          return;
        }
        if (p.matchId || queue.includes(p)) {
          send(p, { type: 'error', message: 'cannot rename while queued or in a match' });
          return;
        }
        p.name = msg.name.trim() || 'anon';
        ratingFor(p.name);
        break;
      }
      case 'queue':
        enqueue(p);
        break;
      case 'leave':
        dequeue(p);
        leaveMatch(p, 'leave');
        break;
      case 'signal': {
        const m = p.matchId ? matches.get(p.matchId) : undefined;
        const peer = m ? peerOf(m, p) : undefined;
        if (!m || !peer || peer.id !== msg.to || peer.matchId !== m.id) {
          send(p, { type: 'error', message: 'not your peer' });
          return;
        }
        if (!isSignal(msg.data)) {
          send(p, { type: 'error', message: 'malformed signal' });
          return;
        }
        send(peer, { type: 'signal', from: p.id, data: msg.data });
        break;
      }
      case 'ping':
        if (typeof msg.t !== 'number' || !Number.isFinite(msg.t) || msg.t < 0) {
          send(p, { type: 'error', message: 'malformed ping' });
          return;
        }
        send(p, { type: 'pong', t: msg.t });
        break;
      case 'result':
        onResult(p, msg);
        break;
      default:
        send(p, { type: 'error', message: `unknown message type ${(msg as { type: string }).type}` });
    }
  }

  // ── HTTP ──
  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch {
      json(res, 400, { error: 'invalid request target' });
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    if (url.pathname === '/health') json(res, 200, { ok: true, ...state() });
    else if (url.pathname === '/leaderboard') json(res, 200, leaderboard());
    else json(res, 404, { error: 'not found' });
  });

  // ── WebSocket ──
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  wss.on('connection', (ws: WebSocket) => {
    const p: Player = { id: randomBytes(4).toString('hex'), name: 'anon', ws, matchId: null };
    players.set(p.id, p);
    log(`connect ${p.id} players=${players.size}`);
    send(p, { type: 'welcome', id: p.id });
    let tokens = MESSAGE_BURST;
    let bytes = BYTE_BURST;
    let last = performance.now();
    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      const elapsedSeconds = Math.max(0, now - last) / 1000;
      tokens = Math.min(MESSAGE_BURST, tokens + elapsedSeconds * MESSAGE_RATE_PER_SECOND);
      bytes = Math.min(BYTE_BURST, bytes + elapsedSeconds * BYTE_RATE_PER_SECOND);
      last = now;
      const size = Array.isArray(data) ? data.reduce((n, b) => n + b.byteLength, 0) : data.byteLength;
      if (isBinary) { ws.close(1003, 'text messages required'); return; }
      if (tokens < 1 || bytes < size) { ws.close(1008, 'message rate exceeded'); return; }
      tokens--; bytes -= size;
      onMessage(p, data);
    });
    ws.on('error', (err) => log(`ws error ${p.id}: ${err.message}`));
    ws.on('close', () => {
      players.delete(p.id);
      dequeue(p);
      leaveMatch(p, 'disconnect');
      log(`disconnect ${p.id} players=${players.size}`);
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, () => {
      boundPort = (http.address() as AddressInfo).port;
      log(`signal server listening on :${boundPort}`);
      resolve();
    });
  });

  async function close(): Promise<void> {
    for (const m of matches.values()) if (m.timer) clearTimeout(m.timer);
    matches.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  return {
    close,
    get port() {
      return boundPort;
    },
    ready,
    state,
    leaderboard,
  };
}
