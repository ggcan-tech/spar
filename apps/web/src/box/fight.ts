import { LEVEL, type AttackKind, type AttackPlan, type BoxLevel, type BoxerMind } from "./boxer";
import type { Guard } from "./defence";
import type { Hand, Punch, PunchShape } from "./punch";

/**
 * The rules of a round against the training opponent.
 *
 * The opponent shows every punch before it throws it. A straight punch is
 * aimed where the player's head is at a moment before it lands (earlier for a
 * beginner, at once for a lesson): move the head aside or down after that and
 * it misses. A hook covers both sides and has to
 * be ducked. A body shot can only be blocked. Any head punch can be blocked by
 * covering the face, at a price. Making the opponent miss leaves it open: a
 * punch landed then counts double. That exchange is the game.
 *
 * The player's punches are judged the instant they are read. The opponent
 * guards its head or its body, never both, so a punch to the other one lands;
 * while it shows a punch its other glove half covers, and while it recovers
 * from one it is open.
 * Every punch costs stamina, so swinging without thought ends with nothing left.
 *
 * Pure and deterministic: no clocks, no randomness except through the mind.
 * All numbers are design guesses to be tuned by playing.
 */
export const RULES = {
  /** Seconds from the end of the wind-up to the punch landing. */
  strike: 0.13,
  /** Hands up catch this share of a jab; hands down take this much more of any head punch. */
  caught: 0.5,
  handsDown: 1.25,
  /** While it shows a punch, its other glove still keeps out this share where its guard was. */
  halfCover: 0.5,
  /** After this many head (or body) punches blocked in a row, the next goes to the other. */
  switchAfter: 2,
  /** Head movement, in game units, that makes a straight punch miss. */
  slip: 0.16,
  duck: 0.2,
  health: 100,
  /** The opponent's punches. */
  hurt: { jab: 7, cross: 12, hook: 14, body: 9 } as Record<AttackKind, number>,
  /** Share of a punch kept out by no, one and two gloves. */
  block: [0, 0.4, 0.75],
  /** A hook comes round a cover: gloves keep out only this share of what they would. */
  hookRound: 0.5,
  /** Stamina a blocked punch takes from the blocker; with less than that left, a block keeps out only this share of its share. */
  blockCost: 10,
  emptyBlock: 0.3,
  /** Gloves that arrive in this last moment before a punch lands keep out all of it, for nothing, and open the opponent for `open` seconds at `bonus`. */
  parry: { window: 0.3, open: 0.5, bonus: 1.5 },
  /** Hit clean within this long of throwing a punch of one's own: it costs this much more. */
  caughtWithin: 0.35,
  /** A dodge begun in this last moment before the punch lands opens it for more: the bonus is multiplied by this. */
  lateDodge: 0.2,
  lateBonus: 1.25,
  /** The player's punches: lead straight, rear straight, hook, uppercut. */
  jab: 3,
  cross: 5,
  hook: 6.5,
  uppercut: 7,
  /** A body punch does less at once but tires the opponent. */
  bodyShare: 0.75,
  cost: { straight: 5, hook: 8, uppercut: 9 } as Record<PunchShape, number>,
  stamina: 100,
  /** Stamina a second, after this long without punching. */
  regen: 20,
  regenAfter: 0.45,
  /**
   * A punch landed where it is not covering while it simply stands in its
   * guard does this share. Full weight is for when it is showing a punch,
   * recovering from one or stunned: the game is to hit it when it is open,
   * not to find the gap in a waiting guard over and over.
   */
  set: 0.6,
  /** Landed punches this close together are a combination: each adds this, up to five. */
  comboWindow: 1.3,
  comboStep: 0.05,
  counter: 2,
  staggered: 1.25,
  /** Share of a blocked punch that still gets through to the opponent, and its guard's strength. */
  chip: 0.15,
  guardStrength: 22,
  /** Its guard comes back this fast, after this long unhit; a straight wears it half as much as a hook. */
  guardBack: 8,
  guardRest: 1,
  /** Hit twice within this long where it is not covering, it moves its guard there. */
  guardFollows: 2,
  /** Seconds the opponent is stunned: a counter, a broken guard, a stopped punch. An ordinary hit only makes it flinch. */
  stun: { counter: 0.6, broken: 0.9, stopped: 0.4, most: 1.2 },
  knockdowns: 3,
  /** Seconds the opponent stays down, and the share of health it gets up with. */
  count: 3.2,
  rise: [0.7, 0.5],
  /** The player: seconds before they can get up, when they are stood up anyway, and what with. */
  downFor: 1.5,
  downMax: 5,
  riseMe: [0.65, 0.45],
  /** Seconds of quiet after anyone gets up. */
  grace: 1.2,
  /** Seconds in a round. */
  clock: 120,
  /** Between rounds each gets back this share of the health they are missing. */
  restHeal: 0.5,
  /** Seconds the opponent waits after the bell of a later round. */
  roundOpening: 1.5,
};

