import type { Guard } from "../defence";
import type { Hand, PunchShape } from "../punch";
import { createMind, type Boxer } from "./mind";
import {
  PUNCH,
  RULES,
  createBout,
  handOut,
  nextRound,
  reaches,
  standsAt,
  stepBout,
  type Blow,
  type Bout,
  type BoutInput,
  type BoutOptions,
  type Code,
  type FoeMode,
  type Level,
  type Mind,
  type Place,
  type Side,
  type Step,
} from "./rules";

/**
 * Scripted ways of playing, run against the real rules and the real
 * opponents. Not people: each does one thing without tiring of it. What they
 * show is whether a way of playing that takes no skill wins, and whether one
 * that takes some is an even match for the opponent written for it.
 *
 * A script has a body like a person's: gloves take a moment to move, the
 * head moves at a walking pace, a punch takes a fifth to a third of a second
 * to go out and as long to come back, and nothing the opponent does is seen
 * sooner than a reaction time ago. Assumed, not measured.
 */
export const BODY = {
  /** Seconds a punch takes to go out, and to come back. */
  punch: { jab: [0.2, 0.22], cross: [0.25, 0.28], hook: [0.28, 0.3], upper: [0.3, 0.32] } as Record<Throw, [number, number]>,
  /** With no breath left everything is this much slower. */
  spentSlow: 1.25,
  /** Seconds a glove takes to get somewhere. */
  glove: 0.15,
  /** Metres a second the head moves sideways, and down. */
  headSpeed: 0.9,
  duckSpeed: 0.8,
  /** Seconds to pull back out of range. */
  lean: 0.2,
};
export type Throw = "jab" | "cross" | "hook" | "upper";
/** The script's own hands: L is the lead hand, R the rear, whichever way round it stands. */
export type LR = "L" | "R";
const otherLR = (h: LR): LR => (h === "L" ? "R" : "L");

/** What a script saw of the opponent a reaction time ago. */
export interface Seen {
  t: number;
  mode: FoeMode;
  pocket: boolean;
  /** The visit it is on, or -1. */
  visit: number;
  feint: boolean;
}
interface Planned {
  at: number;
  hand: LR;
  kind: Throw;
  level?: Level;
  /** Thrown only if a punch of this shape reaches when its time comes. */
  need?: PunchShape;
}
/** A script's own notes from step to step. Cleared at each bell. */
export interface Memo {
  next?: number;
  n?: number;
  until?: number;
  lazyUntil?: number;
  plan?: Planned[];
  mid?: {
    nextLead: number;
    handled: number;
    def: { id: number; read: boolean; side: number; how: number; slipAt: Record<number, number>; countered: boolean } | null;
    postUntil: number;
    postSide: number;
    postHow: number;
    jit: number;
    answered: number;
    swarmAt: number;
  };
}
/** What a script can do and know. */
export interface Pilot {
  /** The bout as it stood at the end of the last step, and the time this step ends. */
  s: Bout;
  t: number;
  rand(): number;
  /** Where the lead and the rear glove should go. */
  guard(lead: Place, rear: Place): void;
  /** Where the head should go: metres sideways, and metres down. */
  head(x: number, down: number): void;
  back(on: boolean): void;
  /** Would a punch of this shape reach? */
  reach(shape: PunchShape): boolean;
  /** The opponent as it was `react` seconds ago. */
  seen(react: number): Seen;
  /** Throw a punch if that hand is free. */
  throw(hand: LR, kind: Throw, level?: Level): boolean;
  /** Is the opponent's lead or rear hand out? Is it in the pocket? */
  foeOut(hand: LR): boolean;
  pocket(): boolean;
}
export type Style = (S: Pilot, m: Memo) => void;

const shapeOf = (kind: Throw): PunchShape => (kind === "hook" ? "hook" : kind === "upper" ? "uppercut" : "straight");
const isPunch = (k: Step | undefined): k is Code => k !== undefined && k !== "f" && k !== "w" && k !== "in";
const queue = (m: Memo) => (m.plan ??= []);
function runPlan(S: Pilot, m: Memo): void {
  const plan = queue(m);
  while (plan.length && S.t >= plan[0].at) {
    const a = plan.shift()!;
    if (!a.need || S.reach(a.need)) S.throw(a.hand, a.kind, a.level);
  }
}

