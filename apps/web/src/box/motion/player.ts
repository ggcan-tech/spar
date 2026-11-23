import type { Vec3 } from "../../pov/physics";
import type { AttackKind } from "../boxer";
import type { FoePose } from "../opponentPose";
import { AIM, aimWeight, armTo, bendOf, keepClear, reachTo, settleTarget, type AimLimits } from "./aim";
import { BLEND, applyBlend, blendOver, startBlend, type RigBlend } from "./inertial";
import { RESTING, applyHit, guardAt, placeGuard, slump, type GuardMove } from "./posture";
import { bodyOfPose, fromRig, gloveOf, mirrorBody, poseOf, sampleAt, shiftBody, toRig } from "./sampler";
import { clipTimeAt, clipTimeLoose, planFeint, planPunch, type ClipTimes, type TimeMap } from "./timewarp";
import {
  SIZE,
  type Body,
  type Clip,
  type FallHook,
  type MotionDown,
  type MotionDrive,
  type MotionLevel,
  type MotionPose,
  type MotionPunch,
  type MotionShape,
  type Pack,
  type PunchMark,
  type RangeSpot,
  type Rig,
  type StanceHand,
} from "./types";
import { add, clamp, distance, scale, sub, unit, v3 } from "./vec";

/**
 * The player object: the game tells it each frame what is happening, in
 * plain words (`MotionDrive`), and it gives back where the opponent's body
 * is (`MotionPose`, which is a `FoePose`).
 *
 * What it does with a frame, in order:
 *  1. picks what plays: a guard loop, a step, the newest punch; and for each
 *     arm, the punch that hand is still throwing, even if a newer punch has
 *     taken over the body (so a one-two overlaps as it does in a ring);
 *  2. where that choice changed since the last frame, starts an inertial
 *     blend, so the new clip is itself from its first frame;
 *  3. lays the small layers over it: tired, hurt, where the guard gloves are;
 *  4. being hit: the head and chest knocked from outside;
 *  5. the aim's last word: the punching arm put exactly on its target at
 *     contact, whatever the layers did;
 *  6. the glove kept clear of the player's eye.
 * The aim's share for hips and trunk is part of the punch itself (step 1),
 * so that when a punch is cut short the blend carries that away too.
 * When it is down the fall is handed to the hook it was given.
 */
export interface PlayerOptions {
  /** Left-handed: every clip mirrored, so the right hand and foot lead. */
  southpaw?: boolean;
  /** The fall and get-up, from outside (see fall.ts). Without it the guard goes on. */
  fall?: FallHook;
  /** How far in from the edge of range the pocket is, metres. */
  pocket?: number;
  /**
   * The stage places the opponent's frame at its range itself (as
   * `distanceOf` in real/standIn.ts does). A step then plays its clip, but
   * no point is moved by it and `advance` stays 0.
   */
  stageMoves?: boolean;
  /** Other limits for the aim than `AIM`: the corner's replay, seen from the side, lets the fist go all the way. */
  aim?: Partial<AimLimits>;
  /** For the order of the guard loops. The same seed gives the same motion. */
  seed?: number;
  /** Seconds a guard glove takes to change place. */
  guardMove?: number;
  /** Fill `FoePose.loading`, which lights the glove in the old drawing: for first lessons only. */
  lightGlove?: boolean;
}
export interface MotionPlayer {
  /** One frame. Call it once for every frame drawn, with times that do not go backwards. */
  update(drive: MotionDrive): MotionPose;
  /** Forget everything: a new round. */
  reset(): void;
}

/** Something that can be asked for the body at a time. */
interface Source {
  key: string;
  kind: "idle" | "track" | "step" | "fall";
  clip: string;
  rig(t: number): Rig;
  frame(t: number): number;
}
interface Config {
  base: Source;
  arms: [Source, Source];
}
/** One punch being played. */
interface Track {
  id: number;
  punch: MotionPunch;
  clip: Clip;
  index: number;
  mark: PunchMark;
  slot: string;
  hand: 0 | 1;
  times: ClipTimes;
  map: TimeMap;
  feint: boolean;
  target: Vec3;
  /** The player's eye when the target was last followed. */
  aimedAt: Vec3;
  frozen: boolean;
  bend: number;
  refused: boolean;
  block: Vec3 | null;
  /** The clip's own contact: where its glove and shoulder are then. */
  own: { glove: Vec3; shoulder: Vec3 };
  /** How far the aim last carried the hips toward the player. */
  carried: number;
  cancelled: boolean;
  source: Source;
}

