// Finds the punches, the guard loops and the steps in a converted trial, and
// times each punch's events. Frames are at the recording's 120 a second.
//
// Two measures, per hand:
//  - speed: how fast the wrist moves relative to the chest, metres a second;
//  - reach: how far the glove is toward the player (its z in the opponent's
//    frame). The study measured reach as wrist-to-shoulder distance over arm
//    length, which works for straight punches only: a hook or an uppercut
//    lands with the arm bent. The glove's distance toward the player peaks at
//    contact for every kind, so that is what is used.
import { ARM, dist, dot, gloveOf, len, scale, sub, unit } from "./convert.mjs";

export const RATE = 120;
const S = (seconds) => Math.round(seconds * RATE);
const DEG = 180 / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const median = (values) => {
  const v = values.slice().sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
};

/** The rules for timing events. Speeds in metres a second, turns in degrees a second. */
export const EVENT_RULES = {
  /** A punch's wrist passes this speed relative to the chest. */
  punchSpeed: 3.0,
  /** Going back from the fastest moment, the fist has left once it is over this. */
  launchSpeed: 1.0,
  /** First visible movement: any of these, and three times the stillness of that boxer's own guard. */
  firstWrist: 0.5,
  firstHips: 30,
  firstShoulders: 40,
  noiseTimes: 3,
  /** The first movement is looked for no further back than this before the launch. */
  firstWithin: 0.6,
  /** Home: the wrist this close to where that hand rests, and slower than this. */
  guardNear: 0.08,
  guardSpeed: 0.5,
  /** A hand that never comes that close is home when it has stopped and the arm is folded again. */
  guardWithin: 1.0,
};

/** The measures the events are found from, for the whole trial. */
export function measure(frames) {
  const n = frames.length;
  const hands = [0, 1].map((s) => {
    const rel = frames.map((f) => sub(f.wrists[s], f.chest));
    const speed = rel.map((_, i) => (i < 2 || i >= n - 2 ? 0 : len(sub(rel[i + 2], rel[i - 2])) * (RATE / 4)));
    const glove = frames.map((f) => gloveOf(f.shoulders[s], f.wrists[s]));
    const reach = glove.map((g) => g[2]);
    const stretch = frames.map((f) => dist(f.wrists[s], f.shoulders[s]) / ARM);
    // The wrist in the chest's own axes, so that turning the body does not move it.
    const local = frames.map((f) => {
      const up = unit(sub(f.chest, f.hips));
      const fwd = unit([f.across[1] * up[2] - f.across[2] * up[1], f.across[2] * up[0] - f.across[0] * up[2], f.across[0] * up[1] - f.across[1] * up[0]]);
      const r = sub(f.wrists[s], f.chest);
      // x across (its right), y up the spine, z out of the chest.
      return [dot(r, f.across), dot(r, up), dot(r, fwd)];
    });
    return { rel, speed, glove, reach, stretch, local };
  });
  // How fast the hips and the shoulders turn about the vertical.
  const angle = (line) => Math.atan2(-line[2], line[0]);
  const rate = (key) =>
    frames.map((_, i) =>
      i < 2 || i >= n - 2 ? 0 : wrap(angle(frames[i + 2][key]) - angle(frames[i - 2][key])) * DEG * (RATE / 4),
    );
  return { hands, hipRate: rate("hipLine"), shoulderRate: rate("across") };
}

/**
 * Is frame `c` the contact of a punch by hand `s`? If so: its launch and its
 * fastest moment. A punch is a fast stroke that carries the glove toward the
 * player; the hand coming back, a hand dropping, or a lift into the guard
 * are not.
 */
export function strokeAt(m, s, c, n) {
  const { speed, reach, glove, rel } = m.hands[s];
  // The fastest moment of the stroke that got it there.
  let peak = Math.max(2, c - S(0.3));
  for (let k = peak; k <= Math.min(n - 3, c + S(0.04)); k++) if (speed[k] > speed[peak]) peak = k;
  if (speed[peak] < EVENT_RULES.punchSpeed) return null;
  // Out in front of the chest.
  if (rel[c][2] < 0.3) return null;
  // Launch: going back from the fastest moment, the last frame the fist
  // was slow, or was still going away from where it lands (a wind-up).
  let launch = Math.min(peak, c - 1);
  while (launch > 2) {
    const closing = (dist(glove[launch - 2], glove[c]) - dist(glove[launch], glove[c])) * (RATE / 2);
    if (speed[launch - 1] < EVENT_RULES.launchSpeed || closing < 0) break;
    launch--;
  }
  // A punch flies for a tenth to four tenths of a second and carries the
  // glove toward the player. A hand dropping after a swing, or coming up
  // into the guard, does neither.
  const flight = (c - launch) / RATE;
  if (flight < 0.07 || flight > 0.4) return null;
  if (reach[c] - reach[launch] < 0.12) return null;
  if (dist(glove[c], glove[launch]) < 0.25) return null;
  return { hand: s, launch, peak, contact: c, peakSpeed: speed[peak] };
}

