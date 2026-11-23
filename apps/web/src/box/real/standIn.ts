import type { Vec3 } from "../../pov/physics";
import { createFight } from "../fight";
import { STOP_SHORT, foePose, type FoePose } from "../opponentPose";
import type { Bout, Place, Thrown } from "./rules";

/**
 * The opponent's body from the state of the bout, by formula: a stand-in
 * until recorded motion drives it (see ../motion). It differs from the first
 * build's body in the one way the rules now demand: nothing is held. A punch
 * is one continuous motion from its first movement to the hand coming home,
 * with the body moving before the fist, in exactly the times the rules use.
 *
 * Everything is in the opponent's own frame: origin between its feet, +x its
 * right, +y up, +z toward the player. How far away it stands is separate
 * (`distanceOf`): the stage places the frame.
 */
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const mix = (a: Vec3, b: Vec3, k: number): Vec3 =>
  v(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
const clamp = (k: number) => Math.max(0, Math.min(1, k));
const smooth = (k: number) => {
  const c = clamp(k);
  return c * c * (3 - 2 * c);
};
const along = (from: Vec3, x: number, y: number, z: number, length: number): Vec3 => {
  const n = length / Math.max(1e-6, Math.hypot(x, y, z));
  return v(from.x + x * n, from.y + y * n, from.z + z * n);
};
const HIPS = 0.98,
  CHEST = 0.42,
  HEAD = 0.27,
  SHOULDER = 0.19;
/** How far its feet are from the player's at each range, metres. */
export const STANDS = { edge: 1.3, pocket: 0.95 };

/** How far away the opponent stands right now, as its step goes. */
export function distanceOf(s: Bout, t: number): number {
  // With range off it stands where a punch from the spot reaches it, and stays there.
  if (!s.range) return 1.0;
  const f = s.foe.feet;
  const k = f.end > f.start ? smooth((t - f.start) / (f.end - f.start)) : 1;
  return STANDS[f.from] + (STANDS[f.to] - STANDS[f.from]) * k;
}

/** Where a resting glove sits, relative to the chest, for its right hand; the left is mirrored. */
const AT: Record<Place, Vec3> = {
  chin: v(0.11, 0.1, 0.25),
  cover: v(0.1, 0.22, 0.2),
  low: v(0.15, -0.14, 0.19),
  down: v(0.2, -0.3, 0.1),
};
/**
 * How each punch is drawn back before the fist leaves, for its right hand:
 * where the glove goes relative to the guard, how far the shoulders turn
 * (positive takes that shoulder back), how far the body dips, and which way
 * the elbow points. Small and continuous: this is the body's tell, not a pose.
 */
const LOAD: Record<Thrown["kind"], { hand: Vec3; turn: number; dip: number; pole: Vec3; lunge: number }> = {
  jab: { hand: v(0, -0.02, -0.04), turn: 0.16, dip: 0, pole: v(0.2, -1, -0.5), lunge: 0.1 },
  cross: { hand: v(0.07, 0.02, -0.13), turn: 0.5, dip: 0.02, pole: v(0.4, -1, -0.5), lunge: 0.16 },
  hook: { hand: v(0.2, -0.03, -0.04), turn: 0.42, dip: 0.03, pole: v(1, 0.35, -0.3), lunge: 0.08 },
  body: { hand: v(0.1, -0.24, -0.06), turn: 0.36, dip: 0.14, pole: v(0.5, -0.3, -1), lunge: 0.14 },
  uppercut: { hand: v(0.06, -0.28, 0.02), turn: 0.3, dip: 0.12, pole: v(0.3, -1, 0.4), lunge: 0.08 },
};
const GUARD_POLE = v(0.15, -1, -0.1);

export interface StandInOptions {
  /** The player's eye in the opponent's frame. */
  target: Vec3;
  /** The player has a glove where the punch in the air is going: it stops there. */
  blocking?: boolean;
  /** The last punch that landed on it, for the fall. */
  struck?: {
    at: number;
    hand: "left" | "right";
    shape: "straight" | "hook" | "uppercut";
    target: "head" | "body";
    power: number;
    damage: number;
    /** Real contact: the way the fist was going and where it caught what it hit, in the opponent's frame. */
    dir?: Vec3;
    off?: Vec3;
  } | null;
  /** A moment being shown again (the corner's replay), not the bout as it runs: nothing may be remembered from it. */
  again?: boolean;
  /**
   * How far away the body will really be placed (its feet from the player's
   * spot), metres. Given, `target` is the player's eye in the opponent's frame
   * at that distance, exactly; not given, `target` is as if it stood at the
   * first build's fixed distance.
   */
  distance?: number;
}

/** Every point of one pose moved a share of the way to another. */
function blend(a: FoePose, b: FoePose, k: number): FoePose {
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
    fallen: b.fallen,
    loading: null,
    open: 0,
    turn: a.turn + (b.turn - a.turn) * k,
    lunge: a.lunge + (b.lunge - a.lunge) * k,
  };
}

