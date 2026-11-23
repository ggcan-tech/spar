// The whole pipeline, one command, same result every time:
//
//   node tools/anim/build.mjs
//
// Reads the CMU boxing trials, turns the boxer into the game's opponent,
// finds every punch, keeps the best takes, and writes:
//   apps/web/public/box/anim/pack.json          the clips the game plays
//   apps/web/src/box/motion/times.generated.ts  the punch times the rules read
//   docs/production/evidence/real-clips.md      what was kept and what was found
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRIALS, boneLengthSpread, readTrial } from "./asf.mjs";
import { GAME, convertRange, dist, gloveOf, mirrorFrame, prepare } from "./convert.mjs";
import { BODY_BELOW, EVENT_RULES, RATE, S, analyse, contactIn, findCombos, findLoops, findSteps, median, planted } from "./cut.mjs";
import { WANTED, kindOf, pick, rateSingle, slotOf, typical } from "./choose.mjs";
import { JOINTS, UNIT, encodeFrames } from "./pack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = {
  pack: join(ROOT, "apps/web/public/box/anim/pack.json"),
  times: join(ROOT, "apps/web/src/box/motion/times.generated.ts"),
  evidence: join(ROOT, "docs/production/evidence/real-clips.md"),
};
const quiet = process.argv.includes("--quiet");
const say = (...words) => quiet || console.log(...words);
const DEG = 180 / Math.PI;
/** Frames of the pack before a punch's first movement and after its hand is home: room for a blend. */
const LEAD = S(4 / 60);
const TAIL = S(6 / 60);
const ms = (frames) => Math.round((frames / RATE) * 1000);
const letter = (i) => "abcdefgh"[i];

// ── 1. Read, convert, find ──────────────────────────────────────────────────
const trials = TRIALS.map((name) => {
  const trial = readTrial(name);
  const spread = boneLengthSpread(trial);
  if (spread > 1e-5) throw new Error(`${name}: the reader's bones change length (${spread})`);
  const prep = prepare(trial);
  const n = prep.frames.length;
  const aim = (p, a) => {
    const g = a.m.hands[p.hand].glove[p.contact];
    return Math.atan2(g[0], g[2]);
  };
  // First with the head's heading as it is; then turned so that this boxer's
  // straight punches, taken together, land dead ahead; then once more, now
  // knowing where his punches land (his imagined opponent's head), which is
  // what times the contact of a hook or an uppercut.
  let analysis = analyse(convertRange(prep, 0, n - 1));
  const straight = (a) => a.punches.filter((p) => p.shape === "straight" && p.level === "head");
  const offset = straight(analysis).length >= 3 ? -median(straight(analysis).map((p) => aim(p, analysis))) : 0;
  const frames = convertRange(prep, 0, n - 1, { offset });
  analysis = analyse(frames);
  const target = [0, 1, 2].map((k) => median(straight(analysis).map((p) => analysis.m.hands[p.hand].glove[p.contact][k])));
  analysis = analyse(frames, target);
  for (const p of analysis.punches) {
    p.alpha = aim(p, analysis);
    p.slot = slotOf(p);
    p.trial = name;
  }
  analysis.hipsUsual = median(frames.map((f) => f.hips[1]));
  say(`${name}: ${n} frames, ${analysis.punches.length} punches, heading turned ${(offset * DEG).toFixed(1)}°, head punches land at ${target.map((x) => x.toFixed(2)).join(", ")}`);
  return { name, subject: name.split("_")[0], prep, frames, analysis, offset, spread, seconds: n / RATE };
});
const trialOf = (name) => trials.find((t) => t.name === name);
const everyPunch = trials.flatMap((t) => t.analysis.punches);
const bySlot = {};
for (const p of everyPunch) (bySlot[p.slot] ||= []).push(p);

// ── 2. Cut one clip ─────────────────────────────────────────────────────────
/** Frames at the recording's rate to the pack's: every second one. */
const halve = (frames) => frames.filter((_, i) => i % 2 === 0);
/** A frame number at the recording's rate as one of the pack's (halves allowed). */
const toPack = (frame) => frame / 2;

/**
 * A stretch of a trial holding one or more punches, as a clip. One heading
 * for the whole clip: toward where its first straight punch lands, or the
 * boxer's slow heading at the start if it has none. Southpaw takes are
 * mirrored, so every clip in the pack is orthodox (left hand and foot lead).
 */
