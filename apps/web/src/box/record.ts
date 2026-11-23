import { LADDER, type BoxLevel } from "./boxer";

/**
 * What is kept between visits: fights and wins, a streak of days, the best
 * numbers, who has been beaten, and the last sessions. Kept on the device
 * only. Pure functions plus a thin wrapper around the browser's storage, so
 * the arithmetic can be tested without one.
 */
export type SessionMode = "bout" | "defence" | "pads" | "session" | "real";
export interface SessionEntry {
  /** Local day, yyyy-mm-dd, and the moment it ended. */
  day: string;
  at: number;
  mode: SessionMode;
  /** The opponent's name: one of the first build's levels, or one of the real game's boxers. */
  level: string;
  result: "win" | "loss" | "draw" | "done";
  grade: string;
  rounds: number;
  seconds: number;
  thrown: number;
  landed: number;
  /** Punches at the player that were made to miss or blocked, of how many came. */
  defended: number;
  incoming: number;
  counters: number;
  bestCombo: number;
  /** A drill's own score: the longest run of clean defences, or combinations finished on the call. */
  score: number;
}
export interface BoxRecord {
  fights: number;
  wins: number;
  /** Days in a row with at least one finished session, and the last such day. */
  streak: number;
  lastDay: string | null;
  bestCombo: number;
  bestDefence: number;
  bestPads: number;
  /** Wins over each opponent, by name. */
  beaten: Partial<Record<string, number>>;
  sessions: SessionEntry[];
}
export const EMPTY_RECORD: BoxRecord = {
  fights: 0,
  wins: 0,
  streak: 0,
  lastDay: null,
  bestCombo: 0,
  bestDefence: 0,
  bestPads: 0,
  beaten: {},
  sessions: [],
};
const KEEP = 40;
const KEY = "box.record";

/** The local day of a date, yyyy-mm-dd. */
export function dayOf(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
/** The day before a yyyy-mm-dd day. Noon is used so that a clock change cannot skip or repeat a day. */
function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayOf(new Date(y, m - 1, d - 1, 12));
}

/** The record with one more finished session in it. */
export function addSession(record: BoxRecord, entry: SessionEntry): BoxRecord {
  const streak =
    record.lastDay === entry.day
      ? Math.max(1, record.streak)
      : record.lastDay === dayBefore(entry.day)
        ? record.streak + 1
        : 1;
  // A session the player ended early is kept, and is nobody's win or loss.
  const bout = (entry.mode === "bout" || entry.mode === "real") && entry.result !== "done";
  const won = bout && entry.result === "win";
  return {
    fights: record.fights + (bout ? 1 : 0),
    wins: record.wins + (won ? 1 : 0),
    streak,
    lastDay: entry.day,
    bestCombo: Math.max(record.bestCombo, entry.bestCombo),
    bestDefence: Math.max(record.bestDefence, entry.mode === "defence" ? entry.score : 0),
    bestPads: Math.max(record.bestPads, entry.mode === "pads" ? entry.score : 0),
    beaten: won
      ? { ...record.beaten, [entry.level]: (record.beaten[entry.level] ?? 0) + 1 }
      : record.beaten,
    sessions: [...record.sessions, entry].slice(-KEEP),
  };
}
/** The streak as it stands today: it is lost once a whole day has been missed. */
export function streakOn(record: BoxRecord, today: string): number {
  return record.lastDay === today || record.lastDay === dayBefore(today) ? record.streak : 0;
}
/** The next opponent up the ladder that has not been beaten, after a win over `level`; null at the top. */
export function nextUp(record: BoxRecord, level: BoxLevel): BoxLevel | null {
  const at = LADDER.indexOf(level);
  const next = LADDER[at + 1];
  return next && !(record.beaten[next] ?? 0) ? next : null;
}

function valid(value: unknown): value is BoxRecord {
  const r = value as BoxRecord | null;
  return (
    !!r &&
    typeof r === "object" &&
    Number.isFinite(r.fights) &&
    Number.isFinite(r.wins) &&
    Number.isFinite(r.streak) &&
    Array.isArray(r.sessions) &&
    typeof r.beaten === "object" &&
    r.beaten !== null
  );
}
type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
export function loadRecord(store: Store | null = browserStore()): BoxRecord {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    return valid(parsed) ? { ...EMPTY_RECORD, ...parsed } : EMPTY_RECORD;
  } catch {
    return EMPTY_RECORD;
  }
}
export function saveRecord(record: BoxRecord, store: Store | null = browserStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage is full or not allowed: the record lasts for this visit only.
  }
}

/** Monday of the week a day falls in, yyyy-mm-dd. */
function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  return dayOf(new Date(y, m - 1, d - ((date.getDay() + 6) % 7), 12));
}
/**
 * Days trained in the week `today` falls in. Three a week is the habit to
 * keep: rest days are training too, so a broken daily streak is never held
 * against anyone.
 */
export function daysThisWeek(record: BoxRecord, today: string): number {
  const week = weekOf(today);
  return new Set(record.sessions.filter((s) => weekOf(s.day) === week).map((s) => s.day)).size;
}
