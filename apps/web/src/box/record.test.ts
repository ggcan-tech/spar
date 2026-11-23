import { describe, expect, it } from "vitest";
import {
  EMPTY_RECORD,
  addSession,
  dayOf,
  loadRecord,
  nextUp,
  saveRecord,
  streakOn,
  type SessionEntry,
} from "./record";

const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
  day: "2026-11-13",
  at: 0,
  mode: "bout",
  level: "rookie",
  result: "win",
  grade: "A",
  rounds: 1,
  seconds: 50,
  thrown: 40,
  landed: 22,
  defended: 6,
  incoming: 9,
  counters: 3,
  bestCombo: 4,
  score: 0,
  ...over,
});

describe("the record kept between visits", () => {
  it("counts fights and wins, and who was beaten", () => {
    let r = addSession(EMPTY_RECORD, entry());
    r = addSession(r, entry({ result: "loss", level: "digger", bestCombo: 6 }));
    expect(r).toMatchObject({ fights: 2, wins: 1, bestCombo: 6, beaten: { rookie: 1 } });
    expect(r.sessions.length).toBe(2);
    // A drill is a session, not a fight.
    r = addSession(r, entry({ mode: "defence", result: "done", score: 11 }));
    r = addSession(r, entry({ mode: "pads", result: "done", score: 7 }));
    expect(r).toMatchObject({ fights: 2, wins: 1, bestDefence: 11, bestPads: 7 });
  });
  it("keeps a streak of days, and loses it after a missed day", () => {
    let r = addSession(EMPTY_RECORD, entry({ day: "2026-11-13" }));
    expect(r.streak).toBe(1);
    r = addSession(r, entry({ day: "2026-11-13" }));
    expect(r.streak).toBe(1);
    r = addSession(r, entry({ day: "2026-11-14" }));
    expect(r.streak).toBe(2);
    // Over a month's end.
    r = addSession(addSession(EMPTY_RECORD, entry({ day: "2026-11-30" })), entry({ day: "2026-12-01" }));
    expect(r.streak).toBe(2);
    expect(streakOn(r, "2026-12-01")).toBe(2);
    expect(streakOn(r, "2026-12-02")).toBe(2);
    expect(streakOn(r, "2026-12-03")).toBe(0);
    r = addSession(r, entry({ day: "2026-12-05" }));
    expect(r.streak).toBe(1);
  });
  it("names the next opponent up the ladder after a win, until it too is beaten", () => {
    const r = addSession(EMPTY_RECORD, entry());
    expect(nextUp(r, "rookie")).toBe("digger");
    expect(nextUp(addSession(r, entry({ level: "digger" })), "rookie")).toBeNull();
    expect(nextUp(r, "champion")).toBeNull();
  });
  it("keeps the last forty sessions and survives a store that is missing or holds rubbish", () => {
    let r = EMPTY_RECORD;
    for (let i = 0; i < 50; i++) r = addSession(r, entry({ at: i }));
    expect(r.sessions.length).toBe(40);
    expect(r.sessions[0].at).toBe(10);
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    saveRecord(r, store);
    expect(loadRecord(store)).toEqual(r);
    kept.set("box.record", "{not json");
    expect(loadRecord(store)).toEqual(EMPTY_RECORD);
    kept.set("box.record", JSON.stringify({ fights: "many" }));
    expect(loadRecord(store)).toEqual(EMPTY_RECORD);
    expect(loadRecord(null)).toEqual(EMPTY_RECORD);
  });
  it("names a day by the local calendar", () => {
    expect(dayOf(new Date(2026, 10, 3, 23, 59))).toBe("2026-11-03");
  });
});