/** The name of a kind of punch in the pack. */
export function slotOf(shape: MotionShape, hand: StanceHand, level: MotionLevel): string {
  if (level === "body") return `body_${hand}_${shape === "straight" ? "straight" : "hook"}`;
  if (shape === "straight") return hand === "lead" ? "jab" : "cross";
  return `${shape === "hook" ? "hook" : "upper"}_${hand}`;
}
/** The shape a punch has when the game does not say: as the rules' own table of punches has it. */
export function shapeFor(punch: Pick<MotionPunch, "kind" | "shape">, hand: StanceHand): MotionShape {
  if (punch.shape) return punch.shape;
  if (punch.kind === "hook") return "hook";
  if (punch.kind === "uppercut") return "uppercut";
  // To the body: the rear hand goes straight, the lead hand comes round.
  if (punch.kind === "body") return hand === "rear" ? "straight" : "hook";
  return "straight";
}
/** The fastest a blend may carry the head, metres a second: about what a boxer's head does in a hard slip. */
const HEAD_SPEED = 3;
/** Where the head is for a set of bones. */
const headOf = (r: Rig): Vec3 => add(add(r.hips, scale(unit(r.spine), SIZE.chest)), scale(unit(r.neck), SIZE.head));
const LIGHT: Record<MotionPunch["kind"], AttackKind> = { jab: "jab", cross: "cross", hook: "hook", uppercut: "hook", body: "body" };