/**
 * A middle-level player. Keeps a tight guard. Takes the first punch of a
 * combination on the gloves, then (reading it `q` of the time) slips the
 * cross on its beat, puts the glove where the hook is going, or drops the
 * elbow for the body shot; otherwise just covers. Answers the end of a
 * combination, leads behind the jab, goes to the body when the opponent
 * covers up, moves the head or covers after punching, and stops to breathe.
 */
export function middle(q: number, react: number, jitter: number): Style {
  return (S, memo) => {
    const { s, t, rand } = S;
    const me = s.me,
      foe = s.foe;
    const m = (memo.mid ??= {
      nextLead: 1.2 + rand(),
      handled: -1,
      def: null,
      postUntil: -1,
      postSide: 1,
      postHow: 0,
      jit: 0,
      answered: -1,
      swarmAt: 0,
    });
    const seen = S.seen(react + m.jit);
    let l: Place = "chin",
      r: Place = "chin",
      x = 0,
      y = 0;
    // After punching: head off the line, or gloves up.
    if (t < m.postUntil) {
      if (m.postHow < 0.5) x = 0.17 * m.postSide;
      else l = r = "cover";
    }
    if (seen.visit >= 0 && seen.visit !== m.handled) {
      m.handled = seen.visit;
      m.def = { id: seen.visit, read: rand() < q * (seen.feint ? 0.5 : 1), side: rand() < 0.5 ? 1 : -1, how: rand(), slipAt: {}, countered: false };
      m.jit = rand() * 0.1 - 0.03;
    }
    const c = foe.visit;
    if (m.def && c && c.id === m.def.id) {
      const d = m.def;
      // What is coming next: the punch in the air, or the next in the combination.
      let nxt: { level: Level; shape: PunchShape; lead: boolean; cross: boolean } | null = null,
        when = Infinity;
      for (const p of foe.punches)
        if (!p.done && !p.feint && p.impact < when) {
          nxt = { level: p.level, shape: p.shape, lead: PUNCH[p.code].lead, cross: p.code === "c" };
          when = p.impact;
        }
      const step = c.steps[c.index];
      if (!nxt && isPunch(step)) {
        const k = PUNCH[step];
        nxt = { level: k.level, shape: k.shape, lead: k.lead, cross: step === "c" };
        when = c.nextAt + s.times[k.kind].impact;
      }
      if (d.read && nxt) {
        // Its lead hand arrives on my rear side.
        const mine: LR = nxt.lead ? "R" : "L";
        if (nxt.level === "body") {
          if (nxt.shape === "hook") mine === "L" ? (l = "low") : (r = "low");
          else l = r = "low";
        } else if (nxt.shape === "hook") {
          if (d.how < 0.3) y = 0.2;
          else mine === "L" ? (l = "cover") : (r = "cover");
        } else if (nxt.cross && d.how < 0.55) {
          // Slip on the beat: begin about a fifth of a second before it lands.
          const key = Math.round(when * 100);
          d.slipAt[key] ??= when - 0.2 + (rand() + rand() - 1) * jitter * 1.7;
          if (t >= d.slipAt[key]) x = 0.17 * d.side;
          // And, half the time, send the right hand over it.
          if (!d.countered && d.how < 0.3 && t >= when - 0.15 && me.breath > 25 && S.reach("straight")) {
            d.countered = true;
            S.throw("R", "cross");
          }
        } else l = r = "cover";
      } else l = r = "cover";
      memo.plan = [];
    } else if (m.def) {
      // It has stopped. Answer it: at once if it was read, late if not.
      const d = m.def;
      m.def = null;
      if (me.breath > 30 && m.answered !== d.id && rand() < 0.75) {
        m.answered = d.id;
        const at = t + (d.read ? 0.05 : 0.45);
        const open: LR | null = S.foeOut("R") ? "R" : S.foeOut("L") ? "L" : null;
        const plan = queue(memo);
        if (S.pocket() && open) {
          // Round the side where its hand is still out, then straight down the middle.
          plan.push({ at, hand: otherLR(open), kind: "hook", need: "hook" });
          plan.push({ at: at + 0.3, hand: open, kind: open === "R" ? "cross" : "jab", need: "straight" });
        } else {
          plan.push({ at, hand: "R", kind: "cross", need: "straight" });
          plan.push({ at: at + 0.3, hand: "L", kind: S.pocket() ? "hook" : "jab", need: S.pocket() ? "hook" : "straight" });
        }
        m.postUntil = at + 1.1;
        m.postSide = rand() < 0.5 ? 1 : -1;
        m.postHow = rand();
        m.nextLead = Math.max(m.nextLead, at + 1.4);
      }
    } else if (t >= m.nextLead && me.breath > 55 && !queue(memo).length && seen.visit < 0) {
      const plan = queue(memo);
      const pick = rand();
      if (seen.mode === "shell") {
        // It has covered up: go downstairs, then up the middle.
        if (S.reach("hook")) {
          plan.push({ at: t + 0.2, hand: "L", kind: "hook", level: "body", need: "hook" });
          plan.push({ at: t + 0.52, hand: "R", kind: pick < 0.5 ? "upper" : "hook", level: pick < 0.5 ? "head" : "body", need: "hook" });
          plan.push({ at: t + 0.86, hand: "L", kind: "hook", level: "head", need: "hook" });
        } else if (S.reach("straight")) {
          plan.push({ at: t + 0.1, hand: "L", kind: "jab", level: "body" });
          plan.push({ at: t + 0.4, hand: "R", kind: "cross", level: "body" });
          plan.push({ at: t + 0.74, hand: "L", kind: "jab", level: "head" });
        }
      } else if (S.reach("straight")) {
        if (pick < 0.45) plan.push({ at: t, hand: "L", kind: "jab" }, { at: t + 0.3, hand: "R", kind: "cross" });
        else if (pick < 0.7) plan.push({ at: t, hand: "L", kind: "jab" }, { at: t + 0.3, hand: "R", kind: "cross", level: "body" });
        else if (pick < 0.85) plan.push({ at: t, hand: "L", kind: "jab" }, { at: t + 0.34, hand: "L", kind: "jab" }, { at: t + 0.64, hand: "R", kind: "cross" });
        else plan.push({ at: t, hand: "L", kind: "jab", level: "body" }, { at: t + 0.3, hand: "R", kind: "cross" });
      }
      const last = plan.length ? plan[plan.length - 1].at : t;
      m.postUntil = last + 0.85;
      m.postSide = rand() < 0.5 ? 1 : -1;
      m.postHow = rand();
      m.nextLead = last + 2.0 + rand() * 1.5;
    }
    // It is hurt: finish it. Its gloves are up, so round them and to the body.
    if (seen.mode === "hurt" && me.breath > 15 && !queue(memo).length && t >= m.swarmAt && !m.def) {
      m.swarmAt = t + 0.9;
      queue(memo).push(
        { at: t, hand: "R", kind: "cross", level: "body", need: "straight" },
        { at: t + 0.3, hand: "L", kind: "hook", level: "head" },
        { at: t + 0.6, hand: "R", kind: "cross", level: "body", need: "straight" },
      );
    }
    // I am hurt: gloves up until it passes.
    if (t < me.hurtUntil) {
      l = r = "cover";
      x = 0;
      memo.plan = [];
    }
    runPlan(S, memo);
    S.guard(l, r);
    S.head(x, y);
  };
}