/** Every punch in a trial, in order of contact. */
export function findPunches(frames, m = measure(frames)) {
  const n = frames.length;
  const found = [];
  for (const s of [0, 1]) {
    const { reach } = m.hands[s];
    for (let c = S(0.3); c < n - S(0.3); c++) {
      // Contact: the glove nearest the player for a third of a second around.
      let top = true;
      for (let k = c - S(0.15); k <= c + S(0.15) && top; k++) if (reach[k] > reach[c] || (reach[k] === reach[c] && k < c)) top = false;
      if (!top) continue;
      const stroke = strokeAt(m, s, c, n);
      if (stroke) found.push(stroke);
    }
  }
  found.sort((a, b) => a.contact - b.contact);
  return found;
}

/** How still this boxer's guard is: the usual size of each measure away from any punch. */
export function stillness(frames, m, punches) {
  const busy = new Uint8Array(frames.length);
  for (const p of punches)
    for (let k = Math.max(0, p.launch - S(0.5)); k <= Math.min(frames.length - 1, p.contact + S(0.7)); k++) busy[k] = 1;
  const quiet = (series) => median(series.filter((_, i) => !busy[i]).map(Math.abs));
  return {
    wrist: [quiet(m.hands[0].speed), quiet(m.hands[1].speed)],
    hips: quiet(m.hipRate),
    shoulders: quiet(m.shoulderRate),
    quietFrames: busy.reduce((a, b) => a + (b ? 0 : 1), 0),
  };
}

/** Where each hand rests, in the chest's own axes, for each stance: the middle of where it is when it is slow and away from any punch. */
export function guardPlaces(frames, m, punches) {
  const busy = new Uint8Array(frames.length);
  for (const p of punches)
    for (let k = Math.max(0, p.launch - S(0.3)); k <= Math.min(frames.length - 1, p.contact + S(0.6)); k++) busy[k] = 1;
  const places = {};
  for (const stance of [1, -1])
    places[stance] = [0, 1].map((s) => {
      const at = [];
      frames.forEach((f, i) => {
        if (busy[i] || m.hands[s].speed[i] > 0.6) return;
        if (Math.sign(f.feet[0][2] - f.feet[1][2]) !== stance) return;
        // A hand hanging at the hip is resting, not guarding.
        if (m.hands[s].local[i][1] < -0.3) return;
        at.push(m.hands[s].local[i]);
      });
      if (at.length < RATE / 2) return null;
      return [0, 1, 2].map((k) => median(at.map((p) => p[k])));
    });
  return places;
}

/**
 * The events of one punch: first visible movement, launch, contact, the hand
 * home. `before` is the frame the search for the first movement may not pass
 * (the same hand's last contact).
 */