function cutPunches(trial, parts, end) {
  const { prep, analysis } = trial;
  const n = prep.frames.length;
  const from = Math.max(0, parts[0].first - LEAD);
  const to = Math.min(n - 1, end + TAIL);
  // The clip faces where its first straight punch lands; with none, where its first punch does.
  const lined = parts.find((p) => p.shape === "straight") ?? parts[0];
  const fixed = prep.heading[lined.contact] + trial.offset - lined.alpha;
  let frames = convertRange(prep, from, to, { fixed });
  const southpaw = parts[0].stance < 0;
  if (southpaw) frames = frames.map(mirrorFrame);
  const marks = parts.map((p) => {
    // In the pack the lead hand is the left (0), the rear the right (1).
    const hand = p.lead ? 0 : 1;
    // A straight punch's contact is its greatest reach, which the new heading
    // can move by a frame. The others keep theirs: nearest the boxer's target.
    const contact = p.shape === "straight" ? contactIn(frames, hand, p.contact - from, p.launch - from) : p.contact - from;
    const at = frames[contact];
    const glove = gloveOf(at.shoulders[hand], at.wrists[hand]);
    // The boxer's target as this clip sees it: turned by as much as the glove was, and mirrored with it.
    const was = analysis.m.hands[p.hand].glove[p.contact];
    const turned = Math.atan2(glove[0] * (southpaw ? -1 : 1), glove[2]) - Math.atan2(was[0], was[2]);
    const t = analysis.target;
    const level = p.level === "body" ? t[1] - BODY_BELOW : t[1];
    const tx = t[0] * Math.cos(turned) + t[2] * Math.sin(turned), tz = -t[0] * Math.sin(turned) + t[2] * Math.cos(turned);
    const aimAt = [southpaw ? -tx : tx, level, tz];
    // The hand is half-way home: from here a new order may cut in.
    const reach = (i) => gloveOf(frames[i].shoulders[hand], frames[i].wrists[hand])[2];
    // The pack keeps every second frame: the last one kept is the latest any event can be.
    const guard = Math.min(p.guard - from, 2 * Math.floor((frames.length - 1) / 2));
    const half = (reach(contact) + reach(guard)) / 2;
    let back = contact;
    while (back < guard && reach(back) > half) back++;
    return {
      slot: p.slot,
      kind: kindOf(p.slot),
      hand: p.lead ? "lead" : "rear",
      level: p.level,
      shape: p.shape,
      events: {
        first: toPack(Math.max(0, p.first - from)),
        seen: toPack(Math.max(0, p.seen - from)),
        launch: toPack(p.launch - from),
        contact: toPack(contact),
        guard: toPack(guard),
      },
      // Home was measured in the recording even when the clip ends before it.
      times: { load: ms(p.launch - p.first), seen: ms(p.launch - p.seen), strike: ms(contact + from - p.launch), home: ms(p.guard - (contact + from)) },
      back: toPack(back),
      contact: { hand: glove.map((x) => +x.toFixed(3)), aim: aimAt.map((x) => +x.toFixed(3)) },
      speed: +p.peakSpeed.toFixed(1),
      stretch: +p.stretch.toFixed(2),
    };
  });
  // Is the hand that does not punch in its guard throughout? If not (the
  // take was cut out of a combination) the game takes that arm from its idle.
  const place = analysis.places[parts[0].stance];
  let other = "guard";
  if (parts.length === 1) {
    const p = parts[0];
    const o = 1 - p.hand;
    for (let i = p.first; i <= Math.min(p.guard, to); i++)
      if (analysis.m.hands[o].speed[i] > 2.5 || (place?.[o] && dist(analysis.m.hands[o].local[i], place[o]) > 0.22)) other = "busy";
  }
  const kept = halve(frames);
  const feet = planted(frames).map((spans) => spans.map(([a, b]) => [Math.ceil(a / 2), Math.floor(b / 2)]).filter(([a, b]) => b > a));
  return { frames: kept, marks, from, to, southpaw, other, feet: { left: feet[0], right: feet[1] } };
}

const base = (trial, cut, extra) => ({
  source: `cmu:${trial.name}`,
  from: cut.from,
  to: cut.to,
  mirrored: cut.southpaw,
  fps: RATE / 2,
  frames: cut.frames.length,
  ...extra,
  data: encodeFrames(cut.frames),
});
const RATE_LIMITS = { load: [0.6, 1.0], strike: [0.9, 1.1] };