export const STYLES = {
  // Stands there with the hands down.
  nothing: (S) => S.guard("down", "down"),
  // Left, right, left, right at the head, 3.3 a second, for ever.
  swings: (S, m) => {
    S.guard("chin", "chin");
    if (S.t >= (m.next ?? 0)) {
      m.n = (m.n ?? 0) + 1;
      S.throw(m.n % 2 ? "L" : "R", m.n % 2 ? "jab" : "cross");
      m.next = S.t + 0.3;
    }
  },
  // The same with head and body, straights and hooks in turn, 3 a second.
  "swings, mixed": (S, m) => {
    S.guard("chin", "chin");
    if (S.t >= (m.next ?? 0)) {
      m.n = (m.n ?? 0) + 1;
      const i = m.n % 4;
      if (i === 0) S.throw("L", "jab", "head");
      else if (i === 1) S.throw("R", "cross", "body");
      else if (i === 2) S.throw("L", "hook", "head");
      else S.throw("R", "hook", "body");
      m.next = S.t + 0.33;
    }
  },
  // Both gloves in front of the face, for ever. Never punches.
  hides: (S) => S.guard("cover", "cover"),
  // Hides, and pokes a jab every 1.2 to 1.8 s.
  "hides and pokes": (S, m) => {
    S.guard("cover", "cover");
    if (S.t >= (m.next ?? 1) && S.reach("straight")) {
      S.throw("L", "jab");
      m.next = S.t + 1.2 + 0.6 * S.rand();
    }
  },
  // Pulls back out of range and stays there.
  "leans back": (S) => {
    S.guard("chin", "chin");
    S.back(true);
  },
  // Pulls back whenever it comes, comes forward again to jab.
  "leans back, jabs": (S, m) => {
    S.guard("chin", "chin");
    const seen = S.seen(0.25);
    S.back(seen.visit >= 0 || S.t < (m.until ?? 0));
    if (seen.visit >= 0) m.until = S.t + 0.5;
    if (!S.s.me.away && S.t >= (m.next ?? 1) && S.reach("straight")) {
      S.throw("L", "jab");
      m.next = S.t + 1.0;
    }
  },
  // Hands up, a jab every 0.8 to 1.3 s, nothing else.
  "only jabs": (S, m) => {
    S.guard("chin", "chin");
    if (S.t >= (m.next ?? 1) && S.reach("straight")) {
      S.throw("L", "jab");
      m.next = S.t + 0.8 + 0.5 * S.rand();
    }
  },
  // Sways the head from side to side without looking, a one-two every 2.2 s.
  "sways, one-twos": (S, m) => {
    S.guard("chin", "chin");
    S.head(0.16 * Math.sin((2 * Math.PI * S.t) / 1.0), 0);
    runPlan(S, m);
    if (S.t >= (m.next ?? 1) && S.reach("straight")) {
      queue(m).push({ at: S.t, hand: "L", kind: "jab" }, { at: S.t + 0.3, hand: "R", kind: "cross" });
      m.next = S.t + 2.2;
    }
  },
  // A beginner: hands up, a one-two every 2.2 to 3 s whatever is happening,
  // covers up for a moment after being hit, sometimes brings the right hand back low.
  beginner: (S, m) => {
    const { t, rand } = S;
    const hit = S.s.me.solidAt;
    let l: Place = "chin",
      r: Place = "chin";
    if (t - hit > 0.25 && t - hit < 1.05) l = r = "cover";
    if (t < (m.lazyUntil ?? 0)) r = "down";
    S.guard(l, r);
    runPlan(S, m);
    if (t >= (m.next ?? 1.5) && S.reach("straight")) {
      queue(m).push({ at: t, hand: "L", kind: "jab" }, { at: t + 0.32, hand: "R", kind: "cross" });
      if (rand() < 0.3) m.lazyUntil = t + 0.32 + 0.53 + 0.6;
      m.next = t + 2.2 + rand() * 0.8;
    }
  },
  // The same beginner with the hands down half the time: up for 1.5 s, down for 1.5 s.
  "sloppy beginner": (S, m) => {
    const { t, rand } = S;
    const up = Math.floor(t / 1.5) % 2 === 0;
    S.guard(up ? "chin" : "down", up ? "chin" : "down");
    runPlan(S, m);
    if (t >= (m.next ?? 1.5) && S.reach("straight")) {
      queue(m).push({ at: t, hand: "L", kind: "jab" }, { at: t + 0.32, hand: "R", kind: "cross" });
      m.next = t + 2.2 + rand() * 0.8;
    }
  },
  middle: middle(0.65, 0.25, 0.06),
  // The same player a year on: reads more, times better.
  good: middle(0.85, 0.22, 0.04),
} satisfies Record<string, Style>;
export type StyleName = keyof typeof STYLES;