export type FoePhase =
  "guard" | "windup" | "strike" | "recover" | "stagger" | "down" | "out";
export interface Attack extends AttackPlan {
  id: number;
  startAt: number;
  impactAt: number;
  /** Where it is going, fixed before it lands (see AttackPlan.commit): the player's head then. */
  aim: { x: number; y: number } | null;
  /** Where the player's head was when the punch was first shown. */
  shownAt: { x: number; y: number } | null;
  /** Where it was a moment before the punch lands: still on the line then, and gone at the end, is a late dodge. */
  lateAt: { x: number; y: number } | null;
  /** The player could not be seen properly at some moment of this punch: it cannot hurt them. */
  blind?: boolean;
}
export interface Foe {
  hp: number;
  downs: number;
  phase: FoePhase;
  since: number;
  until: number;
  guard: "high" | "low";
  /** When it will move its guard, and to where. */
  cover: { at: number; to: "high" | "low" } | null;
  guardLeft: number;
  attack: Attack | null;
  /** Open to a counter until this time. */
  counterUntil: number;
  /** Body punishment taken, 0 to 1. */
  tired: number;
  /** The last punch that landed on it, for its reaction. */
  struck: { at: number; hand: Hand; shape: PunchShape; target: "head" | "body"; power: number; damage: number } | null;
  /** The last punch it took on its guard. */
  guarded: { at: number; hand: Hand } | null;
  /** The last punch landed where it was not covering. */
  opened: { at: number; target: "head" | "body" } | null;
  /** What a punch landed in its present opening counts for. */
  counterBonus: number;
}
export interface Me {
  hp: number;
  downs: number;
  down: boolean;
  downAt: number;
  stamina: number;
  lastPunchAt: number;
  combo: number;
  comboAt: number;
  /** When the player was last hit, and from which side (-1 their left, 1 their right). */
  hurtAt: number;
  hurtSide: number;
  /** Head punches, and body punches, blocked in a row. */
  blockedHigh: number;
  blockedLow: number;
  /** When the gloves came up to cover, and went down to the ribs; -1 while they are not there. */
  coverSince: number;
  lowSince: number;
}
export type FightEvent = { id: number; at: number } & (
  | {
      kind: "landed";
      hand: Hand;
      shape: PunchShape;
      target: "head" | "body";
      damage: number;
      power: number;
      counter: boolean;
      combo: number;
    }
  | { kind: "blocked"; hand: Hand; shape: PunchShape; target: "head" | "body" }
  | { kind: "gassed" }
  | { kind: "guard-broken" }
  | { kind: "stopped" }
  | { kind: "telegraph"; attack: AttackKind; hand: Hand; teaching: boolean }
  | { kind: "feint" }
  | { kind: "parried"; attack: AttackKind }
  | { kind: "dodged"; how: "slip" | "duck"; attack: AttackKind; late: boolean }
  | {
      kind: "blocked-me";
      attack: AttackKind;
      damage: number;
      hands: number;
      /** Covered up, dropped the gloves to the ribs, or caught a jab on a raised guard. */
      how: "cover" | "low" | "catch";
      /** The right glove in the right place: at the temple on a hook's side, or the elbow down on a body shot's side. */
      placed: boolean;
    }
  | {
      kind: "hit-me";
      attack: AttackKind;
      hand: Hand;
      damage: number;
      /** The player moved before the punch had aimed and stood there: it followed them. */
      early: boolean;
      /** Their hands were down. */
      open: boolean;
      /** They were in the middle of a punch of their own. */
      caught: boolean;
    }
  | { kind: "foe-down"; downs: number }
  | { kind: "foe-up" }
  | { kind: "me-down"; downs: number }
  | { kind: "me-up" }
  /** The bell at the end of a round that is not the last: [the player's score, the opponent's]. */
  | { kind: "round-over"; round: number; score: [number, number] }
  | { kind: "over"; winner: 0 | 1 | null; how: "ko" | "points" | "draw" }
);
export interface FightState {
  time: number;
  level: BoxLevel;
  me: Me;
  foe: Foe;
  events: FightEvent[];
  nextId: number;
  /** null while the fight is on. */
  over: { winner: 0 | 1 | null; how: "ko" | "points" | "draw" } | null;
  /** Damage each has done, for a decision on points. */
  dealt: [number, number];
  /**
   * A lesson, not a fight: nobody is hurt and nothing is stopped or stunned.
   * The opponent throws only `attack`, shown for `windup` seconds and aimed
   * when first shown; with no attack it stands open to be hit. `rest` is how
   * long it waits between punches (a drill keeps a beat), `open` how long it
   * stays open when made to miss, `hand` which of its hands throws.
   */
  practice?: { attack: AttackKind | null; windup: number; rest?: number; open?: number; hand?: Hand };
  /** The player's lead hand: the left for most right-handers, who stand left foot forward. Its straight is the jab. */
  lead: Hand;
  /** Which round this is, of how many, and the fight time at which it began. */
  round: number;
  rounds: number;
  roundStart: number;
  /** Between rounds: nothing moves until `nextRound`. */
  rest: boolean;
  /** Each finished round's score, ten to the one who took it: [the player, the opponent]. */
  card: [number, number][];
  /** Damage done before this round began, and knockdowns scored in the whole fight: [by the player, by the opponent]. */
  roundDealt: [number, number];
  downsAll: [number, number];
  /** Low impact: nobody has to duck. A glove at the temple on the side a hook comes from keeps all of it out. */
  gentle?: boolean;
}
export interface FightInput {
  /** Punches read since the last step. */
  punches: readonly Punch[];
  /** The player's head, in their own frame: sideways and height. */
  head: { x: number; y: number };
  guard: Guard;
  /** The player, knocked down, is asking to get up. */
  rise?: boolean;
  /** The height of the player's head when they stand in their stance. Default 1.65. */
  standing?: number;
  /**
   * The player is not seen properly right now: a hand is hidden, or the
   * newest pose is old. A punch that was in the air at such a moment is
   * drawn glancing off a glove and hurts nobody: the doubt is the player's.
   */
  blind?: boolean;
}

