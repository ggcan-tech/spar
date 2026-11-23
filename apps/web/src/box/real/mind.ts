import { PUNCH, standsAt, type Body, type Bout, type Code, type Habit, type Lead, type Mind, type PunchTimes, type Report, type Step } from "./rules";

/**
 * The opponent's decisions, and the five opponents.
 *
 * Each opponent is a row of numbers, a book of combinations and a few habits.
 * Rows differ only in things real boxers differ in: how long their punches
 * take and how early they are aimed, how soon the hand is home, how many
 * punches a minute, what is in the book, how tidy the guard is, and how well
 * they read what the player keeps doing. No row has a number for how long a
 * punch is shown: nothing is shown.
 *
 * The mind picks from the book, keeps a beat and sometimes breaks it, and
 * learns four things about the player: a head that is always covered is
 * hit in the body, a head that keeps slipping straights is thrown hooks, a
 * player who always answers the last punch is shown a late extra one, and
 * one who keeps pulling back is stepped in on first.
 *
 * All numbers are guesses tuned on the scripted players in players.ts.
 */
export interface Boxer extends Body {
  name: string;
  /** One line on how it boxes, for a menu. Not shown in a fight. */
  about: string;
  /** Punches a minute when it is fresh and left alone. Its beat comes from this and its book. */
  rate: number;
  /** How often it breaks its own beat: comes early, or makes the player wait. */
  breaks: number;
  /** A player who has stopped punching is pressed: its wait is multiplied by this. */
  press: number;
  /** Touched, its gloves come up this often. */
  coversUp: number;
  /** Hit in the body, that elbow comes down this often. */
  elbow: number;
  /** It drops its other hand as it punches this often; on the punches in `dropsOn` it does so `dropsThen` often. */
  drops: number;
  dropsOn?: readonly Code[];
  dropsThen?: number;
  /** After punching, this hand comes home low this often, for this long. */
  homeLow: { hand: "lead" | "rear" | "both"; chance: number; for: [number, number] } | null;
  /**
   * Seeing the player's lead coming: a fresh one, more for each repeat of the
   * same lead up to `most`, more for a lead on a steady beat, more for a
   * wide punch. `recalls` is how many seconds it keeps the last lead in
   * mind: a novice notices the same jab every second, not the same
   * combination every three.
   */
  read: { fresh: number; repeat: number; most: number; beat: number; wide: number; recalls: number };
  /** Having read a lead, it is ready for the punch after it this often. */
  ready: number;
  /** It answers a punch that did nothing this often, and hits straight back when hit solidly this often. */
  answers: number;
  fires: number;
  /** Seconds it stays covered up. */
  shellFor: [number, number];
  /** How readily it changes its attack to what the player keeps doing. */
  adapts: number;
  /** At a head that is already moving it throws a hook or goes to the body this often. */
  hooksMoving: number;
  /** It comes in on a hurt player this often. */
  finisher: number;
  /** A stiff jab as it steps in stops its feet this often. */
  jabStops: number;
  /** Combinations and how often each is picked. */
  book: readonly (readonly [readonly Step[], number])[];
  /** What it answers with. */
  replies: readonly (readonly [readonly Step[], number])[];
  /** What it throws at a hurt player, if it knows how to finish: round the gloves and to the body. A novice has none and throws what it always throws. */
  finish?: readonly (readonly [readonly Step[], number])[];
}

/** Punch times from four rows: [aim fixed, contact, hand home] for jab, cross, hook and body shot. The uppercut is the hook's. */
const times = (jab: number[], cross: number[], hook: number[], body: number[]): PunchTimes => {
  const row = ([commit, impact, home]: number[]) => ({ commit, impact, home });
  return { jab: row(jab), cross: row(cross), hook: row(hook), body: row(body), uppercut: row(hook) };
};

export type BoxerName = "beginner" | "swinger" | "jabber" | "pressure" | "counter";
/** The ladder, easiest first. */
export const LADDER: readonly BoxerName[] = ["beginner", "swinger", "jabber", "pressure", "counter"];