/**
 * A scripted player with a body: call `input` once a step to get what the
 * rules need. `lag` is how long after the fist's full stretch a punch is
 * reported, as a camera would.
 */
export function createPlayer(style: Style, seed: number, lag = 0) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Gloves, [lead, rear]: where each is, where it is going, and when it gets there.
  const pos: Place[] = ["chin", "chin"],
    want: Place[] = ["chin", "chin"],
    moveAt = [0, 0],
    busyUntil = [-1, -1];
  let x = 0,
    down = 0,
    xT = 0,
    downT = 0,
    back = false,
    backT = false,
    backAt = 0;
  let pending: { tell: number; blow: Blow }[] = [];
  let memo: Memo = {};
  let round = 1;
  // What was seen, oldest first.
  let hist: Seen[] = [];
  let guardKey = -1,
    guard: Guard = { high: 0, low: 0, up: 0, heights: [null, null] };
  let bout: Bout;
  let now = 0;
  const ix = (h: LR) => (h === "L" ? 0 : 1);
  const handOf = (h: LR): Hand => ((h === "L") === (bout.lead === "left") ? "left" : "right");
  const S: Pilot = {
    get s() {
      return bout;
    },
    get t() {
      return now;
    },
    rand,
    guard(l, r) {
      const to = [l, r];
      for (let i = 0; i < 2; i++)
        if (want[i] !== to[i]) {
          want[i] = to[i];
          moveAt[i] = now + BODY.glove;
        }
    },
    head(to, d) {
      xT = to;
      downT = d;
    },
    back(on) {
      if (backT !== on) {
        backT = on;
        backAt = now + BODY.lean;
      }
    },
    reach: (shape) => reaches(bout, shape),
    seen(react) {
      // The newest thing seen at least `react` ago.
      let found = hist[0];
      for (const h of hist) {
        if (h.t > now - react) break;
        found = h;
      }
      return found ?? { t: 0, mode: "set", pocket: false, visit: -1, feint: false };
    },
    throw(hand, kind, level = "head") {
      const i = ix(hand);
      if (bout.me.down || bout.foe.down || now < busyUntil[i]) return false;
      const slow = bout.me.breath < RULES.spent.below ? BODY.spentSlow : 1;
      const [out, home] = BODY.punch[kind];
      busyUntil[i] = now + (out + home) * slow;
      const actual = handOf(hand);
      const at = now + out * slow;
      // A straight goes down the middle; a hook or an uppercut comes round its own side.
      pending.push({ tell: at + lag, blow: { hand: actual, shape: shapeOf(kind), level, third: kind === "jab" || kind === "cross" ? "middle" : actual, quality: 1, at } });
      return true;
    },
    foeOut: (hand) => handOut(bout.foe, (hand === "L") === (bout.lead === "left") ? "left" : "right", bout.time),
    pocket: () => !bout.range || standsAt(bout.foe, bout.time) === "pocket",
  };
  return {
    /** What the player does in the step that takes the bout from `s` to `dt` later. */
    input(s: Bout, dt: number): BoutInput {
      bout = s;
      now = s.time + dt;
      if (s.round !== round) {
        round = s.round;
        memo = {};
        pending = [];
      }
      const v = s.foe.visit;
      const last = hist[hist.length - 1];
      const visit = v ? v.id : -1,
        feint = v ? v.feint : false,
        pocket = !s.range || standsAt(s.foe, s.time) === "pocket";
      if (!last || last.mode !== s.foe.mode || last.visit !== visit || last.feint !== feint || last.pocket !== pocket) {
        hist.push({ t: s.time, mode: s.foe.mode, pocket, visit, feint });
        if (hist.length > 24) hist = hist.slice(-12);
      }
      if (!s.me.down && !s.foe.down) style(S, memo);
      // The body catches up with what was asked of it.
      for (let i = 0; i < 2; i++) if (want[i] !== pos[i] && now >= moveAt[i]) pos[i] = want[i];
      x += Math.max(-BODY.headSpeed * dt, Math.min(BODY.headSpeed * dt, xT - x));
      down += Math.max(-BODY.duckSpeed * dt, Math.min(BODY.duckSpeed * dt, downT - down));
      if (backT !== back && now >= backAt) back = backT;
      const busy: [boolean, boolean] = [false, false];
      const sides = { high: [false, false] as [boolean, boolean], low: [false, false] as [boolean, boolean], up: [false, false] as [boolean, boolean] };
      let key = 0;
      for (let i = 0; i < 2; i++) {
        const side = handOf(i === 0 ? "L" : "R") === "left" ? 0 : 1;
        const out = now < busyUntil[i];
        busy[side] = out;
        const p = out ? "down" : pos[i];
        if (p === "cover") sides.high[side] = sides.up[side] = true;
        else if (p === "chin") sides.up[side] = true;
        else if (p === "low") sides.low[side] = true;
        key = key * 8 + (out ? 5 : p === "cover" ? 1 : p === "chin" ? 2 : p === "low" ? 3 : 4);
      }
      if (key !== guardKey) {
        guardKey = key;
        const n = (pair: [boolean, boolean]) => (pair[0] ? 1 : 0) + (pair[1] ? 1 : 0);
        guard = { high: n(sides.high), low: n(sides.low), up: n(sides.up), heights: [null, null], sides, known: true };
      }
      let punches: Blow[] = [];
      if (pending.length && pending.some((q) => q.tell <= now)) {
        punches = pending.filter((q) => q.tell <= now).map((q) => q.blow);
        pending = pending.filter((q) => q.tell > now);
      }
      return { punches, head: { x, y: RULES.standing - down }, guard, back, busy };
    },
  };
}

