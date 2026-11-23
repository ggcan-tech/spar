import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createPovServer,
  POV_MAX_PAYLOAD,
  type PovServer,
} from "../src/povServer";
import { neutralPose, type DuelState } from "../../web/src/pov/duel";
import { JOINT, solveBody } from "../../web/src/pov/body";

type StateMessage = {
  type: "state";
  state: DuelState;
  ready: boolean;
  reason: string | null;
};
type Message =
  | StateMessage
  | { type: "joined"; player: 0 | 1 }
  | { type: "error"; message: string };
class Client {
  inbox: Message[] = [];
  waiters = new Set<() => void>();
  heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      this.inbox.push(JSON.parse(String(raw)));
      for (const check of [...this.waiters]) check();
    });
  }
  send(value: unknown) {
    this.ws.send(JSON.stringify(value));
  }
  next<T extends Message["type"]>(
    type: T,
    accept: (m: Extract<Message, { type: T }>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Extract<Message, { type: T }>> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      const check = () => {
        const index = this.inbox.findIndex(
          (m) => m.type === type && accept(m as Extract<Message, { type: T }>),
        );
        if (index >= 0) {
          cleanup();
          resolve(
            this.inbox.splice(index, 1)[0] as Extract<Message, { type: T }>,
          );
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${type}; recent=${JSON.stringify(this.inbox.slice(-2))}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
  ready() {
    const pose = () =>
      this.send({ type: "pose", pose: neutralPose(), ready: true });
    pose();
    this.heartbeat = setInterval(pose, 50);
  }
  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
let server: PovServer;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) {
    c.stopHeartbeat();
    c.ws.terminate();
  }
  await server?.close();
});
async function start() {
  server = createPovServer({ port: 0 });
  await server.ready;
}
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const c = new Client(ws);
  clients.push(c);
  return c;
}
async function pair() {
  await start();
  const a = await connect(),
    b = await connect();
  a.send({ type: "join", room: "DUEL01" });
  expect((await a.next("joined")).player).toBe(0);
  b.send({ type: "join", room: "duel01" });
  expect((await b.next("joined")).player).toBe(1);
  a.ready();
  b.ready();
  await a.next("state", (m) => m.ready);
  await b.next("state", (m) => m.ready);
  return { a, b };
}

