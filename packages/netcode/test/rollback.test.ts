import { describe, expect, it } from 'vitest';
import { BIT, FRAME_MS, HELD_MASK, IMPULSE_MASK, predictInput, type InputBits, type SimEvent } from '@spar/protocol';
import {
  PACKET_MAX_BYTES,
  createDirectPair,
  createLocalSession,
  createLoopbackPair,
  createRollbackSession,
  decodeInputPacket,
  encodeInputPacket,
  type RollbackSession,
  type TransportPair,
} from '../src/index';
import { countKind, directRun, dummySim, expectedLog, makeScript } from './dummy-sim';

const DELAY = 2;
const SEED = 0xc0ffee;

function pair(net: TransportPair, opts: { inputDelay?: number; maxRollback?: number } = {}): [RollbackSession, RollbackSession] {
  const a = createRollbackSession({ sim: dummySim, transport: net.a, localPlayer: 0, seed: SEED, now: net.clock.now, ...opts });
  const b = createRollbackSession({ sim: dummySim, transport: net.b, localPlayer: 1, seed: SEED, now: net.clock.now, ...opts });
  return [a, b];
}

/**
 * Drive both sessions with scripts until each has executed `frames` frames. A session that reaches
 * the target stops ticking. Scripts are indexed by the frame the input was offered at.
 */
function drive(
  net: TransportPair,
  a: RollbackSession,
  b: RollbackSession,
  scriptA: (f: number) => InputBits,
  scriptB: (f: number) => InputBits,
  frames: number,
) {
  const eventsA: SimEvent[] = [];
  const eventsB: SimEvent[] = [];
  let stallsA = 0;
  let stallsB = 0;
  let guard = 0;
  while ((a.frame < frames || b.frame < frames) && guard++ < frames * 20) {
    if (a.frame < frames) {
      const r = a.tick(scriptA(a.frame));
      eventsA.push(...r.events);
      if (r.stalled) stallsA++;
    }
    if (b.frame < frames) {
      const r = b.tick(scriptB(b.frame));
      eventsB.push(...r.events);
      if (r.stalled) stallsB++;
    }
    net.clock.advance(FRAME_MS);
  }
  return { eventsA, eventsB, stallsA, stallsB };
}