export const BOXERS: Record<BoxerName, Boxer> = {
  /**
   * Three weeks in. Pawing jabs and big rights, one at a time, each aimed
   * from its first movement. His hands stay at his chest after he punches,
   * he freezes with his arms over his face when hit, and he is blowing
   * after a minute.
   */
  beginner: {
    name: "Three-week beginner",
    about: "Pawing jabs, big rights, hands low after he punches",
    times: times([0, 0.55, 0.45], [0, 0.7, 0.55], [0, 0.78, 0.6], [0, 0.72, 0.58]),
    gap: 0.6,
    rate: 14,
    breaks: 0,
    press: 0.9,
    stepIn: 0.35,
    stepOut: 0.35,
    follows: 1.0,
    power: 1.1,
    tight: { chin: 1, cover: 0.9, low: 0.9 },
    guardMove: 0.35,
    lowFor: 2.0,
    coversUp: 0.3,
    elbow: 0.4,
    drops: 0,
    homeLow: { hand: "both", chance: 0.8, for: [0.5, 1.0] },
    read: { fresh: 0.05, repeat: 0.2, most: 0.6, beat: 0.05, wide: 0.05, recalls: 2.0 },
    ready: 0.3,
    answers: 0.15,
    fires: 0.2,
    answerDelay: 0.5,
    answerEvery: 2.0,
    shellAfter: 1,
    shellFor: [1.0, 2.0],
    adapts: 0.5,
    hooksMoving: 0.5,
    finisher: 0.2,
    jabStops: 0.5,
    sags: 35,
    wind: 0.3,
    book: [
      [["j"], 0.45],
      [["c"], 0.25],
      [["j", "c"], 0.25],
      [["rh"], 0.05],
    ],
    replies: [[["c"], 1]],
  },
  /**
   * Six months in. Rushes of wide hooks on one beat; the arcs can be seen
   * coming and the other hand drops. He walks through jabs and swings back
   * when hit, and by the second round his guard is at his chest.
   */
  swinger: {
    name: "Six-month swinger",
    about: "Rushes of wide hooks; the other hand drops",
    times: times([0.05, 0.48, 0.4], [0.1, 0.6, 0.5], [0.2, 0.66, 0.5], [0.2, 0.62, 0.5]),
    gap: 0.42,
    rate: 17,
    breaks: 0,
    press: 0.8,
    stepIn: 0.32,
    stepOut: 0.35,
    follows: 0.9,
    power: 1.2,
    tight: { chin: 1, cover: 0.9, low: 0.9 },
    guardMove: 0.3,
    lowFor: 1.8,
    coversUp: 0.15,
    elbow: 0.5,
    drops: 0.6,
    homeLow: null,
    read: { fresh: 0.08, repeat: 0.2, most: 0.6, beat: 0.05, wide: 0.07, recalls: 3.0 },
    ready: 0.3,
    answers: 0.3,
    fires: 0.6,
    answerDelay: 0.4,
    answerEvery: 1.6,
    shellAfter: 4,
    shellFor: [0.8, 1.4],
    adapts: 0.3,
    hooksMoving: 0.9,
    finisher: 0.5,
    jabStops: 0,
    sags: 55,
    wind: 0.55,
    book: [
      [["h", "rh", "h"], 0.3],
      [["rh", "h", "rh", "h"], 0.15],
      [["h", "rh", "h", "rh", "h"], 0.08],
      [["j"], 0.22],
      [["j", "rh"], 0.15],
      [["bh", "rh"], 0.1],
    ],
    replies: [
      [["rh", "h"], 0.6],
      [["h"], 0.4],
    ],
  },
  /**
   * A year in. Mostly jabs: the double jab, the one-two, then out. Always
   * the same gap in his one-two, and his right hand comes back low. He
   * catches jabs he has seen before.
   */
  jabber: {
    name: "One-year jabber",
    about: "Jab, double jab, one-two, then out; the right comes back low",
    times: times([0.15, 0.38, 0.3], [0.2, 0.5, 0.4], [0.26, 0.56, 0.42], [0.24, 0.52, 0.42]),
    gap: 0.4,
    rate: 18,
    breaks: 0,
    press: 0.8,
    stepIn: 0.3,
    stepOut: 0.35,
    follows: 0.8,
    power: 1.25,
    tight: { chin: 1, cover: 1, low: 0.95 },
    guardMove: 0.25,
    lowFor: 1.5,
    coversUp: 0.6,
    elbow: 0.6,
    drops: 0.1,
    homeLow: { hand: "rear", chance: 0.8, for: [0.3, 0.6] },
    read: { fresh: 0.2, repeat: 0.2, most: 0.5, beat: 0.08, wide: 0.1, recalls: 6.0 },
    ready: 0.4,
    answers: 0.35,
    fires: 0.3,
    answerDelay: 0.35,
    answerEvery: 1.6,
    shellAfter: 2,
    shellFor: [0.8, 1.4],
    adapts: 0.4,
    hooksMoving: 0.7,
    finisher: 0.5,
    jabStops: 0.3,
    sags: 30,
    wind: 0.8,
    book: [
      [["j"], 0.3],
      [["j", "j"], 0.25],
      [["j", "c"], 0.3],
      [["j", "j", "c"], 0.1],
      [["j", "bc"], 0.05],
    ],
    replies: [
      [["j", "c"], 0.5],
      [["c"], 0.5],
    ],
  },
  /**
   * Two years in. Walks in behind a high guard and works body then head in
   * threes and fours. His rear hand drops on the body hook, and a stiff jab
   * as he steps in stops his feet.
   */
  pressure: {
    name: "Two-year pressure fighter",
    about: "Walks in; body then head, in threes and fours",
    times: times([0.18, 0.33, 0.28], [0.26, 0.44, 0.36], [0.3, 0.48, 0.4], [0.28, 0.46, 0.4]),
    gap: 0.34,
    rate: 24,
    breaks: 0.1,
    press: 0.7,
    stepIn: 0.28,
    stepOut: 0.35,
    follows: 0.6,
    power: 1.3,
    tight: { chin: 1, cover: 1.05, low: 1 },
    guardMove: 0.2,
    lowFor: 1.2,
    coversUp: 0.5,
    elbow: 0.4,
    drops: 0,
    dropsOn: ["bh"],
    dropsThen: 0.7,
    homeLow: null,
    read: { fresh: 0.6, repeat: 0.15, most: 0.3, beat: 0.1, wide: 0.1, recalls: 20 },
    ready: 0.75,
    answers: 0.5,
    fires: 0.35,
    answerDelay: 0.3,
    answerEvery: 1.5,
    shellAfter: 2,
    shellFor: [0.8, 1.4],
    adapts: 0.6,
    hooksMoving: 0.85,
    finisher: 0.8,
    jabStops: 0.7,
    sags: 20,
    wind: 1,
    book: [
      [["bh", "h"], 0.2],
      [["j", "bc", "h"], 0.15],
      [["bh", "h", "c"], 0.15],
      [["j", "c", "bh"], 0.12],
      [["bc", "h", "c", "bh"], 0.08],
      [["j", "c"], 0.2],
      [["j"], 0.1],
    ],
    replies: [
      [["bh", "h"], 0.5],
      [["c", "h"], 0.5],
    ],
    finish: [[["bh", "rh", "h"], 1]],
  },
  /**
   * Middle level. Throws less and lands more. Feints, catches a jab and
   * returns it at once, and punishes a hand that is slow to come home. Tidy
   * guard, no free habits: he is beaten by work rate and by the body.
   */
  counter: {
    name: "Middle-level counter-puncher",
    about: "Feints, catches and returns; punishes a slow hand",
    times: times([0.15, 0.3, 0.24], [0.25, 0.4, 0.32], [0.3, 0.45, 0.36], [0.3, 0.45, 0.36]),
    gap: 0.3,
    rate: 8,
    breaks: 0.3,
    press: 0.75,
    stepIn: 0.25,
    stepOut: 0.35,
    follows: 0.4,
    power: 1.36,
    tight: { chin: 1.1, cover: 1.05, low: 1.05 },
    guardMove: 0.15,
    lowFor: 0.6,
    coversUp: 0.4,
    elbow: 0.5,
    drops: 0,
    homeLow: null,
    read: { fresh: 0.75, repeat: 0.1, most: 0.15, beat: 0.1, wide: 0.1, recalls: 60 },
    ready: 0.85,
    answers: 0.5,
    fires: 0.4,
    answerDelay: 0.22,
    answerEvery: 1.3,
    shellAfter: 2,
    shellFor: [0.8, 1.4],
    adapts: 0.8,
    hooksMoving: 0.95,
    finisher: 0.9,
    jabStops: 0.2,
    sags: 15,
    wind: 1,
    book: [
      [["j"], 0.15],
      [["j", "c"], 0.2],
      [["f", "c"], 0.12],
      [["f", "c", "h"], 0.1],
      [["j", "c", "h"], 0.15],
      [["j", "bc"], 0.08],
      [["c", "h"], 0.08],
      [["bh", "h", "c"], 0.07],
      [["j", "j", "c"], 0.05],
    ],
    replies: [
      [["c"], 0.8],
      [["c", "h"], 0.2],
    ],
    finish: [
      [["bh", "rh", "h"], 0.5],
      [["rh", "bh", "rh"], 0.5],
    ],
  },
};