/** A small repeatable random number maker. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMotionPlayer(pack: Pack, options: PlayerOptions = {}): MotionPlayer {
  const southpaw = options.southpaw === true;
  const depth: Record<RangeSpot, number> = { edge: 0, pocket: options.pocket ?? 0.3 };
  const ownGuardMove = options.guardMove ?? 0.18;
  const limits: AimLimits = { ...AIM, ...options.aim };
  const sample = (clip: Clip, seconds: number): Body => {
    const b = sampleAt(clip, seconds);
    return southpaw ? mirrorBody(b) : b;
  };
  /** The game's left or right as a hand of the stance: orthodox leads with the left. */
  const stanceHand = (hand: "left" | "right"): StanceHand => ((hand === "left") !== southpaw ? "lead" : "rear");

  // ── The clips, sorted for finding ─────────────────────────────────────────
  const singles = new Map<string, Clip[]>();
  const combos: Clip[] = [];
  const steps: Clip[] = [];
  for (const clip of pack.clips) {
    if (clip.kind === "combo") combos.push(clip);
    else if (clip.kind === "step") steps.push(clip);
    else if (clip.punches.length === 1) {
      const m = clip.punches[0];
      const slot = slotOf(m.shape, m.hand, m.level);
      singles.set(slot, [...(singles.get(slot) ?? []), clip]);
    }
  }
  const loops = pack.guards.slice().sort((a, b) => a.bounce - b.bounce);
  if (!loops.length) throw new Error("motion pack: no guard loop");
  /** The middle height of the hips in each loop: its bounce is measured from there. */
  const middle = new Map<Clip, number>();
  for (const clip of loops) {
    let sum = 0;
    for (let f = 0; f < clip.frames; f++) sum += clip.data[f * 33 + 1];
    middle.set(clip, sum / clip.frames);
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let next = random(options.seed ?? 1);
  let last = -Infinity;
  let config: Config | null = null;
  let blend: RigBlend | null = null;
  let shown: Rig | null = null;
  let tracks: Track[] = [];
  let advance = 0;
  /** The player's eye as last told. */
  let eye: Vec3 = v3(0, 1.6, 1.3);
  /** How much of the bounce is left: less when it is set to work, less when tired. */
  let bounce = 1;
  let wasIdle = true;
  /** Where each guard glove is going. */
  let moves: [GuardMove, GuardMove] = [RESTING, RESTING];
  let idle = idleSource(loops[loops.length > 1 ? 1 : 0], 0);
  let stepping: { key: string; source: Source; curve(t: number): number; from: number; to: number } | null = null;
  let falling: { down: MotionDown; source: Source } | null = null;

  function idleSource(clip: Clip, start: number): Source & { clipRef: Clip; start: number; seconds: number } {
    // To its last frame and no further. The recorded loops do not quite
    // close (the boxer is never in the same place twice), so the join to the
    // next loop is a blend like any other switch, not a wrap.
    const seconds = (clip.frames - 1) / clip.fps;
    const mid = middle.get(clip) ?? 0;
    return {
      key: `idle:${clip.id}:${start}`,
      kind: "idle",
      clip: clip.id,
      clipRef: clip,
      start,
      seconds,
      frame: (t) => clamp(t - start, 0, seconds) * clip.fps,
      rig(t) {
        const r = toRig(sample(clip, clamp(t - start, 0, seconds)));
        // The bounce calmed: the hips keep their middle height and move less about it.
        return bounce >= 1 ? r : { ...r, hips: v3(r.hips.x, mid + (r.hips.y - mid) * bounce, r.hips.z) };
      },
    };
  }
  /** The loop to stand in next: the stillest while it is set to work, otherwise a lively one that is not the one just played. */
  function pickLoop(lively: boolean, not: Clip): Clip {
    if (!lively || loops.length === 1) return loops[0];
    const choices = loops.filter((c) => c !== not && c !== loops[0]);
    const from = choices.length ? choices : loops;
    return from[Math.floor(next() * from.length)];
  }

  // ── Punches ───────────────────────────────────────────────────────────────
  function timesOf(clip: Clip, index: number): ClipTimes {
    const e = clip.punches[index].events;
    const following = clip.punches[index + 1];
    // In a combination the take goes on into the next punch. A punch played
    // from it stops owning the body as that next fist would leave.
    const endFrame = following ? Math.min(e.guard, following.events.launch) : clip.frames - 1;
    return {
      first: e.first / clip.fps,
      launch: e.launch / clip.fps,
      contact: e.contact / clip.fps,
      guard: Math.max(e.contact, Math.min(e.guard, endFrame)) / clip.fps,
      end: Math.max(e.contact, endFrame) / clip.fps,
    };
  }
  /** The take to play for a punch: the next part of a combination if the punch before it is still out, else a single take. */
  function findTake(punch: MotionPunch, slot: string, before: Track | null): { clip: Clip; index: number } | null {
    const index: 0 | 1 = punch.hand === "left" ? 0 : 1;
    /** How far a take's own punch would have to be bent to land where this one is aimed. */
    const bendFor = (c: Clip, part: number): number => {
      const at = sample(c, c.punches[part].events.contact / c.fps);
      const along = v3(0, 0, advance);
      return bendOf(add(at.shoulders[index], along), add(gloveOf(at.shoulders[index], at.wrists[index]), along), punch.target);
    };
    if (before && !punch.feint) {
      // Only if the take's next punch goes about where this one is aimed: a
      // boxer who turned between two punches threw the second somewhere else.
      const fits = (c: Clip, part: number) => bendFor(c, part) <= 0.3;
      const own = before.clip.punches[before.index + 1];
      if (before.clip.kind === "combo" && own && slotOf(own.shape, own.hand, own.level) === slot && fits(before.clip, before.index + 1))
        return { clip: before.clip, index: before.index + 1 };
      for (const clip of combos)
        for (let i = 0; i + 1 < clip.punches.length; i++) {
          const a = clip.punches[i],
            b = clip.punches[i + 1];
          if (slotOf(a.shape, a.hand, a.level) === before.slot && slotOf(b.shape, b.hand, b.level) === slot && fits(clip, i + 1))
            return { clip, index: i + 1 };
        }
    }
    const hand = stanceHand(punch.hand);
    const shape = shapeFor(punch, hand);
    // The exact kind; failing that the same punch at the other height, then a straight one from that hand.
    const tries = [
      slot,
      slotOf(shape, hand, punch.level === "head" ? "body" : "head"),
      slotOf("straight", hand, punch.level),
      slotOf("straight", hand, "head"),
    ];
    for (const name of tries) {
      const takes = singles.get(name);
      if (!takes?.length) continue;
      // First the takes that land nearest where this one is aimed: the less
      // the arm must be bent, the more of the recording is left.
      const bends = new Map(takes.map((c) => [c, bendFor(c, 0)] as const));
      const least = Math.min(...bends.values());
      const near = takes.filter((c) => (bends.get(c) ?? 0) <= Math.max(least + 0.1, 0.2));
      // Of those, the take whose own length is nearest what is asked; of two alike, turn about.
      const wanted = punch.impact - punch.start;
      const cost = (c: Clip) => Math.abs((c.punches[0].events.contact - c.punches[0].events.first) / c.fps - wanted);
      const ranked = near.slice().sort((a, b) => cost(a) - cost(b));
      const alike = ranked.filter((c) => cost(c) - cost(ranked[0]) < 0.04);
      return { clip: alike[Math.abs(punch.id) % alike.length], index: 0 };
    }
    return null;
  }
  function wanted(p: MotionPunch) {
    return { start: p.start, commit: p.commit, impact: p.impact, home: p.home };
  }
  function makeTrack(punch: MotionPunch, t: number): Track | null {
    const hand: 0 | 1 = punch.hand === "left" ? 0 : 1;
    const side = stanceHand(punch.hand);
    const slot = slotOf(shapeFor(punch, side), side, punch.level);
    const live = tracks.filter((k) => !k.cancelled && !k.feint && t < k.map.homes);
    const take = findTake(punch, slot, live.length ? live[live.length - 1] : null);
    if (!take) return null;
    const { clip, index } = take;
    const times = timesOf(clip, index);
    const map = punch.feint ? planFeint(times, punch.start, punch.commit, 1 / clip.fps) : planPunch(times, wanted(punch));
    const at = sample(clip, times.contact);
    const track: Track = {
      id: punch.id,
      punch,
      clip,
      index,
      mark: clip.punches[index],
      slot,
      hand,
      times,
      map,
      feint: punch.feint,
      target: punch.target,
      aimedAt: eye,
      frozen: false,
      bend: 0,
      refused: false,
      block: punch.block,
      own: { glove: gloveOf(at.shoulders[hand], at.wrists[hand]), shoulder: at.shoulders[hand] },
      carried: 0,
      cancelled: false,
      source: {
        key: `track:${punch.id}`,
        kind: "track",
        clip: clip.id,
        frame: (time) => clipTimeAt(track.map, time) * clip.fps,
        rig: (time) => toRig(aimed(track, time).body),
      },
    };
    return track;
  }
  /** Where a punch's glove is to end, in the clip's own frame (before the step is added). */
  const endOf = (k: Track): Vec3 => sub(k.block ?? settleTarget(k.target, k.aimedAt, eye, k.punch.level), v3(0, 0, advance));
  /**
   * A punch's own body at a time, bent toward its target: the clip, with
   * hips, trunk and arm sharing the move that puts the glove where it is
   * wanted. This is the punch as the blend knows it.
   */
  function aimed(k: Track, time: number): { body: Body; weight: number } {
    const clipTime = clipTimeLoose(k.map, time);
    const bare = sample(k.clip, clipTime);
    const weight = k.feint ? 0 : aimWeight(clipTime, k.times);
    if (weight <= 0 || k.refused) return { body: bare, weight };
    const from = gloveOf(bare.shoulders[k.hand], bare.wrists[k.hand]);
    const move = sub(endOf(k), k.own.glove);
    const body = reachTo(bare, k.hand, v3(from.x + move.x * weight, from.y + move.y * weight, from.z + move.z * weight), limits);
    k.carried = body.hips.z - bare.hips.z;
    return { body, weight };
  }
  function syncTracks(drive: MotionDrive, t: number): boolean {
    let cut = false;
    // Finished: the body has gone back and the hand is home.
    tracks = tracks.filter((k) => !k.cancelled && t < Math.max(k.map.ends, k.map.homes));
    const p = drive.punch;
    const newest = tracks[tracks.length - 1];
    if (!p) {
      // Gone before it landed: called off.
      if (newest && !newest.feint && t < newest.map.lands) {
        newest.cancelled = true;
        cut = true;
      }
      return cut;
    }
    let track = tracks.find((k) => k.id === p.id);
    if (!track) {
      const made = makeTrack(p, t);
      if (!made) return cut;
      tracks.push(made);
      track = made;
    } else if (!track.feint) {
      // The rules moved its times: plan again from where the clip is now.
      const q = track.punch;
      const moved = Math.abs(q.impact - p.impact) > 1e-4 || Math.abs(q.commit - p.commit) > 1e-4 || Math.abs(q.home - p.home) > 1e-4;
      const now = clipTimeAt(track.map, t);
      if (moved && now < track.times.contact - 1e-3)
        track.map = planPunch(track.times, wanted(p), undefined, t > track.map.begins ? { at: t, clip: now } : null);
    }
    track.punch = p;
    // The aim follows until the commit (or until the rules say they have
    // fixed it); from then on a head that moves is missed.
    if (!track.frozen && (p.fixed === undefined ? t < p.commit : !p.fixed)) {
      track.target = p.target;
      track.aimedAt = eye;
    }
    // A block is followed to the moment of landing: the glove meets the glove.
    if (t <= track.map.lands) track.block = p.block;
    return cut;
  }

  // ── What plays ────────────────────────────────────────────────────────────
  function stepFor(drive: MotionDrive, t: number): void {
    const s = drive.step;
    if (!s) {
      stepping = null;
      return;
    }
    // With the stage moving the frame the clip still plays, but nothing here moves.
    const from = options.stageMoves ? 0 : depth[s.from],
      to = options.stageMoves ? 0 : depth[s.to];
    const span = s.end - s.start;
    if (s.from === s.to || span <= 0) {
      stepping = null;
      advance = to;
      return;
    }
    const key = `step:${s.start}:${s.to}`;
    if (stepping?.key !== key) {
      // The take that goes the right way and about as far.
      const way = s.to === "pocket" ? "in" : "out";
      const far = Math.abs(depth.pocket - depth.edge);
      const takes = steps.filter((c) => c.step?.dir === way);
      const clip = takes.sort((a, b) => Math.abs(Math.abs(a.step!.travel) - far) - Math.abs(Math.abs(b.step!.travel) - far))[0];
      const mark = clip?.step ?? null;
      // The clip's step is laid over the time the rules give the step.
      const frame = (time: number) => (mark ? mark.start + ((time - s.start) / span) * (mark.end - mark.start) : 0);
      const done = (f: number): number => {
        if (!mark) return 0;
        const a = clamp(Math.floor(f), 0, mark.curve.length - 1),
          b = Math.min(mark.curve.length - 1, a + 1);
        return mark.curve[a] + (mark.curve[b] - mark.curve[a]) * clamp(f - a);
      };
      const curve = (time: number): number => {
        const u = clamp((time - s.start) / span);
        if (!mark) return u * u * (3 - 2 * u);
        const low = done(mark.start),
          high = done(mark.end);
        // Stretched to run exactly from 0 to 1 over the step.
        return high > low ? clamp((done(mark.start + u * (mark.end - mark.start)) - low) / (high - low)) : u;
      };
      stepping = {
        key,
        from,
        to,
        curve,
        source: clip
          ? { key, kind: "step", clip: clip.id, frame, rig: (time) => toRig(sample(clip, clamp(frame(time), 0, clip.frames - 1) / clip.fps)) }
          : idle,
      };
    }
    advance = t <= s.start ? from : t >= s.end ? to : from + (to - from) * stepping.curve(t);
  }
  function configAt(t: number): Config {
    if (falling) return { base: falling.source, arms: [falling.source, falling.source] };
    const live = tracks.filter((k) => !k.cancelled && t >= k.map.begins);
    let body: Track | null = null;
    for (const k of live) if (t < k.map.ends) body = k;
    let base: Source = idle;
    if (body) base = body.source;
    else if (stepping && stepping.source.kind === "step") {
      // The step clip from a little before the feet move until a little after.
      const f = stepping.source.frame(t);
      const clip = pack.byId.get(stepping.source.clip);
      if (clip && f >= 0 && f <= clip.frames - 1) base = stepping.source;
    }
    const arm = (h: 0 | 1): Source => {
      let owner: Track | null = null;
      for (const k of live) if (k.hand === h && t < k.map.homes) owner = k;
      if (owner) return owner.source;
      // A take cut out of a combination has its other hand busy: that arm stays with the guard.
      if (body && body.clip.other === "busy") return idle;
      return base;
    };
    return { base, arms: [arm(0), arm(1)] };
  }
  const keyOf = (c: Config) => `${c.base.key}|${c.arms[0].key}|${c.arms[1].key}`;
  function compose(c: Config, t: number): Rig {
    const base = c.base.rig(t);
    if (c.arms[0] === c.base && c.arms[1] === c.base) return base;
    const upper: [Vec3, Vec3] = [base.upper[0], base.upper[1]];
    const fore: [Vec3, Vec3] = [base.fore[0], base.fore[1]];
    for (const h of [0, 1] as const) {
      if (c.arms[h] === c.base) continue;
      const r = c.arms[h].rig(t);
      upper[h] = r.upper[h];
      fore[h] = r.fore[h];
    }
    return { ...base, upper, fore };
  }
  /** How long a change of what plays takes to settle. */
  function settleTime(from: Config, to: Config, hit: boolean, cut: boolean): number {
    if (from.base.kind === "fall" || to.base.kind === "fall") return BLEND.fall;
    if (cut) return hit ? BLEND.hit : BLEND.punch;
    if (to.base !== from.base) {
      if (to.base.kind === "track") return from.base.kind === "track" ? BLEND.chain : BLEND.punch;
      if (to.base.kind === "idle" && from.base.kind === "idle") return BLEND.loop;
      return BLEND.guard;
    }
    for (const h of [0, 1] as const)
      if (to.arms[h] !== from.arms[h] && to.arms[h].kind === "track") return BLEND.punch;
    return BLEND.guard;
  }

  function update(drive: MotionDrive): MotionPose {
    const t = drive.time;
    let dt = t - last;
    // The first frame, a pause, or the tab coming back: no blend across it.
    const jumped = !(dt >= 0) || dt > 0.25;
    if (jumped) {
      dt = 0;
      blend = null;
      shown = null;
      config = null;
      if (!(t >= last)) tracks = [];
      idle = idleSource(idle.clipRef, t);
    }
    last = t;
    const tired = clamp(drive.tired),
      hurt = clamp(drive.hurt);

    // The bounce calms when it is set to work, and with tiredness.
    const ease = dt <= 0 ? (jumped ? 1 : 0) : 1 - Math.exp(-dt / 0.12);
    const wantBounce = (drive.idle ? 1 : 0.4) * (1 - 0.5 * tired);
    bounce += (wantBounce - bounce) * ease;

    // Down: the fall takes over, and whatever it was doing is dropped.
    if (drive.down && options.fall) {
      const down = drive.down;
      if (!falling || falling.down.since !== down.since) {
        const fall = options.fall;
        falling = {
          down,
          source: { key: `fall:${down.since}`, kind: "fall", clip: "fall", frame: () => 0, rig: (time) => toRig(bodyOfPose(fall(falling?.down ?? down, time))) },
        };
        tracks = [];
      }
      falling.down = down;
    } else if (falling) {
      falling = null;
      idle = idleSource(pickLoop(drive.idle, idle.clipRef), t);
    }

    // The guard loop: on to another when this one ends; to the still one at once when it is set to work.
    if (t - idle.start >= idle.seconds) idle = idleSource(pickLoop(drive.idle, idle.clipRef), t);
    else if (wasIdle && !drive.idle && idle.clipRef !== loops[0]) idle = idleSource(loops[0], t);
    wasIdle = drive.idle;

    eye = drive.eye;
    const cut = falling ? false : syncTracks(drive, t);
    stepFor(drive, t);
    // Too great a bend is refused, and the punch plays its own line. Decided for good when the aim is fixed.
    for (const k of tracks) {
      if (k.frozen || k.feint) continue;
      k.bend = bendOf(k.own.shoulder, k.own.glove, endOf(k));
      k.refused = k.bend > limits.bend;
      if (k.punch.fixed ?? t >= k.punch.commit) k.frozen = true;
    }

    // What plays now; and if that changed, a blend from what was on screen.
    const to = configAt(t);
    const now = compose(to, t);
    if (config && shown && keyOf(to) !== keyOf(config)) {
      const was = applyBlend(blend, compose(config, t), t);
      // A far join takes longer: the head is never asked to cross the gap
      // faster than about three metres a second.
      const gap = distance(headOf(was), headOf(now));
      const time = Math.max(settleTime(config, to, drive.hit !== null, cut), Math.min(BLEND.most, (1.9 * gap) / HEAD_SPEED));
      blend = startBlend(was, shown, now, compose(to, t - dt), dt, time, t);
    }
    config = to;
    const rig = applyBlend(blend, now, t);
    shown = rig;
    const blending = !blendOver(blend, t);
    if (!blending) blend = null;

    const along = v3(0, 0, advance);
    let fallen = 0;
    let carried = 0;
    const guardMove = drive.guardMove ?? ownGuardMove;
    let body: Body;
    let aim: MotionPose["aim"] = null;
    let loading: FoePose["loading"] = null;
    if (falling && options.fall) {
      fallen = options.fall(falling.down, t).fallen;
      body = shiftBody(applyHit(fromRig(rig), drive.hit), along);
    } else {
      body = fromRig(slump(rig, tired, hurt, t));
      // The guard gloves go where the rules say. A punching hand is let go of.
      for (const h of [0, 1] as const) {
        const punching = to.arms[h].kind === "track";
        // A new order: it sets off from wherever the glove has got to.
        if (moves[h].to !== drive.guard[h] || moves[h].punching !== punching)
          moves[h] = { from: guardAt(moves[h], t, guardMove), to: drive.guard[h], punching, since: jumped ? -Infinity : t };
        body = placeGuard(body, h, guardAt(moves[h], t, guardMove), tired, hurt);
      }
      body = shiftBody(applyHit(body, drive.hit), along);

      // The aim's last word, for each hand's punch in flight. Hips and
      // trunk have done their share inside the punch itself; here the arm
      // alone closes whatever the blend and the layers left, so that at
      // contact the glove is on the target and nowhere else.
      for (const k of tracks) {
        if (k.cancelled || k.feint || t < k.map.begins || to.arms[k.hand] !== k.source) continue;
        const clipTime = clipTimeAt(k.map, t);
        const own = aimed(k, t);
        if (to.base === k.source) carried = own.weight > 0 && !k.refused ? k.carried : 0;
        if (options.lightGlove)
          loading = {
            glove: k.hand,
            amount: clamp((clipTime - k.times.first) / Math.max(1e-6, k.times.launch - k.times.first)),
            kind: LIGHT[k.punch.kind],
            thrown: clipTime >= k.times.launch,
          };
        aim = { hand: k.hand, weight: own.weight, bend: k.bend, refused: k.refused, target: add(endOf(k), along) };
        if (own.weight <= 0 || k.refused) continue;
        const wanted = add(gloveOf(own.body.shoulders[k.hand], own.body.wrists[k.hand]), along);
        const glove = gloveOf(body.shoulders[k.hand], body.wrists[k.hand]);
        body = armTo(body, k.hand, v3(glove.x + (wanted.x - glove.x) * own.weight, glove.y + (wanted.y - glove.y) * own.weight, glove.z + (wanted.z - glove.z) * own.weight));
      }
      for (const k of tracks) {
        if (!options.lightGlove || !k.feint || k.cancelled || t < k.map.begins) continue;
        const clipTime = clipTimeAt(k.map, t);
        loading = { glove: k.hand, amount: clamp((clipTime - k.times.first) / Math.max(1e-6, k.times.launch - k.times.first)), kind: LIGHT[k.punch.kind], thrown: false };
      }
      body = keepClear(body, drive.eye, limits.near);
    }
    return {
      ...poseOf(body),
      fallen,
      loading,
      open: 0,
      lunge: advance,
      elbows: [body.elbows[0], body.elbows[1]],
      feet: [body.feet[0], body.feet[1]],
      advance,
      carried,
      playing: { clip: to.base.clip, frame: to.base.frame(t), blending },
      aim,
    };
  }

  function reset(): void {
    next = random(options.seed ?? 1);
    last = -Infinity;
    config = null;
    blend = null;
    shown = null;
    tracks = [];
    advance = 0;
    bounce = 1;
    wasIdle = true;
    moves = [RESTING, RESTING];
    idle = idleSource(loops[loops.length > 1 ? 1 : 0], 0);
    stepping = null;
    falling = null;
  }
  return { update, reset };
}
