import { JOINT } from "../pov/body";
import type { Target, Who, Ball } from "./arena";
import { createArena, laneSpan, pathOf } from "./arena";
import { createAnswerReader, type Answer } from "./answers";
import { figureFrom, laneOf, other, p2, placeFigure, standardFigure, type Figure, type FlatPose, type P2, type Side } from "./body";
import { aimShot, botLaunch, createBotBody, createDefender, dummies, walkerAt, type BotBody, type BotShot, type Defender, type Incoming } from "./bot";
import { at, fanOf, launch, solveLaunch, timeToFloor, type Fan, type Flight } from "./flight";
import { nearest } from "./hit";
import { createMatch, type Match, type MatchEvent } from "./match";
import { armHeldOut, createSlingReader, createSlingSetup, defaultSetup, type SlingRead, type SlingReader, type SlingShot } from "./sling";
import { PALETTE, type FigureDraw, type StageView } from "./stage";
import { FIELD, RULES, SLING } from "./tune";

/**
 * One page of the duel, free of the screen: it takes every pose from the
 * camera, reads the sling, runs the test or the match, and says what to draw.
 *
 * - probe: live numbers, a ball that just flies, guided recording steps (step 1a).
 * - sling: test 1, the sling alone, on dummies and a walking target (step 1b).
 * - dodge: test 2, a bot sling fires at you in four blocks (step 2).
 * - duel: test 3, a full duel against a training bot (step 3).
 */
export type DuelMode = "probe" | "sling" | "dodge" | "duel";
export type SetupStep = "camera" | "stand" | "side" | "holds" | "first" | "play";

export interface SessionOptions {
  mode: DuelMode;
  defender?: Exclude<Defender, "still">;
  balls?: 1 | 2;
  release?: "flick" | "still";
  aim?: "line" | "height";
  look?: "ball" | "arrow";
  /** Extra wait before the shooter's own ball leaves, ms (test 1 switch). */
  launchDelayMs?: number;
  /** Plain balls hidden from the dodger until they clear the wall: always, only in the Squeeze, or never. */
  dark?: "always" | "squeeze" | "off";
  seed?: number;
}

export interface SoundCue {
  kind: "thwip" | "whistle" | "splorch" | "zing" | "tick" | "bell" | "squeeze";
  seconds?: number;
  quiet?: boolean;
}

export interface LineRow {
  id: string;
  name: string;
  value: string;
  pass: boolean | null;
}
export interface Hud {
  step: SetupStep;
  prompt: string;
  sub: string;
  /** Duel: hearts, clock, round, score, balls held. */
  match: {
    hearts: [number, number];
    clock: number;
    round: number;
    score: [number, number];
    phase: string;
    wait: number;
    me: Who;
    held: [number, number];
  } | null;
  numbers: [string, string][];
  lines: LineRow[];
  /** Which test line is running, and its instruction. */
  line: { id: string; text: string } | null;
  asking: boolean;
  fan: Fan | null;
  /** The sling checklist while it is learned: arm out, pulled back, hold (0–1), ready to flick. */
  sling: { armOut: boolean; pulled: boolean; hold: number; ready: boolean } | null;
}

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
const cm = (m: number) => `${Math.round(m * 100)} cm`;

/** Guided recording for the probe (DUEL.md 11, step 1a). */
export const PROBE_STEPS = [
  "1 · Point your slingshot at the figure across the wall. Ten times, any way that feels natural. Arms down in between.",
  "2 · Arms out to the sides. Then a full draw three times. Then your natural level point three times.",
  "3 · Ten shots, aim anywhere. Then step to the other side of your space and shoot five more.",
  "4 · Hold a full draw for 60 seconds while you step in and out and duck, slow and fast. Never flick.",
  "5 · Five shots at your highest arc.",
  "6 · Hold the draw and step toward your sling side until the hand glows.",
  "7 · Five cancels (hands back together), then five nocks at the chest.",
  "Done. Press Save recording.",
];

/** Test 1's lines (DUEL.md 11, step 1b). */
const SLING_LINES = [
  { id: "free", text: "Two minutes of free slinging at the walking target. Nothing is counted." },
  { id: "l1", text: "Line 1 · 20 deliberate shots at the middle dummy. Each should fire on your flick." },
  { id: "l2", text: "Line 2 · Hold a full draw for 60 s while stepping and ducking, slow and fast. Never flick. Nothing should fire." },
  { id: "l3", text: "Line 3 · Shoot at the dummy shown. The first 5 show where they land. After each, keep still for 'mine', or both hands on your head for 'not mine'." },
  { id: "l4", text: "Line 4 · Three blocks of 10 at the middle dummy. The miss distance should fall." },
  { id: "l6", text: "Line 6 · Ten shots at your highest arc. Your sling hand should stay in the picture." },
  { id: "l8", text: "Line 8 · Free play on the walking target. Keep going as long as you like." },
] as const;

/** Test 2's four blocks of ten (DUEL.md 11, step 2). */
const DODGE_BLOCKS = [
  { id: "A", dark: false, fan: true, text: "Block A · 10 balls, always visible. Dodge with your body." },
  { id: "B", dark: true, fan: false, text: "Block B · 10 balls hidden until they clear the wall. No fan." },
  { id: "C", dark: true, fan: true, text: "Block C · 10 hidden balls, with the fan: flat means guess, high means read." },
  { id: "D", dark: true, fan: true, text: "Block D · 10 mixed." },
] as const;

interface Shot {
  ball: Ball | null;
  flight: Flight;
  sling: SlingShot;
  target: string | null;
  miss: number | null;
  block?: number;
  lineId?: string;
  answer?: Answer;
}

