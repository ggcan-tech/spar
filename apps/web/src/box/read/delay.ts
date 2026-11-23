import { createFlashProbe } from "../probe";
import type { LineDelay } from "./timeline";

/**
 * This device's own delay, measured by the game itself.
 *
 * The delay has parts no code can remove: the screen takes time to show a
 * picture, the camera takes time to hand one over, the model takes time to
 * find the body. The game can only know them and allow for them. Two numbers
 * come out: how far ahead to draw the opponent, and how early to start a
 * sound.
 *
 * How each part is known, best first:
 * - screen and camera together: the flash probe. The screen is flashed white
 *   in the count-in and the flash is looked for in the camera's own picture;
 * - the camera alone: the browser's capture time on each frame, when it
 *   reports one;
 * - the model: the time from a frame's stamp to its pose arriving;
 * - the sound: what the audio context reports.
 * Where a part is not known a typical value is used and `how` says so. The
 * typical values are from the perception study's table, not from this device.
 *
 * Nothing here has been checked against a real camera. The check is a 240
 * frames-a-second phone video of the screen and the player together.
 */
export interface DelayParts {
  /** The flash probe's result, or null when it was not run. */
  flash?: { ms: number | null; found: number; flashes: number; spreadMs: number } | null;
  /** The camera's own delay, ms: the middle of (the page's stamp less the reported capture time). Null when the browser does not report it. */
  cameraMs?: number | null;
  /** The middle time from a frame's stamp to its pose arriving, ms. */
  modelMs?: number | null;
  /** Poses a second that arrive. */
  poseFps?: number | null;
  /** The screen's frames a second. */
  screenHz?: number | null;
  /** The sound's delay as the audio context reports it, ms (output and base latency together). */
  soundMs?: number | null;
}
export const TYPICAL = {
  /** Camera to page: 30–70 ms at 30 frames a second, 20–45 ms at 60. */
  camera30: 50,
  camera60: 32,
  /** Bitmap, model and back. */
  model: 25,
  /** A drawn frame to light: 15–35 ms on a laptop. */
  screen: 25,
  /** Speakers and wired headphones. */
  sound: 20,
  /** Above this the sound is wireless and cannot be made tight. */
  wireless: 60,
  /** The flash is believed when this many showed and they agree this well. */
  flashFound: 4,
  flashSpread: 40,
  /** A whole delay beyond this is believed, but said to be unusual. */
  unusual: 300,
};
export interface DeviceDelay extends LineDelay {
  /** The camera's part, the model's, and the screen's, ms. */
  cameraMs: number;
  modelMs: number;
  screenMs: number;
  /** One pose's spacing, ms: added so that a reading falls between two poses. */
  poseMs: number;
  /** From the page drawing a picture to the player seeing it: the screen and half a drawn frame. */
  showMs: number;
  /** The whole measured delay: what the opponent is drawn ahead by. */
  leadMs: number;
  /** Start a sound this long before its moment on the line. */
  soundMs: number;
  /** The sound is wireless: tell the player a cable or the speakers will be tighter. */
  wireless: boolean;
  /** Where the screen-and-camera figure came from. */
  how: "flash" | "camera-reported" | "typical";
  /** Plain lines for the camera check: what was measured and what was assumed. */
  notes: string[];
}
const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Put the parts together. Every missing part falls back to a typical value, and says so. */
export function deviceDelay(parts: DelayParts = {}): DeviceDelay {
  const notes: string[] = [];
  const fps = usable(parts.poseFps) && parts.poseFps > 5 ? parts.poseFps : 30;
  const poseMs = 1000 / fps;
  const typicalCamera = fps >= 45 ? TYPICAL.camera60 : TYPICAL.camera30;
  const flash = parts.flash;
  // The flash is found on the first camera frame that shows it. A camera that
  // exposes for a whole frame shows it at once; one that exposes briefly, up
  // to a frame late, half a frame in the middle. A quarter of a frame is
  // taken off: right to within a quarter of a frame either way.
  const flashMs =
    flash && usable(flash.ms) && flash.found >= TYPICAL.flashFound && flash.spreadMs <= TYPICAL.flashSpread
      ? Math.max(10, flash.ms - poseMs / 4)
      : null;
  let cameraMs: number, screenMs: number;
  let how: DeviceDelay["how"];
  if (flashMs !== null) {
    how = "flash";
    if (usable(parts.cameraMs)) {
      // Both known: the flash is screen plus camera, so the screen is what is left.
      cameraMs = parts.cameraMs;
      screenMs = Math.max(5, flashMs - cameraMs);
    } else {
      // Only their sum is known. The split matters to the sound alone.
      screenMs = Math.min(TYPICAL.screen, Math.max(5, flashMs / 3));
      cameraMs = flashMs - screenMs;
      notes.push("The camera does not report its own delay: the screen's share is taken as typical.");
    }
  } else if (usable(parts.cameraMs)) {
    how = "camera-reported";
    cameraMs = parts.cameraMs;
    screenMs = TYPICAL.screen;
    notes.push(
      flash
        ? "The flash did not show (a bright room?): the camera's own figure is used, with a typical screen."
        : "No flash was run: the camera's own figure is used, with a typical screen.",
    );
  } else {
    how = "typical";
    cameraMs = typicalCamera;
    screenMs = TYPICAL.screen;
    notes.push("Neither the flash nor the camera gave a figure: typical values are used. Timing may be off by 40 ms.");
  }
  const modelMs = usable(parts.modelMs) ? parts.modelMs : TYPICAL.model;
  if (!usable(parts.modelMs)) notes.push("The model's time is taken as typical.");
  const frameMs = 1000 / (usable(parts.screenHz) && parts.screenHz >= 20 ? parts.screenHz : 60);
  const showMs = screenMs + frameMs / 2;
  const behindMs = cameraMs + modelMs + poseMs;
  const leadMs = behindMs + showMs;
  if (leadMs > TYPICAL.unusual) notes.push(`The whole delay is ${Math.round(leadMs)} ms: unusual. A television in game mode, or a cable, may help.`);
  const soundMs = usable(parts.soundMs) ? parts.soundMs : TYPICAL.sound;
  if (!usable(parts.soundMs)) notes.push("The sound's delay is not reported: taken as typical.");
  const wireless = soundMs > TYPICAL.wireless;
  if (wireless) notes.push(`The sound is ${Math.round(soundMs)} ms late: wireless. A cable or the speakers will be tighter.`);
  if (fps < 45) notes.push("At 60 pictures a second a punch would be known about 15 ms sooner.");
  return { cameraMs, modelMs, screenMs, poseMs, showMs, behindMs, leadMs, soundMs, wireless, how, notes };
}

