import { describe, expect, it } from "vitest";
import { CONTACT, type ContactEvent } from "./contact";
import { CAMS, cam, f0, mean, runContact, throwsOf, type Noise, type Thrown } from "./rig";

/**
 * The delay budget (the perception study's findings 2 and 3), kept as tests.
 * The scripted person throws punches of a known length; the script's own end
 * of each is the "real full stretch". A pose reaches the game `delay` ms after
 * the camera took it. Measured on a scripted person; a camera will differ.
 */
const NOISE: Omit<Noise, "seed"> = { sigma: 0.005, depth: 0.03 };
type Timed = ContactEvent & { s: number };
const kind = <K extends ContactEvent["kind"]>(events: Timed[], k: K) => events.filter((e): e is Extract<Timed, { kind: K }> => e.kind === k);
/** Punches one after another, hands taking turns, each at a slightly different moment against the camera's frames. */
function series(count: number, shape: Thrown["shape"], extend: number, every = 0.9, hands: ("left" | "right")[] = ["left", "right"]): Thrown[] {
  const list: Thrown[] = [];
  for (let i = 0; i < count; i++) list.push({ at: 0.3 + i * every + i * 0.0073, hand: hands[i % hands.length], shape, style: { extend, hold: 0.05 } });
  return list;
}
/** The punch a moment belongs to: the last one that began before it. */
const punchAt = (list: Thrown[], s: number) => {
  let best = -1;
  for (let i = 0; i < list.length; i++) if (list[i].at <= s + 0.02) best = i;
  return best;
};
interface Timing {
  /** When the game could show the contact, against the script's end, ms, for each delay. */
  shown: Record<number, number[]>;
  /** The scheduled time itself, and the corrected one, against the script's end. */
  scheduled: number[];
  corrected: number[];
  /** The reader's start, ms into the punch. */
  startedAt: number[];
  toGo: number;
  confirmed: number;
  cancelled: number;
  thrown: number;
}
function timing(shape: Thrown["shape"], extend: number, fps: number, delays: number[], learn = 4): Timing {
  const list = series(16, shape, extend);
  const run = runContact(throwsOf(list), 0.3 + 16 * 0.92 + 0.4, { fps, cam: cam(1.0, 2.6, 1.0), noise: { seed: 9, ...NOISE } });
  const t: Timing = { shown: {}, scheduled: [], corrected: [], startedAt: [], toGo: 0, confirmed: 0, cancelled: 0, thrown: list.length - learn };
  for (const d of delays) t.shown[d] = [];
  const confirmed = new Set(kind(run.events, "confirm").map((e) => e.id));
  for (const e of run.events) {
    const i = punchAt(list, e.s);
    if (i < learn || e.kind === "home") continue;
    if (e.kind === "cancel") {
      t.cancelled++;
      continue;
    }
    if (e.hand !== list[i].hand) continue;
    // The script's own end of this punch, on the same clock as the event.
    const end = e.t + (list[i].at + extend - e.s) * 1000;
    if (e.kind === "start" && confirmed.has(e.id)) {
      t.confirmed++;
      t.scheduled.push(e.at - end);
      t.startedAt.push((e.s - list[i].at) * 1000);
      // Known when the pose arrives; shown then, or at the scheduled time if that is still to come.
      for (const d of delays) t.shown[d].push(Math.max(e.at, e.t + d) - end);
    }
    if (e.kind === "end") t.corrected.push(e.at - end);
  }
  t.toGo = run.contact.learned().toGo.left[shape];
  return t;
}
const late = (v: number[]) => `${f0(mean(v))} ms (${f0(Math.min(...v))} to ${f0(Math.max(...v))})`;

