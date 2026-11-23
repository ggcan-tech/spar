import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  copyPose,
  createRally,
  FIXED_STEP,
  launchBall,
  stepDuel,
  validPose,
  type DuelState,
  type PlayerPose,
  type ThrowInput,
} from "../../web/src/pov/duel";

/** Local/private two-person prototype. No authentication, ranked results or public hosting claim. */
export interface PovServerOptions {
  port?: number;
  host?: string;
  log?: (message: string) => void;
}
export interface PovServer {
  readonly port: number;
  ready: Promise<void>;
  close(): Promise<void>;
  stats(): { rooms: number; peers: number };
}
interface Peer {
  ws: WebSocket;
  room: Room | null;
  player: 0 | 1 | null;
  pose: PlayerPose | null;
  ready: boolean;
  lastPoseAt: number;
  pending: { shot: ThrowInput; pose: PlayerPose } | null;
}
interface Room {
  code: string;
  players: [Peer | null, Peer | null];
  state: DuelState;
  accumulator: number;
  running: boolean;
}
export const POV_STALE_MS = 400;
export const POV_MAX_PAYLOAD = 8 * 1024;
const MAX_ROOMS = 64,
  MAX_PEERS = 128;
const BURST = 90,
  RATE = 90;
const INTERVAL_MS = 1000 / 60,
  BROADCAST_MS = 1000 / 30;
const MAX_CATCHUP_MS = 100;

/**
 * Collision points are blended per fixed step. The skeleton is presentation
 * only, so the server relays the latest received one as-is: no extra work per
 * step, and the client's rounded values stay compact on the wire.
 */
function blendPose(a: PlayerPose, b: PlayerPose, t: number): PlayerPose {
  const mix = (x: typeof a.head, y: typeof b.head) => ({
    x: x.x + (y.x - x.x) * t,
    y: x.y + (y.y - x.y) * t,
    z: x.z + (y.z - x.z) * t,
  });
  return {
    head: mix(a.head, b.head),
    root: mix(a.root, b.root),
    leftHand: mix(a.leftHand, b.leftHand),
    rightHand: mix(a.rightHand, b.rightHand),
    ...(b.body ? { body: b.body } : {}),
  };
}
/** `previous` only feeds collision sweeps; it never needs a skeleton on the wire. */
function withoutBody(p: PlayerPose): PlayerPose {
  const { body: _body, ...points } = p;
  return points;
}