/** What one scripted bout came to. */
export interface Played {
  winner: Side | null;
  how: "stoppage" | "points" | "draw";
  seconds: number;
  /** Knockdowns: [scored by the player, scored by the opponent]. */
  downs: [number, number];
  /** Times each was hurt: [the player, the opponent]. */
  hurts: [number, number];
  /** The player was put down, or stopped, in round one. */
  r1Down: boolean;
  r1Stopped: boolean;
  /** Punches a minute: [the player's, the opponent's]. */
  rate: [number, number];
  /** Over the whole bout: [the player's, the opponent's]. */
  thrown: [number, number];
  clean: [number, number];
  partly: [number, number];
  gloves: [number, number];
  missed: [number, number];
  points: [number, number];
  scores: [number, number][];
}

/** Box one whole bout between a scripted player and an opponent, both seeded. */
export function playBout(
  boxer: Boxer,
  style: Style,
  seed: number,
  options: Partial<BoutOptions> & { dt?: number; lag?: number; mind?: Mind } = {},
): Played {
  const dt = options.dt ?? 1 / 60;
  const mind = options.mind ?? createMind(boxer, seed);
  const player = createPlayer(style, (seed ^ 0x9e3779b9) >>> 0, options.lag ?? 0);
  let s = createBout({ ...options, boxer });
  const hurts: [number, number] = [0, 0];
  let boxed = 0;
  let r1Stopped = false;
  while (!s.over) {
    if (s.rest) {
      s = nextRound(s);
      continue;
    }
    const before = s;
    s = stepBout(s, dt, player.input(s, dt), mind);
    boxed += dt;
    if (s.me.hurtUntil > before.me.hurtUntil && s.me.hurtUntil > s.time) hurts[0]++;
    if (s.foe.hurtUntil > before.foe.hurtUntil && s.foe.hurtUntil > s.time) hurts[1]++;
    if (s.over && s.over.winner === "foe" && s.over.how === "stoppage" && s.round === 1) r1Stopped = true;
  }
  const sum = (what: "thrown" | "clean" | "partly" | "gloves" | "missed" | "points"): [number, number] =>
    s.card.rounds.reduce<[number, number]>((n, r) => [n[0] + r[what][0], n[1] + r[what][1]], [0, 0]);
  const thrown = sum("thrown");
  const minutes = boxed / 60;
  const over = s.over!;
  return {
    winner: over.winner,
    how: over.how,
    seconds: boxed,
    downs: [s.downs[0], s.downs[1]],
    hurts,
    r1Down: s.card.rounds[0].downs[1] > 0,
    r1Stopped,
    rate: [thrown[0] / minutes, thrown[1] / minutes],
    thrown,
    clean: sum("clean"),
    partly: sum("partly"),
    gloves: sum("gloves"),
    missed: sum("missed"),
    points: sum("points"),
    scores: s.card.scores,
  };
}