export function timePunch(frames, m, punch, still, places, before = 0, after = frames.length - 1) {
  const s = punch.hand;
  const hand = m.hands[s];
  const R = EVENT_RULES;
  // Which way the body turns to throw it: the sign of the shoulders' turn while the fist flies.
  let turn = 0;
  for (let i = punch.launch; i <= punch.contact; i++) turn += m.shoulderRate[i];
  const way = Math.sign(turn) || 1;
  // A boxer in his guard is never still, so only turning the punch's own way
  // counts, or the hand itself moving.
  const moving = (i, times) =>
    hand.speed[i] > Math.max(R.firstWrist, times * still.wrist[s]) ||
    way * m.hipRate[i] > Math.max(R.firstHips, times * still.hips) ||
    way * m.shoulderRate[i] > Math.max(R.firstShoulders, times * still.shoulders);
  // First: back from the launch for as long as something is moving. Two
  // still frames in a row end it; one alone is noise.
  const onset = (times) => {
    let at = punch.launch;
    const floor = Math.max(before, punch.launch - S(R.firstWithin), 2);
    for (let i = punch.launch - 1; i >= floor; i--) {
      if (moving(i, times)) at = i;
      else if (!moving(i - 1, times)) break;
    }
    return at;
  };
  // `first` is where the movement begins. `seen` is where it first stands out
  // from the boxer's own bounce: three times how much he moves in his guard.
  const first = onset(0);
  const seen = Math.max(first, onset(R.noiseTimes));
  // Home: near where the hand rests and slow. Failing that: slow, with the arm folded again.
  const stance = Math.sign(frames[punch.launch].feet[0][2] - frames[punch.launch].feet[1][2]) || 1;
  const place = places[stance]?.[s] ?? places[-stance]?.[s];
  const last = Math.min(after, punch.contact + S(R.guardWithin), frames.length - 3);
  let guard = -1;
  let how = "near";
  for (let i = punch.contact + S(0.08); i <= last && guard < 0; i++)
    if (place && hand.speed[i] < R.guardSpeed && dist(hand.local[i], place) < R.guardNear) guard = i;
  if (guard < 0) {
    how = "stopped";
    const folded = Math.min(hand.stretch[punch.launch] + 0.12, 0.75);
    for (let i = punch.contact + S(0.08); i <= last && guard < 0; i++)
      if (hand.speed[i] < R.guardSpeed && hand.stretch[i] < folded) guard = i;
  }
  if (guard < 0) {
    how = "slowest";
    // Never settled: the slowest moment once the arm has come most of the way back.
    let best = -1;
    for (let i = punch.contact + S(0.15); i <= last; i++)
      if (hand.stretch[i] < 0.8 && (best < 0 || hand.speed[i] < hand.speed[best])) best = i;
    guard = best < 0 ? last : best;
  }
  return { first, seen, launch: punch.launch, contact: punch.contact, guard, guardHow: how, stance };
}

/**
 * The shape of a punch, from the fist's direction at its fastest: mostly
 * forward with the arm ending straight is a straight punch, mostly up an
 * uppercut, mostly across a hook.
 */
export function shapeOf(m, punch) {
  const s = punch.hand;
  const hand = m.hands[s];
  const stretch = hand.stretch[punch.contact];
  const v = scale(sub(hand.rel[punch.peak + 2], hand.rel[punch.peak - 2]), RATE / 4);
  // Sideways speed toward the other side of the body: the left hand going to its right.
  const acrossSpeed = s === 0 ? v[0] : -v[0];
  const fast = len(v) || 1;
  if (v[2] >= 0.72 * fast && stretch >= 0.85) return "straight";
  if (v[1] >= 0.55 * fast && v[1] > Math.abs(v[0])) return "uppercut";
  if (acrossSpeed >= 0.5 * fast) return "hook";
  if (stretch >= 0.88) return "straight";
  return v[1] > Math.abs(v[0]) && v[1] > v[2] * 0.6 ? "uppercut" : acrossSpeed > 0.35 * fast ? "hook" : "straight";
}

/** How far below where his head punches land a boxer's body punches land. */
export const BODY_BELOW = 0.32;

/**
 * A hook or an uppercut lands with the arm bent, and its glove is furthest
 * forward only after it has swung past. Its contact is where the glove comes
 * nearest to where this boxer's punches land: his own straight punches say
 * where his imagined opponent's head is, and the body is under it.
 */
export function nearestContact(m, punch, target, n) {
  const glove = m.hands[punch.hand].glove;
  const body = [target[0], target[1] - BODY_BELOW, target[2]];
  const far = (i) => Math.min(dist(glove[i], target), dist(glove[i], body));
  let best = punch.launch + 2;
  for (let i = best; i <= Math.min(n - 1, punch.contact + S(0.15)); i++) if (far(i) < far(best)) best = i;
  return best;
}

/** The rest of what is said about a punch: its level, which hand of the stance it is, and its name. */
export function classify(frames, m, punch, events, shape, target, standing) {
  const s = punch.hand;
  const hand = m.hands[s];
  const c = events.contact;
  const height = hand.glove[c][1];
  // Nearer the body than the head, by height. Before the boxer's own target is known: well under his shoulder line.
  const level = (target ? height < target[1] - BODY_BELOW / 2 : height < standing.chest - 0.14) ? "body" : "head";
  const lead = (events.stance > 0 ? 0 : 1) === s;
  // How far apart the feet are front to back: under a hand's width is no stance at all.
  const feet = frames[events.launch].feet;
  const square = Math.abs(feet[0][2] - feet[1][2]) < 0.1;
  return {
    shape,
    level,
    lead,
    square,
    stretch: hand.stretch[c],
    height,
    kind: level === "body" ? "body" : shape === "straight" ? (lead ? "jab" : "cross") : shape,
  };
}

