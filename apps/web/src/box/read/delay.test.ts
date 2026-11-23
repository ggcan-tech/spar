import { describe, expect, it } from "vitest";
import { TYPICAL, createDelayMeter, deviceDelay, soundStart } from "./delay";
import { createTimeline } from "./timeline";

/**
 * A screen that shows a picture `screen` ms after it is drawn, and a camera
 * that hands a frame to the page `camera` ms after taking it, at `fps`. The
 * count-in flashes the screen at uneven moments, as the game does.
 */
function countIn(o: { screen: number; camera: number; fps: number; model: number; flashes?: number; bright?: boolean; reports?: boolean }) {
  const meter = createDelayMeter();
  const flashes: number[] = [];
  for (let i = 0; i < (o.flashes ?? 12); i++) flashes.push(1000 + i * 437 + (i % 3) * 11);
  const step = 1000 / o.fps;
  for (const f of flashes) meter.flash(f);
  for (let taken = 500; taken < 7000; taken += step) {
    // The picture in front of the camera when it took this frame.
    const lit = flashes.some((f) => taken >= f + o.screen && taken < f + o.screen + 34);
    const stamp = taken + o.camera;
    // In a bright room the flash adds nothing the camera can see.
    meter.brightness(stamp, 60 + (lit && !o.bright ? 25 : 0) + Math.sin(taken) * 0.4);
    meter.frame(stamp, o.reports === false ? undefined : taken);
    meter.pose(stamp, stamp + o.model);
  }
  return meter;
}

describe("this device's own delay", () => {
  it("measures screen and camera with the flash, and splits them with the camera's own capture time", () => {
    const meter = countIn({ screen: 30, camera: 62, fps: 30, model: 24 });
    meter.sound(0.012, 0.005);
    meter.screen(60);
    const d = meter.result();
    console.log(
      `delay, simulated laptop (screen 30, camera 62, model 24 ms, 30 poses a second): camera ${d.cameraMs.toFixed(0)}, screen ${d.screenMs.toFixed(0)}, model ${d.modelMs.toFixed(0)}, one pose ${d.poseMs.toFixed(0)} → the rules run ${d.behindMs.toFixed(0)} ms behind the room and the opponent is drawn ${d.leadMs.toFixed(0)} ms ahead; sound starts ${d.soundMs.toFixed(0)} ms early (${d.how})`,
    );
    expect(d.how).toBe("flash");
    expect(d.cameraMs).toBeCloseTo(62, 0);
    // The flash is found on the first frame taken after it showed, up to a
    // frame late; a quarter of a frame is allowed for. Right to about 10 ms.
    expect(Math.abs(d.screenMs - 30)).toBeLessThanOrEqual(12);
    expect(d.modelMs).toBeCloseTo(24, 0);
    expect(d.poseMs).toBeCloseTo(33.3, 0);
    expect(d.behindMs).toBeCloseTo(d.cameraMs + d.modelMs + d.poseMs, 6);
    expect(d.showMs).toBeCloseTo(d.screenMs + 1000 / 60 / 2, 6);
    expect(d.leadMs).toBeCloseTo(d.behindMs + d.showMs, 6);
    // The whole delay, well past the old cap of 120 ms.
    expect(d.leadMs).toBeGreaterThan(150);
    expect(d.soundMs).toBeCloseTo(17, 6);
    expect(d.wireless).toBe(false);
  });

  it("is not capped: a slow television is allowed for in full, and said to be unusual", () => {
    const d = deviceDelay({ flash: { ms: 260, found: 11, flashes: 12, spreadMs: 12 }, cameraMs: 70, modelMs: 30, poseFps: 30, screenHz: 60 });
    expect(d.screenMs).toBeCloseTo(260 - 33.33 / 4 - 70, 1);
    expect(d.leadMs).toBeCloseTo(260 - 33.33 / 4 + 30 + 33.33 + 8.33, 1);
    expect(d.leadMs).toBeGreaterThan(300);
    expect(d.notes.some((n) => n.includes("unusual"))).toBe(true);
    // A timeline takes it as it is.
    const line = createTimeline({ delay: d });
    expect(line.drawn(1000) - line.judged(1000)).toBeCloseTo(d.leadMs, 6);
  });

  it("falls back honestly when the flash does not show", () => {
    // A bright room: the camera's own figure and a typical screen.
    const bright = countIn({ screen: 30, camera: 62, fps: 30, model: 24, bright: true }).result();
    expect(bright.how).toBe("camera-reported");
    expect(bright.cameraMs).toBeCloseTo(62, 0);
    expect(bright.screenMs).toBe(TYPICAL.screen);
    expect(bright.notes.join(" ")).toMatch(/flash did not show/);
    // No flash and no capture time: typical values, and it says timing may be off.
    const blind = countIn({ screen: 30, camera: 62, fps: 30, model: 24, bright: true, reports: false }).result();
    expect(blind.how).toBe("typical");
    expect(blind.cameraMs).toBe(TYPICAL.camera30);
    expect(blind.screenMs).toBe(TYPICAL.screen);
    expect(blind.notes.join(" ")).toMatch(/typical values/);
    // Nothing at all.
    const nothing = deviceDelay();
    expect(nothing.how).toBe("typical");
    expect(nothing.leadMs).toBeCloseTo(TYPICAL.camera30 + TYPICAL.model + 1000 / 30 + TYPICAL.screen + 1000 / 120, 6);
    expect(nothing.soundMs).toBe(TYPICAL.sound);
    // A 60 fps camera hands frames over sooner.
    expect(deviceDelay({ poseFps: 60 }).cameraMs).toBe(TYPICAL.camera60);
  });

  it("uses the flash alone when the camera reports no capture time", () => {
    const d = countIn({ screen: 30, camera: 62, fps: 30, model: 24, reports: false }).result();
    expect(d.how).toBe("flash");
    // Only the sum is known: the screen's share is a typical one, and the lead is still the whole sum.
    expect(d.screenMs).toBe(TYPICAL.screen);
    expect(Math.abs(d.cameraMs + d.screenMs - 92)).toBeLessThanOrEqual(12);
    expect(d.notes.join(" ")).toMatch(/does not report/);
  });

  it("does not believe a flash seen too few times or too unevenly", () => {
    expect(deviceDelay({ flash: { ms: 90, found: 3, flashes: 12, spreadMs: 5 } }).how).toBe("typical");
    expect(deviceDelay({ flash: { ms: 90, found: 10, flashes: 12, spreadMs: 90 } }).how).toBe("typical");
    expect(deviceDelay({ flash: { ms: null, found: 0, flashes: 12, spreadMs: 0 }, cameraMs: 55 }).how).toBe("camera-reported");
  });

  it("starts a sound early by the sound's own delay, and says when it cannot be on time", () => {
    const d = deviceDelay({ soundMs: 18 });
    // The opponent's punch, planned ahead: started 18 ms before its moment.
    expect(soundStart(5000, 4900, d)).toEqual({ inMs: 82, lateMs: 0 });
    // The player's own punch, known a little late: started at once, heard 30 ms late.
    expect(soundStart(5000, 5012, d)).toEqual({ inMs: 0, lateMs: 30 });
    const wireless = deviceDelay({ soundMs: 180 });
    expect(wireless.wireless).toBe(true);
    expect(wireless.notes.join(" ")).toMatch(/wireless/);
    // An audio context that reports nothing.
    const meter = createDelayMeter();
    meter.sound(undefined);
    expect(meter.result().soundMs).toBe(TYPICAL.sound);
  });
});
