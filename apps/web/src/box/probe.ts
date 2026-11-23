import { JOINT } from "../pov/body";
import type { ArmSource } from "./punch";

/**
 * What this camera, this room and this person really give the game. Every
 * number the boxing rests on was made with a scripted person; these are the
 * ones only a real camera can supply: how much the wrists and elbows jitter
 * while standing still, how many poses a second arrive and how old they are,
 * whether straight punches are read, and how long the picture takes to get
 * from the screen back into the camera.
 *
 * Pure: fed poses and brightness readings, it does the arithmetic.
 */
export interface StillSummary {
  seconds: number;
  /** Poses a second that arrived. */
  rate: number;
  /** Share of poses in which the body was followed, and each hand was seen: [left, right]. */
  followed: number;
  seen: [number, number];
  /** Jitter across the picture of each wrist and elbow against its own shoulder, centimetres: [left, right]. */
  wristCm: [number, number];
  elbowCm: [number, number];
  /** Jitter of the wrist's depth as the model reports it, centimetres. */
  depthCm: [number, number];
  /** Times a minute the two wrists changed sides for a pose. */
  swapsPerMinute: number;
}

const quarter = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
};
/**
 * Jitter of a value that should be still, from its second differences: blind
 * to a steady drift, and taken from the smallest quarter so that a real twitch
 * or a breath does not count as noise.
 */
export function jitterOf(values: number[]): number {
  if (values.length < 12) return 0;
  const squares: number[] = [];
  for (let i = 2; i < values.length; i++) {
    const second = values[i] - 2 * values[i - 1] + values[i - 2];
    squares.push(second * second);
  }
  return Math.sqrt(quarter(squares) / 0.1015 / 6);
}

/** Watches a player who is standing still in their guard. */
export function createStillMeter() {
  const track = () => ({ x: [] as number[], y: [] as number[] });
  const wrist = [track(), track()],
    elbow = [track(), track()],
    depth: number[][] = [[], []];
  let poses = 0,
    followed = 0,
    swaps = 0,
    firstT = -1,
    lastT = -1,
    lastOrder = 0;
  const seen = [0, 0];
  return {
    /** Call once for each new pose. `valid` is the tracker's own verdict on the body. */
    pose(source: ArmSource, t: number, valid: boolean) {
      if (firstT < 0) firstT = t;
      if (t <= lastT) return;
      lastT = t;
      poses++;
      const { joints, jointWeights: weights } = source;
      if (!valid || !joints || !weights) return;
      followed++;
      for (let i = 0; i < 2; i++) {
        const ok =
          weights[JOINT.L_WRIST + i] >= 0.6 &&
          weights[JOINT.L_ELBOW + i] >= 0.6 &&
          weights[JOINT.L_SHOULDER + i] >= 0.6 &&
          (i === 0 ? source.leftHandTracked : source.rightHandTracked) !== false;
        if (!ok) continue;
        seen[i]++;
        const s = joints[JOINT.L_SHOULDER + i],
          e = joints[JOINT.L_ELBOW + i],
          w = joints[JOINT.L_WRIST + i];
        wrist[i].x.push(w.x - s.x);
        wrist[i].y.push(w.y - s.y);
        elbow[i].x.push(e.x - s.x);
        elbow[i].y.push(e.y - s.y);
        depth[i].push((i === 0 ? source.leftHand : source.rightHand).z - s.z);
      }
      // In a guard the player's left wrist is on their left. A pose with them the other way round is the model's mistake.
      const order = Math.sign(joints[JOINT.R_WRIST].x - joints[JOINT.L_WRIST].x);
      if (order !== 0 && lastOrder !== 0 && order !== lastOrder) swaps++;
      if (order !== 0) lastOrder = order;
    },
    summary(): StillSummary {
      const seconds = Math.max(0.001, (lastT - firstT) / 1000);
      const cm = (t: { x: number[]; y: number[] }) => 100 * Math.hypot(jitterOf(t.x), jitterOf(t.y));
      return {
        seconds,
        rate: poses > 1 ? (poses - 1) / seconds : 0,
        followed: poses ? followed / poses : 0,
        seen: [poses ? seen[0] / poses : 0, poses ? seen[1] / poses : 0],
        wristCm: [cm(wrist[0]), cm(wrist[1])],
        elbowCm: [cm(elbow[0]), cm(elbow[1])],
        depthCm: [100 * jitterOf(depth[0]), 100 * jitterOf(depth[1])],
        // Each mistake is two changes of side: there and back.
        swapsPerMinute: (swaps / 2 / seconds) * 60,
      };
    },
  };
}

/**
 * How long the picture takes to go from the screen, through the room, into the
 * camera and back to the page. The screen is flashed white for a moment, many
 * times, and the flash is looked for in the camera's own picture. That time is
 * the display's delay plus the camera's: the part of the game's delay that no
 * code can remove, only allow for.
 */
