import { Capacitor } from '@capacitor/core';
import type { ClientMsg, InputBits, ServerMsg } from '@spar/protocol';
import { SIGNAL_PORT } from '@spar/protocol';
import type { MatchMsg, VerifiedMsg } from './types';

/** Typed event map for the signaling client. */
export interface SignalingEvents {
  open: [];
  close: [code: number, reason: string];
  /** Socket-level failure or a server `{type:'error'}` message. */
  error: [message: string];
  welcome: [id: string];
  queued: [size: number];
  match: [m: MatchMsg];
  signal: [from: string, data: unknown];
  verified: [m: VerifiedMsg];
  peer_left: [];
  pong: [t: number];
  /** Smoothed round-trip estimate, emitted after every pong. */
  rtt: [ms: number];
  /** Every raw server message, for debugging. */
  message: [msg: ServerMsg];
}

type Listener<K extends keyof SignalingEvents> = (...args: SignalingEvents[K]) => void;

export interface SignalingClient {
  readonly url: string;
  /** Our id as assigned by the server's `welcome`; null until connected. */
  readonly id: string | null;
  /** Latest smoothed RTT in ms (0 until the first pong). */
  readonly rttMs: number;
  readonly connected: boolean;
  /** Opens the socket; resolves with our id once `welcome` arrives. Idempotent. */
  connect(): Promise<string>;
  hello(name: string): void;
  queue(): void;
  leave(): void;
  signal(to: string, data: unknown): void;
  result(matchId: string, seed: number, log: [InputBits[], InputBits[]], hash: number): void;
  ping(): void;
  send(msg: ClientMsg): void;
  on<K extends keyof SignalingEvents>(event: K, cb: Listener<K>): () => void;
  once<K extends keyof SignalingEvents>(event: K, cb: Listener<K>): () => void;
  close(): void;
}

/**
 * Resolves the signaling URL: `?signal=` query param > VITE_SIGNAL_URL > ws://<host>:8787.
 * Safe to call outside a browser (falls back to localhost).
 */
export function signalUrl(): string {
  if (typeof location !== 'undefined') {
    try {
      const q = new URLSearchParams(location.search).get('signal');
      if (q) return q;
    } catch {
      /* ignore malformed query */
    }
  }
  const env = import.meta.env;
  if (env?.VITE_SIGNAL_URL) return env.VITE_SIGNAL_URL;
  // A packaged phone app has no signaling server at its own localhost.
  if (Capacitor.isNativePlatform()) return '';
  const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}:${SIGNAL_PORT}`;
}

const PING_INTERVAL_MS = 2000;

export function createSignaling(url: string = signalUrl()): SignalingClient {
  const listeners = new Map<keyof SignalingEvents, Set<(...args: never[]) => void>>();
  let ws: WebSocket | null = null;
  let id: string | null = null;
  let rttMs = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let connectPromise: Promise<string> | null = null;
  let closedByUs = false;

  function emit<K extends keyof SignalingEvents>(event: K, ...args: SignalingEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        (cb as (...a: SignalingEvents[K]) => void)(...args);
      } catch (err) {
        console.error(`[signaling] listener for ${event} threw`, err);
      }
    }
  }

  function on<K extends keyof SignalingEvents>(event: K, cb: Listener<K>): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb as (...args: never[]) => void);
    return () => {
      set?.delete(cb as (...args: never[]) => void);
    };
  }

  function once<K extends keyof SignalingEvents>(event: K, cb: Listener<K>): () => void {
    const off = on(event, ((...args: SignalingEvents[K]) => {
      off();
      cb(...args);
    }) as Listener<K>);
    return off;
  }

  function send(msg: ClientMsg): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  function stopPing(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function handle(msg: ServerMsg): void {
    emit('message', msg);
    switch (msg.type) {
      case 'welcome':
        id = msg.id;
        emit('welcome', msg.id);
        break;
      case 'queued':
        emit('queued', msg.size);
        break;
      case 'match':
        emit('match', msg);
        break;
      case 'signal':
        emit('signal', msg.from, msg.data);
        break;
      case 'verified':
        emit('verified', msg);
        break;
      case 'peer_left':
        emit('peer_left');
        break;
      case 'pong': {
        const sample = Math.max(0, performance.now() - msg.t);
        rttMs = rttMs === 0 ? sample : rttMs * 0.7 + sample * 0.3;
        emit('pong', msg.t);
        emit('rtt', rttMs);
        break;
      }
      case 'error':
        emit('error', msg.message);
        break;
    }
  }

  function connect(): Promise<string> {
    if (!url) return Promise.reject(new Error('Online fights are not configured in this build.'));
    if (connectPromise) return connectPromise;
    closedByUs = false;
    connectPromise = new Promise<string>((resolve, reject) => {
      let settled = false;
      let sock: WebSocket;
      try {
        sock = new WebSocket(url);
      } catch (err) {
        connectPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws = sock;
      const offWelcome = once('welcome', (assigned) => {
        settled = true;
        resolve(assigned);
      });
      sock.onopen = () => {
        emit('open');
        stopPing();
        pingTimer = setInterval(() => ping(), PING_INTERVAL_MS);
        ping();
      };
      sock.onmessage = (ev) => {
        let parsed: ServerMsg;
        try {
          parsed = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') handle(parsed);
      };
      sock.onerror = () => {
        const message = `signaling socket error (${url})`;
        emit('error', message);
        if (!settled) {
          settled = true;
          offWelcome();
          connectPromise = null;
          reject(new Error(message));
        }
      };
      sock.onclose = (ev) => {
        stopPing();
        if (ws === sock) ws = null;
        connectPromise = null;
        emit('close', ev.code, ev.reason);
        if (!settled) {
          settled = true;
          offWelcome();
          reject(new Error(closedByUs ? 'cancelled' : `signaling closed (${ev.code})`));
        }
      };
    });
    return connectPromise;
  }

  function ping(): void {
    send({ type: 'ping', t: performance.now() });
  }

  function close(): void {
    closedByUs = true;
    stopPing();
    const sock = ws;
    ws = null;
    connectPromise = null;
    if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
      try {
        sock.close(1000, 'client closed');
      } catch {
        /* already closed */
      }
    }
  }

  return {
    url,
    get id() {
      return id;
    },
    get rttMs() {
      return rttMs;
    },
    get connected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    connect,
    hello: (name) => send({ type: 'hello', name }),
    queue: () => send({ type: 'queue' }),
    leave: () => send({ type: 'leave' }),
    signal: (to, data) => send({ type: 'signal', to, data }),
    result: (matchId, seed, log, hash) => send({ type: 'result', matchId, seed, log, hash }),
    ping,
    send,
    on,
    once,
    close,
  };
}