describe("the player's punch, with its contact scheduled ahead", () => {
  it("shows a straight's contact within 45 ms of real full stretch at 30 poses a second and within 20 ms at 60 (the study's budget)", () => {
    const rows: string[] = [];
    const at30 = timing("straight", 0.2, 30, [90, 110]),
      at60 = timing("straight", 0.2, 60, [90, 110]);
    for (const [fps, t] of [
      [30, at30],
      [60, at60],
    ] as const)
      rows.push(
        `${fps} poses a second, 200 ms straight: read ${t.confirmed} of ${t.thrown}; the reader starts it ${f0(mean(t.startedAt))} ms in; learned ${f0(t.toGo)} ms to go; scheduled ${late(t.scheduled)} from the script's end; shown with 90 ms of delay ${late(t.shown[90])}, with 110 ms ${late(t.shown[110])}; corrected when the end was seen to ${late(t.corrected)}`,
      );
    console.log("contact, scripted straights (+ is late)\n" + rows.join("\n"));
    for (const t of [at30, at60]) {
      expect(t.confirmed).toBe(t.thrown);
      expect(t.cancelled).toBe(0);
      // The schedule itself: this player's own middle, right to about a pose.
      expect(Math.abs(mean(t.scheduled))).toBeLessThan(25);
    }
    // The study: about 40 ms late at 30 poses a second with the screen's delay counted, within 45 here without it.
    expect(Math.abs(mean(at30.shown[90]))).toBeLessThan(45);
    expect(Math.abs(mean(at30.shown[110]))).toBeLessThan(45);
    // The study's own check: a 90 ms delay at 60 poses a second, within 20 ms.
    expect(Math.abs(mean(at60.shown[90]))).toBeLessThan(20);
    // With 110 ms the start is simply known 20 ms later. The study's 20 ms is not reached there:
    // the reader starts a 200 ms straight 110 ms in, so the game knows of it at 220 ms. Held to 40.
    expect(Math.abs(mean(at60.shown[110]))).toBeLessThan(40);
    expect(mean(at60.shown[110])).toBeGreaterThan(mean(at60.shown[90]));
    // Seeing the real end puts the time right, to about a pose.
    expect(Math.abs(mean(at30.corrected))).toBeLessThan(25);
    expect(Math.abs(mean(at60.corrected))).toBeLessThan(25);
  });

  it("is on time for a hook that takes 300 ms, and says how late a 200 ms hook is with the reader as it stands", () => {
    const rows: string[] = [];
    const slow30 = timing("hook", 0.3, 30, [90, 110]),
      slow60 = timing("hook", 0.3, 60, [90, 110]),
      fast30 = timing("hook", 0.2, 30, [90, 110]),
      fast60 = timing("hook", 0.2, 60, [90, 110]),
      upper = timing("uppercut", 0.25, 60, [90, 110]);
    for (const [name, t] of [
      ["30 poses a second, 300 ms hook", slow30],
      ["60 poses a second, 300 ms hook", slow60],
      ["30 poses a second, 200 ms hook", fast30],
      ["60 poses a second, 200 ms hook", fast60],
      ["60 poses a second, 250 ms uppercut", upper],
    ] as const)
      rows.push(
        `${name}: read ${t.confirmed} of ${t.thrown}; the reader starts it ${f0(mean(t.startedAt))} ms in; learned ${f0(t.toGo)} ms to go; shown with 90 ms of delay ${late(t.shown[90])}, with 110 ms ${late(t.shown[110])}; corrected to ${late(t.corrected)}`,
      );
    console.log("contact, scripted hooks and an uppercut (+ is late)\n" + rows.join("\n"));
    // A hook of 300 ms: the reader starts it about 90 ms before its end, the delay is about that: on time.
    for (const t of [slow30, slow60]) {
      expect(t.confirmed).toBeGreaterThanOrEqual(t.thrown - 1);
      expect(Math.abs(mean(t.shown[90]))).toBeLessThan(35);
      expect(Math.abs(mean(t.shown[110]))).toBeLessThan(45);
    }
    // A hook of 200 ms is NOT on time, and this is the study's figure this module could not reach
    // by itself: the reader starts such a hook 140–160 ms in (it waits for the fist to come back
    // inside its rest), which leaves 40–60 ms, less than any web delay. It is shown as soon as it
    // is known. The bound says how late that is today; an earlier start in punch.ts will lower it.
    for (const t of [fast30, fast60]) {
      expect(mean(t.shown[90])).toBeLessThan(75);
      expect(mean(t.shown[110])).toBeLessThan(95);
      // Whatever the delay, the time it is judged at is the real one.
      expect(Math.abs(mean(t.corrected))).toBeLessThan(30);
    }
  });

  it("learns this player's own time from start to full stretch, for each shape", () => {
    const quick = runContact(throwsOf(series(8, "straight", 0.15)), 8, { noise: { seed: 2, ...NOISE } });
    const slow = runContact(throwsOf(series(8, "straight", 0.3)), 8, { noise: { seed: 2, ...NOISE } });
    const q = quick.contact.learned().toGo.left.straight,
      s = slow.contact.learned().toGo.left.straight;
    console.log(
      `contact, time to go as learned: 150 ms straights ${f0(q)} ms, 300 ms straights ${f0(s)} ms; before any punch ${CONTACT.toGo.straight} / hook ${CONTACT.toGo.hook} / uppercut ${CONTACT.toGo.uppercut} ms`,
    );
    expect(q).toBeGreaterThan(35);
    expect(q).toBeLessThan(85);
    expect(s).toBeGreaterThan(q + 25);
    expect(s).toBeLessThan(170);
    // A hand that has thrown nothing borrows the other's; a shape nobody has thrown keeps the starting value.
    expect(quick.contact.learned().toGo.left.hook).toBe(CONTACT.toGo.hook);
    const oneHand = runContact(throwsOf(series(6, "straight", 0.15, 0.9, ["left"])), 6, { noise: { seed: 2, ...NOISE } });
    expect(oneHand.contact.learned().toGo.right.straight).toBe(oneHand.contact.learned().toGo.left.straight);
    // The first punch of all is scheduled by the starting value.
    const first = kind(quick.events, "start")[0];
    expect(first.at - first.t).toBeCloseTo(CONTACT.toGo.straight, 6);
  });

  it("tells the story of a punch in order: start, confirm, end, home", () => {
    const list = series(6, "straight", 0.2);
    const run = runContact(throwsOf(list), 6, { noise: { seed: 5, ...NOISE } });
    const starts = kind(run.events, "start");
    expect(starts.length).toBe(6);
    for (const start of starts) {
      const mine = run.events.filter((e) => e.id === start.id);
      expect(mine.map((e) => e.kind)).toEqual(["start", "confirm", "end", "home"]);
      const [, confirm, end, home] = mine;
      // Confirmed a pose or two after the start; the end seen later still; the hand home in about a fifth of a second.
      expect(confirm.t - start.t).toBeGreaterThan(20);
      expect(confirm.t - start.t).toBeLessThan(80);
      expect(end.t).toBeGreaterThan(confirm.t);
      if (home.kind === "home") {
        expect(home.backMs).not.toBeNull();
        expect(home.backMs!).toBeGreaterThan(80);
        expect(home.backMs!).toBeLessThan(400);
      }
      if (end.kind === "end" && start.kind === "start") {
        // The corrected time is within the punch, not at the pose that noticed it.
        expect(end.at).toBeLessThan(end.t);
        expect(Math.abs(end.at - start.at)).toBeLessThan(90);
        expect(end.short).toBe(false);
      }
    }
    // Nothing is in the air at the end.
    expect(run.contact.flying()).toEqual([false, false]);
  });

  it("cancels a start that is never confirmed, and calls it a feint when a real hand went out alone", () => {
    const list = series(3, "straight", 0.2, 0.9, ["left"]);
    /** The reader's confirmations are withheld from the third punch on: its hand is let go one pose after the start. */
    const unconfirmed = (o: { jitter?: [number, number]; both?: boolean; busy?: boolean }) => {
      let started = -1;
      return runContact(throwsOf(list), 3.2, {
        noise: { seed: 5, ...NOISE },
        tamper: (input, p) => {
          if (p.s < list[2].at - 0.05) return input;
          if (input.starts.some((s) => s.hand === "left") && started < 0) started = p.t;
          const starts = o.both && started === p.t ? [...input.starts, { hand: "right" as const, shape: "straight" as const, target: "head" as const, t: p.t }] : input.starts;
          return { ...input, starts, punches: [], busy: o.busy === false ? undefined : [false, false], jitter: o.jitter ?? input.jitter };
        },
      });
    };
    const lone = unconfirmed({});
    const cancels = kind(lone.events, "cancel");
    expect(cancels.length).toBe(1);
    expect(cancels[0]).toMatchObject({ hand: "left", feint: true, why: "unconfirmed" });
    // Known one pose after the start: before the contact it had scheduled.
    const start = kind(lone.events, "start").find((e) => e.id === cancels[0].id)!;
    expect(cancels[0].t - start.t).toBeLessThan(40);
    expect(cancels[0].t).toBeLessThan(start.at);
    // No end and no home for a punch that never was.
    expect(lone.events.filter((e) => e.id === cancels[0].id).map((e) => e.kind)).toEqual(["start", "cancel"]);
    // Both hands starting together is the guard moving, not a feint.
    const together = kind(unconfirmed({ both: true }).events, "cancel");
    expect(together.length).toBe(2);
    expect(together.every((c) => !c.feint)).toBe(true);
    // A hand that jitters by centimetres starts on jitter: not a feint.
    expect(kind(unconfirmed({ jitter: [0.03, 0.03] }).events, "cancel")[0].feint).toBe(false);
    // Without the reader's `busy` the start is given up at the time limit instead.
    const slow = unconfirmed({ busy: false });
    const given = kind(slow.events, "cancel")[0];
    const begun = kind(slow.events, "start").find((e) => e.id === given.id)!;
    expect(given.t - begun.t).toBeGreaterThan(CONTACT.confirmWithinMs);
    expect(given.t - begun.t).toBeLessThan(CONTACT.confirmWithinMs + 70);
    // Starts that are not kept cost trust.
    expect(lone.contact.learned().confirmed).toBeCloseTo(2 / 3, 5);
  });

  it("cancels a punch in the air when the hand is lost: any pause cancels", () => {
    const list = series(3, "straight", 0.25, 0.9, ["left"]);
    let lostFrom = Infinity;
    const run = runContact(
      throwsOf(list),
      3.2,
      {
        noise: { seed: 5, ...NOISE },
        // From the pose after the third punch is confirmed, the model loses the left wrist for a third of a second.
        fault: (frame, s) => (s >= lostFrom && s < lostFrom + 0.33 ? { ...frame, lm: frame.lm.map((p, i) => (i === 15 || i === 13 ? { ...p, v: 0.05 } : p)) } : frame),
      },
      (p, events) => {
        if (events.some((e) => e.kind === "confirm") && p.s > list[2].at) lostFrom = Math.min(lostFrom, p.s + 1.6 + 0.01);
      },
    );
    const cancels = kind(run.events, "cancel");
    expect(cancels.length).toBe(1);
    expect(cancels[0]).toMatchObject({ hand: "left", why: "unseen", feint: false });
    // It had been confirmed: the game is told to take it back.
    const mine = run.events.filter((e) => e.id === cancels[0].id).map((e) => e.kind);
    expect(mine).toEqual(["start", "confirm", "cancel"]);
  });

  it("names the zone from real distances: a first reading at the start, the measured one at the end", () => {
    const rows: string[] = [];
    for (const [camName, c] of [CAMS[0], CAMS[1], CAMS[2], CAMS[5]]) {
      const list: Thrown[] = [];
      for (let i = 0; i < 16; i++)
        list.push({ at: 0.3 + i * 0.9 + i * 0.0073, hand: i % 2 ? "right" : "left", shape: "straight", style: { extend: 0.2, hold: 0.05, body: i % 4 >= 2 } });
      const run = runContact(throwsOf(list), 15.2, { cam: c, noise: { seed: 7, ...NOISE }, aim: true });
      let startRight = 0,
        starts = 0,
        endRight = 0,
        ends = 0;
      for (const e of run.events) {
        if (e.kind !== "start" && e.kind !== "end") continue;
        const want = list[punchAt(list, e.s)].style!.body ? "body" : "head";
        expect(e.point).not.toBeNull();
        if (e.kind === "start") {
          starts++;
          if (e.level === want) startRight++;
        } else {
          ends++;
          if (e.level === want) endRight++;
          // The scripted straight ends 5 cm to its own side of the body's middle: the middle third.
          expect(e.third).toBe("middle");
          // A straight thrown at full reach reads as nearly a whole arm.
          expect(e.reach).toBeGreaterThan(0.8);
        }
      }
      rows.push(`${camName}: head or body right at the start ${startRight} of ${starts}, at the end ${endRight} of ${ends}`);
      expect(ends).toBe(16);
      expect(endRight).toBe(16);
      // The first reading carries a half-thrown punch on to where it is going: mostly right, not always.
      expect(startRight / starts).toBeGreaterThanOrEqual(0.85);
    }
    console.log("contact, zones of scripted straights at head and body, 0.5 cm of noise\n" + rows.join("\n"));
  });

  it("puts a hook on its own side and an uppercut up the middle, and without a set-up uses the reader's own head or body", () => {
    const list: Thrown[] = [
      { at: 0.3, hand: "left", shape: "hook", style: { extend: 0.25 } },
      { at: 1.3, hand: "right", shape: "hook", style: { extend: 0.25, body: true } },
      { at: 2.3, hand: "right", shape: "uppercut", style: { extend: 0.25 } },
      { at: 3.3, hand: "left", shape: "straight", style: { extend: 0.2, body: true } },
    ];
    const withAim = kind(runContact(throwsOf(list), 4.4, { cam: CAMS[2][1], aim: true }).events, "end");
    expect(withAim.map((e) => `${e.hand} ${e.shape} ${e.level} ${e.third}`)).toEqual([
      "left hook head left",
      "right hook body right",
      "right uppercut head middle",
      "left straight body middle",
    ]);
    const without = kind(runContact(throwsOf(list), 4.4, { cam: CAMS[2][1] }).events, "end");
    expect(without.map((e) => `${e.hand} ${e.shape} ${e.level} ${e.third}`)).toEqual(withAim.map((e) => `${e.hand} ${e.shape} ${e.level} ${e.third}`));
    for (const e of without) expect(e.point).toBeNull();
    for (const e of without) expect(e.reach).toBeNull();
  });

  it("trusts a start without its confirmation only once this player's starts have kept their word", () => {
    const run = runContact(throwsOf(series(13, "straight", 0.2)), 12.6, { noise: { seed: 5, ...NOISE } });
    const starts = kind(run.events, "start");
    expect(starts.length).toBe(13);
    // Ten confirmed starts first.
    expect(starts.slice(0, 10).every((e) => !e.trusted)).toBe(true);
    expect(starts.slice(10).every((e) => e.trusted)).toBe(true);
    expect(run.contact.learned().confirmed).toBe(1);
    // A second punch from the same hand before the first is home closes the first as it stands.
    const double: Thrown[] = [
      { at: 0.3, hand: "left", shape: "straight", style: { extend: 0.18, hold: 0.02, back: 0.12 } },
      { at: 0.56, hand: "left", shape: "straight", style: { extend: 0.18, hold: 0.04 } },
    ];
    const two = runContact(throwsOf(double), 1.6, { noise: { seed: 5, ...NOISE } });
    const ids = [...new Set(two.events.map((e) => e.id))];
    for (const id of ids) {
      const kinds = two.events.filter((e) => e.id === id).map((e) => e.kind);
      // Every punch that was confirmed is ended and brought home exactly once.
      if (kinds.includes("confirm")) expect(kinds.filter((k) => k === "end").length).toBe(1);
      if (kinds.includes("confirm")) expect(kinds.filter((k) => k === "home").length).toBe(1);
    }
    expect(kind(two.events, "confirm").length).toBeGreaterThanOrEqual(1);
  });
});
