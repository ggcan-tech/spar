import type { Landmark, PoseFrame } from "@spar/protocol";

/**
 * A rolling record of what the camera's pose model reported and what the game
 * made of it, kept in memory and saved to a file on request.
 *
 * Why: the game can only be judged on a real camera, and a player describing
 * what went wrong ("it stuck on hold still") does not say why. With the last
 * minute saved, the same frames can be played back through the tracker and
 * the throw detector offline, and the answer read off.
 *
 * What is in it: body landmark positions and visibilities, and short notes of
 * the game's state when it changes. No picture or video of the player.
 */
/** 2: all 33 world landmarks are kept (1 kept ten). Both are read. */
export const SESSION_VERSION = 2;
/** World landmarks the tracker reads: shoulders, elbows, wrists, hips, knees. */
const WORLD_KEPT = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

export interface RecordedFrame {
  /** The frame's own timestamp, ms. */
  t: number;
  /** When it reached the game, ms. */
  at: number;
  /** Camera capture time when the browser reported one. */
  c?: number;
  /** The even clock for this frame (PoseFrame.motionT), when the source gave one. */
  m?: number;
  /** Image height over width. */
  a: number;
  /** 33 landmarks × (x, y, z, visibility). */
  lm: number[];
  /** Version 2: all 33 world landmarks × (x, y, z, visibility); version 1: WORLD_KEPT only; or empty. */
  w: number[];
}
export interface RecordedNote {
  at: number;
  [key: string]: string | number | boolean | null;
}
export interface RecordedSession {
  version: number;
  savedAt: string;
  meta: Record<string, string | number | boolean | null>;
  frames: RecordedFrame[];
  notes: RecordedNote[];
}

const round = (v: number, places: number) => {
  const k = 10 ** places;
  return Number.isFinite(v) ? Math.round(v * k) / k : 0;
};
const pack = (points: readonly (Landmark | undefined)[]) =>
  points.flatMap((p) =>
    p
      ? [round(p.x, 4), round(p.y, 4), round(p.z, 4), round(p.v, 2)]
      : [0, 0, 0, 0],
  );

export function createSessionLog(keepMs = 60_000) {
  let frames: RecordedFrame[] = [];
  let notes: RecordedNote[] = [];
  let lastNote = "";
  const meta: RecordedSession["meta"] = {};
  const trim = (now: number) => {
    const from = now - keepMs;
    let drop = 0;
    while (drop < frames.length && frames[drop].at < from) drop++;
    if (drop) frames = frames.slice(drop);
    drop = 0;
    // Keep the last note before the window, so the state at its start is known.
    while (drop + 1 < notes.length && notes[drop + 1].at < from) drop++;
    if (drop) notes = notes.slice(drop);
  };
  return {
    /** Facts about the device and settings, saved with the session. */
    describe(facts: RecordedSession["meta"]) {
      Object.assign(meta, facts);
    },
    frame(frame: PoseFrame, arrivedMs: number) {
      if (!Array.isArray(frame.lm) || frame.lm.length < 33) return;
      frames.push({
        t: round(frame.t, 1),
        at: round(arrivedMs, 1),
        ...(typeof frame.capturedAt === "number"
          ? { c: round(frame.capturedAt, 1) }
          : {}),
        ...(typeof frame.motionT === "number"
          ? { m: round(frame.motionT, 2) }
          : {}),
        a: round(frame.imageAspect ?? 0, 4),
        lm: pack(frame.lm.slice(0, 33)),
        w:
          Array.isArray(frame.world) && frame.world.length >= 33
            ? pack(frame.world.slice(0, 33))
            : [],
      });
      trim(arrivedMs);
    },
    /** The game's state; recorded only when something in it changes. */
    note(now: number, facts: Omit<RecordedNote, "at">) {
      const key = JSON.stringify(facts);
      if (key === lastNote) return;
      lastNote = key;
      notes.push({ at: round(now, 1), ...facts } as RecordedNote);
      trim(now);
    },
    size: () => ({ frames: frames.length, notes: notes.length }),
    save(): RecordedSession {
      return {
        version: SESSION_VERSION,
        savedAt: new Date().toISOString(),
        meta: { ...meta },
        frames: frames.map((f) => ({ ...f })),
        notes: notes.map((n) => ({ ...n })),
      };
    },
    clear() {
      frames = [];
      notes = [];
      lastNote = "";
    },
  };
}

/** A recorded frame as the pose model delivered it, for playing back. */
export function playbackFrame(recorded: RecordedFrame): PoseFrame {
  const unpack = (values: number[], i: number): Landmark => ({
    x: values[i * 4],
    y: values[i * 4 + 1],
    z: values[i * 4 + 2],
    v: values[i * 4 + 3],
  });
  const lm = Array.from({ length: 33 }, (_, i) => unpack(recorded.lm, i));
  // Landmarks that were not kept are marked unseen, which is how the tracker
  // treats a world landmark it cannot use.
  const world: Landmark[] = recorded.w.length
    ? Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, v: 0 }))
    : [];
  if (recorded.w.length === 132) for (let i = 0; i < 33; i++) world[i] = unpack(recorded.w, i);
  else if (recorded.w.length)
    WORLD_KEPT.forEach((index, i) => {
      world[index] = unpack(recorded.w, i);
    });
  return {
    t: recorded.t,
    lm,
    world,
    imageAspect: recorded.a,
    ...(recorded.c !== undefined ? { capturedAt: recorded.c } : {}),
    ...(recorded.m !== undefined ? { motionT: recorded.m } : {}),
  };
}

/** Reads a saved session, refusing anything that is not one. */
export function parseSession(text: string): RecordedSession {
  const data = JSON.parse(text) as Partial<RecordedSession>;
  if (
    !data ||
    (data.version !== 1 && data.version !== SESSION_VERSION) ||
    !Array.isArray(data.frames) ||
    !Array.isArray(data.notes) ||
    data.frames.some(
      (f) =>
        !f ||
        !Number.isFinite(f.t) ||
        !Number.isFinite(f.at) ||
        !Array.isArray(f.lm) ||
        f.lm.length !== 132 ||
        !Array.isArray(f.w),
    )
  )
    throw new Error("Not a saved tracking session");
  return data as RecordedSession;
}