// ── 3. Single punches ───────────────────────────────────────────────────────
const clips = [];
const report = { singles: [], combos: [], loops: [], steps: [], missing: [] };
for (const [slot, count] of Object.entries(WANTED)) {
  const found = bySlot[slot] ?? [];
  const usual = typical(found.length ? found : everyPunch);
  // A punch thrown alone is best; the first punch of a combination costs
  // more; one from inside a combination more still.
  const rated = [];
  for (const p of found) {
    const r = rateSingle(p, trialOf(p.trial), usual, 2);
    if (r) rated.push({ ...r, p, trial: p.trial, subject: p.trial.split("_")[0] });
  }
  const kept = pick(rated, count);
  if (kept.length < count) report.missing.push(`${slot}: wanted ${count}, found ${found.length} in all, kept ${kept.length}`);
  kept.forEach((k, i) => {
    const trial = trialOf(k.trial);
    // Cut from a combination, the take ends as the next punch's fist leaves.
    const end = k.next ? Math.min(k.p.guard, k.next.launch) : k.p.guard;
    const cut = cutPunches(trial, [k.p], end);
    const mark = cut.marks[0];
    const id = `${slot}_${letter(i)}`;
    const last = cut.frames.length - 1;
    clips.push({
      id,
      ...base(trial, cut, {
        kind: mark.kind,
        hand: mark.hand,
        level: mark.level,
        shape: mark.shape,
        events: mark.events,
        interrupt: [
          [0, Math.max(0, mark.events.launch - 2)],
          [Math.min(last, mark.back), last],
        ],
        chain: { from: Math.min(last, mark.events.contact + 2), to: mark.events.guard },
        contact: mark.contact,
        feet: cut.feet,
        rate: RATE_LIMITS,
        other: cut.other,
        cut: k.tier === 0 ? "alone" : k.tier === 1 ? "first of a combination" : "inside a combination",
      }),
    });
    report.singles.push({ id, slot, trial: k.trial, cut, mark, tier: k.tier, cost: k.cost });
  });
}

// ── 4. Combinations thrown as one motion ────────────────────────────────────
const patterns = {};
for (const t of trials)
  for (const run of findCombos(t.analysis.punches)) (patterns[run.map((p) => p.slot).join(" > ")] ||= []).push(run);
