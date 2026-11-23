import type { Vec3 } from "../pov/physics";
import type { AttackKind } from "./boxer";
import { RULES, type Attack, type Foe } from "./fight";

/**
 * Where the opponent's body is, worked out from the state of the fight: no
 * canned clips. Everything is in the opponent's own frame: the origin between
 * its feet, +x its right, +y up, +z toward the player.
 *
 * What matters most is that each punch can be read before it is thrown. A
 * wind-up snaps into its pose in a fifth of a second and holds it, so the
 * player has the rest of the showing to read it; each kind has its own pose,
 * with the elbow as well as the glove saying which; and the punch itself
 * arrives at its fastest, hips first and the fist last.
 */
export interface FoePose {
  head: Vec3;
  chest: Vec3;
  hips: Vec3;
  /** [its left, its right] */
  shoulders: [Vec3, Vec3];
  gloves: [Vec3, Vec3];
  /** Which way each elbow bends. */
  poles: [Vec3, Vec3];
  /** 0 standing to 1 on the canvas. */
  fallen: number;
  /** The glove that is about to punch or punching (0 left, 1 right), how far the showing has got, and what it is. */
  loading: { glove: 0 | 1; amount: number; kind: AttackKind; thrown: boolean } | null;
  /** Made to miss and not yet recovered: the moment to hit back. 0 to 1, falling as the opening closes. */
  open: number;
  /** How far the shoulders are turned about the spine, radians: positive takes its right shoulder back. */
  turn: number;
  /** How far it has stepped in behind a punch. */
  lunge: number;
  /** Where its ankles really are, [its left, its right], when the motion is recorded. Without them the feet are placed by formula. */
  feet?: [Vec3, Vec3];
}
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const mix = (a: Vec3, b: Vec3, k: number): Vec3 =>
  v(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
const clamp = (k: number) => Math.max(0, Math.min(1, k));
const smooth = (k: number) => {
  const c = clamp(k);
  return c * c * (3 - 2 * c);
};
/** Snaps past its mark by a twentieth and settles: an arm stopping hard. */
const snap = (k: number) => {
  const c = clamp(k) - 1;
  return 1 + 2.2 * c * c * c + 1.2 * c * c;
};
/** How far apart the two stand. */
export const DISTANCE = 1.3;
/** A punch stops this far short of the player's eye: closer and the glove is all there is. */
export const STOP_SHORT = 0.3;
const HIPS = 0.98,
  /** Hips to chest and chest to head: the spine keeps these lengths whatever the body does. */
  CHEST = 0.42,
  HEAD = 0.27,
  SHOULDER = 0.19,
  /** How far it steps in behind a punch. */
  LUNGE = 0.3,
  /** Seconds it takes to get up, at the end of the count. */
  GET_UP = 0.9;
export const SPINE = { chest: CHEST, head: HEAD };
/** A point `length` from `from` in the direction (x, y, z). */
const along = (from: Vec3, x: number, y: number, z: number, length: number): Vec3 => {
  const n = length / Math.max(1e-6, Math.hypot(x, y, z));
  return v(from.x + x * n, from.y + y * n, from.z + z * n);
};

/**
 * Each kind of punch drawn back, for the right hand: the glove relative to the
 * chest, how far the shoulders turn (positive takes that shoulder back), and
 * which way the elbow bends. Chosen so that the four differ in outline.
 */
const COCKED: Record<
  AttackKind,
  { hand: Vec3; turn: number; pole: Vec3; lean: number; dip: number; shift: number }
> = {
  // The lead glove drops and comes out: that side of its face opens.
  jab: { hand: v(0.22, -0.04, 0.24), turn: 0.3, pole: v(0.2, -1, -0.6), lean: -0.04, dip: 0, shift: 0 },
  // The whole figure coils away behind the rear shoulder.
  cross: { hand: v(0.3, 0.16, -0.12), turn: 0.6, pole: v(0.4, -1, -0.5), lean: -0.06, dip: 0, shift: 0.06 },
  // The elbow lifts level with the shoulder, out wide.
  hook: { hand: v(0.39, 0.02, 0.2), turn: 0.5, pole: v(1, 0.4, -0.3), lean: 0, dip: 0, shift: 0 },
  // It sinks at the knees with the glove down behind the hip.
  body: { hand: v(0.3, -0.3, 0), turn: 0.4, pole: v(0.5, -0.3, -1), lean: 0.1, dip: 0.12, shift: 0 },
};
const GUARD_POLE = v(0.15, -1, -0.1);

/**
 * `clock` is the fight's time as the opponent's attack should be drawn: the
 * fight's own time plus the lead that makes up for the camera's delay.
 * `target` is the player's eye in the opponent's frame. `blocking` says the
 * player has a glove where this punch is going.
 */
export function foePose(
  foe: Foe,
  time: number,
  clock: number,
  target: Vec3,
  blocking = false,
): FoePose {
  const attack: Attack | null = foe.attack;
  const showing = foe.phase === "windup" || foe.phase === "strike";
  // Going still is the first tell: the idle sway dies as a punch is shown.
  const calm = showing && attack ? 1 - smooth((clock - attack.startAt) / 0.08) : 1;
  // Body punishment shows: it breathes harder, sags forward and its hands come down.
  const tired = clamp(foe.tired);
  const sway = 0.05 * Math.sin(time * 1.3) * calm,
    bob = 0.012 * (1 + 2 * tired) * Math.sin(time * (2.6 + 1.4 * tired)) * calm;
  let lean = 0.03 + 0.05 * tired,
    side = sway,
    dip = 0,
    turn = 0,
    lunge = 0;
  // A high guard sits at the chin, so its eyes show over the gloves.
  const guardY = (foe.guard === "high" ? 0.1 : -0.12) - 0.05 * tired;
  // Hands relative to the chest, and elbow directions: [left, right].
  let hands: [Vec3, Vec3] = [v(-0.11, guardY, 0.25), v(0.11, guardY, 0.25)];
  const poles: [Vec3, Vec3] = [
    v(-GUARD_POLE.x, GUARD_POLE.y, GUARD_POLE.z),
    v(GUARD_POLE.x, GUARD_POLE.y, GUARD_POLE.z),
  ];
  let loading: FoePose["loading"] = null;
  let reach: { glove: 0 | 1; to: Vec3; k: number; bulge: number } | null = null;
  let fallen = 0;
  let open = 0;
  /** On the canvas: seconds since it went down, and how far through getting up it is. */
  let floor: { t: number; rise: number } | null = null;
  /** Draw the punching arm back by `k` of the way. */
  const cock = (a: Attack, k: number) => {
    const glove: 0 | 1 = a.hand === "left" ? 0 : 1,
      sign = glove ? 1 : -1;
    const c = COCKED[a.kind];
    hands[glove] = mix(hands[glove], v(sign * c.hand.x, c.hand.y, c.hand.z), k);
    poles[glove] = mix(poles[glove], v(sign * c.pole.x, c.pole.y, c.pole.z), clamp(k));
    turn = sign * c.turn * k;
    lean += c.lean * k;
    dip = c.dip * k;
    // Weight to the rear side.
    side += sign * c.shift * k;
    return glove;
  };
  /** Where the fist ends up, given where the player is now. */
  const end = (a: Attack): Vec3 => {
    if (a.kind === "body")
      return v(target.x * 0.5, target.y - 0.26, target.z - (blocking ? 0.6 : 0.5));
    const ax = a.aim ? -a.aim.x : target.x,
      ay = a.aim?.y ?? target.y;
    // The head has left the line: the fist goes on past it, wide of the ear.
    const off = Math.hypot(target.x - ax, target.y - ay);
    const past = smooth((off - 0.08) / 0.08);
    const wide = Math.max(0, 0.2 - Math.abs(ax - target.x)) * past;
    return v(
      ax + (ax >= target.x ? wide : -wide),
      ay + (ay - target.y > 0.1 ? Math.max(0, 0.2 - (ay - target.y)) * past : 0),
      target.z - (blocking ? 0.52 : STOP_SHORT) + (STOP_SHORT + 0.2) * past,
    );
  };
  if (showing && attack) {
    const t = clock - attack.startAt;
    const draw = Math.min(0.22, 0.4 * attack.windup);
    // Into the pose fast, then held, creeping a little further as it loads.
    let shown =
      snap(t / draw) +
      0.06 * clamp((t - draw) / Math.max(0.05, attack.windup - draw));
    // A feint is shown and taken back in the last third.
    if (attack.feint) shown *= 1 - smooth((t / attack.windup - 0.65) / 0.35);
    const glove = cock(attack, shown);
    // A loaded arm trembles.
    hands[glove].y += 0.004 * Math.sin(t * 2 * Math.PI * 9) * clamp(shown);
    const strikeAt = attack.impactAt - RULES.strike;
    const u = attack.feint ? 0 : clamp((clock - strikeAt) / RULES.strike);
    // The hips start in before the fist leaves; the fist lands last, at its fastest.
    lunge =
      attack.feint
        ? 0
        : (attack.kind === "body" ? 0.85 : 1) *
          LUNGE *
          (0.3 * smooth((t / attack.windup - 0.65) / 0.35) + 0.7 * smooth(u));
    if (u > 0) {
      reach = { glove, to: end(attack), k: u * u, bulge: attack.kind === "hook" ? 0.3 : 0 };
      turn *= 1 - 1.6 * u;
      lean += 0.16 * u;
    }
    loading = { glove, amount: clamp(shown), kind: attack.kind, thrown: u > 0 };
  } else if (foe.phase === "recover" && attack) {
    const glove: 0 | 1 = attack.hand === "left" ? 0 : 1;
    const missed = foe.counterUntil >= foe.since;
    const k = clamp((time - foe.since) / Math.max(0.05, foe.until - foe.since));
    // Made to miss, the arm hangs out there and the body falls after it;
    // otherwise it comes back fast and then settles.
    const out = missed ? 1 - smooth((k - 0.5) / 0.5) : (1 - clamp(k / 0.6)) ** 2;
    // From exactly where the punch ended, so nothing jumps at the moment it lands.
    const c = COCKED[attack.kind],
      sign = glove ? 1 : -1;
    poles[glove] = mix(poles[glove], v(sign * c.pole.x, c.pole.y, c.pole.z), out);
    reach = { glove, to: end(attack), k: out, bulge: 0 };
    lean += (c.lean + 0.16 + (missed ? 0.05 : 0)) * out;
    dip = c.dip * out;
    lunge = (attack.kind === "body" ? 0.85 : 1) * LUNGE * out;
    turn = -0.6 * sign * c.turn * out;
    if (missed) {
      hands[1 - glove] = mix(hands[1 - glove], v((glove ? -1 : 1) * 0.2, -0.2, 0.1), out);
      open = 1 - smooth((k - 0.7) / 0.3);
    }
  } else if (foe.phase === "stagger") {
    const k = 1 - smooth((time - foe.since) / Math.max(0.1, foe.until - foe.since));
    // Away from the hand that hit: the player's left lands on its right side.
    const from = foe.struck?.hand === "left" ? -1 : 1;
    const low = foe.struck?.target === "body";
    // The longer stun; the snap of the punch itself is the reaction layer's.
    side += from * (low ? 0.02 : 0.06) * k;
    lean += low ? 0.09 * k : -0.1 * k;
    dip = low ? 0.05 * k : 0;
    hands = [
      mix(hands[0], v(-0.24, -0.16, 0.1), k * 0.8),
      mix(hands[1], v(0.24, -0.16, 0.1), k * 0.8),
    ];
    open = k;
  } else if (foe.phase === "down" || foe.phase === "out") {
    floor = {
      t: Math.max(0, time - foe.since),
      rise: foe.phase === "down" ? clamp((time - (foe.until - GET_UP)) / GET_UP) : 0,
    };
  }
  // The spine keeps its lengths: leaning and dipping tilt it, they do not stretch it.
  let hips = v(side * 0.4, HIPS - dip + bob, lunge);
  let chest = along(hips, side * 0.6, CHEST - dip * 0.3, lean, CHEST);
  let head = along(chest, (side - sway) * 0.5, HEAD, 0.03 + (lean - 0.03) * 0.6, HEAD);
  const cos = Math.cos(turn),
    sin = Math.sin(turn);
  // Turned about the spine: a positive turn takes the right shoulder back.
  const about = (p: Vec3): Vec3 => v(p.x * cos + p.z * sin, p.y, -p.x * sin + p.z * cos);
  let shoulders: [Vec3, Vec3] = [
    v(chest.x - SHOULDER * cos, chest.y + 0.02, chest.z + SHOULDER * sin),
    v(chest.x + SHOULDER * cos, chest.y + 0.02, chest.z - SHOULDER * sin),
  ];
  let gloves = hands.map((h) => {
    const r = about(h);
    return v(chest.x + r.x, chest.y + r.y, chest.z + r.z);
  }) as [Vec3, Vec3];
  const bends = poles.map(about) as [Vec3, Vec3];
  if (reach) {
    const out = mix(gloves[reach.glove], reach.to, reach.k);
    // A hook swings wide on its way.
    out.x += (reach.glove ? 1 : -1) * reach.bulge * Math.sin(Math.PI * reach.k);
    gloves[reach.glove] = out;
  }
  if (floor) {
    // It falls as a body: the knees give, then hips, chest and head go over
    // backwards together about the feet, tipped the way the punch was going,
    // and land with a small bounce. Nothing changes length on the way.
    const t = floor.t;
    const over = clamp((t - 0.08) / 0.5) ** 2;
    const landed = t - 0.58;
    const bounce =
      landed > 0 && landed < 0.24
        ? 0.105 * Math.abs(Math.sin((Math.PI * landed) / 0.12)) * (1 - landed / 0.24)
        : 0;
    let tip = (Math.PI / 2) * over - bounce;
    let hipY = (HIPS - 0.25 * smooth(t / 0.15)) * (1 - over) + 0.14 * over;
    let hipZ = -0.05 * over;
    // The arms follow a moment after the body.
    let arms = clamp((t - 0.16) / 0.5) ** 2;
    fallen = over;
    if (floor.rise > 0) {
      // Getting up: the hips come up first with the trunk rolling forward over
      // them, then it straightens, and the hands come back last.
      const sit = smooth(floor.rise / 0.55),
        stand = smooth((floor.rise - 0.55) / 0.45);
      tip = (Math.PI / 2) * (1 - sit) - 0.35 * sit * (1 - stand) + 0.03 * stand;
      hipY = 0.14 + (0.7 * HIPS - 0.14) * sit + 0.3 * HIPS * stand;
      hipZ = -0.05 * (1 - sit);
      arms = 1 - smooth(floor.rise / 0.8);
      fallen = 1 - sit;
    }
    // Tipped toward where the punch was going: the player's left travels to its left.
    const struck = foe.struck;
    const way = (struck?.hand === "left" ? -1 : 1) * (struck?.shape === "hook" ? 0.25 : 0.08);
    const lean0 = Math.max(0, Math.sin(tip));
    const dx = way * lean0,
      dy = Math.cos(tip),
      dz = -Math.sin(tip);
    hips = v(hips.x * (1 - fallen), hipY, hipZ);
    chest = along(hips, dx, dy, dz, CHEST);
    // Lying, the chest and head rest on the canvas, not in it.
    chest.y += 0.03 * lean0;
    head = along(chest, dx, dy, dz, HEAD);
    shoulders = [v(chest.x - SHOULDER, chest.y + 0.02 * dy, chest.z), v(chest.x + SHOULDER, chest.y + 0.02 * dy, chest.z)];
    // The guard tips with the body, then the arms fall out to the sides.
    const cosT = Math.cos(tip),
      sinT = Math.sin(tip);
    gloves = hands.map((h, i) => {
      const standing = v(chest.x + h.x, chest.y + h.y * cosT + h.z * sinT, chest.z - h.y * sinT + h.z * cosT);
      return mix(standing, v((i ? 1 : -1) * 0.5, 0.1, hips.z - 0.5), arms);
    }) as [Vec3, Vec3];
    return { head, chest, hips, shoulders, gloves, poles: bends, fallen, loading: null, open: 0, turn: 0, lunge: 0 };
  }
  return { head, chest, hips, shoulders, gloves, poles: bends, fallen, loading, open, turn, lunge };
}

/** The opponent's frame to the ring's: the player stands at the origin looking down -z. */
export const foeToWorld = (p: Vec3): Vec3 => v(-p.x, p.y, -DISTANCE + p.z);
/** The player's own frame (+x right, +z toward the opponent) to the ring's. */
export const meToWorld = (p: Vec3): Vec3 => v(p.x, p.y, -p.z);
/** The player's head as the opponent sees it. */
export const headForFoe = (head: Vec3): Vec3 =>
  v(-head.x, head.y, DISTANCE - head.z);