describe('rollback session', () => {
  it('(1) direct pair: identical hashes and identical inputLog on both sides', () => {
    const net = createDirectPair();
    const [a, b] = pair(net);
    const sA = makeScript(11);
    const sB = makeScript(22);
    const N = 300;
    const { stallsA, stallsB } = drive(net, a, b, sA, sB, N);
    expect(stallsA).toBe(0);
    expect(stallsB).toBe(0);
    expect(a.frame).toBe(N);
    expect(b.frame).toBe(N);

    const ca = a.confirmed();
    const cb = b.confirmed();
    expect(ca.frame).toBe(N);
    expect(cb.frame).toBe(N);
    expect(ca.hash).toBe(cb.hash);
    expect(a.inputLog()).toEqual(b.inputLog());

    const log0 = expectedLog(sA, DELAY, N);
    const log1 = expectedLog(sB, DELAY, N);
    expect(a.inputLog()).toEqual([log0, log1]);
    expect(directRun(SEED, log0, log1, N).hash).toBe(ca.hash);
    // no prediction ever happened over a synchronous link, so no rollbacks either
    expect(a.stats().rollbacksTotal).toBe(0);
    expect(b.stats().rollbacksTotal).toBe(0);
  });

  it('(2) 100 ms latency + 40 ms jitter + 5% loss over 600 ticks: converges, rolled back at least once', () => {
    const net = createLoopbackPair({ latencyMs: 100, jitterMs: 40, loss: 0.05, seed: 7 });
    const [a, b] = pair(net);
    const sA = makeScript(33);
    const sB = makeScript(44);
    const N = 600;
    drive(net, a, b, sA, sB, N);
    net.clock.advance(1000); // flush whatever is still in flight
    expect(a.frame).toBe(N);
    expect(b.frame).toBe(N);

    const ca = a.confirmed();
    const cb = b.confirmed();
    expect(ca.frame).toBeGreaterThan(N - 10);
    expect(cb.frame).toBeGreaterThan(N - 10);

    const la = a.inputLog();
    const lb = b.inputLog();
    expect(la[0].length).toBe(ca.frame);
    expect(lb[0].length).toBe(cb.frame);
    // the confirmed logs are exactly what the scripts produced …
    expect(la[0]).toEqual(expectedLog(sA, DELAY, ca.frame));
    expect(la[1]).toEqual(expectedLog(sB, DELAY, ca.frame));
    expect(lb[0]).toEqual(expectedLog(sA, DELAY, cb.frame));
    expect(lb[1]).toEqual(expectedLog(sB, DELAY, cb.frame));
    // … and each side's confirmed hash is the direct replay of its own confirmed log
    expect(directRun(SEED, la[0], la[1], ca.frame).hash).toBe(ca.hash);
    expect(directRun(SEED, lb[0], lb[1], cb.frame).hash).toBe(cb.hash);
    // at a common frame both sides agree
    const common = Math.min(ca.frame, cb.frame);
    expect(directRun(SEED, la[0], la[1], common).hash).toBe(directRun(SEED, lb[0], lb[1], common).hash);

    const sa = a.stats();
    const sb = b.stats();
    expect(sa.rollbacksTotal + sb.rollbacksTotal).toBeGreaterThan(0);
    expect(sa.rttMs).toBeGreaterThan(150);
    expect(sa.rttMs).toBeLessThan(260);
  });

  it('(3) stalls when the remote is silent for more than maxRollback frames, resumes after', () => {
    const net = createLoopbackPair({ latencyMs: 0 }); // nothing is delivered until the clock advances
    const [a, b] = pair(net, { maxRollback: 8 });
    const sA = makeScript(1);
    const sB = makeScript(2);
    const results = [];
    for (let i = 0; i < 12; i++) results.push(a.tick(sA(a.frame)));
    // 8 predicted frames are allowed, the 9th stalls
    for (let i = 0; i < 8; i++) expect(results[i].stalled).toBe(false);
    for (let i = 8; i < 12; i++) expect(results[i].stalled).toBe(true);
    expect(a.frame).toBe(8);
    expect(results[11].stats.framesAhead).toBe(8);
    expect(results[11].stats.confirmedFrame).toBe(0);

    // remote wakes up and its packets get delivered
    for (let i = 0; i < 12; i++) b.tick(sB(b.frame));
    net.clock.advance(1);
    const r = a.tick(sA(a.frame));
    expect(r.stalled).toBe(false);
    expect(a.frame).toBe(9);
    expect(r.stats.confirmedFrame).toBeGreaterThan(0);
    // the input offered during the stall was not lost: the impulse bits were merged into the next frame
    const merged = a.inputLog()[0][8 + DELAY] ?? 0;
    expect(merged & IMPULSE_MASK).toBe(sA(8) & IMPULSE_MASK);

    // run on: everything converges
    for (let i = 0; i < 100; i++) {
      a.tick(sA(a.frame));
      b.tick(sB(b.frame));
      net.clock.advance(FRAME_MS);
    }
    net.clock.advance(1);
    const ca = a.confirmed();
    const cb = b.confirmed();
    const common = Math.min(ca.frame, cb.frame);
    const la = a.inputLog();
    const lb = b.inputLog();
    expect(la[0].slice(0, common)).toEqual(lb[0].slice(0, common));
    expect(la[1].slice(0, common)).toEqual(lb[1].slice(0, common));
    expect(directRun(SEED, la[0], la[1], ca.frame).hash).toBe(ca.hash);
    expect(directRun(SEED, lb[0], lb[1], cb.frame).hash).toBe(cb.hash);
  });

  it('(4) prediction keeps held bits and drops impulse bits', () => {
    expect(predictInput(BIT.GUARD_HIGH | BIT.JAB | BIT.STEP_IN)).toBe(BIT.GUARD_HIGH);
    expect(predictInput(BIT.SLIP_L | BIT.DUCK | BIT.CROSS)).toBe(BIT.SLIP_L | BIT.DUCK);
    expect(predictInput(0xffff)).toBe(HELD_MASK);
    expect(predictInput(IMPULSE_MASK)).toBe(0);

    // session level: B holds GUARD_HIGH and jabs every frame; with 50 ms latency A executes frames
    // before B's inputs arrive, so the remote input A uses must be the held bits only.
    const net = createLoopbackPair({ latencyMs: 50 });
    const [a, b] = pair(net);
    const held = BIT.GUARD_HIGH | BIT.JAB;
    let sawPredicted = 0;
    for (let i = 0; i < 60; i++) {
      const ra = a.tick(0);
      b.tick(held);
      net.clock.advance(FRAME_MS);
      const usedRemote = ra.view.fighters[1].thrown; // dummy sim exposes the input used
      if (ra.frame > ra.stats.confirmedFrame && ra.frame > DELAY + 1) {
        sawPredicted++;
        expect(usedRemote).toBe(BIT.GUARD_HIGH);
      }
    }
    expect(sawPredicted).toBeGreaterThan(20);
    // and once confirmed, the real (jab) input is in the log
    const log = a.inputLog();
    expect(log[1][DELAY + 5]).toBe(held);
  });

  it('(5) local session matches stepping the sim directly', () => {
    const sA = makeScript(5);
    const sB = makeScript(6);
    const N = 200;
    const s = createLocalSession({ sim: dummySim, seed: SEED, localPlayer: 0, remoteInput: (_view, frame) => sB(frame) });
    let last;
    for (let f = 0; f < N; f++) {
      last = s.tick(sA(f));
      expect(last.stalled).toBe(false);
      expect(last.frame).toBe(f + 1);
    }
    const log0 = Array.from({ length: N }, (_, f) => sA(f));
    const log1 = Array.from({ length: N }, (_, f) => sB(f));
    const direct = directRun(SEED, log0, log1, N);
    expect(s.inputLog()).toEqual([log0, log1]);
    expect(dummySim.hash(dummySim.init(SEED))).not.toBe(direct.hash);
    expect(last!.view.frame).toBe(N);
    // hash equality via the view-independent route: replaying the session's own log gives the same state
    const replayed = directRun(SEED, ...s.inputLog(), N);
    expect(replayed.hash).toBe(direct.hash);
    expect(replayed.state).toEqual(direct.state);
    expect(last!.stats).toEqual({ rttMs: 0, rollbackFrames: 0, rollbacksTotal: 0, framesAhead: 0, confirmedFrame: N });

    // localPlayer 1 flips the input order
    const s1 = createLocalSession({ sim: dummySim, seed: SEED, localPlayer: 1, remoteInput: (_v, frame) => sA(frame) });
    for (let f = 0; f < N; f++) s1.tick(sB(f));
    expect(s1.inputLog()).toEqual([log0, log1]);
  });

  it('(6) packet encode/decode roundtrip, under 48 bytes', () => {
    const pkt = {
      frame: 1234,
      ack: 1229,
      startFrame: 1229,
      inputs: [0, 1, 0xffff, BIT.GUARD_HIGH, BIT.JAB | BIT.BODY, 7, 8, 9],
      sendTime: 0xfffffff0,
      hasEcho: true,
      echoTime: 0x12345678,
      echoDelay: 17,
      advantage: 1.5,
    };
    const bytes = encodeInputPacket(pkt);
    expect(bytes.byteLength).toBe(PACKET_MAX_BYTES);
    expect(bytes.byteLength).toBeLessThan(48);
    expect(decodeInputPacket(bytes)).toEqual(pkt);

    const small = encodeInputPacket({ ...pkt, inputs: [5], ack: -1, hasEcho: false, echoTime: 0, echoDelay: 0 });
    expect(small.byteLength).toBe(30);
    expect(decodeInputPacket(small)).toEqual({ ...pkt, inputs: [5], ack: -1, hasEcho: false, echoTime: 0, echoDelay: 0 });

    expect(decodeInputPacket(new Uint8Array(3))).toBeNull();
    const bad = new Uint8Array(bytes);
    bad[0] = 0;
    expect(decodeInputPacket(bad)).toBeNull();
    // works on a view into a larger buffer
    const big = new Uint8Array(100);
    big.set(bytes, 10);
    expect(decodeInputPacket(big.subarray(10, 10 + bytes.byteLength))).toEqual(pkt);
  });

  it('(7) events from rolled-back frames are not duplicated', () => {
    const net = createLoopbackPair({ latencyMs: 100, jitterMs: 40, loss: 0.05, seed: 99 });
    const [a, b] = pair(net);
    const sA = makeScript(77);
    const sB = makeScript(88);
    const N = 600;
    const { eventsA, eventsB } = drive(net, a, b, sA, sB, N);
    net.clock.advance(1000);
    // drain events produced by rollbacks applied at flush time
    eventsA.push(...a.tick(0).events);
    eventsB.push(...b.tick(0).events);
    expect(a.stats().rollbacksTotal).toBeGreaterThan(0);

    const ca = a.confirmed();
    const cb = b.confirmed();
    const la = a.inputLog();
    const lb = b.inputLog();
    const dA = directRun(SEED, la[0], la[1], ca.frame).events;
    const dB = directRun(SEED, lb[0], lb[1], cb.frame).events;

    // BELL depends on the frame only, HIT on impulse bits (never predicted): counts over confirmed
    // frames must equal the direct run exactly — no duplicates, nothing missing.
    for (const [ev, direct, cf] of [
      [eventsA, dA, ca.frame],
      [eventsB, dB, cb.frame],
    ] as const) {
      expect(countKind(ev, 'BELL', undefined, cf)).toBe(countKind(direct, 'BELL', undefined, cf));
      expect(countKind(direct, 'BELL', undefined, cf)).toBeGreaterThan(50);
      expect(countKind(ev, 'HIT', 0, cf)).toBe(countKind(direct, 'HIT', 0, cf));
      expect(countKind(ev, 'HIT', 1, cf)).toBe(countKind(direct, 'HIT', 1, cf));
      expect(countKind(direct, 'HIT', 0, cf) + countKind(direct, 'HIT', 1, cf)).toBeGreaterThan(10);
      // no event (any kind) is ever delivered twice
      const keys = ev.map((e) => JSON.stringify(e));
      expect(new Set(keys).size).toBe(keys.length);
      // every true event of a confirmed frame was delivered (corrected outcomes are re-emitted)
      const delivered = new Set(keys);
      for (const e of direct) if (e.frame < cf) expect(delivered.has(JSON.stringify(e))).toBe(true);
    }
    // BLOCK depends on a held bit: mispredictions at transitions add a few phantom BLOCKs but never
    // remove true ones
    expect(countKind(eventsA, 'BLOCK', 1, ca.frame)).toBeGreaterThanOrEqual(countKind(dA, 'BLOCK', 1, ca.frame));
  });

  it('time sync: a peer that ticks 2% too fast skips ticks instead of running into remote stalls', () => {
    const net = createLoopbackPair({ latencyMs: 20, jitterMs: 3, seed: 4 });
    const [a, b] = pair(net);
    const sA = makeScript(9);
    const sB = makeScript(10);
    let stallsA = 0;
    let stallsB = 0;
    let maxAheadA = 0;
    for (let i = 0; i < 1500; i++) {
      const ra = a.tick(sA(a.frame));
      if (ra.stalled) stallsA++;
      maxAheadA = Math.max(maxAheadA, ra.stats.framesAhead);
      if (i % 50 === 49) {
        // A gets one extra tick every 50: 2% faster than B
        const extra = a.tick(sA(a.frame));
        if (extra.stalled) stallsA++;
      }
      const rb = b.tick(sB(b.frame));
      if (rb.stalled) stallsB++;
      net.clock.advance(FRAME_MS);
    }
    expect(a.timeSyncSkips).toBeGreaterThanOrEqual(5);
    expect(stallsA).toBe(a.timeSyncSkips); // every stall on A was a time-sync skip, never a remote stall
    expect(b.timeSyncSkips).toBe(0);
    expect(stallsB).toBe(0);
    expect(maxAheadA).toBeLessThan(8);
    expect(Math.abs(a.frame - b.frame)).toBeLessThan(6);
    net.clock.advance(100);
    const ca = a.confirmed();
    const cb = b.confirmed();
    const common = Math.min(ca.frame, cb.frame);
    expect(directRun(SEED, ...a.inputLog(), common).hash).toBe(directRun(SEED, ...b.inputLog(), common).hash);
  });

  it('inputLog is empty before anything is confirmed and both logs stay aligned', () => {
    const net = createDirectPair();
    const [a, b] = pair(net);
    expect(a.inputLog()).toEqual([[], []]);
    expect(a.confirmed().frame).toBe(0);
    a.tick(BIT.JAB);
    // B has not spoken yet: A's frame 0 ran on a prediction
    expect(a.confirmed().frame).toBe(0);
    b.tick(BIT.CROSS);
    // A now knows B's frames 0..2
    expect(a.confirmed().frame).toBe(1);
    expect(a.inputLog()).toEqual([[0], [0]]);
  });
});
