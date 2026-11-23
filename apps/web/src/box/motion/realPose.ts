import type { Vec3 } from "../../pov/physics";
import { DISTANCE, type FoePose } from "../opponentPose";
import type { PoseMaker } from "../real/game";
import type { Bout, PunchTimes, Thrown } from "../real/rules";
import { distanceOf, standInPose, type StandInOptions } from "../real/standIn";
import { formulaFall } from "./fall";
import { PACK_URL, loadPack } from "./pack";
import { createMotionPlayer, type MotionPlayer } from "./player";
import { PUNCH_SPAN, PUNCH_TIMES, rulesTimes } from "./times";
import type { GuardPlace, MotionDrive, MotionPunch, Pack } from "./types";
import { clamp, distance, mix, smooth, v3 } from "./vec";

/**
 * The recorded motion as the pose maker the game takes
 * (`createRealGame({ pose, times })`), in place of the stand-in formula body.
 *
 *   const motion = loadMotionPose();              // starts fetching the pack
 *   createRealGame({ pose: motion.pose, times: MOTION_TIMES });
 *
 * Until the pack has arrived (or if it never does) `motion.pose` gives the
 * stand-in's pose, so the game can start at once.
 *
 * It reads the bout exactly as real/standIn.ts does: the stage places the
 * opponent's frame at its range, so no point is moved by a step here; things
 * the opponent planned (punches, steps, gloves) are read at the time given;
 * things that answer the player (the fall, being hurt) are read `ahead`
 * seconds earlier, from their own beginning.
 */

/**
 * Where a punch's glove is asked to be at contact, metres from the player's
 * eye. To the head: as far short of the eye as the stand-in stops (0.42),
 * to its own side so it does not hide everything, and at the chin, not the
 * eye: a recorded punch lands about there by itself (these boxers throw at
 * 1.42 to 1.51 m), and a glove under the line of sight leaves the opponent
 * visible. To the body: the belly, where the recorded body punches land.
 */
export const LANDING = {
  short: 0.42,
  side: 0.06,
  chin: 0.1,
  /** Taken on the player's glove: this much further out. */
  blocked: 0.1,
  body: { down: 0.5, short: 0.55 },
  /** The corner's replay, seen from the side: the fist goes all the way, with no offset. */
  again: { short: 0.1, chin: 0.05 },
};

/**
 * The clips' own punch times, as the rules read them. Not what the game
 * gives the rules: one performer's timing for all five opponents takes away
 * what tells them apart (measured: a middle-level player's 48% against the
 * top of the ladder becomes 2%). See `fitTimes`.
 */
export const MOTION_TIMES: PunchTimes = rulesTimes();
/** The same with every punch slower to start, for a beginner: only the load stretches, and no further than the clips allow (1 to 1.67). */
export const motionTimes = (slower = 1): PunchTimes => rulesTimes(slower);

/**
 * An opponent's own punch times, held to what the clips can show. A clip can
 * be played slower only so far before it reads as slow motion, so a punch
 * the rules give 0.7 s may be on screen for 0.45: here the rules are told
 * the time the player will really see. A punch quicker than the clip is left
 * alone: the clip then starts part-way through its wind-up, which is what a
 * better boxer's punch looks like.
 */
export function fitTimes(own: PunchTimes): PunchTimes {
  const out = {} as PunchTimes;
  for (const kind of Object.keys(own) as (keyof PunchTimes)[]) {
    const t = own[kind];
    const impact = Math.min(t.impact, PUNCH_SPAN[kind].most);
    // The moment the aim is fixed keeps its place in the punch.
    out[kind] = { commit: t.impact > 0 ? t.commit * (impact / t.impact) : 0, impact, home: t.home };
  }
  return out;
}
/**
 * When the fist leaves, for the picture. The rules' `commit` is when the aim
 * is fixed, which for a beginner is the first movement; the clip's fist
 * leaves where the recording's own proportions put it, as near as its flight
 * may be bent (0.9 to 1.1 of its speed).
 */
function launchOf(p: Thrown): number {
  if (p.feint) return p.commit;
  const c = PUNCH_TIMES[p.kind];
  const whole = p.impact - p.start;
  const flight = clamp((whole * c.strike) / (c.load + c.strike), c.strike / 1.1, c.strike / 0.9);
  return Math.max(p.start, p.impact - flight);
}

/**
 * The player's eye in the opponent's frame, where it really is. The game
 * gives it as if the opponent always stood at the edge (`headForFoe`), but
 * the stage places the frame at `distanceOf`: stepped into the pocket the
 * eye is that much nearer. The glove is stopped short of, and kept clear
 * of, the eye as it is.
 */