/** How good a take of a combination is; null is unusable. */
function rateCombo(run, takes) {
  const trial = trialOf(run[0].trial);
  const { analysis, frames } = trial;
  if (run.some((p) => p.square || p.stance !== run[0].stance)) return null;
  const straight = run.find((p) => p.shape === "straight");
  if (straight && Math.abs(straight.alpha) > 25 / DEG) return null;
  // Every punch of it must go to about the same place: a boxer who turns
  // between two punches throws the second somewhere the player is not.
  // (Which way a punch goes in the room: the heading then, less its own angle.)
  const way = (p) => trial.prep.heading[p.contact] + trial.offset - p.alpha;
  const lined = straight ?? run[0];
  let apart = 0;
  for (const p of run) apart = Math.max(apart, Math.abs(Math.atan2(Math.sin(way(p) - way(lined)), Math.cos(way(p) - way(lined)))));
  if (apart > 12 / DEG) return null;
  const first = run[0], last = run[run.length - 1];
  const end = Math.max(...run.map((p) => p.guard));
  if ((end - first.first) / RATE > 2.4) return null;
  // Nothing else going on just before or after.
  for (const q of analysis.punches) if (!run.includes(q) && q.guard > first.first - S(0.1) && q.first < end) return null;
  const place = analysis.places[first.stance];
  if (!place?.[0] || !place?.[1]) return null;
  const local = (s, i) => analysis.m.hands[s].local[i];
  const start = dist(local(0, first.first), place[0]) + dist(local(1, first.first), place[1]);
  const finish = dist(local(0, end), place[0]) + dist(local(1, end), place[1]);
  // The gaps between its punches against the usual gaps of this combination.
  let rhythm = 0;
  for (let i = 1; i < run.length; i++) {
    const usual = median(takes.map((r) => r[i].contact - r[i - 1].contact));
    rhythm += Math.abs(run[i].contact - run[i - 1].contact - usual) / S(0.05);
  }
  let near = Infinity, far = -Infinity;
  for (let i = first.first; i <= end; i++) {
    near = Math.min(near, frames[i].travel);
    far = Math.max(far, frames[i].travel);
  }
  const cost = 4 * start + 2 * finish + rhythm + 2 * (far - near) + (straight ? Math.abs(straight.alpha) / (10 / DEG) : 0) + run.filter((p) => p.guardHow !== "near").length * 0.5 + apart / (4 / DEG);
  return { cost, end };
}
for (const [name, takes] of Object.entries(patterns).sort((a, b) => b[1].length - a[1].length)) {
  // Kept: combinations of two or three punches that were thrown at least twice.
  const length = takes[0].length;
  if (takes.length < 2 || length > 3) continue;
  const rated = takes.map((run) => ({ run, r: rateCombo(run, takes) })).filter((x) => x.r).sort((a, b) => a.r.cost - b.r.cost);
  if (!rated.length) {
    report.missing.push(`combination ${name}: thrown ${takes.length} times, none usable as one take`);
    continue;
  }
  const { run, r } = rated[0];
  const trial = trialOf(run[0].trial);
  const cut = cutPunches(trial, run, r.end);
  const id = `combo_${run.map((p) => p.slot).join("_")}`;
  const last = cut.frames.length - 1;
  clips.push({
    id,
    ...base(trial, cut, {
      kind: "combo",
      name: run.map((p) => p.slot).join("-"),
      parts: cut.marks.map((m) => ({ kind: m.kind, hand: m.hand, level: m.level, shape: m.shape, events: m.events, contact: m.contact })),
      interrupt: [
        [0, Math.max(0, cut.marks[0].events.launch - 2)],
        [Math.min(last, cut.marks[cut.marks.length - 1].back), last],
      ],
      feet: cut.feet,
      rate: RATE_LIMITS,
    }),
  });
  report.combos.push({ id, name, trial: run[0].trial, cut, thrown: takes.length, gaps: run.slice(1).map((p, i) => ms(p.contact - run[i].contact)) });
}
// What followed what in the recordings: where a punch of a combination may go next.
const follows = {};
for (const runs of Object.values(patterns))
  for (const run of runs) for (let i = 1; i < run.length; i++) ((follows[run[i - 1].slot] ||= new Set())).add(run[i].slot);
for (const clip of clips) {
  if (!clip.chain) continue;
  const slot = clip.id.replace(/_[a-h]$/, "");
  clip.chain.next = [...(follows[slot] ?? [])].sort();
}

// ── 5. Guard loops ──────────────────────────────────────────────────────────
{
  const searched = trials.map((t) => ({ t, ...findLoops(t.frames, t.analysis) }));
  const all = searched.flatMap(({ t, loops }) => loops.map((l) => ({ ...l, trial: t.name, subject: t.subject })));
  // Not the ones he ducks or weaves in (the hips drop a hand's length or
  // more): the rules take its head to be where a standing boxer's is.
  const usable = all.filter((l) => l.turned < 20 && l.travel < 0.45 && l.bounce <= 0.2).sort((a, b) => a.score - b.score);
  report.ducking = all.filter((l) => l.bounce > 0.2).length;
  const kept = [];
  for (const l of usable) {
    if (kept.length >= 4) break;
    // Not two from the same stretch of the same trial.
    if (kept.some((k) => k.trial === l.trial && Math.abs(k.from - l.from) < S(4))) continue;
    kept.push(l);
  }
  kept.forEach((l, i) => {
    const trial = trialOf(l.trial);
    let frames = convertRange(trial.prep, l.from, l.to, { offset: trial.offset });
    const southpaw = l.stance < 0;
    if (southpaw) frames = frames.map(mirrorFrame);
    // The last frame is like the first: leave it out, and the clip goes round.
    const cut = { frames: halve(frames.slice(0, -1)), from: l.from, to: l.to, southpaw };
    const id = `guard_${letter(i)}`;
    clips.push({ id, ...base(trial, cut, { kind: "guard", loop: true, bounce: +l.bounce.toFixed(3) }) });
    report.loops.push({ id, ...l });
  });
  report.loopsFound = all.length;
  report.longestQuiet = Math.max(...searched.map((x) => x.longest));
}

