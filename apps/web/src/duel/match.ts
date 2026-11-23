import { createArena, laneSpan, type Arena, type ArenaEvent, type Ball, type Target, type Who } from "./arena";
import { p2, type P2 } from "./body";
import { launch, type Flight } from "./flight";
import { FIELD, RULES, ZONES } from "./tune";

/**
 * The duel's rules on top of the arena (DUEL.md 1.5, 1.9): two balls, a serve,
 * pickups, clocks and the self-lob, hearts, the Squeeze, the 75 s end, best of
 * three with a rest between. Turns mode is the same with one ball.
 */
export type Phase = "count" | "play" | "rest" | "over";
export interface Held {
  /** When its clock started; null while it waits behind the first (the serve). */
  from: number | null;
}
export interface Player {
  who: Who;
  hearts: number;
  held: Held[];
  lastRelease: number;
  closeCalls: number;
  safeUntil: number;
  /** Stains for the round, against the hips. */
  stains: P2[];
  /** Hits taken this round: for the round card. */
  hitsTaken: number;
}
export type RoundEnd = "hearts" | "time";
export type MatchEvent =
  | ArenaEvent
  | { kind: "round"; round: number; server: Who }
  | { kind: "go" }
  | { kind: "squeeze"; step: number }
  | { kind: "self-lob"; who: Who; ball: Ball }
  | { kind: "pickup"; who: Who }
  | { kind: "round-end"; winner: Who; how: RoundEnd; hearts: [number, number] }
  | { kind: "match-end"; winner: Who; score: [number, number] }
  | { kind: "damage"; who: Who; zone: "head" | "chest"; hearts: number };

export interface MatchOptions {
  /** 2 for the duel, 1 for turns. */
  balls?: 1 | 2;
  /** Who serves the first round. */
  server?: Who;
  countMs?: number;
  restMs?: number;
}