const isPunch = (k: Step): k is Code => k !== "f" && k !== "w" && k !== "in";

/** Seconds between visits that give a boxer its punches a minute, from its book. */
export function beatOf(boxer: Boxer): number {
  let total = 0,
    punches = 0;
  for (const [steps, share] of boxer.book) {
    total += share;
    punches += share * steps.filter(isPunch).length;
  }
  return ((punches / total) * 60) / boxer.rate;
}

/** A mind for one bout. The same seed and the same inputs give the same bout. */
export function createMind(boxer: Boxer, seed = (Math.random() * 2 ** 32) >>> 0): Mind & { boxer: Boxer } {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list: Boxer["book"]): Step[] => {
    let total = 0;
    for (const [, share] of list) total += share;
    let at = random() * total;
    for (const [steps, share] of list) if ((at -= share) < 0) return steps.slice();
    return list[list.length - 1][0].slice();
  };
  const beat = beatOf(boxer);
  // What it has learned about this player.
  const learned = { headBlocks: 0, slips: 0, answered: 0, shorts: 0, lead: "", repeats: 0, leadAt: -9, leadGap: 0 };
  const chance: Record<Habit, number> = {
    drop: boxer.drops,
    hook: boxer.hooksMoving,
    cover: boxer.coversUp,
    elbow: boxer.elbow,
    press: boxer.finisher,
    ready: boxer.ready,
    answer: boxer.answers,
    fire: boxer.fires,
    stop: boxer.jabStops,
  };
  return {
    boxer,
    wait(s: Bout, share = 1) {
      let b = beat * (0.7 + 0.6 * random());
      // It paces itself: the less breath it has, the longer it waits.
      b *= 1 + Math.max(0, 60 - s.foe.breath) / 50;
      // A player who has gone quiet is pressed.
      if (s.time - s.me.lastPunchAt > 4) b *= boxer.press;
      if (random() < boxer.breaks) b *= random() < 0.6 ? 0.45 : 1.8;
      return b * share;
    },
    visit(s: Bout) {
      // The player is hurt and it knows what to do about it.
      if (boxer.finish && s.time < s.me.hurtUntil) return pick(boxer.finish);
      let steps = pick(boxer.book);
      if (boxer.adapts > 0) {
        // A player who keeps covering the head is hit in the body first.
        if (learned.headBlocks >= 2 && random() < boxer.adapts) {
          if (steps[0] !== "f") steps = [random() < 0.5 ? "bh" : "bc", ...steps.filter((k) => k !== "bh" && k !== "bc").slice(0, 2)];
          learned.headBlocks = 0;
        }
        // A player who slips straights is thrown hooks, which cover the sideways move.
        if (learned.slips >= 2 && random() < boxer.adapts) {
          steps = steps.map((k) => (k === "c" ? "rh" : k));
          learned.slips = 0;
        }
        // A player who always answers the end of a combination is shown a late extra punch.
        if (learned.answered >= 2 && random() < boxer.adapts) {
          steps = [...steps, "w", "c"];
          learned.answered = 0;
        }
        // A player who keeps pulling back out of reach is stepped in on first.
        if (learned.shorts >= 2 && random() < boxer.adapts) {
          steps = ["in", ...steps];
          learned.shorts = 0;
        }
      }
      return steps;
    },
    reads(lead: Lead, s: Bout) {
      const r = boxer.read;
      const key = lead.hand + lead.shape + lead.level;
      const gap = lead.at - learned.leadAt;
      // The same lead again, soon enough to be remembered.
      learned.repeats = learned.lead === key && gap <= r.recalls ? learned.repeats + 1 : 0;
      let p = r.fresh + Math.min(r.most, r.repeat * learned.repeats);
      // A lead that comes on a steady beat is easier to see coming.
      if (learned.leadGap > 0 && Math.abs(gap - learned.leadGap) < 0.15 * learned.leadGap) p += r.beat;
      learned.leadGap = gap;
      learned.leadAt = lead.at;
      learned.lead = key;
      if (lead.shape !== "straight") p += r.wide;
      if (s.foe.breath < 40) p *= 0.7;
      if (random() >= p) return null;
      return { how: random() < 0.5 ? "slip" : "catch", answer: random() < boxer.answers };
    },
    reply(s: Bout) {
      let steps = pick(boxer.replies);
      // Its head punches keep meeting gloves: the answer goes to the body.
      if (learned.headBlocks >= 2 && random() < boxer.adapts) {
        steps = ["bc", ...steps.filter((k) => k !== "c" && k !== "bc").slice(0, 1)];
        learned.headBlocks = 0;
      }
      // From the edge it as often throws what reaches as steps in.
      if (s.range && standsAt(s.foe, s.time) !== "pocket" && steps.some((k) => isPunch(k) && PUNCH[k].pocket) && random() < 0.5)
        steps = ["c"];
      return steps;
    },
    will(what: Habit, _s: Bout, code?: Code) {
      const p = what === "drop" && code && boxer.dropsOn?.includes(code) ? (boxer.dropsThen ?? boxer.drops) : chance[what];
      return p > 0 && random() < p;
    },
    span(what, _s: Bout, code?: Code) {
      if (what === "shell") return boxer.shellFor[0] + random() * (boxer.shellFor[1] - boxer.shellFor[0]);
      const h = boxer.homeLow;
      if (!h || !code) return 0;
      const lead = PUNCH[code].lead;
      if (h.hand !== "both" && (h.hand === "lead") !== lead) return 0;
      return random() < h.chance ? h.for[0] + random() * (h.for[1] - h.for[0]) : 0;
    },
    report(what: Report) {
      if (what === "head-blocked") learned.headBlocks++;
      else if (what === "head-through" || what === "ducked") learned.headBlocks = 0;
      else if (what === "slipped") {
        learned.slips++;
        learned.headBlocks = 0;
      } else if (what === "answered") learned.answered++;
      else if (what === "short") learned.shorts++;
    },
  };
}

/**
 * A mind that does exactly what it is told, for tests and for drills: it
 * throws the given combinations in order (the last one for ever), waits a
 * fixed time between them, and has no habits unless given some.
 */
export function scriptedMind(
  visits: readonly (readonly Step[])[],
  options: {
    wait?: number;
    will?: Partial<Record<Habit, boolean>>;
    reads?: { how: "slip" | "catch"; answer: boolean } | null;
    reply?: readonly Step[];
    shell?: number;
    homeLow?: number;
  } = {},
): Mind & { said: Report[] } {
  let i = 0;
  const said: Report[] = [];
  return {
    said,
    wait: (_s, share = 1) => (options.wait ?? 1) * share,
    visit: () => visits[Math.min(i++, visits.length - 1)].slice(),
    reads: () => options.reads ?? null,
    reply: () => (options.reply ?? ["c"]).slice(),
    will: (what) => options.will?.[what] ?? false,
    span: (what) => (what === "shell" ? (options.shell ?? 1) : (options.homeLow ?? 0)),
    report: (what) => void said.push(what),
  };
}