export const eyeOf = (s: Bout, t: number, o: StandInOptions): Vec3 =>
  // Told where it really stands, the target is already the eye where it is.
  o.distance !== undefined ? v3(o.target.x, o.target.y, o.target.z) : v3(o.target.x, o.target.y, o.target.z - DISTANCE + distanceOf(s, t));

function punchOf(p: Thrown, s: Bout, t: number, o: StandInOptions, newest: boolean): MotionPunch {
  const eye = eyeOf(s, t, o);
  const sign = p.hand === "left" ? -1 : 1;
  const blocking = newest && o.blocking === true && !o.again;
  let target: Vec3;
  if (p.level === "body") {
    // The ribs under where the head is now: a body cannot be taken off the line.
    target = v3(eye.x * 0.5, eye.y - LANDING.body.down, eye.z - LANDING.body.short);
  } else {
    // The head where it was when the rules fixed the aim; until then, where it is.
    const x = p.aim ? -p.aim.x : eye.x,
      y = p.aim?.y ?? eye.y;
    target = o.again
      ? v3(x, y - LANDING.again.chin, eye.z - LANDING.again.short)
      : v3(x + sign * LANDING.side, y - LANDING.chin, eye.z - LANDING.short);
  }
  return {
    id: p.id,
    kind: p.kind,
    hand: p.hand,
    level: p.level,
    shape: p.shape,
    start: p.start,
    commit: launchOf(p),
    impact: p.impact,
    home: p.home,
    feint: p.feint,
    target,
    block: blocking ? v3(target.x, target.y, target.z - LANDING.blocked) : null,
    // The rules run a little behind what is drawn: the picture follows the head until they have fixed the aim.
    fixed: p.level === "head" ? p.aim !== null : t >= p.impact,
  };
}

/** The bout at a time, as the plain description the motion player takes. */
export function driveOf(s: Bout, t: number, o: StandInOptions): MotionDrive {
  const foe = s.foe;
  // What answers the player is drawn from its own beginning.
  const answered = t - s.ahead;
  // The newest punch that has begun, as drawn, and is not yet home.
  let punch: Thrown | null = null;
  for (const p of foe.punches) if (t >= p.start - 1 / 30 && t < p.home) punch = p;
  const move = Math.max(0.05, s.boxer.guardMove);
  const place = (i: 0 | 1): GuardPlace => {
    const g = foe.gloves[i];
    return g.next && t >= g.next.at - move ? g.next.place : g.place;
  };
  const down = foe.down;
  const out = s.over !== null && s.over.winner === "me";
  const hurt = down?.standing
    ? 1
    : answered < foe.hurtUntil
      ? Math.min(smooth((answered - foe.solidAt) / 0.12), smooth((foe.hurtUntil - answered) / 0.3))
      : 0;
  return {
    time: t,
    idle: foe.mode === "set" && !foe.visit && !punch,
    punch: punch ? punchOf(punch, s, t, o, punch === foe.punches[foe.punches.length - 1]) : null,
    // With range off it stands where it stands.
    step: s.range ? { from: foe.feet.from, to: foe.feet.to, start: foe.feet.start, end: foe.feet.end } : null,
    guard: [place(0), place(1)],
    guardMove: move,
    tired: clamp(1 - foe.breath / 60),
    hurt,
    // The stage lays the knock of a landed punch over the pose itself (reaction.ts).
    hit: null,
    eye: eyeOf(s, t, o),
    down:
      down && !down.standing
        ? {
            since: down.since + s.ahead,
            until: out ? Infinity : down.until + s.ahead,
            out,
            ...(o.struck ? { by: { hand: o.struck.hand, shape: o.struck.shape } } : {}),
          }
        : null,
  };
}

/** A motion pose as the `FoePose` the stage draws: the feet go with the hips as far as the aim carried them. */
const drawn = (p: FoePose & { carried?: number }): FoePose => ({
  ...(p.feet ? { feet: p.feet } : {}),
  head: p.head,
  chest: p.chest,
  hips: p.hips,
  shoulders: p.shoulders,
  gloves: p.gloves,
  poles: p.poles,
  fallen: p.fallen,
  loading: null,
  open: 0,
  turn: p.turn,
  lunge: p.carried ?? 0,
});
/** Every point of one pose moved a share of the way to another. */
function between(a: FoePose, b: FoePose, k: number): FoePose {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const pair = (x: [Vec3, Vec3], y: [Vec3, Vec3]): [Vec3, Vec3] => [mix(x[0], y[0], k), mix(x[1], y[1], k)];
  return {
    head: mix(a.head, b.head, k),
    chest: mix(a.chest, b.chest, k),
    hips: mix(a.hips, b.hips, k),
    shoulders: pair(a.shoulders, b.shoulders),
    gloves: pair(a.gloves, b.gloves),
    poles: pair(a.poles, b.poles),
    fallen: a.fallen + (b.fallen - a.fallen) * k,
    loading: null,
    open: 0,
    turn: a.turn + (b.turn - a.turn) * k,
    lunge: a.lunge + (b.lunge - a.lunge) * k,
    ...(a.feet && b.feet ? { feet: pair(a.feet, b.feet) } : {}),
  };
}