/** Many bouts of one way of playing against one opponent, averaged. */
export function playMany(boxer: Boxer, style: Style, bouts: number, options: Parameters<typeof playBout>[3] = {}, seed0 = 1) {
  const a = { wins: 0, draws: 0, stopped: 0, stoppedBy: 0, seconds: 0, downsMe: 0, downsIt: 0, hurtMe: 0, hurtIt: 0, r1Down: 0, r1Stopped: 0, myRate: 0, itsRate: 0, myClean: 0, itsClean: 0, myPoints: 0, itsPoints: 0 };
  for (let f = 0; f < bouts; f++) {
    const r = playBout(boxer, style, seed0 * 7919 + f * 104729 + 13, options);
    if (r.winner === "me") a.wins++;
    if (r.winner === null) a.draws++;
    if (r.how === "stoppage") r.winner === "me" ? a.stopped++ : a.stoppedBy++;
    a.seconds += r.seconds;
    a.downsMe += r.downs[1];
    a.downsIt += r.downs[0];
    a.hurtMe += r.hurts[0];
    a.hurtIt += r.hurts[1];
    a.r1Down += r.r1Down ? 1 : 0;
    a.r1Stopped += r.r1Stopped ? 1 : 0;
    a.myRate += r.rate[0];
    a.itsRate += r.rate[1];
    const minutes = r.seconds / 60;
    a.myClean += r.clean[0] / minutes;
    a.itsClean += r.clean[1] / minutes;
    a.myPoints += r.points[0] / minutes;
    a.itsPoints += r.points[1] / minutes;
  }
  for (const k of Object.keys(a) as (keyof typeof a)[]) a[k] /= bouts;
  return a;
}