// ── 6. Steps ────────────────────────────────────────────────────────────────
{
  const all = trials.flatMap((t) => findSteps(t.frames, t.analysis).map((s) => ({ ...s, trial: t.name })));
  const usable = all.filter((s) => Math.abs(s.far) >= 0.15 && Math.abs(s.far) <= 0.45 && s.seconds >= 0.15 && s.seconds <= 0.5 && s.stanceChange < 0.2 && s.turned < 10);
  for (const way of [1, -1]) {
    const kept = usable
      .filter((s) => Math.sign(s.far) === way)
      .sort((a, b) => a.stanceChange + a.turned / 20 + Math.abs(Math.abs(a.far) - 0.25) - (b.stanceChange + b.turned / 20 + Math.abs(Math.abs(b.far) - 0.25)))
      .slice(0, 2);
    kept.forEach((s, i) => {
      const trial = trialOf(s.trial);
      const from = Math.max(0, s.from - S(0.1)), to = Math.min(trial.prep.frames.length - 1, s.to + S(0.15));
      let frames = convertRange(trial.prep, from, to, { offset: trial.offset });
      const southpaw = s.stance < 0;
      if (southpaw) frames = frames.map(mirrorFrame);
      const start = frames[s.from - from].travel, far = frames[s.to - from].travel - start;
      const kept60 = halve(frames);
      // How far along the step each frame is, in thousandths.
      const curve = kept60.map((f) => Math.round(1000 * Math.max(0, Math.min(1, (f.travel - start) / far))));
      const id = `step_${way > 0 ? "in" : "out"}_${letter(i)}`;
      clips.push({
        id,
        ...base(trial, { frames: kept60, from, to, southpaw }, {
          kind: "step",
          dir: way > 0 ? "in" : "out",
          events: { start: toPack(s.from - from), end: toPack(s.to - from) },
          travel: +far.toFixed(3),
          curve,
        }),
      });
      report.steps.push({ id, ...s, far });
    });
  }
  report.stepsFound = all.length;
}

// ── 7. Check and write the pack ─────────────────────────────────────────────
for (const clip of clips) {
  const marks = clip.parts ?? (clip.events?.contact !== undefined ? [clip] : []);
  for (const m of marks) {
    const e = m.events;
    if (!(e.first <= e.launch && e.launch < e.contact && e.contact < e.guard + 1e-9 && e.guard <= clip.frames - 1))
      throw new Error(`${clip.id}: events out of order ${JSON.stringify(e)}`);
  }
}
const pack = {
  version: 1,
  source: "CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu: free for all uses. Subjects 13, 14, 15, 17, boxing trials.",
  fps: RATE / 2,
  unit: UNIT,
  joints: JOINTS,
  stance: "orthodox",
  sizes: { chest: GAME.chest, head: GAME.head, shoulder: GAME.shoulder, shoulderUp: GAME.shoulderUp, upperArm: GAME.upperArm, forearm: GAME.forearm, wristShare: GAME.wristShare },
  clips,
};
mkdirSync(dirname(OUT.pack), { recursive: true });
const packText = JSON.stringify(pack);
writeFileSync(OUT.pack, packText);

// ── 8. The punch times the rules read ───────────────────────────────────────
const KINDS = ["jab", "cross", "hook", "uppercut", "body"];
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const sec = (millis) => +(millis / 1000).toFixed(3);
const kindTimes = {};
for (const kind of KINDS) {
  const takes = report.singles.filter((s) => s.mark.kind === kind);
  kindTimes[kind] = {
    load: sec(mean(takes.map((s) => s.mark.times.load))),
    strike: sec(mean(takes.map((s) => s.mark.times.strike))),
    home: sec(mean(takes.map((s) => s.mark.times.home))),
    seen: sec(mean(takes.map((s) => s.mark.times.seen))),
    takes: takes.length,
  };
}
const clipTimes = Object.fromEntries(
  report.singles.map((s) => [s.id, { kind: s.mark.kind, hand: s.mark.hand, level: s.mark.level, load: sec(s.mark.times.load), strike: sec(s.mark.times.strike), home: sec(s.mark.times.home), seen: sec(s.mark.times.seen) }]),
);
const found = {};
for (const kind of KINDS) {
  const list = everyPunch.filter((p) => kindOf(p.slot) === kind);
  found[kind] = {
    count: list.length,
    load: sec(ms(median(list.map((p) => p.launch - p.first)))),
    strike: sec(ms(median(list.map((p) => p.contact - p.launch)))),
    home: sec(ms(median(list.map((p) => p.guard - p.contact)))),
    seen: sec(ms(median(list.map((p) => p.launch - p.seen)))),
  };
}
const stepTimes = Object.fromEntries(report.steps.map((s) => [s.id, { seconds: +s.seconds.toFixed(3), metres: +Math.abs(s.far).toFixed(3) }]));
const comboGaps = Object.fromEntries(report.combos.map((c) => [c.id, c.gaps.map(sec)]));
writeFileSync(
  OUT.times,
  `// Written by tools/anim/build.mjs from the recorded clips. Do not edit: run the build again.
// Seconds. load: first movement to the fist leaving. strike: the fist leaving to contact.
// home: contact to the hand back in the guard. seen: how long before the fist leaves the
// body's movement stands out from the boxer's own bounce (three times its usual size).

/** The mean of the kept takes of each kind. */
export const KIND_TIMES = ${JSON.stringify(kindTimes, null, 2)} as const;

/** Each kept take of a single punch. */
export const CLIP_TIMES = ${JSON.stringify(clipTimes, null, 2)} as const;

/** Every punch found in the recordings, kept or not: how many, and the middle value of each time. */
export const FOUND_TIMES = ${JSON.stringify(found, null, 2)} as const;

/** The kept steps: how long each takes and how far it goes. */
export const STEP_TIMES = ${JSON.stringify(stepTimes, null, 2)} as const;

/** The kept combinations: seconds from each contact to the next. */
export const COMBO_GAPS = ${JSON.stringify(comboGaps, null, 2)} as const;
`,
);