/**
 * When to start a sound that belongs to moment `at` on the line: how long
 * from page time `now`, and how late it will be heard if that moment is
 * already too near. The player's own punch is usually late by a little; the
 * opponent's, planned ahead, never is.
 */
export function soundStart(at: number, now: number, delay: Pick<DeviceDelay, "soundMs">): { inMs: number; lateMs: number } {
  const wait = at - delay.soundMs - now;
  return { inMs: Math.max(0, wait), lateMs: Math.max(0, -wait) };
}

const middle = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : null;
};
/**
 * Gathers what the count-in can measure and gives the delay. Feed it as the
 * count-in runs, read `result()` at its end, and again whenever asked: it
 * only gets better.
 *
 * - `flash(t)` when the screen was drawn white, `brightness(t, v)` for each
 *   camera frame's mean brightness (as ProbeScreen does);
 * - `frame(...)` for each camera frame's stamps; `pose(...)` when its pose arrived;
 * - `sound(ms)` once, from the audio context.
 */
export function createDelayMeter() {
  const probe = createFlashProbe();
  let flashes = 0;
  const camera: number[] = [],
    model: number[] = [],
    arrivals: number[] = [];
  let soundMs: number | null = null,
    screenHz: number | null = null;
  const keep = (list: number[], v: number) => {
    list.push(v);
    if (list.length > 240) list.shift();
  };
  return {
    flash(t: number) {
      flashes++;
      probe.flash(t);
    },
    brightness(t: number, v: number) {
      probe.brightness(t, v);
    },
    /** One camera frame: the page's stamp, and the capture time when the browser reports it. */
    frame(stamp: number, capturedAt?: number | null) {
      if (usable(capturedAt) && capturedAt <= stamp && stamp - capturedAt < 500) keep(camera, stamp - capturedAt);
    },
    /** A pose arrived at page time `arrived` for the frame stamped `stamp`. */
    pose(stamp: number, arrived: number) {
      if (arrived >= stamp && arrived - stamp < 500) keep(model, arrived - stamp);
      keep(arrivals, arrived);
    },
    /** `outputLatency` and `baseLatency` together, in seconds as the audio context gives them. */
    sound(outputLatencyS: number | undefined, baseLatencyS: number | undefined = 0) {
      const total = (outputLatencyS ?? NaN) + (baseLatencyS ?? 0);
      soundMs = Number.isFinite(total) && total > 0 ? total * 1000 : null;
    },
    screen(hz: number) {
      screenHz = hz;
    },
    result(): DeviceDelay {
      const gaps: number[] = [];
      for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i] - arrivals[i - 1]);
      const gap = middle(gaps);
      return deviceDelay({
        flash: flashes ? probe.result() : null,
        cameraMs: camera.length >= 5 ? middle(camera) : null,
        modelMs: model.length >= 5 ? middle(model) : null,
        poseFps: gap && gap > 0 ? 1000 / gap : null,
        screenHz,
        soundMs,
      });
    },
  };
}