export function createFight(
  level: BoxLevel = "rookie",
  opening = 2,
  practice?: FightState["practice"],
  lead: Hand = "left",
  rounds = 1,
): FightState {
  return {
    ...(practice ? { practice } : {}),
    lead,
    round: 1,
    rounds: Math.max(1, Math.floor(rounds)),
    roundStart: 0,
    rest: false,
    card: [],
    roundDealt: [0, 0],
    downsAll: [0, 0],
    time: 0,
    level,
    me: {
      hp: RULES.health,
      downs: 0,
      down: false,
      downAt: 0,
      stamina: RULES.stamina,
      lastPunchAt: -Infinity,
      combo: 0,
      comboAt: -Infinity,
      hurtAt: -Infinity,
      hurtSide: 0,
      blockedHigh: 0,
      blockedLow: 0,
      coverSince: -1,
      lowSince: -1,
    },
    foe: {
      hp: RULES.health,
      downs: 0,
      phase: "guard",
      since: 0,
      until: opening,
      // A rookie starts with its hands low, so the first punch at its head lands.
      guard: level === "rookie" ? "low" : "high",
      cover: null,
      guardLeft: RULES.guardStrength,
      attack: null,
      counterUntil: -Infinity,
      tired: 0,
      struck: null,
      guarded: null,
      opened: null,
      counterBonus: RULES.counter,
    },
    events: [],
    nextId: 1,
    over: null,
    dealt: [0, 0],
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Advance the fight by `dt` seconds. Returns a new state; the given one is not changed. */
export function stepFight(
  before: FightState,
  dt: number,
  input: FightInput,
  mind: BoxerMind,
): FightState {
  if (!(dt > 0) || dt > 0.1) throw new Error("Fight needs a small positive step");
  if (before.over || before.rest) return before;
  const s: FightState = {
    ...before,
    time: before.time + dt,
    me: { ...before.me },
    foe: { ...before.foe, attack: before.foe.attack && { ...before.foe.attack } },
    events: before.events.filter((e) => before.time + dt - e.at < 1.5),
    dealt: [before.dealt[0], before.dealt[1]],
  };
  const { me, foe } = s;
  const now = s.time;
  const say = (event: Record<string, unknown> & { kind: FightEvent["kind"] }) => {
    s.events.push({ id: s.nextId++, at: now, ...event } as FightEvent);
  };
  const end = (winner: 0 | 1 | null, how: "ko" | "points" | "draw") => {
    s.over = { winner, how };
    say({ kind: "over", winner, how });
  };
  const toGuard = (rest: number) => {
    foe.phase = "guard";
    foe.since = now;
    foe.until = now + rest;
    foe.attack = null;
  };
  const stun = (seconds: number) => {
    // A stun never shortens one already running, and has a ceiling.
    const until = Math.min(
      Math.max(foe.phase === "stagger" ? foe.until : 0, now + seconds),
      (foe.phase === "stagger" ? foe.since : now) + RULES.stun.most,
    );
    foe.phase = "stagger";
    if (before.foe.phase !== "stagger") foe.since = now;
    foe.until = until;
    foe.attack = null;
  };
  const begin = (plan: AttackPlan) => {
    foe.phase = "windup";
    foe.since = now;
    foe.until = now + plan.windup;
    // For a player who stands right foot forward everything is mirrored, the
    // opponent too: its jab then comes from its right.
    const hand: Hand = s.lead === "right" ? (plan.hand === "left" ? "right" : "left") : plan.hand;
    foe.attack = {
      ...plan,
      hand,
      id: s.nextId++,
      startAt: now,
      impactAt: now + plan.windup + RULES.strike,
      aim: null,
      shownAt: { ...input.head },
      lateAt: null,
    };
    say({
      kind: "telegraph",
      attack: plan.kind,
      hand,
      teaching: plan.teaching,
    });
  };

  // When the gloves went where they are: a block made at the last moment is a parry.
  me.coverSince = input.guard.high > 0 ? (me.coverSince < 0 ? now : me.coverSince) : -1;
  me.lowSince = input.guard.low > 0 ? (me.lowSince < 0 ? now : me.lowSince) : -1;
  // Its guard comes back when it is left alone.
  if (!foe.guarded || now - foe.guarded.at > RULES.guardRest)
    foe.guardLeft = Math.min(RULES.guardStrength, foe.guardLeft + RULES.guardBack * dt);
  // ── The player ──────────────────────────────────────────────────────────
  if (me.down) {
    const lying = now - me.downAt;
    if ((lying >= RULES.downFor && input.rise === true) || lying >= RULES.downMax) {
      me.down = false;
      me.hp = RULES.health * RULES.riseMe[Math.min(me.downs, 2) - 1];
      me.stamina = RULES.stamina;
      say({ kind: "me-up" });
      toGuard(RULES.grace);
    }
  } else {
    // Breath comes back only with the hands at rest: not while punching, and
    // not behind a cover, which is work to hold.
    if (now - me.lastPunchAt >= RULES.regenAfter && input.guard.high === 0)
      me.stamina = Math.min(RULES.stamina, me.stamina + RULES.regen * dt);
    if (now - me.comboAt > RULES.comboWindow) me.combo = 0;
    for (const punch of input.punches) {
      if (foe.phase === "down" || foe.phase === "out" || s.over) break;
      const cost = RULES.cost[punch.shape];
      const spent = me.stamina < cost;
      me.stamina = Math.max(0, me.stamina - cost);
      me.lastPunchAt = now;
      // A punch thrown with nothing left has nothing behind it: it does not land.
      if (spent) {
        say({ kind: "gassed" });
        continue;
      }
      const base =
        punch.shape === "hook"
          ? RULES.hook
          : punch.shape === "uppercut"
            ? RULES.uppercut
            : punch.hand === s.lead
              ? RULES.jab
              : RULES.cross;
      const guarded = (punch.target === "head") === (foe.guard === "high");
      const covered = foe.phase === "guard" && guarded;
      const practice = s.practice !== undefined;
      let damage =
        base *
        clamp(punch.power, 0.6, 1.4) *
        (punch.target === "body" ? RULES.bodyShare : 1) *
        // Showing a punch, its other glove is still where its guard was.
        (foe.phase === "windup" && guarded ? 1 - RULES.halfCover : 1) *
        (foe.phase === "guard" && !guarded && !practice ? RULES.set : 1);
      if (covered) {
        damage *= RULES.chip;
        if (!practice) {
          // A hook wears a guard down; a straight half as much.
          foe.guardLeft -=
            base * clamp(punch.power, 0.6, 1.4) * (punch.shape === "straight" ? 0.5 : 1);
          foe.hp -= damage;
          s.dealt[0] += damage;
        }
        foe.guarded = { at: now, hand: punch.hand };
        say({
          kind: "blocked",
          hand: punch.hand,
          shape: punch.shape,
          target: punch.target,
        });
        mind.report("blocked-player");
        if (foe.guardLeft <= 0) {
          foe.guardLeft = RULES.guardStrength;
          say({ kind: "guard-broken" });
          stun(RULES.stun.broken);
        }
      } else {
        const counter = foe.phase === "recover" && now <= foe.counterUntil;
        damage *=
          (1 + RULES.comboStep * Math.min(me.combo, 5)) *
          (counter ? foe.counterBonus : 1) *
          (foe.phase === "stagger" ? RULES.staggered : 1);
        me.combo++;
        me.comboAt = now;
        if (!practice) {
          foe.hp -= damage;
          s.dealt[0] += damage;
          if (punch.target === "body")
            foe.tired = clamp(foe.tired + damage / 60, 0, 1);
        }
        foe.struck = {
          at: now,
          hand: punch.hand,
          shape: punch.shape,
          target: punch.target,
          power: punch.power,
          damage,
        };
        say({
          kind: "landed",
          hand: punch.hand,
          shape: punch.shape,
          target: punch.target,
          damage,
          power: punch.power,
          counter,
          combo: me.combo,
        });
        mind.report(counter ? "was-countered" : "was-hit");
        // Hit where it was not covering: it may move its guard there, and
        // hit there twice running it does.
        const to = punch.target === "head" ? "high" : "low";
        if (foe.guard !== to && !foe.cover && !practice) {
          // A contender covers up at the first one; a rookie needs telling twice.
          const again =
            LEVEL[s.level].coversAtOnce ||
            (foe.opened !== null &&
              foe.opened.target === punch.target &&
              now - foe.opened.at <= RULES.guardFollows);
          const delay = again ? 0.15 : mind.coverAfter(s.level);
          if (delay !== null) foe.cover = { at: now + delay, to };
          foe.opened = { at: now, target: punch.target };
        }
        // A straight punch beats a wide one: a hook or a body shot still in
        // the first half of its showing is stopped by a straight, either hand.
        // A jab or a cross has to be defended, and a lesson is never stopped.
        const a = foe.attack;
        const stoppable =
          foe.phase === "windup" &&
          a !== null &&
          !a.teaching &&
          (a.kind === "hook" || a.kind === "body") &&
          now < a.startAt + a.windup / 2;
        if (practice) {
          // A lesson: the punch is felt, and no more.
        } else if (stoppable && punch.shape === "straight" && punch.power >= 1) {
          say({ kind: "stopped" });
          stun(RULES.stun.stopped);
        } else if (counter) stun(RULES.stun.counter);
        else if (foe.phase === "stagger") stun(0.3);
        // An ordinary hit makes it flinch and no more: its next punch still
        // comes when it was coming. Punching does not keep it from punching.
        else if (foe.phase === "guard") foe.until = Math.max(foe.until, now + 0.12);
      }
      if (foe.hp <= 0 && !practice) {
        foe.hp = 0;
        foe.downs++;
        s.downsAll[0]++;
        foe.attack = null;
        foe.since = now;
        say({ kind: "foe-down", downs: foe.downs });
        if (foe.downs >= RULES.knockdowns) {
          foe.phase = "out";
          foe.until = Infinity;
          end(0, "ko");
        } else {
          foe.phase = "down";
          foe.until = now + RULES.count;
        }
      }
    }
  }
  if (s.over) return s;

  // ── The opponent ────────────────────────────────────────────────────────
  if (foe.cover && now >= foe.cover.at) {
    if (foe.phase === "guard") foe.guard = foe.cover.to;
    foe.cover = null;
  }
  const attack = foe.attack;
  // The aim is taken once, a moment before the punch lands.
  if (attack && !attack.feint && !attack.aim && now >= attack.startAt + attack.aimAfter)
    attack.aim = { ...input.head };
  if (attack && !attack.feint && !attack.lateAt && now >= attack.impactAt - RULES.lateDodge)
    attack.lateAt = { ...input.head };
  if (attack && input.blind) attack.blind = true;
  if (foe.phase === "guard" && now >= foe.until && !me.down) {
    if (s.practice) {
      const kind = s.practice.attack;
      // Standing open to be hit: it waits. Otherwise the one punch being taught.
      if (kind === null) foe.until = now + 1;
      else
        begin({
          kind,
          hand: s.practice.hand ?? (kind === "cross" ? "right" : "left"),
          windup: s.practice.windup,
          feint: false,
          follow: null,
          counterWindow: s.practice.open ?? 1.2,
          recover: 0.5,
          teaching: true,
          aimAfter: 0,
        });
    } else {
      // A player who keeps covering one place is hit in the other.
      const go =
        me.blockedHigh >= RULES.switchAfter
          ? "body"
          : me.blockedLow >= RULES.switchAfter
            ? "head"
            : null;
      if (go) me.blockedHigh = me.blockedLow = 0;
      begin(mind.next(s.level, foe.tired, go));
    }
  } else if (foe.phase === "windup" && attack && now >= foe.until) {
    if (attack.feint) {
      say({ kind: "feint" });
      toGuard(0.25 + 0.35 * mind.idle(s.level));
    } else {
      foe.phase = "strike";
      foe.since = now;
      foe.until = attack.impactAt;
    }
  } else if (foe.phase === "strike" && attack && now >= attack.impactAt) {
    const aim = attack.aim ?? input.head;
    const slipped = Math.abs(input.head.x - aim.x) >= RULES.slip;
    // A straight punch is aimed at the head and must be got under after it has
    // aimed. A hook travels at standing head height: anyone below it when it
    // arrives is missed, however early they went down.
    const ducked =
      attack.kind === "hook"
        ? (input.standing ?? 1.65) - input.head.y >= RULES.duck
        : aim.y - input.head.y >= RULES.duck;
    const head = attack.kind !== "body";
    // A hook comes round: only getting under it works. A body shot cannot be dodged.
    const missed =
      head && (ducked || (attack.kind !== "hook" && slipped));
    const hands = head ? input.guard.high : input.guard.low;
    // A jab is caught on a guard that is up, as a good guard does.
    const caught =
      attack.kind === "jab" && hands === 0 && input.guard.up >= 2;
    // Did the player move before it aimed and then stand there?
    const early =
      attack.shownAt !== null &&
      (Math.abs(aim.x - attack.shownAt.x) >= RULES.slip ||
        attack.shownAt.y - aim.y >= RULES.duck);
    foe.phase = "recover";
    foe.since = now;
    if (me.down) {
      foe.until = now + attack.recover;
    } else if (attack.blind && !missed) {
      // Not seen for part of it: nobody can say where the gloves were. It
      // glances off, costs nothing, and counts for nothing either way.
      say({ kind: "blocked-me", attack: attack.kind, damage: 0, hands: 1, how: head ? "cover" : "low", placed: false });
      foe.until = now + attack.recover;
    } else if (missed) {
      // Still on the line a moment before it landed, and gone when it did: the
      // dodge a boxer is proud of. It opens the opponent for more.
      const then = attack.lateAt;
      const late =
        then !== null &&
        (attack.kind === "hook"
          ? (input.standing ?? 1.65) - then.y < RULES.duck
          : Math.abs(then.x - aim.x) < RULES.slip && aim.y - then.y < RULES.duck);
      say({ kind: "dodged", how: ducked ? "duck" : "slip", attack: attack.kind, late });
      me.blockedHigh = me.blockedLow = 0;
      mind.report("dodged-by-player");
      foe.until = now + attack.counterWindow;
      foe.counterUntil = foe.until;
      foe.counterBonus = RULES.counter * (late ? RULES.lateBonus : 1);
    } else if (
      hands > 0 &&
      (head ? me.coverSince : me.lowSince) >= 0 &&
      now - (head ? me.coverSince : me.lowSince) <= RULES.parry.window
    ) {
      // Gloves that got there at the last moment: all of it kept out, for
      // nothing, and the opponent is open for a moment.
      say({ kind: "parried", attack: attack.kind });
      mind.report("blocked-by-player");
      foe.until = now + RULES.parry.open;
      foe.counterUntil = foe.until;
      foe.counterBonus = RULES.parry.bonus;
    } else {
      // The opponent's left hand arrives on the player's right.
      const side = attack.hand === "left" ? 1 : 0;
      const sides = input.guard.sides;
      // A glove at the temple on the side a hook comes from stops it; an
      // elbow down on the side a body shot comes from, with the other hand
      // still up, is the right block and keeps out the most.
      const placed =
        attack.kind === "hook"
          ? sides?.high[side] === true
          : attack.kind === "body" && sides?.low[side] === true && input.guard.up >= 1;
      const block =
        (placed
          ? attack.kind === "hook" && s.gentle
            ? 1
            : RULES.block[2]
          : RULES.block[Math.min(2, hands)] * (attack.kind === "hook" ? RULES.hookRound : 1)) *
        (me.stamina < RULES.blockCost ? RULES.emptyBlock : 1);
      const kept = caught ? RULES.caught : block;
      // Hands down only if both were seen to be down: a hidden hand is not a low one.
      const open = head && hands === 0 && input.guard.up === 0 && input.guard.known !== false;
      // In the middle of a punch of their own, they are hit harder.
      const punching = hands === 0 && !caught && now - me.lastPunchAt <= RULES.caughtWithin;
      const damage = s.practice
        ? 0
        : RULES.hurt[attack.kind] *
          (1 - kept) *
          (open ? RULES.handsDown : 1) *
          (punching ? LEVEL[s.level].caught : 1);
      me.hp -= damage;
      s.dealt[1] += damage;
      if (hands > 0 || caught) {
        if (!caught) me.stamina = Math.max(0, me.stamina - RULES.blockCost);
        if (head && !caught) {
          me.blockedHigh++;
          me.blockedLow = 0;
        } else if (!head) {
          me.blockedLow++;
          me.blockedHigh = 0;
        }
        say({
          kind: "blocked-me",
          attack: attack.kind,
          damage,
          hands: caught ? 2 : hands,
          how: caught ? "catch" : head ? "cover" : "low",
          placed: placed && !caught,
        });
        mind.report("blocked-by-player");
      } else {
        me.combo = 0;
        me.hurtAt = now;
        me.blockedHigh = me.blockedLow = 0;
        // The opponent's left hand arrives on the player's right.
        me.hurtSide = attack.hand === "left" ? 1 : -1;
        say({
          kind: "hit-me",
          attack: attack.kind,
          hand: attack.hand,
          damage,
          early: early && head && attack.kind !== "hook",
          open,
          caught: punching,
        });
        mind.report("hit-player");
      }
      foe.until = now + attack.recover;
      if (me.hp <= 0) {
        me.hp = 0;
        me.downs++;
        s.downsAll[1]++;
        say({ kind: "me-down", downs: me.downs });
        if (me.downs >= RULES.knockdowns) end(1, "ko");
        else {
          me.down = true;
          me.downAt = now;
          toGuard(RULES.downMax + RULES.grace);
        }
      }
    }
  } else if (foe.phase === "recover" && now >= foe.until) {
    const first = attack;
    // A second punch at once, unless the first was made to miss.
    if (first?.follow && foe.counterUntil < foe.since && !me.down)
      begin(mind.follow(s.level, first.follow, first));
    else toGuard(s.practice?.rest ?? mind.idle(s.level));
  } else if (foe.phase === "stagger" && now >= foe.until) {
    // It gathers itself before it comes again.
    toGuard(0.3 + 0.5 * mind.idle(s.level));
  } else if (foe.phase === "down" && now >= foe.until) {
    foe.hp = RULES.health * RULES.rise[Math.min(foe.downs, 2) - 1];
    foe.guardLeft = RULES.guardStrength;
    foe.tired *= 0.5;
    say({ kind: "foe-up" });
    mind.report("got-up");
    toGuard(RULES.grace);
  }
  if (!s.over && !s.practice && now - s.roundStart >= RULES.clock) {
    // The bell. The round goes to whoever did more in it, a knockdown counting
    // for 25; ten to them and nine to the other, eight if the other went down.
    const mine = s.dealt[0] - s.roundDealt[0] + 25 * foe.downs,
      theirs = s.dealt[1] - s.roundDealt[1] + 25 * me.downs;
    const level = Math.abs(mine - theirs) < 1;
    const score: [number, number] = level
      ? [10, 10]
      : mine > theirs
        ? [10, me.downs > foe.downs ? 9 : foe.downs > 0 ? 8 : 9]
        : [foe.downs > me.downs ? 9 : me.downs > 0 ? 8 : 9, 10];
    s.card = [...s.card, score];
    if (s.round >= s.rounds) {
      const total = s.card.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
      // Nothing between them is a draw, not a win.
      if (total[0] === total[1]) end(null, "draw");
      else end(total[0] > total[1] ? 0 : 1, "points");
    } else {
      // Saved by the bell: whoever is down is stood up, and both go to their corners.
      if (me.down) {
        me.down = false;
        me.hp = RULES.health * RULES.riseMe[Math.min(me.downs, 2) - 1];
      }
      if (foe.phase === "down") foe.hp = RULES.health * RULES.rise[Math.min(foe.downs, 2) - 1];
      toGuard(RULES.roundOpening);
      s.rest = true;
      say({ kind: "round-over", round: s.round, score });
    }
  }
  return s;
}

/** Out of the corner for the next round: both have their breath back and some of their health, and the knockdowns start again. */
export function nextRound(before: FightState): FightState {
  if (!before.rest || before.over) return before;
  const now = before.time;
  const heal = (hp: number) => hp + (RULES.health - hp) * RULES.restHeal;
  return {
    ...before,
    rest: false,
    round: before.round + 1,
    roundStart: now,
    roundDealt: [before.dealt[0], before.dealt[1]],
    me: {
      ...before.me,
      hp: heal(before.me.hp),
      stamina: RULES.stamina,
      downs: 0,
      down: false,
      combo: 0,
      blockedHigh: 0,
      blockedLow: 0,
      coverSince: -1,
      lowSince: -1,
    },
    foe: {
      ...before.foe,
      hp: heal(before.foe.hp),
      downs: 0,
      phase: "guard",
      since: now,
      until: now + RULES.roundOpening,
      attack: null,
      cover: null,
      guardLeft: RULES.guardStrength,
      tired: before.foe.tired * 0.5,
      counterUntil: -Infinity,
    },
  };
}