export function createMatch(o: MatchOptions = {}) {
  const balls = o.balls ?? RULES.balls;
  const countMs = o.countMs ?? 3000,
    restMs = o.restMs ?? RULES.restS * 1000;
  const arena: Arena = createArena();
  const fresh = (who: Who): Player => ({ who, hearts: RULES.hearts, held: [], lastRelease: -Infinity, closeCalls: 0, safeUntil: -Infinity, stains: [], hitsTaken: 0 });
  const players: [Player, Player] = [fresh(0), fresh(1)];
  let phase: Phase = "count";
  let round = 1;
  let server: Who = o.server ?? 0;
  let phaseAt = 0,
    roundStart = 0;
  let squeeze: [number, number] = [0, 0];
  let squeezeSteps = 0;
  const score: [number, number] = [0, 0];
  let started = false;
  let lastWinner: Who | null = null;
  const events: MatchEvent[] = [];

  function startRound(now: number) {
    arena.clear();
    for (const p of players) {
      p.hearts = RULES.hearts;
      p.held = [];
      p.lastRelease = -Infinity;
      p.closeCalls = 0;
      p.safeUntil = -Infinity;
      p.stains = [];
      p.hitsTaken = 0;
    }
    squeeze = [0, 0];
    squeezeSteps = 0;
    phase = "count";
    phaseAt = now;
    events.push({ kind: "round", round, server });
  }
  function endRound(now: number, winner: Who, how: RoundEnd) {
    score[winner]++;
    lastWinner = winner;
    events.push({ kind: "round-end", winner, how, hearts: [players[0].hearts, players[1].hearts] });
    arena.clear();
    if (score[winner] >= RULES.roundsToWin) {
      phase = "over";
      events.push({ kind: "match-end", winner, score: [score[0], score[1]] });
    } else {
      phase = "rest";
      // The loser of the round serves the next.
      server = (1 - winner) as Who;
      round++;
    }
    phaseAt = now;
  }
  function damage(now: number, who: Who, zone: "head" | "chest", at: P2, hips: P2 | null) {
    const p = players[who];
    p.hearts = Math.max(0, p.hearts - ZONES.damage[zone]);
    p.safeUntil = now + ZONES.safeAfterHitMs;
    p.hitsTaken++;
    // A stain stays where it landed on the body: kept against the hips, so it moves with them.
    p.stains.push(hips ? p2(at.x - hips.x, at.y - hips.y) : at);
    events.push({ kind: "damage", who, zone, hearts: p.hearts });
  }
  return {
    arena,
    players: () => players,
    phase: () => phase,
    round: () => round,
    score: () => score,
    server: () => server,
    squeeze: () => squeeze,
    /** Seconds into the round's play (0 before it starts). */
    clock: (now: number) => (phase === "play" ? (now - roundStart) / 1000 : 0),
    /** Ms left of the count-in or the rest. */
    waitLeft: (now: number) => (phase === "count" ? countMs - (now - phaseAt) : phase === "rest" ? restMs - (now - phaseAt) : 0),
    lastWinner: () => lastWinner,
    start(now: number) {
      if (started) return;
      started = true;
      startRound(now);
    },
    /** Skip the rest. */
    next(now: number) {
      if (phase === "rest") startRound(now);
    },
    /** May `who` throw now? If so the oldest ball leaves their hand. */
    release(who: Who, now: number): boolean {
      const p = players[who];
      if (phase !== "play" || !p.held.length) return false;
      if (now - p.lastRelease < RULES.secondGapMs) return false;
      p.held.shift();
      p.lastRelease = now;
      // The next ball's clock starts now.
      if (p.held[0] && p.held[0].from === null) p.held[0].from = now;
      return true;
    },
    /** How much of each held ball's clock is left, 0–1. */
    clocks(who: Who, now: number): number[] {
      return players[who].held.map((h) => (h.from === null ? 1 : Math.max(0, 1 - (now - h.from) / RULES.clockMs)));
    },
    canThrow(who: Who, now: number) {
      const p = players[who];
      return phase === "play" && p.held.length > 0 && now - p.lastRelease >= RULES.secondGapMs;
    },
    /**
     * Move the match to `now`. `targets` are the two bodies (null: no body);
     * `trunks` where each trunk is, for picking up balls; `onLaunch` is told of
     * every ball the rules launch themselves (self-lobs).
     */
    step(now: number, targets: [Target | null, Target | null], trunks: [number | null, number | null]): MatchEvent[] {
      if (!started) return [];
      if (phase === "count" && now - phaseAt >= countMs) {
        phase = "play";
        roundStart = now;
        // The serve: the server holds every ball; the second's clock waits for the first to leave.
        players[server].held = Array.from({ length: balls }, (_, i) => ({ from: i === 0 ? now : null }));
        events.push({ kind: "go" });
      } else if (phase === "rest" && now - phaseAt >= restMs) startRound(now);
      if (phase !== "play") return events.splice(0);
      const t = (now - roundStart) / 1000;
      // The Squeeze.
      while (squeezeSteps < RULES.squeezeAt.length && t >= RULES.squeezeAt[squeezeSteps]) {
        squeezeSteps++;
        squeeze = [squeezeSteps * RULES.squeezeStep, squeezeSteps * RULES.squeezeStep];
        events.push({ kind: "squeeze", step: squeezeSteps });
      }
      // Clocks that run out: the ball pops up and drops back on its holder.
      for (const p of players) {
        const trunk = trunks[p.who] ?? targets[p.who]?.fig.hips.x ?? (p.who === 0 ? -FIELD.laneMiddle : FIELD.laneMiddle);
        for (let i = 0; i < p.held.length; i++) {
          const h = p.held[i];
          if (h.from !== null && now - h.from >= RULES.clockMs) {
            p.held.splice(i, 1);
            if (p.held[0] && p.held[0].from === null) p.held[0].from = now;
            const fig = targets[p.who]?.fig;
            const top = p2(trunk, (fig?.head.c.y ?? 1.6) + 0.35);
            const vy = (RULES.selfLobS * 3.5) / 2;
            const ball = arena.launch(p.who, launch(top, 1, 90, vy, now), { self: true });
            events.push({ kind: "self-lob", who: p.who, ball });
            break;
          }
        }
      }
      // Balls.
      const guarded: [Target | null, Target | null] = [
        targets[0] ? { ...targets[0], safe: now < players[0].safeUntil } : null,
        targets[1] ? { ...targets[1], safe: now < players[1].safeUntil } : null,
      ];
      for (const e of arena.step(now, guarded, squeeze)) {
        events.push(e);
        if (e.kind === "hit") damage(now, e.who, e.zone, e.at, targets[e.who]?.fig.hips ?? null);
        if (e.kind === "close" && !e.ball.self) players[e.who].closeCalls++;
        // A self-lob goes to the other player once it is down.
        if ((e.kind === "hit" || e.kind === "down") && e.ball.self) e.ball.owner = (1 - e.ball.from) as Who;
      }
      // Pickups.
      for (const p of players) {
        for (const b of arena.pickups(now, p.who, trunks[p.who])) {
          arena.remove(b.id);
          p.held.push({ from: now });
          events.push({ kind: "pickup", who: p.who });
        }
      }
      // The round's end.
      const dead = players.filter((p) => p.hearts <= 0);
      if (dead.length === 1) endRound(now, (1 - dead[0].who) as Who, "hearts");
      else if (dead.length === 2) endRound(now, (1 - server) as Who, "hearts");
      else if (t >= RULES.roundEndS) {
        const lost = players.map((p) => RULES.hearts - p.hearts);
        const winner: Who =
          lost[0] !== lost[1] ? (lost[0] < lost[1] ? 0 : 1) : players[0].closeCalls !== players[1].closeCalls ? (players[0].closeCalls > players[1].closeCalls ? 0 : 1) : ((1 - server) as Who);
        endRound(now, winner, "time");
      }
      return events.splice(0);
    },
    /** Launch a thrown ball (after `release` said yes). */
    throwBall(who: Who, flight: Flight, o: { dark?: boolean; tag?: string } = {}) {
      return arena.launch(who, flight, o);
    },
    span: (who: Who) => laneSpan(who, squeeze[who]),
  };
}
export type Match = ReturnType<typeof createMatch>;