export function createFlashProbe() {
  const flashes: number[] = [];
  const light: { t: number; v: number }[] = [];
  return {
    /** The screen went white at `t`, ms. */
    flash(t: number) {
      flashes.push(t);
    },
    /** The camera's picture had this mean brightness (0–255) at `t`, ms. */
    brightness(t: number, v: number) {
      if (Number.isFinite(v)) light.push({ t, v });
    },
    result(): { ms: number | null; found: number; flashes: number; spreadMs: number } {
      const delays: number[] = [];
      for (const at of flashes) {
        const before = light.filter((p) => p.t > at - 250 && p.t <= at).map((p) => p.v);
        if (before.length < 3) continue;
        const sorted = [...before].sort((a, b) => a - b);
        const middle = sorted[sorted.length >> 1];
        const wobble = Math.max(...before.map((v) => Math.abs(v - middle)));
        // A step clearly above anything the picture was doing by itself.
        const need = middle + Math.max(2.5, 3 * wobble);
        const hit = light.find((p) => p.t > at && p.t <= at + 450 && p.v >= need);
        if (hit) delays.push(hit.t - at);
      }
      if (delays.length < 3) return { ms: null, found: delays.length, flashes: flashes.length, spreadMs: 0 };
      const sorted = [...delays].sort((a, b) => a - b);
      return {
        ms: sorted[sorted.length >> 1],
        found: delays.length,
        flashes: flashes.length,
        spreadMs: sorted[Math.floor((sorted.length - 1) * 0.75)] - sorted[Math.floor((sorted.length - 1) * 0.25)],
      };
    },
  };
}

/** Everything one run of the camera check found. Saved as a file and kept on the device. */
export interface ProbeReport {
  at: string;
  /** What the camera said it gave: size, pictures a second, exposure when it tells. */
  camera: string;
  screen: string;
  /** How old a pose is when the game uses it, ms: typical and worst. */
  poseAgeMs: { middle: number; worst: number };
  guard: StillSummary;
  tight: StillSummary;
  /** Straight punches asked for on a beep, and how many the reader confirmed, with what it called them. */
  punches: { asked: number; read: number; called: string[] };
  /**
   * Punches the reader called while the player only stood in the guard (both
   * guard steps together), and for how many seconds. Should be none: restless
   * hands seen from a camera below are the reader's known weakness.
   */
  invented?: { punches: number; seconds: number };
  /** The screen-to-camera delay, ms; null when the room was too bright for the flash to show. */
  flash: { ms: number | null; found: number; flashes: number; spreadMs: number };
  /** The sound's own delay as the browser reports it, ms; null when it does not say. */
  soundMs: number | null;
}

/** The report as a few plain lines for the screen. */
export function describeProbe(r: ProbeReport): string[] {
  const one = (v: number, d = 1) => v.toFixed(d);
  const both = (v: [number, number], d = 1) => `${one(v[0], d)} left, ${one(v[1], d)} right`;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const worstWrist = Math.max(...r.guard.wristCm);
  return [
    `Camera: ${r.camera}. Poses: ${one(r.guard.rate, 0)} a second, ${one(r.poseAgeMs.middle, 0)} ms old (worst ${one(r.poseAgeMs.worst, 0)}).`,
    `Standing in guard: wrists jitter ${both(r.guard.wristCm)} cm, elbows ${both(r.guard.elbowCm)} cm, depth ${both(r.guard.depthCm, 0)} cm. Hands seen ${pct(Math.min(...r.guard.seen))} of the time. Wrists swapped ${one(r.guard.swapsPerMinute, 0)} times a minute.`,
    `Tight guard: wrists jitter ${both(r.tight.wristCm)} cm. Hands seen ${pct(Math.min(...r.tight.seen))} of the time.`,
    `Straight punches: ${r.punches.read} of ${r.punches.asked} read${r.punches.called.length ? ` (${r.punches.called.join(", ")})` : ""}.`,
    ...(r.invented
      ? [
          r.invented.punches === 0
            ? `Standing in guard for ${one(r.invented.seconds, 0)} s: no punch was invented.`
            : `Standing in guard for ${one(r.invented.seconds, 0)} s: ${r.invented.punches} punches were read that you did not throw. This is the number to send back.`,
        ]
      : []),
    r.flash.ms === null
      ? `Screen to camera: the flash did not show (${r.flash.found} of ${r.flash.flashes}); try a darker room.`
      : `Screen to camera: ${one(r.flash.ms, 0)} ms (${r.flash.found} of ${r.flash.flashes} flashes, spread ${one(r.flash.spreadMs, 0)} ms).`,
    r.soundMs === null ? "Sound delay: not reported by this browser." : `Sound delay: ${one(r.soundMs, 0)} ms${r.soundMs > 80 ? " (wireless? a cable or the speakers will be tighter)" : ""}.`,
    worstWrist <= 0.7
      ? "Reading: clean. The punch reader works at its plain numbers here."
      : worstWrist <= 1.3
        ? "Reading: some jitter. Punches will be called a little later than on a clean camera."
        : "Reading: heavy jitter. More light, or a step closer, should help before anything else.",
  ];
}