/** How the boxer stands in his guard: the usual heights of chest and head away from punches. */
export function standingOf(frames) {
  const chest = frames.map((f) => f.chest[1]).sort((a, b) => a - b);
  const head = frames.map((f) => f.head[1]).sort((a, b) => a - b);
  // Most of the time he is upright; dips are the lower tail.
  return { chest: chest[Math.floor(chest.length * 0.6)], head: head[Math.floor(head.length * 0.6)] };
}

/**
 * Everything about every punch of a trial. `target` is where this boxer's
 * head punches land, once that is known from a first pass.
 */
export function analyse(frames, target = null) {
  const m = measure(frames);
  const raw = findPunches(frames, m);
  const still = stillness(frames, m, raw);
  const places = guardPlaces(frames, m, raw);
  const standing = standingOf(frames);
  const lastOf = [0, 0];
  const punches = raw.map((p, i) => {
    const shape = shapeOf(m, p);
    const stroke = { ...p };
    if (target && shape !== "straight") stroke.contact = nearestContact(m, p, target, frames.length);
    const next = raw.slice(i + 1).find((q) => q.hand === p.hand);
    const events = timePunch(frames, m, stroke, still, places, lastOf[p.hand], next ? next.launch : frames.length - 1);
    lastOf[p.hand] = stroke.contact + 2;
    return { ...stroke, ...events, ...classify(frames, m, stroke, events, shape, target, standing) };
  });
  punches.sort((a, b) => a.contact - b.contact);
  return { m, punches, still, places, standing, target };
}

/**
 * A clip keeps one heading, which can move a punch's contact (the glove
 * nearest the player) by a frame or two from where the first pass found it.
 * The other events do not depend on the heading. `near` is the old contact
 * in these frames; `launch` the launch.
 */
export function contactIn(frames, hand, near, launch) {
  let c = Math.max(launch + 4, near - 5);
  const reach = (i) => gloveOf(frames[i].shoulders[hand], frames[i].wrists[hand])[2];
  for (let k = c; k <= Math.min(frames.length - 1, near + 5); k++) if (reach(k) > reach(c)) c = k;
  return c;
}

/** When each foot is planted: within 3 cm of its lowest and slower than 0.15 m/s. Spans of frames. */
export function planted(frames) {
  return [0, 1].map((s) => {
    const low = Math.min(...frames.map((f) => f.feet[s][1]));
    const spans = [];
    let from = -1;
    frames.forEach((f, i) => {
      const a = frames[Math.max(0, i - 2)].feet[s], b = frames[Math.min(frames.length - 1, i + 2)].feet[s];
      const speed = dist(a, b) * (RATE / 4);
      const down = f.feet[s][1] - low < 0.03 && speed < 0.15;
      if (down && from < 0) from = i;
      if (!down && from >= 0) {
        if (i - from >= 6) spans.push([from, i - 1]);
        from = -1;
      }
    });
    if (from >= 0) spans.push([from, frames.length - 1]);
    return spans;
  });
}

// ── Guard loops ─────────────────────────────────────────────────────────────
/** How unlike two frames are: metres between the points that show, plus how differently they are moving. */
function unlike(frames, i, j) {
  const points = (f) => [f.feet[0], f.feet[1], f.hips, f.chest, f.head, f.wrists[0], f.wrists[1]];
  const a = points(frames[i]), b = points(frames[j]);
  const va = points(frames[i + 4]).map((p, k) => sub(p, a[k])), vb = points(frames[j + 4]).map((p, k) => sub(p, b[k]));
  let sum = 0;
  for (let k = 0; k < a.length; k++) sum += dist(a[k], b[k]) + 0.08 * dist(va[k], vb[k]) * (RATE / 4);
  return sum;
}

/**
 * Stretches of guard with no punch in them that can be played round and
 * round: the frame they leave on is like the frame they enter on (feet, hips,
 * chest, head, hands, and how those are moving).
 */