// ── 9. The evidence ─────────────────────────────────────────────────────────
const at = (frame) => (frame / RATE).toFixed(2);
const lines = [];
lines.push("# The recorded clips: what was kept and what was found");
lines.push("");
lines.push("Written by `node tools/anim/build.mjs`; do not edit by hand. Source: the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu, free for all uses), boxing trials of subjects 13, 14, 15 and 17: one person shadow boxing, 120 frames a second. Nobody is hit and nobody falls.");
lines.push("");
lines.push("**Every time here is measured by rule** from wrist speed, reach and the turn of hips and shoulders, not judged by eye. While the tools were written a few clips were looked at as stick figures (a jab, a cross, hooks, uppercuts, a body punch, a guard, a combination, a step) and looked like what they are called; no clip has been stepped through frame by frame, and nobody who boxes has seen them. `ClipViewer` (apps/web/src/box/motion) is the page for doing that. Frames are the recording's own (120 a second); the pack holds every second one.");
lines.push("");
lines.push("How the times are measured:");
lines.push(`- **contact**: greatest reach. For a straight punch that is the glove furthest toward the player. A hook or an uppercut lands with the arm bent and is furthest forward only after it has swung past, so for those it is the glove nearest to where that boxer's own straight punches land (his imagined opponent's head; ${BODY_BELOW} m lower for the body). This differs from the study, which measured reach as wrist-to-shoulder distance over arm length.`);
lines.push(`- **launch**: going back from the fist's fastest moment, the last frame it was under ${EVENT_RULES.launchSpeed} m/s relative to the chest, or still drawing back.`);
lines.push(`- **first movement**: going back from the launch, where the hips (${EVENT_RULES.firstHips}°/s) or shoulders (${EVENT_RULES.firstShoulders}°/s) began to turn the punch's own way, or the hand to move (${EVENT_RULES.firstWrist} m/s). A boxer in his guard never stands still, so turning the other way does not count.`);
lines.push(`- **stands out**: the same, at three times the size of that boxer's usual movement in his guard: how long before the fist leaves a watcher could tell this from his bounce.`);
lines.push(`- **home**: the wrist within ${EVENT_RULES.guardNear * 100} cm of where that hand rests and slower than ${EVENT_RULES.guardSpeed} m/s; or, if it never comes that close, stopped with the arm folded.`);
lines.push("");
lines.push("## The trials");
lines.push("");
lines.push("| Trial | Seconds | Punches found | Bone length change (reader check) |");
lines.push("|---|---|---|---|");
for (const t of trials) lines.push(`| ${t.name} | ${t.seconds.toFixed(1)} | ${t.analysis.punches.length} | ${t.spread.toExponential(1)} |`);
lines.push(`| all | ${trials.reduce((a, t) => a + t.seconds, 0).toFixed(1)} | ${everyPunch.length} | |`);
lines.push("");
lines.push("## Punches found, by kind");
lines.push("");
lines.push("Lead and rear are by the boxer's stance at that moment (these boxers change stance within a trial). Middle value of each time over every punch found, in milliseconds.");
lines.push("");
lines.push("| Kind | Found | First movement to launch | Stands out to launch | Launch to contact | Contact to home | Fist speed, m/s |");
lines.push("|---|---|---|---|---|---|---|");
const NAMES = {
  jab: "Jab (lead straight, head)",
  cross: "Cross (rear straight, head)",
  hook_lead: "Lead hook, head",
  hook_rear: "Rear hook, head",
  upper_lead: "Lead uppercut",
  upper_rear: "Rear uppercut",
  body_lead_straight: "Lead straight to the body",
  body_rear_straight: "Rear straight to the body",
  body_lead_hook: "Lead hook or rising punch to the body",
  body_rear_hook: "Rear hook or rising punch to the body",
};
for (const slot of Object.keys(NAMES)) {
  const list = bySlot[slot] ?? [];
  if (!list.length) {
    lines.push(`| ${NAMES[slot]} | 0 | | | | | |`);
    continue;
  }
  const mid = (get) => ms(median(list.map(get)));
  lines.push(`| ${NAMES[slot]} | ${list.length} | ${mid((p) => p.launch - p.first)} | ${mid((p) => p.launch - p.seen)} | ${mid((p) => p.contact - p.launch)} | ${mid((p) => p.guard - p.contact)} | ${median(list.map((p) => p.peakSpeed)).toFixed(1)} |`);
}
lines.push("");
lines.push("## Single punches kept");
lines.push("");
lines.push("| Clip | Trial | Frames (120/s) | At, s | Mirrored | How cut | First movement to launch | Stands out to launch | Launch to contact | Contact to home | First movement to contact | Fist speed, m/s | Arm at contact |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of report.singles) {
  const t = s.mark.times;
  lines.push(`| ${s.id} | ${s.trial} | ${s.cut.from}–${s.cut.to} | ${at(s.cut.from)}–${at(s.cut.to)} | ${s.cut.southpaw ? "yes" : "no"} | ${s.tier === 0 ? "alone" : s.tier === 1 ? "first of a combination" : "inside a combination"} | ${t.load} | ${t.seen} | ${t.strike} | ${t.home} | ${t.load + t.strike} | ${s.mark.speed} | ${Math.round(s.mark.stretch * 100)}% |`);
}
lines.push("");
lines.push("\"Arm at contact\" is wrist-to-shoulder distance as a share of the whole arm: about 95% is a straight arm, about 70% an elbow at a right angle. **The hooks and uppercuts in these recordings are mostly long swings**: the hand drops or goes wide first (that is the long first-movement time) and the arm is nearly straight when it lands. There is no short hook or uppercut thrown from the guard with the elbow at a right angle; the takes with the most bend were preferred.");
lines.push("");
lines.push("A take cut from a combination ends as the next punch's fist leaves; its contact-to-home time is still the one measured in the recording, where the hand did come home while the next punch was thrown. In the game its other arm is taken from the guard loop.");
lines.push("");
lines.push("## Combinations kept as single takes");
lines.push("");
lines.push("| Clip | Trial | Frames (120/s) | At, s | Mirrored | Thrown this often | Contact to contact, ms | Each punch: first movement to launch / launch to contact / contact to home |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const c of report.combos)
  lines.push(`| ${c.id} | ${c.trial} | ${c.cut.from}–${c.cut.to} | ${at(c.cut.from)}–${at(c.cut.to)} | ${c.cut.southpaw ? "yes" : "no"} | ${c.thrown} | ${c.gaps.join(", ")} | ${c.cut.marks.map((m) => `${m.slot} ${m.times.load}/${m.times.strike}/${m.times.home}`).join("; ")} |`);
lines.push("");
lines.push("Every combination found, by how often:");
lines.push("");
for (const [name, takes] of Object.entries(patterns).sort((a, b) => b[1].length - a[1].length))
  lines.push(`- ${takes.length} × ${name}: contact to contact ${takes.map((run) => run.slice(1).map((p, i) => ms(p.contact - run[i].contact)).join("/")).join(", ")} ms`);
lines.push("");
lines.push("## Guard loops kept");
lines.push("");
lines.push("| Clip | Trial | Frames (120/s) | At, s | Seconds | Mirrored | Hips rise and fall, m | Join mismatch |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const l of report.loops) lines.push(`| ${l.id} | ${l.trial} | ${l.from}–${l.to} | ${at(l.from)}–${at(l.to)} | ${l.seconds.toFixed(2)} | ${l.stance < 0 ? "yes" : "no"} | ${l.bounce.toFixed(2)} | ${l.cost.toFixed(2)} |`);
lines.push("");
lines.push(`The brief asked for loops of 4 to 6 seconds. **The recordings do not hold one**: these boxers punch every second or two, and the longest stretch of guard with no punch, both hands up and one stance is ${report.longestQuiet.toFixed(1)} s. ${report.loopsFound} stretches of a second and a half or more were found; the ${report.loops.length} kept are those whose last frame is most like their first, longer ones preferred. ${report.ducking} more were left out because the boxer ducks or weaves in them (hips dropping over 0.2 m), which the rules do not know about. The game plays the kept ones one after another in a changing order, with a blend at each join, so the whole does not repeat for several seconds.`);
lines.push("");
lines.push("## Steps kept");
lines.push("");
lines.push("| Clip | Trial | Frames (120/s) | At, s | Seconds | Metres (game size) | Mirrored |");
lines.push("|---|---|---|---|---|---|---|");
for (const s of report.steps) lines.push(`| ${s.id} | ${s.trial} | ${s.from}–${s.to} | ${at(s.from)}–${at(s.to)} | ${s.seconds.toFixed(2)} | ${s.far.toFixed(2)} | ${s.stance < 0 ? "yes" : "no"} |`);
lines.push("");
lines.push(`${report.stepsFound} steps with no punch in them were found; kept are those that leave the stance as it was and turn least.`);
lines.push("");
lines.push("## The times the rules read (mean of the kept single takes), seconds");
lines.push("");
lines.push("| Kind | Takes | First movement to commit | Commit to contact | Contact to home | First movement to contact |");
lines.push("|---|---|---|---|---|---|");
for (const kind of KINDS) {
  const t = kindTimes[kind];
  lines.push(`| ${kind} | ${t.takes} | ${t.load} | ${t.strike} | ${t.home} | ${(t.load + t.strike).toFixed(3)} |`);
}
lines.push("");
lines.push("## What is missing or thin");
lines.push("");
for (const m of report.missing) lines.push(`- ${m}`);
lines.push("- Nobody is hit, covers up, staggers or falls in these recordings: there are no clips for those. The fall stays the formula one.");
lines.push("- No guard loop of 4 to 6 seconds (see above).");
lines.push("- Hands are the noisiest part of this database; glove direction is not recorded, only where the wrist is.");
lines.push("- The fists peak at 4 to 9 m/s relative to the chest: shadow boxing at a working pace, not a fighter's fastest.");
lines.push("");
mkdirSync(dirname(OUT.evidence), { recursive: true });
writeFileSync(OUT.evidence, lines.join("\n"));

// ── 10. Say what happened ───────────────────────────────────────────────────
const seconds = clips.reduce((a, c) => a + c.frames / (RATE / 2), 0);
say(`\n${everyPunch.length} punches found; ${clips.length} clips kept, ${seconds.toFixed(1)} s, pack ${(packText.length / 1024).toFixed(0)} KB`);
for (const s of report.singles) say(`  ${s.id.padEnd(22)} ${s.trial} ${at(s.cut.from)}–${at(s.cut.to)}s ${s.cut.southpaw ? "mirrored" : "        "} tier ${s.tier} cost ${s.cost.toFixed(1)}  load ${s.mark.times.load} (seen ${s.mark.times.seen}) strike ${s.mark.times.strike} home ${s.mark.times.home}  contact ${s.mark.contact.hand.join(",")} other ${s.cut.other}`);
for (const c of report.combos) say(`  ${c.id.padEnd(30)} ${c.trial} ${at(c.cut.from)}–${at(c.cut.to)}s gaps ${c.gaps.join("/")} (thrown ${c.thrown}×)`);
for (const l of report.loops) say(`  ${l.id.padEnd(22)} ${l.trial} ${at(l.from)}–${at(l.to)}s ${l.seconds.toFixed(2)} s join ${l.cost.toFixed(2)} bounce ${l.bounce.toFixed(2)}`);
for (const s of report.steps) say(`  ${s.id.padEnd(22)} ${s.trial} ${at(s.from)}–${at(s.to)}s ${s.far.toFixed(2)} m in ${s.seconds.toFixed(2)} s`);
for (const m of report.missing) say(`  missing: ${m}`);
