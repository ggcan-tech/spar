// Chooses which takes to keep: for each kind of punch the cleanest ones of
// typical length, the best loops of guard, the best steps, and the
// combinations that were thrown most often.
import { S, median } from "./cut.mjs";
import { dist } from "./convert.mjs";

/** How many takes of each kind are wanted. */
export const WANTED = {
  jab: 2,
  cross: 2,
  hook_lead: 2,
  hook_rear: 2,
  upper_lead: 2,
  upper_rear: 2,
  body_lead_straight: 1,
  body_rear_straight: 1,
  body_lead_hook: 1,
  body_rear_hook: 1,
};

/** The slot a punch belongs in. A rising punch to the body goes with the hooks to the body: both come round and under. */
export function slotOf(p) {
  const side = p.lead ? "lead" : "rear";
  if (p.level === "body") return `body_${side}_${p.shape === "straight" ? "straight" : "hook"}`;
  if (p.shape === "straight") return p.lead ? "jab" : "cross";
  return `${p.shape === "hook" ? "hook" : "upper"}_${side}`;
}
/** The kind the rules know a slot by. */
export const kindOf = (slot) =>
  slot.startsWith("body") ? "body" : slot.startsWith("hook") ? "hook" : slot.startsWith("upper") ? "uppercut" : slot;

const quartile = (values, share) => {
  const v = values.slice().sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) * share)] : 0;
};
/** The middle and the spread of each time, over every punch of a slot. */
export function typical(punches) {
  const of = (get) => {
    const v = punches.map(get);
    return { mid: median(v), spread: Math.max((quartile(v, 0.75) - quartile(v, 0.25)) / 1.35, S(0.025)) };
  };
  return {
    load: of((p) => p.launch - p.first),
    strike: of((p) => p.contact - p.launch),
    home: of((p) => p.guard - p.contact),
    speed: of((p) => p.peakSpeed),
  };
}

/**
 * How good a take of a single punch is: lower is better, null is unusable.
 * `trial` holds the frames and analysis it came from; `all` every punch of
 * that trial.
 */
export function rateSingle(p, trial, usual, most = 0) {
  const { frames, analysis } = trial;
  const all = analysis.punches;
  if (p.square) return null;
  if (Math.abs(p.alpha) > (25 * Math.PI) / 180) return null;
  // Alone: no other punch in flight from just before it starts until its
  // hand is home. Failing that (`tier` 1): the first punch of a combination,
  // which at least starts from the guard. Failing that (`tier` 2): any.
  let tier = 0;
  let next = null;
  for (const q of all) {
    if (q === p) continue;
    if (q.guard > p.first - S(0.1) && q.first < p.guard) {
      if (q.contact < p.contact) tier = 2;
      else {
        tier = Math.max(tier, 1);
        if (!next || q.launch < next.launch) next = q;
      }
    }
  }
  if (tier > most) return null;
  // Cut from a combination, the take ends when the next punch's fist leaves:
  // there must be a little of the hand coming back before that.
  if (next && next.launch < p.contact + S(0.07)) return null;
  // The stance holds from start to finish.
  let narrow = Infinity;
  for (let i = p.first; i <= p.guard; i++) {
    const d = (frames[i].feet[0][2] - frames[i].feet[1][2]) * p.stance;
    narrow = Math.min(narrow, d);
  }
  if (narrow < 0.1) return null;
  const place = analysis.places[p.stance];
  if (!place?.[0] || !place?.[1]) return null;
  const local = (s, i) => analysis.m.hands[s].local[i];
  // Starts from the guard and ends in it.
  const start = dist(local(0, p.first), place[0]) + dist(local(1, p.first), place[1]);
  const end = dist(local(p.hand, p.guard), place[p.hand]);
  let other = 0;
  for (let i = p.first; i <= p.guard; i++) other = Math.max(other, analysis.m.hands[1 - p.hand].speed[i]);
  let near = Infinity, far = -Infinity;
  for (let i = p.first; i <= p.guard; i++) {
    near = Math.min(near, frames[i].travel);
    far = Math.max(far, frames[i].travel);
  }
  const z = (value, u) => Math.abs(value - u.mid) / u.spread;
  const parts = {
    load: z(p.launch - p.first, usual.load),
    strike: z(p.contact - p.launch, usual.strike),
    home: 0.7 * z(p.guard - p.contact, usual.home),
    speed: 0.5 * z(p.peakSpeed, usual.speed),
    start: 4 * start,
    end: 3 * end,
    other: 0.3 * Math.max(0, other - 1.5),
    aim: Math.abs(p.alpha) / ((10 * Math.PI) / 180),
    travel: 2 * (far - near),
    settled: p.guardHow === "near" ? 0 : 0.7,
    height: 3 * Math.abs(frames[p.first].hips[1] - analysis.hipsUsual),
  };
  // A hook or an uppercut is a bent-arm punch. Most of these boxers' are long
  // swings; the more bent the arm at contact, the better the take.
  if (p.shape !== "straight") parts.bent = 6 * Math.max(0, p.stretch - 0.82);
  // And it should land where that boxer's punches of its level land, not half-way between head and body.
  const target = analysis.target;
  if (target) parts.level = 4 * Math.abs(p.height - (p.level === "body" ? target[1] - 0.32 : target[1]));
  if (tier) parts.combination = 3 * tier;
  return { cost: Object.values(parts).reduce((a, b) => a + b, 0), parts, tier, next };
}

/** The best `count` of a list of rated takes, preferring different trials for the second. */
export function pick(rated, count) {
  const left = rated.slice().sort((a, b) => a.cost - b.cost);
  const kept = [];
  while (kept.length < count && left.length) {
    // A second take from another boxer is worth a little.
    left.sort((a, b) => a.cost + (kept.some((k) => k.trial === a.trial) ? 0.5 : 0) + (kept.some((k) => k.subject === a.subject) ? 0.5 : 0) - (b.cost + (kept.some((k) => k.trial === b.trial) ? 0.5 : 0) + (kept.some((k) => k.subject === b.subject) ? 0.5 : 0)));
    kept.push(left.shift());
  }
  return kept;
}