describe("local authoritative POV server", () => {
  it("relays a player's skeleton to the opponent and rejects a malformed one", async () => {
    const { a, b } = await pair();
    a.stopHeartbeat();
    const pose = neutralPose();
    const body = solveBody(pose);
    body[JOINT.R_ELBOW].y = 1.7;
    const send = () => a.send({ type: "pose", pose: { ...pose, body }, ready: true });
    send();
    a.heartbeat = setInterval(send, 50);
    const seen = await b.next(
      "state",
      (m) => m.state.poses[0].body?.[JOINT.R_ELBOW].y === 1.7,
    );
    expect(seen.state.poses[0].body).toEqual(body);
    // The other player sent none, and collision history never carries one.
    expect(seen.state.poses[1].body).toBeUndefined();
    expect(seen.state.previous[0].body).toBeUndefined();
    a.send({
      type: "pose",
      pose: { ...pose, body: body.slice(2) },
      ready: true,
    });
    expect((await a.next("error")).message).toMatch(/Invalid pose/);
  });
  it("joins exactly two clients and resolves a real physics hit in a shared room", async () => {
    const { a, b } = await pair();
    a.send({
      type: "throw",
      pose: neutralPose(),
      shot: {
        origin: neutralPose().rightHand,
        velocity: { x: -0.4, y: 4, z: 12 },
        spin: { x: 0, y: 0, z: 0 },
      },
    });
    const aa = await a.next("state", (m) => m.state.hits === 1);
    const bb = await b.next("state", (m) => m.state.hits === 1);
    expect(aa.state.hp).toEqual([5, 4]);
    expect(bb.state.hp).toEqual(aa.state.hp);
    expect(aa.state.balls).toHaveLength(0);
    expect(aa.state.misses).toBe(0);
    expect(aa.state.rally).toMatchObject({ turn: 1, phase: "ready" });
    a.send({
      type: "throw",
      pose: neutralPose(),
      shot: {
        origin: neutralPose().rightHand,
        velocity: { x: -0.4, y: 4, z: 12 },
        spin: { x: 0, y: 0, z: 0 },
      },
    });
    expect((await a.next("error")).message).toMatch(/rejected/);
    await b.next("state", (m) => m.state.time >= aa.state.rally!.readyAt);
    b.send({
      type: "throw",
      pose: neutralPose(),
      shot: {
        origin: neutralPose().rightHand,
        velocity: { x: -0.4, y: 4, z: 12 },
        spin: { x: 0, y: 0, z: 0 },
      },
    });
    const reply = await a.next("state", (m) => m.state.hits === 2);
    expect(reply.state.hp).toEqual([4, 4]);
    expect(reply.state.rally).toMatchObject({ turn: 0, phase: "ready" });
    const third = await connect();
    third.send({ type: "join", room: "DUEL01" });
    expect((await third.next("error")).message).toMatch(/full/);
    expect(server.stats()).toEqual({ rooms: 1, peers: 3 });
  });

  it("does not let the target stop a ball in flight by pausing or going silent", async () => {
    for (const escape of ["not-ready", "silent"] as const) {
      const { a, b } = await pair();
      a.send({
        type: "throw",
        pose: neutralPose(),
        shot: {
          origin: neutralPose().rightHand,
          velocity: { x: -0.4, y: 4, z: 12 },
          spin: { x: 0, y: 0, z: 0 },
        },
      });
      const flying = await a.next("state", (m) => m.state.balls.length === 1);
      // The target tries to freeze the ball: presses pause, or stops sending.
      b.stopHeartbeat();
      if (escape === "not-ready")
        b.send({ type: "pose", pose: neutralPose(), ready: false });
      const landed = await a.next("state", (m) => m.state.hits === 1, 4000);
      expect(landed.state.hp).toEqual([5, 4]);
      expect(landed.state.time).toBeGreaterThan(flying.state.time);
      // With the ball resolved and the target still away, play does pause.
      const paused = await a.next("state", (m) => !m.ready && !!m.reason);
      expect(paused.state.balls).toHaveLength(0);
      for (const c of clients.splice(0)) {
        c.stopHeartbeat();
        c.ws.terminate();
      }
      await server.close();
    }
  });

  it("pauses without fresh ready input and cannot launch while stale", async () => {
    const { a, b } = await pair();
    b.stopHeartbeat();
    const paused = await a.next(
      "state",
      (m) => !m.ready && !!m.reason?.includes("stale"),
    );
    a.inbox = [];
    const again = await a.next(
      "state",
      (m) => !m.ready && !!m.reason?.includes("stale"),
    );
    expect(again.state.time).toBe(paused.state.time);
    a.send({
      type: "throw",
      pose: neutralPose(),
      shot: {
        origin: neutralPose().rightHand,
        velocity: { x: 0, y: 4, z: 12 },
        spin: { x: 0, y: 0, z: 0 },
      },
    });
    expect((await a.next("error")).message).toMatch(/stale/);
  });

  it("resets projectiles and score on disconnect and cleans up an empty room", async () => {
    const { a, b } = await pair();
    a.send({
      type: "throw",
      pose: neutralPose(),
      shot: {
        origin: neutralPose().rightHand,
        velocity: { x: 0, y: 4, z: 12 },
        spin: { x: 0, y: 0, z: 0 },
      },
    });
    await a.next("state", (m) => m.state.balls.length === 1);
    b.stopHeartbeat();
    b.ws.close();
    const reset = await a.next(
      "state",
      (m) => m.reason?.includes("disconnected") === true,
    );
    expect(reset.ready).toBe(false);
    expect(reset.state.time).toBe(0);
    expect(reset.state.hp).toEqual([5, 5]);
    expect(reset.state.balls).toHaveLength(0);
    a.stopHeartbeat();
    await new Promise<void>((resolve) => {
      a.ws.once("close", () => resolve());
      a.ws.close();
    });
    // HTTP request runs after the close handler and observes actual room cleanup.
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then(
      (r) => r.json(),
    );
    expect(health.rooms).toBe(0);
  });

  it("rejects malformed messages, invalid rooms/poses and out-of-envelope throws", async () => {
    await start();
    const a = await connect();
    a.ws.send("not json");
    expect((await a.next("error")).message).toMatch(/JSON/);
    a.send([]);
    expect((await a.next("error")).message).toMatch(/Malformed/);
    a.send({ type: "join", room: "../bad" });
    expect((await a.next("error")).message).toMatch(/six/);
    a.send({ type: "join", room: "DUEL02" });
    await a.next("joined");
    a.send({
      type: "pose",
      pose: { ...neutralPose(), head: { x: 0, y: null, z: 0 } },
      ready: true,
    });
    expect((await a.next("error")).message).toMatch(/Invalid pose/);
    a.send({ type: "pose", pose: neutralPose(), ready: "true" });
    expect((await a.next("error")).message).toMatch(/readiness/);
    const b = await connect();
    b.send({ type: "join", room: "DUEL02" });
    await b.next("joined");
    a.ready();
    b.ready();
    await a.next("state", (m) => m.ready);
    a.send({
      type: "throw",
      pose: neutralPose(),
      shot: {
        origin: neutralPose().rightHand,
        velocity: { x: 0, y: 0, z: 200 },
        spin: { x: 0, y: 0, z: 0 },
      },
    });
    expect((await a.next("error")).message).toMatch(/Throw rejected/);
    a.send({ type: "throw", pose: neutralPose(), shot: null });
    expect((await a.next("error")).message).toMatch(/Throw rejected/);
    a.send({ type: "join", room: "OTHER1" });
    expect((await a.next("error")).message).toMatch(/Already joined/);
  });

  it("accepts an atomic measured release after wrist movement and rejects forged origins", async () => {
    const { a } = await pair();
    const pose = neutralPose();
    pose.rightHand.x += 0.7;
    const shot = {
      origin: pose.rightHand,
      velocity: { x: 0, y: 4, z: 12 },
      spin: { x: 0, y: 0, z: 0 },
    };
    a.send({
      type: "throw",
      pose,
      shot: { ...shot, origin: { ...shot.origin, x: shot.origin.x + 0.5 } },
    });
    expect((await a.next("error")).message).toMatch(/Throw rejected/);
    a.send({ type: "throw", shot });
    expect((await a.next("error")).message).toMatch(/measured release pose/);
    a.send({ type: "throw", pose, shot });
    const launched = await a.next("state", (m) => m.state.balls.length === 1);
    expect(launched.state.balls[0].position.x).toBeCloseTo(pose.rightHand.x, 8);
    // The throw pose did not overwrite ongoing collision-body history.
    expect(launched.state.poses[0]).toEqual(neutralPose());
    expect(launched.state.nextId).toBe(2);
  });

  it("bounds message size and rejects binary input", async () => {
    await start();
    const a = await connect();
    const bigClosed = new Promise<number>((resolve) =>
      a.ws.once("close", resolve),
    );
    a.ws.send("x".repeat(POV_MAX_PAYLOAD + 1));
    expect(await bigClosed).toBe(1009);
    const b = await connect();
    const binaryClosed = new Promise<number>((resolve) =>
      b.ws.once("close", resolve),
    );
    b.ws.send(Buffer.from("{}"));
    expect(await binaryClosed).toBe(1003);
  });

  it("limits a burst of messages without harming a separate healthy client", async () => {
    await start();
    const a = await connect();
    const closed = new Promise<number>((resolve) =>
      a.ws.once("close", resolve),
    );
    for (let i = 0; i < 200; i++) a.send({ type: "invalid" });
    expect(await closed).toBe(1008);
    const b = await connect();
    b.send({ type: "join", room: "CLEAN1" });
    expect((await b.next("joined")).player).toBe(0);
  });
});