export function createPovServer(options: PovServerOptions = {}): PovServer {
  const rooms = new Map<string, Room>(),
    peers = new Set<Peer>();
  let port = options.port ?? 8791,
    closed = false;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError("port must be an integer in [0, 65535]");
  const log = options.log ?? (() => {});
  const send = (peer: Peer, value: unknown) => {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    // Do not queue unbounded snapshots behind a slow consumer.
    if (peer.ws.bufferedAmount > 256 * 1024) {
      peer.ws.close(1008, "slow consumer");
      return;
    }
    peer.ws.send(JSON.stringify(value));
  };
  const error = (peer: Peer, message: string) =>
    send(peer, { type: "error", message });
  /**
   * A ball in the air is committed. Neither player can stop it by pausing,
   * covering the lens or stepping out of frame: the simulation carries on and
   * an absent player is a stationary target at the last pose they sent. Before
   * this, the target could freeze a ball in flight, move, resume, and be missed,
   * with the unmodified client.
   */
  function flightHolds(room: Room): boolean {
    return (
      room.running &&
      room.state.balls.length > 0 &&
      room.players.every((p) => p?.pose)
    );
  }
  function reason(room: Room, now: number): string | null {
    if (room.players.some((p) => !p)) return "Waiting for another player";
    if (room.state.hp.some((h) => h <= 0)) return "Round complete";
    if (flightHolds(room)) return null;
    if (room.players.some((p) => !p!.ready || !p!.pose))
      return "Both players must be ready";
    if (room.players.some((p) => now - p!.lastPoseAt > POV_STALE_MS))
      return "Player tracking is stale — paused";
    return null;
  }
  function broadcast(room: Room, now: number, override?: string): void {
    const why =
      override ??
      reason(room, now) ??
      (room.running ? null : "Synchronizing player poses");
    const message = {
      type: "state",
      state: {
        ...room.state,
        previous: room.state.previous.map(withoutBody),
      },
      ready: why === null,
      reason: why,
    };
    for (const p of room.players) if (p) send(p, message);
  }
  function leave(peer: Peer): void {
    const room = peer.room,
      player = peer.player;
    peer.room = null;
    peer.player = null;
    peer.pending = null;
    if (!room || player === null) return;
    if (room.players[player] === peer) room.players[player] = null;
    // A new connection never inherits projectiles, score or an unsafe old pose history.
    room.state = createRally(0, 0);
    room.accumulator = 0;
    room.running = false;
    for (const remaining of room.players)
      if (remaining) {
        remaining.pending = null;
        remaining.ready = false;
        remaining.pose = null;
        remaining.lastPoseAt = -Infinity;
      }
    if (room.players.every((p) => !p)) rooms.delete(room.code);
    else
      broadcast(room, performance.now(), "Opponent disconnected — round reset");
  }
  function handle(peer: Peer, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      error(peer, "Invalid JSON");
      return;
    }
    if (
      !msg ||
      typeof msg !== "object" ||
      Array.isArray(msg) ||
      typeof msg.type !== "string"
    ) {
      error(peer, "Malformed message");
      return;
    }
    if (msg.type === "join") {
      if (peer.room) {
        error(peer, "Already joined; reconnect to change rooms");
        return;
      }
      if (typeof msg.room !== "string" || !/^[a-z0-9]{6}$/i.test(msg.room)) {
        error(peer, "Room must contain six letters or digits");
        return;
      }
      const code = msg.room.toUpperCase();
      let room = rooms.get(code);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) {
          error(peer, "Local room limit reached");
          return;
        }
        room = {
          code,
          players: [null, null],
          state: createRally(0, 0),
          accumulator: 0,
          running: false,
        };
        rooms.set(code, room);
      }
      const player =
        room.players[0] === null ? 0 : room.players[1] === null ? 1 : null;
      if (player === null) {
        error(peer, "Room is full");
        return;
      }
      room.players[player] = peer;
      peer.room = room;
      peer.player = player;
      send(peer, { type: "joined", player });
      broadcast(room, performance.now());
      return;
    }
    if (!peer.room || peer.player === null) {
      error(peer, "Join a room first");
      return;
    }
    if (msg.type === "pose") {
      if (
        typeof msg.ready !== "boolean" ||
        !validPose(msg.pose as PlayerPose)
      ) {
        error(peer, "Invalid pose or readiness");
        return;
      }
      peer.pose = copyPose(msg.pose as PlayerPose);
      peer.ready = msg.ready;
      peer.lastPoseAt = performance.now();
      return;
    }
    if (msg.type === "throw") {
      const why = reason(peer.room, performance.now());
      if (why || !peer.room.running) {
        error(peer, why ?? "Synchronizing player poses");
        return;
      }
      if (!validPose(msg.pose as PlayerPose)) {
        error(peer, "Throw rejected: measured release pose required");
        return;
      }
      if (peer.pending) {
        error(peer, "Throw rejected: release already queued");
        return;
      }
      const pose = copyPose(msg.pose as PlayerPose);
      const poses: [PlayerPose, PlayerPose] = [...peer.room.state.poses];
      poses[peer.player] = pose;
      // Validate against the atomic measured release, without rewriting collision history.
      if (
        launchBall(
          { ...peer.room.state, poses },
          peer.player,
          msg.shot as ThrowInput,
        ).nextId === peer.room.state.nextId
      ) {
        error(peer, "Throw rejected: invalid launch or cooldown");
        return;
      }
      const shot = msg.shot as ThrowInput;
      peer.pending = {
        pose,
        shot: {
          origin: { ...shot.origin },
          velocity: { ...shot.velocity },
          spin: { ...shot.spin },
        },
      };
      return;
    }
    error(peer, "Unknown message type");
  }

  const http = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400);
      res.end("Invalid request target");
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          ok: true,
          scope: "local-private-prototype",
          rooms: rooms.size,
          peers: peers.size,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({
    server: http,
    maxPayload: POV_MAX_PAYLOAD,
    perMessageDeflate: false,
  });
  wss.on("connection", (ws) => {
    ws.on("error", () => log("POV socket error"));
    if (peers.size >= MAX_PEERS) {
      ws.close(1008, "local connection limit");
      return;
    }
    const peer: Peer = {
      ws,
      room: null,
      player: null,
      pose: null,
      ready: false,
      lastPoseAt: -Infinity,
      pending: null,
    };
    peers.add(peer);
    let tokens = BURST,
      last = performance.now();
    ws.on("message", (data, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (binary) {
        ws.close(1003, "text JSON required");
        return;
      }
      const now = performance.now();
      tokens = Math.min(BURST, tokens + ((now - last) * RATE) / 1000);
      last = now;
      if (tokens < 1) {
        ws.close(1008, "message rate exceeded");
        return;
      }
      tokens--;
      handle(peer, String(data));
    });
    ws.on("close", () => {
      peers.delete(peer);
      leave(peer);
    });
  });
  let lastTick = performance.now(),
    lastBroadcast = lastTick;
  const timer = setInterval(() => {
    const now = performance.now(),
      elapsed = now - lastTick;
    lastTick = now;
    for (const room of rooms.values()) {
      const why = reason(room, now);
      if (why || elapsed > MAX_CATCHUP_MS || elapsed < 0) {
        room.accumulator = 0;
        room.running = false;
        for (const peer of room.players) if (peer) peer.pending = null;
        if (!why) broadcast(room, now, "Server timing recovery — paused");
        continue;
      }
      const target: [PlayerPose, PlayerPose] = [
        room.players[0]!.pose!,
        room.players[1]!.pose!,
      ];
      if (!room.running) {
        room.state = {
          ...room.state,
          poses: target.map(copyPose) as [PlayerPose, PlayerPose],
          previous: target.map(copyPose) as [PlayerPose, PlayerPose],
        };
        room.running = true;
        room.accumulator = 0;
      }
      room.accumulator += elapsed / 1000;
      const steps = Math.floor(room.accumulator / FIXED_STEP);
      if (steps > 0)
        for (const peer of room.players) {
          if (!peer?.pending || peer.player === null) continue;
          const pending = peer.pending;
          peer.pending = null;
          const poses: [PlayerPose, PlayerPose] = [...room.state.poses];
          poses[peer.player] = pending.pose;
          const launched = launchBall(
            { ...room.state, poses },
            peer.player,
            pending.shot,
          );
          if (launched.nextId === room.state.nextId) {
            error(peer, "Throw rejected: invalid launch or cooldown");
            continue;
          }
          room.state = {
            ...room.state,
            balls: launched.balls,
            cooldown: launched.cooldown,
            nextId: launched.nextId,
            message: launched.message,
            rally: launched.rally,
          };
        }
      const start = room.state.poses;
      for (let i = 0; i < steps; i++) {
        const poses: [PlayerPose, PlayerPose] = [
          blendPose(start[0], target[0], (i + 1) / steps),
          blendPose(start[1], target[1], (i + 1) / steps),
        ];
        room.state = stepDuel(room.state, poses, FIXED_STEP);
        room.accumulator -= FIXED_STEP;
      }
    }
    if (now - lastBroadcast >= BROADCAST_MS) {
      for (const room of rooms.values()) broadcast(room, now);
      lastBroadcast = now;
    }
  }, INTERVAL_MS);
  const ready = new Promise<void>((resolve, reject) => {
    http.once("error", (err) => {
      clearInterval(timer);
      reject(err);
    });
    http.listen(port, options.host ?? "127.0.0.1", () => {
      port = (http.address() as AddressInfo).port;
      log(
        `POV local server listening on ${options.host ?? "127.0.0.1"}:${port}`,
      );
      resolve();
    });
  });
  return {
    get port() {
      return port;
    },
    ready,
    stats: () => ({ rooms: rooms.size, peers: peers.size }),
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      peers.clear();
      rooms.clear();
    },
  };
}