export function findLoops(frames, a, { least = 1.5, most = 6 } = {}) {
  const n = frames.length;
  const busy = new Uint8Array(n);
  for (const p of a.punches) for (let k = Math.max(0, p.first - S(0.05)); k <= Math.min(n - 1, p.guard + S(0.05)); k++) busy[k] = 1;
  for (let i = 0; i < n; i++) {
    for (const s of [0, 1]) if (a.m.hands[s].speed[i] > 2.0 || a.m.hands[s].local[i][1] < -0.28) busy[i] = 1;
    // No stance at all (feet level): he is standing about, not on guard.
    if (Math.abs(frames[i].feet[0][2] - frames[i].feet[1][2]) < 0.1) busy[i] = 1;
  }
  const loops = [];
  let longest = 0;
  let i = 0;
  while (i < n) {
    if (busy[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !busy[j] && Math.sign(frames[j].feet[0][2] - frames[j].feet[1][2]) === Math.sign(frames[i].feet[0][2] - frames[i].feet[1][2])) j++;
    longest = Math.max(longest, (j - i) / RATE);
    if (j - i >= S(least) + 8) {
      // The best pair of frames to enter and leave on.
      let best = null;
      for (let x = i; x + S(least) < j - 6; x += 2)
        for (let y = x + S(least); y < Math.min(j - 6, x + S(most)); y += 2) {
          const cost = unlike(frames, x, y);
          // Longer is better: a loop that repeats every second and a half is
          // noticed, and the blend at the join hides a small mismatch.
          const score = cost - 0.45 * ((y - x) / RATE);
          if (!best || score < best.score) best = { from: x, to: y, cost, score };
        }
      if (best) {
        const part = frames.slice(best.from, best.to + 1);
        const range = (get) => Math.max(...part.map(get)) - Math.min(...part.map(get));
        loops.push({
          ...best,
          seconds: (best.to - best.from) / RATE,
          stance: Math.sign(frames[best.from].feet[0][2] - frames[best.from].feet[1][2]),
          travel: range((f) => f.travel),
          turned: Math.abs(part[part.length - 1].heading - part[0].heading) * DEG,
          bounce: range((f) => f.hips[1]),
        });
      }
    }
    i = Math.max(j, i + 1);
  }
  return { loops, longest };
}

// ── Steps ───────────────────────────────────────────────────────────────────
/**
 * Steps in and out with no punch in them: the midpoint of the feet moves
 * along the way he faces, and the stance afterwards is the stance before.
 */
export function findSteps(frames, a) {
  const n = frames.length;
  const busy = new Uint8Array(n);
  for (const p of a.punches) for (let k = Math.max(0, p.first - S(0.05)); k <= Math.min(n - 1, p.guard + S(0.05)); k++) busy[k] = 1;
  const speed = frames.map((_, i) => (i < 6 || i >= n - 6 ? 0 : (frames[i + 6].travel - frames[i - 6].travel) * (RATE / 12)));
  const steps = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(speed[i]) <= 0.35) {
      i++;
      continue;
    }
    const way = Math.sign(speed[i]);
    let from = i, to = i;
    while (from > 0 && Math.sign(speed[from - 1]) === way && Math.abs(speed[from - 1]) > 0.12) from--;
    while (to < n - 1 && Math.sign(speed[to + 1]) === way && Math.abs(speed[to + 1]) > 0.12) to++;
    i = to + 1;
    const far = frames[to].travel - frames[from].travel;
    const stance = (k) => frames[k].feet[0][2] - frames[k].feet[1][2];
    let clean = true;
    for (let k = Math.max(0, from - S(0.1)); k <= Math.min(n - 1, to + S(0.15)); k++)
      if (busy[k] || a.m.hands[0].speed[k] > 2 || a.m.hands[1].speed[k] > 2 || a.m.hands[0].local[k][1] < -0.28 || a.m.hands[1].local[k][1] < -0.28) clean = false;
    if (!clean || from < S(0.1) || to > n - S(0.2)) continue;
    const before = stance(from), after = stance(to);
    if (Math.sign(before) !== Math.sign(after) || Math.abs(before) < 0.2 || Math.abs(after) < 0.2) continue;
    steps.push({
      from,
      to,
      far,
      seconds: (to - from) / RATE,
      stance: Math.sign(before),
      stanceChange: Math.abs(after - before),
      turned: Math.abs(frames[to].heading - frames[from].heading) * DEG,
    });
  }
  return steps;
}

// ── Combinations ────────────────────────────────────────────────────────────
/** Punches thrown as one motion: each lands within six tenths of a second of the one before. */
export function findCombos(punches, within = 0.6) {
  const combos = [];
  let run = [];
  for (const p of punches) {
    if (run.length && (p.contact - run[run.length - 1].contact) / RATE > within) {
      if (run.length > 1) combos.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 1) combos.push(run);
  return combos;
}

export { S, median };