export function createDuelSession(o: SessionOptions) {
  const mode = o.mode;
  let seed = o.seed ?? 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let release = o.release ?? "flick";
  let aimMode = o.aim ?? "line";
  let look = o.look ?? "ball";
  let launchDelay = o.launchDelayMs ?? 0;
  let dark = o.dark ?? "always";
  // The player.
  let step: SetupStep = "camera";
  let side: Side | null = null;
  let sideSince = -Infinity,
    sideSeen: Side | null = null;
  let reader: SlingReader | null = null;
  let setup = createSlingSetup("left");
  let firstAskedAt = 0;
  const poses: FlatPose[] = [];
  let lastPose: FlatPose | null = null;
  let lastRead: SlingRead | null = null;
  const reads: SlingRead[] = [];
  let myFig: Figure | null = null;
  let stone = false;
  const cues: SoundCue[] = [];
  const texts: { at: P2; text: string; colour: string; born: number }[] = [];
  const splats: { at: P2; colour: string; born: number }[] = [];
  const answers = createAnswerReader({ guess: mode === "dodge" });
  // Who is who: the player's lane is the far side from where the sling arm points.
  let me: Who = 1;
  const them = () => (1 - me) as Who;
  const myLane = () => laneOf(me === 0 ? "left" : "right");
  // The arena for the tests; the match for the duel.
  const arena = createArena();
  let match: Match | null = mode === "duel" ? createMatch({ balls: o.balls ?? 2, server: 0 }) : null;
  // Bots.
  let bot: BotBody | null = null;
  const defender = createDefender(o.defender ?? "coach", (o.seed ?? 11) + 5);
  let botShot: BotShot | null = null;
  let botNextAt = 0;
  const incoming = new Map<number, Incoming>();
  // Test logs.
  const shots: Shot[] = [];
  let lastShotPath: P2[] = [];
  const refusals: { t: number; reason: string; gate: string }[] = [];
  let pendingLaunch: { at: number; shot: SlingShot }[] = [];
  let lineIdx = 0;
  let lineStart = 0;
  let l2Fires = 0;
  let l3Target = 1;
  let l6Lost = 0,
    l6Shots = 0;
  let armUpMs = 0,
    armTotalMs = 0,
    lastArmAt = 0;
  let probeStep = 0;
  // Dodge test.
  let dodgeIdx = 0;
  const dodgeLog: { block: number; hit: boolean; zone?: string; close?: number; answer?: Answer; fan: Fan; kind: string; drawnOnly?: boolean }[] = [];
  let answerFor: number | null = null;
  // Duel counters.
  const duel = { botHits: {} as Record<string, number>, myHits: 0, mine: 0, notMine: 0, drawnDodges: 0, rounds: [] as string[], myShots: 0 };
  let lastFrame = 0;
  const walkerStains: { at: P2; born: number }[] = [];
  const puffs: { at: P2; born: number }[] = [];
  /** After a hit on the player: the ball's last second of path, shown for a second. */
  let hitPath: { pts: P2[]; born: number } | null = null;
  /** The round's best moment, replayed slowly in the rest. */
  const film: { t: number; view: StageView }[] = [];
  let best: { t: number; weight: number } | null = null;
  let restFrom: number | null = null;
  let slides = 0;
  /** Modes where the player only dodges or only looks: no set-up draws. */
  /** The dodge test never asks the player to shoot. */
  const noHolds = mode === "dodge";
  /** While learning: when the sling was first held ready and still, for the first shot's help. */
  let readyFrom: number | null = null;

  function chooseSide(s: Side) {
    side = s;
    // A left-arm sling points to the screen's left: the opponent is on the left, the player in the right lane.
    me = s === "left" ? 1 : 0;
    reader = createSlingReader(defaultSetup(s), { release, aim: aimMode });
    setup = createSlingSetup(s);
    const toward = myLane().toward;
    bot = createBotBody(laneOf(me === 0 ? "right" : "left").middle, (-toward) as 1 | -1);
  }

  function say(at: P2, text: string, colour = PALETTE.text, now = lastFrame) {
    texts.push({ at, text, colour, born: now });
  }

  function slingHand(fig: Figure): P2 {
    return side === "left" ? fig.j[JOINT.L_WRIST] : fig.j[JOINT.R_WRIST];
  }

  /** The player's figure, kept inside the lane (the squeeze included). */
  function place(pose: FlatPose): Figure {
    const fig = placeFigure(pose, myLane());
    const span = match ? match.span(me) : laneSpan(me);
    const lo = span[0] + 0.12,
      hi = span[1] - 0.12;
    const dx = fig.hips.x < lo ? lo - fig.hips.x : fig.hips.x > hi ? hi - fig.hips.x : 0;
    if (!dx) return fig;
    return figureFrom(
      fig.j.map((q) => p2(q.x + dx, q.y)),
      fig.w,
      fig.stone,
    );
  }

  /** The figure of the first pose captured at or after `cap`, for rule D. */
  function laterFigure(cap: number): Figure | null {
    const p = poses.find((q) => q.cap >= cap);
    return p ? place(p) : null;
  }

  /** Every pose from the camera. */
  function onPose(pose: FlatPose) {
    lastPose = pose;
    poses.push(pose);
    while (poses.length > 90) poses.shift();
    if (step === "side") {
      const s = armHeldOut(pose);
      if (s && s === sideSeen) {
        if (pose.t - sideSince > 500) {
          chooseSide(s);
          step = noHolds ? "play" : "first";
          firstAskedAt = pose.t;
        }
      } else {
        sideSeen = s;
        sideSince = pose.t;
      }
    }
    if (!reader) return;
    // Set-up is learned while playing: the player's level, full draw and arm length from their own held draws.
    if (!reader.setup().measured) {
      const got = setup.update(pose);
      if (got) reader.configure({ level: got.level, fullDraw: got.fullDraw, armLen: got.armLen, measured: true });
    }
    // The first shot: held ready for 2.5 s with no flick, it fires on stillness, so the first ball always flies.
    if (step === "first" && release === "flick" && readyFrom !== null && pose.t - readyFrom > 2500) reader.configure({}, { release: "still" });
    const r = reader.update(pose);
    if (r.state === "ready") readyFrom ??= pose.t;
    else readyFrom = null;
    reads.push(r);
    lastRead = r;
  }

  function launchMine(now: number, shot: SlingShot) {
    if (!myFig || !side) return;
    const toward = myLane().toward;
    const flight = launch(slingHand(myFig), toward, shot.angle, shot.speed, now, shot.power);
    let ball: Ball | null = null;
    if (match && step === "play") {
      ball = match.throwBall(me, flight, { dark: darkNow(now) });
    } else ball = arena.launch(me, flight, { dark: false });
    cues.push({ kind: "thwip" }, { kind: "whistle", seconds: timeToFloor(flight) * 0.7 });
    puffs.push({ at: flight.from, born: now });
    lastShotPath = pathOf(flight, 0, timeToFloor(flight));
    const entry: Shot = { ball, flight, sling: shot, target: null, miss: null };
    if (mode === "sling") {
      const line = SLING_LINES[lineIdx].id;
      entry.lineId = line;
      entry.target = line === "l3" ? ["front", "middle", "back"][l3Target] : line === "free" || line === "l8" ? "walker" : "middle";
      if (line === "l3") answers.ask(now + 1500);
      if (line === "l6") l6Shots++;
    }
    shots.push(entry);
    if (step === "first") {
      step = "play";
      reader?.configure({}, { release });
      if (match) match.start(now);
    }
  }

  function darkNow(now: number) {
    if (dark === "off") return false;
    if (dark === "always") return true;
    return !!match && match.clock(now) >= RULES.squeezeAt[0];
  }

  /** The far lane's bodies in the tests. */
  function testTargets(now: number): { name: string; fig: Figure }[] {
    // Before the sling arm is chosen the player stands in the right lane, so the targets show on the left.
    const far = laneOf(me === 0 ? "right" : "left");
    const toward = (-myLane().toward) as 1 | -1;
    if (mode === "probe") return [dummies(far.middle, toward)[1]];
    if (mode === "sling") {
      const line = SLING_LINES[lineIdx].id;
      if (line === "free" || line === "l8") {
        const w = walkerAt(far.middle, toward, now / 1000);
        return [{ name: "walker", fig: standardFigure({ x: w.x, duck: w.duck, toward }) }];
      }
      if (line === "l2") return [];
      return dummies(far.middle, toward);
    }
    return [];
  }

  function missDistance(flight: Flight, fig: Figure): number {
    const pts = pathOf(flight, 0, timeToFloor(flight), 0.01);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) best = Math.min(best, nearest(fig, pts[i - 1], pts[i]));
    return Math.max(0, best);
  }

  /** The bot shooter for the dodge test: a schedule of 40. */
  function dodgeBot(now: number) {
    if (!bot || !myFig || dodgeIdx >= 40) return;
    const block = Math.floor(dodgeIdx / 10);
    if (!botShot && now >= botNextAt && !answers.waiting()) {
      const kinds: ["fast" | "middle" | "lob", "head" | "chest" | "neck"][] = [
        ["lob", "head"],
        ["lob", "chest"],
        ["fast", "head"],
        ["fast", "neck"],
        ["fast", "chest"],
        ["middle", "head"],
      ];
      const [kind, zone] = kinds[Math.floor(rnd() * kinds.length)];
      const lead = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) * 0.22 : 0;
      botShot = aimShot(bot, myFig, { kind, zone, lead, now, drawS: 0.5, holdS: 0.8 });
      if (!botShot) botNextAt = now + 500;
    }
    if (botShot) {
      const b = DODGE_BLOCKS[block];
      const k = Math.min(1, (now - botShot.drawAt) / 500);
      bot.holdSling(now < botShot.releaseAt ? { angle: botShot.angle, draw: k } : null);
      if (now >= botShot.releaseAt) {
        const flight = botLaunch(bot, botShot, now);
        const isDark = block === 3 ? rnd() < 0.6 : b.dark;
        const ball = arena.launch(them(), flight, { dark: isDark, tag: `${block}` });
        incomingLog.set(ball.id, { block, fan: botShot.fan, kind: botShot.kind });
        puffs.push({ at: flight.from, born: now });
        bot.flick(now);
        cues.push({ kind: "thwip" }, { kind: "whistle", seconds: timeToFloor(flight) * 0.7, quiet: isDark });
        botShot = null;
        dodgeIdx++;
        botNextAt = now + 2600;
      }
    }
  }
  const incomingLog = new Map<number, { block: number; fan: Fan; kind: string }>();

  /** The bot in the duel: picks shots when it holds a ball, and dodges. */
  function duelBot(now: number) {
    if (!bot || !match || !myFig) return;
    const phase = match.phase();
    if (phase !== "play") {
      bot.holdSling(null);
      botShot = null;
      return;
    }
    const held = match.players()[them()].held.length;
    if (!botShot && held > 0 && match.canThrow(them(), now)) {
      if (botNextAt < now - 6000) botNextAt = now + 1000 * (1.2 + rnd() * 2);
      if (now >= botNextAt) {
        const r = rnd();
        const kind = r < 0.45 ? "fast" : r < 0.7 ? "middle" : "lob";
        const zone = rnd() < 0.55 ? "head" : "chest";
        const lead = rnd() < 0.35 ? (rnd() < 0.5 ? -1 : 1) * 0.2 : 0;
        botShot = aimShot(bot, myFig, { kind, zone, lead, now, drawS: 0.4, holdS: 0.5 + rnd() * 0.5 });
        if (!botShot) botNextAt = now + 400;
      }
    }
    if (botShot) {
      const k = Math.min(1, (now - botShot.drawAt) / 400);
      bot.holdSling(now < botShot.releaseAt ? { angle: botShot.angle, draw: k } : null);
      if (now >= botShot.releaseAt) {
        if (match.release(them(), now)) {
          const flight = botLaunch(bot, botShot, now);
          match.throwBall(them(), flight, { dark: darkNow(now) });
          puffs.push({ at: flight.from, born: now });
          bot.flick(now);
          cues.push({ kind: "thwip" }, { kind: "whistle", seconds: timeToFloor(flight) * 0.7, quiet: darkNow(now) });
        }
        botShot = null;
        botNextAt = now + 1000 * (1.0 + rnd() * 2.2);
      }
    } else bot.holdSling(null);
  }

  function handleEvents(now: number, events: MatchEvent[]) {
    for (const e of events) {
      if (e.kind === "hit") {
        const colour = e.ball.from === me ? PALETTE.me : PALETTE.them;
        splats.push({ at: e.at, colour: PALETTE.goo, born: now });
        cues.push({ kind: "splorch" });
        mark(now, e.zone === "head" ? 3 : 2);
        if (e.who === me) {
          const sNow = (now - e.ball.flight.t0 - e.ball.heldMs) / 1000;
          hitPath = { pts: pathOf(e.ball.flight, Math.max(0, sNow - 1), sNow, 0.02), born: now };
          say(p2(e.at.x, e.at.y + 0.2), e.zone === "head" ? "−2" : "−1", PALETTE.squeeze, now);
          lastHitOnMe = { at: now, ghost: laterFigure((poses[poses.length - 1]?.cap ?? 0) - 1) };
          if (mode === "dodge") {
            const info = incomingLog.get(e.ball.id);
            dodgeLog.push({ block: info?.block ?? 0, hit: true, zone: e.zone, fan: info?.fan ?? "flat", kind: info?.kind ?? "", drawnOnly: e.drawnOnly });
            answers.ask(now);
            answerFor = dodgeLog.length - 1;
          }
          if (mode === "duel" && duel.mine + duel.notMine < 10) {
            answers.ask(now);
            answerFor = -1;
          }
        } else {
          say(p2(e.at.x, e.at.y + 0.2), e.zone === "head" ? "HEAD" : "CHEST", colour, now);
          if (mode === "duel") {
            duel.myHits++;
            const reason = whyHit(now, e.ball);
            duel.botHits[reason] = (duel.botHits[reason] ?? 0) + 1;
          }
        }
      } else if (e.kind === "slide" && e.who === me) {
        slides++;
        say(p2(e.ball.pos.x, e.ball.pos.y + 0.15), "slid off", PALETTE.text, now);
      } else if (e.kind === "close" && e.who === me) {
        mark(now, 1);
        cues.push({ kind: "zing" });
        say(p2(myFig?.head.c.x ?? 0, (myFig?.head.c.y ?? 1.6) + 0.25), `MISSED ME · ${Math.max(1, Math.round(e.gap * 100))} cm`, PALETTE.goo, now);
        if (mode === "dodge") {
          const info = incomingLog.get(e.ball.id);
          dodgeLog.push({ block: info?.block ?? 0, hit: false, close: e.gap, fan: info?.fan ?? "flat", kind: info?.kind ?? "" });
        }
        if (mode === "duel" && lastRead && (lastRead.state === "drawing" || lastRead.state === "ready")) duel.drawnDodges++;
      } else if (e.kind === "miss" && e.ball.to === me && mode === "dodge") {
        const info = incomingLog.get(e.ball.id);
        dodgeLog.push({ block: info?.block ?? 0, hit: false, fan: info?.fan ?? "flat", kind: info?.kind ?? "" });
      } else if (e.kind === "miss" && e.ball.to === me && mode === "duel" && lastRead && (lastRead.state === "drawing" || lastRead.state === "ready")) {
        duel.drawnDodges++;
      } else if (e.kind === "squeeze") cues.push({ kind: "squeeze" });
      else if (e.kind === "go" || e.kind === "round") cues.push({ kind: "bell" });
      else if (e.kind === "round-end") {
        duel.rounds.push(`${e.winner === me ? "won" : "lost"} on ${e.how}`);
        cues.push({ kind: "bell" });
      } else if (e.kind === "self-lob") say(p2(e.ball.pos.x, 2.2), "too slow!", PALETTE.squeeze, now);
    }
  }
  let lastHitOnMe: { at: number; ghost: Figure | null } | null = null;
  /** Remember the round's best moment: the last hit beats a close call. */
  function mark(now: number, weight: number) {
    if (!best || weight >= best.weight || now - best.t > 30_000) best = { t: now, weight };
  }

  /** Why a ball hit the bot (DUEL.md 11, step 3's counter). */
  function whyHit(now: number, ball: Ball): string {
    if (!match || !bot) return "read";
    const t = match.clock(now);
    const span = match.span(them());
    const bx = bot.state().x;
    const two = match.arena.balls().filter((b) => b.from === me && b.phase === "flying").length >= 1;
    if (t >= RULES.squeezeAt[0]) return "squeeze";
    if (two) return "two at once";
    if (bx < span[0] + 0.2 || bx > span[1] - 0.2) return "pin";
    if (ball.dark && fanOf(ball.flight.angle) === "flat") return "dark guess";
    return "read";
  }

  return {
    mode,
    onPose,
    /** Advance to `now`; `tracked` says whether the camera follows a body, `calibrated` whether set-up locked. */
    frame(now: number, o2: { live: boolean; calibrated: boolean; pose: FlatPose | null }): { stage: StageView; hud: Hud; cues: SoundCue[]; read: SlingRead | null } {
      const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
      lastFrame = now;
      if (!o2.live) step = "camera";
      else if (step === "camera") step = "stand";
      if (step === "stand" && o2.calibrated) step = side ? "play" : "side";
      // The player's figure.
      const pose = o2.pose ?? lastPose;
      stone = !o2.pose;
      if (pose) {
        const f = place(pose);
        myFig = stone ? { ...f, stone: true } : f;
      }
      // Arm-up share (line 7).
      if (lastRead && step === "play") {
        if (lastArmAt) {
          armTotalMs += now - lastArmAt;
          if (lastRead.armUp) armUpMs += now - lastArmAt;
        }
        lastArmAt = now;
      }
      // Shots and refusals read since the last frame.
      for (const r of reads.splice(0)) {
        if (r.shot) {
          if (mode === "sling" && SLING_LINES[lineIdx].id === "l2") {
            l2Fires++;
            say(p2(myFig?.head.c.x ?? 0, 2.1), "FIRED", PALETTE.squeeze, now);
            continue;
          }
          if (match && step === "play") {
            if (!match.release(me, now)) {
              say(myFig ? slingHand(myFig) : p2(), match.players()[me].held.length ? "wait" : "no ball", PALETTE.text, now);
              cues.push({ kind: "tick" });
              continue;
            }
            duel.myShots++;
          }
          pendingLaunch.push({ at: now + launchDelay, shot: r.shot });
        }
        if (r.refused) {
          refusals.push({ t: now, reason: r.refused.reason, gate: r.refused.gate });
          if (myFig && r.refused.reason !== "settle") say(slingHand(myFig), r.refused.reason, "#ffd27a", now);
          cues.push({ kind: "tick" });
        }
        if (r.state !== "down" && mode === "sling" && SLING_LINES[lineIdx].id === "l6" && r.edge && r.edge.top < 0.02) l6Lost++;
      }
      for (const p of pendingLaunch.filter((q) => q.at <= now)) launchMine(now, p.shot);
      pendingLaunch = pendingLaunch.filter((q) => q.at > now);
      // Bots, match, arena.
      const tTargets = testTargets(now);
      let events: MatchEvent[] = [];
      if (bot && side) {
        const span = match ? match.span(them()) : laneSpan(them());
        if (mode === "dodge" && step === "play") dodgeBot(now);
        if (mode === "duel") duelBot(now);
        if (mode === "duel") {
          const balls = match!.arena.balls().filter((b) => b.to === them() && b.phase !== "down");
          const inc: Incoming[] = balls.map((b) => ({ id: b.id, flight: b.flight, seenAt: b.dark ? b.wallAt : b.flight.t0, fan: fanOf(b.flight.angle) }));
          defender.update(now, bot, inc, span);
        }
        bot.step(dt, span);
      }
      const meTarget: Target | null =
        myFig && step === "play"
          ? stone
            ? { fig: myFig, judge: "drawn" }
            : { fig: myFig, judge: "rule-d", cap: pose?.cap, later: laterFigure }
          : null;
      if (match) {
        if (step === "play") match.start(now);
        const botFig = bot ? bot.figure(now) : null;
        const tg: [Target | null, Target | null] = me === 0 ? [meTarget, botFig ? { fig: botFig, judge: "drawn" } : null] : [botFig ? { fig: botFig, judge: "drawn" } : null, meTarget];
        events = match.step(now, tg, me === 0 ? [myFig?.hips.x ?? null, bot?.state().x ?? null] : [bot?.state().x ?? null, myFig?.hips.x ?? null]);
        arena.step(now, [null, null]);
        for (const b of arena.balls()) if (b.phase === "down" && b.downAt !== null && now - b.downAt > 1200) arena.remove(b.id);
      } else {
        const far: Target | null = mode === "dodge" ? null : null;
        const tg: [Target | null, Target | null] = me === 0 ? [meTarget, far] : [far, meTarget];
        events = arena.step(now, tg);
        // In the tests a ball at a dummy is judged against the dummy alone, and comes back at once.
        for (const b of arena.balls()) {
          if (b.from !== me || b.phase === "down") continue;
          for (const d of tTargets) {
            const prev = at(b.flight, Math.max(0, (now - 16 - b.flight.t0) / 1000));
            const hit = sweepTarget(d.fig, prev, b.pos);
            if (hit) {
              b.phase = "down";
              b.downAt = now;
              splats.push({ at: b.pos, colour: PALETTE.goo, born: now });
              cues.push({ kind: "splorch" });
              say(p2(b.pos.x, b.pos.y + 0.2), d.name === "walker" ? "SPLAT" : hit === "head" ? "HEAD" : "CHEST", PALETTE.me, now);
              if (d.name === "walker") walkerStains.push({ at: b.pos, born: now });
            }
          }
        }
        for (const b of arena.balls()) if (b.phase === "down" && b.downAt !== null && now - b.downAt > 1200) arena.remove(b.id);
      }
      handleEvents(now, events);
      // Miss distances for test shots, once the ball is down.
      for (const s of shots)
        if (s.miss === null && s.ball && s.ball.phase === "down" && s.target) {
          const d = tTargets.find((t) => t.name === s.target) ?? (s.target === "walker" ? tTargets[0] : null);
          if (d) s.miss = missDistance(s.flight, d.fig);
          if (s.lineId === "l3") l3Target = Math.floor(rnd() * 3);
        }
      // Answers.
      const ans = answers.update(o2.pose, now);
      if (ans) giveAnswer(ans);
      const live = view(now, tTargets);
      let shown = live;
      if (match && match.phase() === "play") {
        restFrom = null;
        film.push({ t: now, view: live });
        while (film.length && film[0].t < now - 8000) film.shift();
      } else if (match && match.phase() === "rest" && best && film.length) {
        restFrom ??= now;
        // About eight seconds of rest: the three seconds around the best moment at 0.4 speed.
        const k = (now - restFrom) * 0.4;
        const t = best.t - 2000 + k;
        if (k < 3000) {
          const f = film.find((x) => x.t >= t) ?? film[film.length - 1];
          shown = { ...f.view, texts: [...f.view.texts, { at: p2(0, 2.45), text: "REPLAY", colour: "#ffd27a", k: 0 }] };
        }
      } else if (match && match.phase() === "count") {
        best = null;
        film.length = 0;
      }
      return { stage: shown, hud: hud(now), cues: cues.splice(0), read: lastRead };
    },
    key(k: string) {
      const a = answers.key(k);
      if (a) giveAnswer(a);
    },
    /** Skip set-up's held draws (use the defaults). */
    skipSetup() {
      if (step === "holds") {
        step = "first";
        firstAskedAt = lastPose?.t ?? 0;
      }
    },
    nextLine(now: number) {
      if (mode === "sling" && lineIdx < SLING_LINES.length - 1) {
        lineIdx++;
        lineStart = now;
        if (SLING_LINES[lineIdx].id === "l2") l2Fires = 0;
      }
      if (mode === "probe" && probeStep < PROBE_STEPS.length - 1) probeStep++;
      if (mode === "duel" && match) match.next(now);
    },
    restartMatch(now: number) {
      if (mode !== "duel") return;
      match = createMatch({ balls: o.balls ?? 2, server: 0 });
      if (step === "play") match.start(now);
    },
    set(next: Partial<Pick<SessionOptions, "release" | "aim" | "look" | "launchDelayMs" | "dark">>) {
      if (next.release) release = next.release;
      if (next.aim) aimMode = next.aim;
      if (next.look) look = next.look;
      if (next.launchDelayMs !== undefined) launchDelay = next.launchDelayMs;
      if (next.dark) dark = next.dark;
      reader?.configure({}, { release, aim: aimMode });
    },
    settings: () => ({ release, aim: aimMode, look, launchDelayMs: launchDelay, dark }),
    /** Everything measured, for the log file. */
    report() {
      return {
        mode,
        side,
        setup: reader?.setup() ?? null,
        shots: shots.map((s) => ({ angle: s.sling.angle, power: s.sling.power, handLine: s.sling.handLine, raisedMs: s.sling.raisedMs, readMs: s.sling.readMs, release: s.sling.release, target: s.target, miss: s.miss, line: s.lineId, answer: s.answer })),
        refusals,
        dodge: dodgeLog,
        /** Drawn touches that rule D refused (the body had already left). */
        slides,
        duel,
        armUp: armTotalMs ? armUpMs / armTotalMs : null,
      };
    },
  };

  function giveAnswer(a: Answer) {
    if (mode === "dodge" && answerFor !== null && dodgeLog[answerFor]) dodgeLog[answerFor].answer = a;
    if (mode === "sling") {
      const s = [...shots].reverse().find((q) => q.lineId === "l3" && !q.answer);
      if (s) s.answer = a;
    }
    if (mode === "duel") {
      if (a === "mine") duel.mine++;
      else duel.notMine++;
    }
    answerFor = null;
    say(p2(myFig?.head.c.x ?? 0, 2.2), a === "mine" ? "mine ✓" : a === "not mine" ? "not mine" : "guessed wrong", PALETTE.text, lastFrame);
  }

  function view(now: number, tTargets: { name: string; fig: Figure }[]): StageView {
    const figures: FigureDraw[] = [];
    const meDraw: FigureDraw | null = myFig
      ? {
          fig: myFig,
          colour: PALETTE.me,
          shade: PALETTE.meShade,
          held: match ? match.clocks(me, now) : undefined,
          glow: lastRead?.glow && side ? slingHand(myFig) : null,
          hold:
            side && lastRead && (lastRead.state === "drawing" || lastRead.state === "ready")
              ? { at: side === "left" ? myFig.j[JOINT.R_WRIST] : myFig.j[JOINT.L_WRIST], k: lastRead.holdK, ready: lastRead.state === "ready" }
              : null,
          stains: match?.players()[me].stains.map((q) => p2(myFig!.hips.x + q.x, myFig!.hips.y + q.y)),
          flash: lastHitOnMe ? Math.max(0, 1 - (now - lastHitOnMe.at) / 400) : 0,
          ghost: lastHitOnMe && now - lastHitOnMe.at < 1000 ? lastHitOnMe.ghost : null,
        }
      : null;
    if (myFig && (step === "side" || step === "holds" || step === "first")) {
      // The pose to copy, as a yellow shape on the player's own spot.
      const toward = myLane().toward;
      const guide = standardFigure({ x: myFig.hips.x, toward, sling: step === "side" ? { angle: 50, draw: 0 } : { angle: 52, draw: 1 } });
      figures.push({ fig: guide, colour: "rgba(255,214,90,0.6)", shade: "rgba(255,214,90,0.3)" });
    }
    if (meDraw) figures.push(meDraw);
    for (const d of tTargets)
      figures.push({
        fig: d.fig,
        colour: d.name === "walker" ? PALETTE.them : (mode === "sling" && SLING_LINES[lineIdx].id === "l3" && ["front", "middle", "back"][l3Target] === d.name) ? "#ffd27a" : PALETTE.dummy,
        shade: PALETTE.dummyShade,
        stains: d.name === "walker" ? walkerStains.filter((s) => now - s.born < 4000).map((s) => s.at) : undefined,
      });
    if (bot && (mode === "dodge" || mode === "duel")) {
      const s = bot.state();
      const f = bot.figure(now);
      const fanBand = botShot && now < botShot.releaseAt && (mode === "duel" || DODGE_BLOCKS[Math.min(3, Math.floor(dodgeIdx / 10))].fan) ? botShot.fan : null;
      figures.push({
        fig: f,
        colour: PALETTE.them,
        shade: PALETTE.themShade,
        held: match ? match.clocks(them(), now) : undefined,
        stains: match?.players()[them()].stains.map((q) => p2(f.hips.x + q.x, f.hips.y + q.y)),
        fan: fanBand ? { band: fanBand, toward: s.toward, from: s.toward < 0 ? f.j[JOINT.L_WRIST] : f.j[JOINT.R_WRIST] } : null,
        label: mode === "duel" ? (o.defender === "wall" ? "WALL" : "COACH") : "BOT",
      });
    }
    const arenas = match ? [match.arena, arena] : [arena];
    const balls = arenas.flatMap((a) =>
      a
        .balls()
        .filter((b) => b.phase !== "down")
        .map((b) => ({ at: b.pos, vel: b.vel, rim: b.from === me ? "#ffb35c" : "#5cc8ff", dark: !a.visibleTo(b, me), squash: b.phase === "squash", arrow: look === "arrow" && b.from === me })),
    );
    const wallPulse = (match ? match.arena : arena)
      .balls()
      .some((b) => b.to === me && b.dark && b.wallAt === null && b.phase === "flying")
      ? 0.5 + 0.5 * Math.sin(now / 70)
      : 0;
    const paths: StageView["paths"] = [];
    // While drawing: a stub of the first quarter second at the angle and power a release now would give.
    if (myFig && lastRead && (lastRead.state === "drawing" || lastRead.state === "ready") && lastRead.angle !== null && side) {
      const speed = Math.max(SLING.speedMin, Math.min(SLING.speedMax, SLING.speedMin + (SLING.speedMax - SLING.speedMin) * Math.max(0, (Math.min(1, lastRead.draw) - SLING.powerMin) / (1 - SLING.powerMin))));
      const f = launch(slingHand(myFig), myLane().toward, lastRead.angle, speed, 0);
      paths.push({ pts: pathOf(f, 0, SLING.stubS, 0.02), colour: lastRead.state === "ready" ? "#ffd27a" : "rgba(255,210,122,0.5)", width: 3 });
    }
    if (lastShotPath.length) paths.push({ pts: lastShotPath, colour: "rgba(255,179,92,0.22)", dashed: true });
    if (hitPath && now - hitPath.born < 1000) paths.push({ pts: hitPath.pts, colour: "rgba(255,93,93,0.7)", width: 2 });
    const rings: StageView["rings"] = [];
    // Line 3's first five shots show where they land: the path's crossing of the named dummy's lane.
    if (mode === "sling" && SLING_LINES[lineIdx].id === "l3" && shots.filter((s) => s.lineId === "l3").length < 5 && myFig && lastRead?.angle != null && side) {
      const speed = SLING.speedMin + (SLING.speedMax - SLING.speedMin) * Math.max(0, (Math.min(1, lastRead.draw) - SLING.powerMin) / (1 - SLING.powerMin));
      const f = launch(slingHand(myFig), myLane().toward, lastRead.angle, speed, 0);
      const d = tTargets.find((t) => t.name === ["front", "middle", "back"][l3Target]);
      if (d) {
        const s = (d.fig.hips.x - f.from.x) / f.vx;
        if (s > 0) rings.push({ at: at(f, s), r: 0.09, colour: "rgba(255,210,122,0.8)" });
      }
    }
    // A self-lob's landing ring.
    for (const b of (match ? match.arena : arena).balls())
      if (b.self && b.phase === "flying") rings.push({ at: p2(b.flight.from.x, 0.02), r: 0.3, colour: "rgba(255,93,93,0.8)" });
    return {
      squeeze: match ? [match.squeeze()[0], match.squeeze()[1]] : [0, 0],
      figures,
      balls,
      splats: [
        ...splats.filter((s) => now - s.born < 900).map((s) => ({ at: s.at, colour: s.colour, k: (now - s.born) / 900 })),
        // A puff at the sling when a ball leaves: the thwip, seen.
        ...puffs.filter((q) => now - q.born < 350).map((q) => ({ at: q.at, colour: "rgba(246,234,214,0.8)", k: 0.4 + (now - q.born) / 600 })),
      ],
      texts: texts.filter((t) => now - t.born < 1300).map((t) => ({ at: t.at, text: t.text, colour: t.colour, k: (now - t.born) / 1300 })),
      paths,
      rings,
      wallPulse,
      now,
    };
  }

  function hud(now: number): Hud {
    let prompt = "",
      sub = "";
    if (step === "camera") prompt = "Start the camera";
    else if (step === "stand") {
      prompt = "Stand back about 1.5 m";
      sub = "The camera should see you from above your head to your hips. Clear an arm's length behind you.";
    } else if (step === "side") {
      const seen = sideSeen && lastPose ? Math.min(1, (lastPose.t - sideSince) / 500) : 0;
      prompt = seen > 0 ? `Good, hold it… ${sideSeen} arm` : "Lift one arm straight out to the side";
      sub = "Like the yellow shape: arm straight, at shoulder height, pointing at the wall (not at the screen). Hold it one second. That arm is your slingshot.";
    } else if (step === "holds") {
      prompt = `Pull back like a slingshot · ${setup.holds()} of 3`;
      sub = "Like the yellow shape: one arm straight out to the side, the other hand pulled back to your chin. Hold still one second, then bring your hands together. Three times. (S skips this.)";
    } else if (step === "first") {
      prompt = lastRead?.state === "ready" ? "FLICK! Snap your back hand backward" : "Shoot your first ball";
      sub = "Copy the yellow shape: one arm straight out to the side, the other hand pulled back to your chin. Hold still until the ring turns green, then snap that back hand backward past your ear.";
    }
    const numbers: [string, string][] = [];
    const lines: LineRow[] = [];
    let line: Hud["line"] = null;
    const r = lastRead;
    if (mode === "probe" || mode === "sling") {
      numbers.push(
        ["state", r?.state ?? "–"],
        ["hand line", r?.handLine != null ? `${Math.round(r.handLine)}°` : "–"],
        ["launch", r?.angle != null ? `${Math.round(r.angle)}° · ${r.angle != null ? fanOf(r.angle) : ""}` : "–"],
        ["draw", r ? `${Math.round(r.draw * 100)}%` : "–"],
        ["arm to side", r ? `${Math.round(r.sideOn * 100)}%` : "–"],
        ["wrist to top / side", r?.edge ? `${cm(r.edge.top)} / ${cm(r.edge.side)}` : "–"],
        ["trunk", r ? `${r.trunk.toFixed(2)} m/s` : "–"],
        ["steady", r?.steady ? "yes" : "no"],
      );
      const lastShot = shots[shots.length - 1];
      if (lastShot) numbers.push(["last shot", `${Math.round(lastShot.sling.angle)}° ${Math.round(lastShot.sling.power * 100)}% read ${Math.round(lastShot.sling.readMs)} ms`]);
      const lastRef = refusals[refusals.length - 1];
      if (lastRef) numbers.push(["last refusal", `${lastRef.reason} (${lastRef.gate})`]);
      if (reader) {
        const su = reader.setup();
        numbers.push(["set-up", `${su.side} arm · level ${Math.round(su.level)}° · draw ${cm(su.fullDraw)} · arm ${cm(su.armLen)}${su.measured ? "" : " (defaults)"}`]);
      }
    }
    if (mode === "probe") {
      line = { id: `p${probeStep}`, text: PROBE_STEPS[probeStep] };
      lines.push({ id: "fires", name: "Fired", value: `${shots.length}`, pass: null }, { id: "ref", name: "Refused", value: `${refusals.length}`, pass: null });
    }
    if (mode === "sling") {
      const cur = SLING_LINES[lineIdx];
      line = { id: cur.id, text: cur.id === "l2" ? `${cur.text} · ${Math.max(0, 60 - Math.round((now - lineStart) / 1000))} s left` : cur.text };
      const of = (id: string) => shots.filter((s) => s.lineId === id);
      const l1 = of("l1");
      const l1Ref = refusals.filter((x) => x.reason !== "settle").length;
      lines.push({ id: "l1", name: "1 Fires when I flick", value: `${l1.length} fired · ${l1Ref} refused`, pass: l1.length >= 20 ? l1Ref <= 2 : null });
      lines.push({ id: "l2", name: "2 Never fires by itself", value: `${l2Fires} fired while holding`, pass: SLING_LINES[lineIdx].id === "l2" && now - lineStart < 60000 ? null : lineIdx > 2 ? l2Fires <= 1 : null });
      const l3 = of("l3").filter((s) => s.answer);
      const mine3 = l3.filter((s) => s.answer === "mine").length;
      lines.push({ id: "l3", name: "3 Went where I aimed", value: `${mine3} of ${l3.length} mine`, pass: l3.length >= 25 ? mine3 >= 16 : null });
      const l4 = of("l4").filter((s) => s.miss !== null);
      const blocks = [0, 1, 2].map((i) => median(l4.slice(i * 10, i * 10 + 10).map((s) => s.miss!)));
      lines.push({
        id: "l4",
        name: "4 Aim can be learned",
        value: blocks.map((b, i) => (Number.isNaN(b) ? `block ${i + 1} –` : `block ${i + 1} ${cm(b)}`)).join(" · "),
        pass: l4.length >= 30 ? blocks[2] <= blocks[0] * 0.67 && blocks[2] <= 0.3 : null,
      });
      const raised = shots.map((s) => s.sling.raisedMs).filter((x) => x > 0);
      lines.push({ id: "l5", name: "5 Quick", value: raised.length ? `${(median(raised) / 1000).toFixed(1)} s raise to release` : "–", pass: raised.length >= 10 ? median(raised) < 3000 : null });
      lines.push({ id: "l6", name: "6 Top edge", value: `${l6Lost} lost wrists in ${l6Shots} shots`, pass: l6Shots >= 10 ? l6Lost <= 1 : null });
      lines.push({ id: "l7", name: "7 Arm", value: armTotalMs ? `arm up ${Math.round((armUpMs / armTotalMs) * 100)}% of the time` : "–", pass: armTotalMs > 300_000 ? armUpMs / armTotalMs <= 0.5 : null });
      const miss = shots.filter((s) => s.miss !== null).map((s) => s.miss!);
      numbers.push(["miss (median)", miss.length ? cm(median(miss)) : "–"]);
    }
    if (mode === "dodge") {
      const b = Math.min(3, Math.floor(dodgeIdx / 10));
      line = { id: DODGE_BLOCKS[b].id, text: dodgeIdx >= 40 ? "All 40 done. Press Save log." : `${DODGE_BLOCKS[b].text} · ball ${dodgeIdx % 10 + (dodgeIdx >= 40 ? 10 : 1)} of 10` };
      const hits = dodgeLog.filter((d) => d.hit);
      const fair = hits.filter((d) => d.answer === "mine" || d.answer === "guessed wrong").length;
      const darkFlat = hits.filter((d) => d.block >= 1 && d.fan === "flat");
      const darkGame = darkFlat.filter((d) => d.answer === "not mine").length;
      lines.push({ id: "d1", name: "1 Fair", value: `${fair} of ${hits.length} hits mine or guessed wrong`, pass: hits.length >= 10 ? fair / hits.length >= 0.8 : null });
      lines.push({ id: "d2", name: "2 Fair dark balls", value: `${darkGame} of ${darkFlat.length} dark flat hits "not mine"`, pass: darkFlat.length >= 5 ? darkGame / darkFlat.length <= 0.3 : null });
      for (let i = 0; i < 4; i++) {
        const blk = dodgeLog.filter((d) => d.block === i);
        lines.push({ id: `b${i}`, name: `Block ${DODGE_BLOCKS[i].id}`, value: `${blk.filter((d) => d.hit).length} hits · ${blk.filter((d) => d.close !== undefined).length} close calls of ${blk.length}`, pass: null });
      }
    }
    let matchHud: Hud["match"] = null;
    if (match) {
      const p = match.players();
      matchHud = {
        hearts: [p[0].hearts, p[1].hearts],
        clock: match.clock(now),
        round: match.round(),
        score: [match.score()[0], match.score()[1]],
        phase: match.phase(),
        wait: match.waitLeft(now),
        me,
        held: [p[0].held.length, p[1].held.length],
      };
      if (step === "play") {
        if (match.phase() === "count") prompt = `Round ${match.round()} · ${Math.max(1, Math.ceil(match.waitLeft(now) / 1000))}`;
        if (match.phase() === "count") sub = match.server() === me ? "You serve: you start with both balls." : "They serve. Get ready to dodge.";
        if (match.phase() === "rest") {
          prompt = `${match.lastWinner() === me ? "You won the round" : "They won the round"} · ${match.score()[me]}–${match.score()[them()]}`;
          sub = `Shake out your arms. Next round in ${Math.ceil(match.waitLeft(now) / 1000)} s (N to skip).`;
        }
        if (match.phase() === "over") {
          prompt = match.score()[me] > match.score()[them()] ? "You won the match" : "You lost the match";
          sub = "Press R for another.";
        }
      }
      const hitsBy = Object.entries(duel.botHits).map(([k, v]) => `${k} ${v}`).join(", ");
      lines.push({ id: "m1", name: "1 Mine", value: `${duel.mine} mine · ${duel.notMine} not, of the first 10 hits on you`, pass: duel.mine + duel.notMine >= 10 ? duel.mine >= 8 : null });
      lines.push({ id: "m2", name: "2 A winner exists", value: `${duel.myHits} hits on the bot (${hitsBy || "none yet"}) from ${duel.myShots} balls`, pass: o.defender === "wall" && duel.myShots >= 20 ? duel.myHits >= 4 : null });
      lines.push({ id: "m3", name: "3 Two jobs at once", value: `${duel.drawnDodges} dodges with the sling drawn`, pass: null });
      lines.push({ id: "m4", name: "4 Rounds", value: duel.rounds.join(" · ") || "–", pass: null });
      lines.push({ id: "m5", name: "Arm up", value: armTotalMs ? `${Math.round((armUpMs / armTotalMs) * 100)}%` : "–", pass: null });
    }
    return {
      step,
      prompt,
      sub,
      match: matchHud,
      numbers,
      lines,
      line,
      asking: answers.waiting(),
      fan: botShot && now < botShot.releaseAt && mode === "duel" ? botShot.fan : null,
      sling:
        side && lastRead && mode !== "dodge" && (step === "first" || step === "play")
          ? { armOut: lastRead.armOut, pulled: lastRead.pulled, hold: lastRead.holdK, ready: lastRead.state === "ready" }
          : null,
    };
  }
}
export type DuelSession = ReturnType<typeof createDuelSession>;

function sweepTarget(fig: Figure, a: P2, b: P2): "head" | "chest" | null {
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const q = p2(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    const dh = Math.hypot(q.x - fig.head.c.x, q.y - fig.head.c.y) - fig.head.r - 0.07;
    if (dh <= 0) return "head";
    const dx = Math.max(fig.chest.x0 - q.x, 0, q.x - fig.chest.x1),
      dy = Math.max(fig.chest.y0 - q.y, 0, q.y - fig.chest.y1);
    if (Math.hypot(dx, dy) <= 0.07) return "chest";
  }
  return null;
}

export { other, solveLaunch, FIELD };