/** A stretch of a bout played through once and kept, for showing again. */
interface Recording {
  target: Vec3;
  from: number;
  step: number;
  poses: FoePose[];
}

/**
 * The pose maker for a loaded pack.
 *
 * The bout as it runs is played by one player object, which remembers
 * (blends, which loop it is in). A moment shown again (`again: true`, the
 * corner's replay) never touches that: the snapshot it is given is played
 * through once by a player of its own, from before its first punch to after
 * its last, and kept; any time asked for is then read from that. So the
 * same (bout, time) always gives the same pose, in any order, and nothing
 * leaks either way.
 */
export function createMotionPose(pack: Pack, seed = 1): PoseMaker {
  let live: { player: MotionPlayer; southpaw: boolean } | null = null;
  const recordings = new WeakMap<Bout, Recording>();
  const STEP = 1 / 120;

  function record(s: Bout, o: StandInOptions): Recording {
    const punches = s.foe.punches;
    const first = punches.length ? Math.min(...punches.map((p) => p.start)) : s.time;
    const last = punches.length ? Math.max(...punches.map((p) => p.home)) : s.time;
    const from = first - 0.5,
      to = last + 0.4;
    // Seen from the side the fist goes all the way: the hips may carry it
    // much further than through the lens, and nothing keeps it off the eye.
    const player = createMotionPlayer(pack, {
      southpaw: s.lead === "right",
      fall: formulaFall,
      stageMoves: true,
      seed,
      aim: { hips: 0.45, near: 0 },
    });
    const poses: FoePose[] = [];
    // A little of the guard first, so the first pose kept is already moving.
    for (let i = -72; from + i * STEP <= to; i++) {
      const pose = drawn(player.update(driveOf(s, from + i * STEP, o)));
      if (i >= 0) poses.push(pose);
    }
    return { target: o.target, from, step: STEP, poses };
  }
  function again(s: Bout, t: number, o: StandInOptions): FoePose {
    let r = recordings.get(s);
    // Played through again if it is asked for with the player somewhere else.
    if (!r || distance(r.target, o.target) > 1e-3) {
      r = record(s, o);
      recordings.set(s, r);
    }
    const at = clamp((t - r.from) / r.step, 0, r.poses.length - 1);
    const i = Math.floor(at);
    return between(r.poses[i], r.poses[Math.min(r.poses.length - 1, i + 1)], at - i);
  }

  return (s, t, o) => {
    if (o.again) return again(s, t, o);
    const southpaw = s.lead === "right";
    if (!live || live.southpaw !== southpaw)
      live = { player: createMotionPlayer(pack, { southpaw, fall: formulaFall, stageMoves: true, seed }), southpaw };
    // Everything the recording knows goes along (the elbows, the feet), for a stage that wants them.
    const pose = live.player.update(driveOf(s, t, o));
    return { ...pose, loading: null, open: 0, lunge: pose.carried };
  };
}

export interface MotionPoseLoader {
  /** Give this to `createRealGame({ pose })`. The stand-in's pose until the pack has loaded, and for good if it fails. */
  pose: PoseMaker;
  /** Resolves true once the recorded motion is playing, false if the pack could not be loaded. Never rejects. */
  whenReady: Promise<boolean>;
  ready(): boolean;
  /** Why loading failed, or null. */
  failed(): unknown;
}

/**
 * Start loading the pack and give back a pose maker that works at once. If
 * the pack arrives in the middle of a bout the body crosses over from the
 * stand-in to the recorded motion in a quarter of a second.
 */
export function loadMotionPose(url: string = PACK_URL, fallback: PoseMaker = standInPose): MotionPoseLoader {
  let maker: PoseMaker | null = null;
  let error: unknown = null;
  /** The first time the recorded motion was drawn in the running bout. */
  let since: number | null = null;
  const whenReady = loadPack(url).then(
    (pack) => {
      maker = createMotionPose(pack);
      return true;
    },
    (reason: unknown) => {
      error = reason;
      return false;
    },
  );
  const pose: PoseMaker = (s, t, o) => {
    if (!maker) return fallback(s, t, o);
    const made = maker(s, t, o);
    if (o.again) return made;
    if (since === null || t < since) since = t;
    const k = smooth((t - since) / 0.25);
    return k >= 1 ? made : between(fallback(s, t, o), made, k);
  };
  return { pose, whenReady, ready: () => maker !== null, failed: () => error };
}