export function standInPose(s: Bout, t: number, o: StandInOptions): FoePose {
  const down = s.foe.down;
  // On the canvas: the formula fall from the first build, which recorded motion does not replace.
  // It is joined to whatever the body was doing over the first and last moments, so nothing jumps.
  if (down && !down.standing) {
    const out = s.over !== null && s.over.winner === "me";
    const old = createFight("contender").foe;
    // A fall answers the player's punch: it is drawn from its own beginning, not from where a planned move would be by now.
    const tf = t - s.ahead;
    const fall = foePose(
      { ...old, phase: out ? "out" : "down", since: down.since, until: out ? Infinity : down.until, struck: o.struck ?? null },
      tf,
      tf,
      o.target,
    );
    const joined = Math.min(smooth((tf - down.since) / 0.15), out ? 1 : smooth((down.until - tf) / 0.15));
    return joined >= 1 ? fall : blend(upright(s, t, o), fall, joined);
  }
  return upright(s, t, o);
}

/** On its feet: guard, steps, punches, hurt. */
function upright(s: Bout, t: number, o: StandInOptions): FoePose {
  const foe = s.foe;
  const target = o.target;
  // Hurt comes on in a tenth of a second from the punch that did it and wears off over the last third of one: nothing switches.
  const hurt = foe.down?.standing
    ? 1
    : t < foe.hurtUntil
      ? Math.min(smooth((t - foe.solidAt) / 0.12), smooth((foe.hurtUntil - t) / 0.3))
      : 0;
  const tired = clamp(1 - foe.breath / 60);
  // It breathes and shifts its weight all the time; more when tired, less while a punch is on its way.
  const live = foe.punches.filter((p) => t >= p.start && t < p.home);
  const busy = live.reduce((most, p) => Math.max(most, Math.min(smooth((t - p.start) / 0.1), smooth((p.home - t) / 0.15))), 0);
  const calm = 1 - 0.65 * busy;
  const sway = 0.045 * Math.sin(t * 1.3) * calm + 0.07 * hurt * Math.sin(t * 5.2);
  const bob = (0.014 + 0.018 * tired) * Math.sin(t * (2.6 + 1.2 * tired)) * calm;
  let lean = 0.03 + 0.05 * tired - 0.09 * hurt,
    dip = 0.05 * hurt,
    turn = 0,
    lunge = 0;
  const sag = foe.breath < s.boxer.sags ? 0.1 : 0.05 * tired;
  // Each glove where the rules say it rests, moving when the rules say it moves.
  const hands: [Vec3, Vec3] = [0, 1].map((i) => {
    const g = foe.gloves[i];
    const sign = i ? 1 : -1;
    const at = (place: Place) => v(sign * AT[place].x, AT[place].y - (place === "chin" || place === "cover" ? sag : 0), AT[place].z);
    if (!g.next) return at(g.place);
    const took = Math.max(0.05, s.boxer.guardMove);
    return mix(at(g.place), at(g.next.place), smooth((t - (g.next.at - took)) / took));
  }) as [Vec3, Vec3];
  const poles: [Vec3, Vec3] = [v(-GUARD_POLE.x, GUARD_POLE.y, GUARD_POLE.z), v(GUARD_POLE.x, GUARD_POLE.y, GUARD_POLE.z)];
  /** A glove on its way to a point in the frame rather than a place by the chest: [the point, how far there]. */
  const reach: ([Vec3, number, number] | null)[] = [null, null];
  for (const p of live) {
    const i = p.hand === "left" ? 0 : 1,
      sign = i ? 1 : -1;
    const c = LOAD[p.kind];
    const load = smooth((t - p.start) / Math.max(0.03, p.commit - p.start));
    if (p.feint) {
      // Shown and taken back: up to the fist leaving, then home, and nothing flies.
      const back = 1 - smooth((t - p.commit) / Math.max(0.05, p.home - p.commit));
      const k = load * back * 0.8;
      hands[i] = v(hands[i].x + sign * c.hand.x * k, hands[i].y + c.hand.y * k, hands[i].z + c.hand.z * k);
      turn += sign * c.turn * k;
      dip += c.dip * k;
      continue;
    }
    const fly = clamp((t - p.commit) / Math.max(0.03, p.impact - p.commit));
    const home = clamp((t - p.impact) / Math.max(0.05, p.home - p.impact));
    // Drawn back as the body turns; released as the fist goes; all of it gone by the time the hand is home.
    const drawn = load * (1 - fly) * (1 - home);
    hands[i] = v(hands[i].x + sign * c.hand.x * drawn, hands[i].y + c.hand.y * drawn, hands[i].z + c.hand.z * drawn);
    poles[i] = mix(poles[i], v(sign * c.pole.x, c.pole.y, c.pole.z), clamp(load * (1 - home)));
    // The shoulders wind up, then go through with the punch, then come square again.
    turn += sign * c.turn * (load * (1 - fly) - 0.7 * fly * (1 - home));
    dip += c.dip * load * (1 - home);
    // The hips start in before the fist leaves; the fist lands last, at its fastest.
    lunge += c.lunge * (0.3 * load + 0.7 * smooth(fly)) * (1 - smooth(home));
    lean += 0.12 * fly * (1 - home);
    if (fly > 0) {
      // Where the fist is going: the head where it was when the fist left, or the ribs under where the head is now.
      // In first person the fist stops short of the lens; shown again from the side it goes all the way.
      const stop = o.again ? 0.1 : o.blocking ? 0.52 : STOP_SHORT + 0.12;
      const end =
        p.level === "body"
          ? v(target.x * 0.5, target.y - 0.3, target.z - (o.blocking ? 0.6 : 0.5))
          : // Off the line of the lens on its own side, so the glove does not hide everything.
            v((p.aim ? -p.aim.x : target.x) + (o.again ? 0 : sign * 0.06), (p.aim?.y ?? target.y) - (p.shape === "uppercut" ? 0.1 : 0.02), target.z - stop);
      // Out fast and late, back slower.
      const out = home > 0 ? (1 - home) ** 2 : fly * fly;
      const bulge = p.shape === "hook" ? 0.28 * Math.sin(Math.PI * Math.min(1, fly)) * (1 - home) : 0;
      reach[i] = [end, out, sign * bulge];
    }
  }
  const hips = v(sway * 0.4, HIPS - dip + bob, lunge);
  const chest = along(hips, sway * 0.6, CHEST - dip * 0.3, lean, CHEST);
  let head = along(chest, 0, HEAD, 0.03 + (lean - 0.03) * 0.6, HEAD);
  const cos = Math.cos(turn),
    sin = Math.sin(turn);
  const about = (p: Vec3): Vec3 => v(p.x * cos + p.z * sin, p.y, -p.x * sin + p.z * cos);
  const shoulders: [Vec3, Vec3] = [
    v(chest.x - SHOULDER * cos, chest.y + 0.02, chest.z + SHOULDER * sin),
    v(chest.x + SHOULDER * cos, chest.y + 0.02, chest.z - SHOULDER * sin),
  ];
  const gloves = hands.map((h, i) => {
    const r = about(h);
    const rest = v(chest.x + r.x, chest.y + r.y, chest.z + r.z);
    const going = reach[i];
    if (!going) return rest;
    const out = mix(rest, going[0], going[1]);
    out.x += going[2];
    return out;
  }) as [Vec3, Vec3];
  // Hurt: the head goes back.
  if (hurt > 0) head = along(chest, head.x - chest.x, head.y - chest.y, head.z - chest.z - 0.06 * hurt, HEAD);
  return {
    head,
    chest,
    hips,
    shoulders,
    gloves,
    poles: poles.map(about) as [Vec3, Vec3],
    fallen: 0,
    loading: null,
    open: 0,
    turn,
    lunge,
  };
}
