/**
 * Reading the player for real boxing: everything the game loop needs, in one
 * place. Each module says in its own header what it rests on and what was
 * measured. All of it was measured on the scripted person only.
 *
 * For each pose, where poses arrive (capture.ts `take`), in this order:
 *
 *   const t = lineTime(frame, delay);                      // when the camera took it
 *   const far = range.update(frame, t);                    // needs the camera's landmarks
 *   timeline.push(t, tracking);
 *   const events = contact.update({ t, tracking, arms, starts, punches, busy, jitter,
 *                                   aim: setup && { setup, range: far.units, marks } });
 *   const shapes = guard.update(tracking, far.units, t);   // once there is a set-up
 *
 * For each drawn frame, at page time `now`:
 *
 *   const me = timeline.me(now);                           // head and hands the rules judge
 *   const drawAt = timeline.drawn(now);                    // the moment to draw the opponent at
 *   const kept = guardShare(shapes, whereItsPunchArrives); // or guardFromShapes(shapes, busy)
 *
 * In set-up: `range.rehome()` while the player stands square; a second with
 * both arms straight out at the screen into `calibrateAim`; a few jabs into
 * `learnMarks`; the count-in's flashes into `createDelayMeter`.
 */
export { createTimeline, lineTime, NO_DELAY, type LineDelay, type PoseLike, type Reading, type Timeline } from "./timeline";
export { createDelayMeter, deviceDelay, soundStart, TYPICAL, type DelayParts, type DeviceDelay } from "./delay";
export { createRangeReader, bodySizes, RANGE, type RangeReader, type RangeReading } from "./range";
export {
  AIM,
  bodyPoint,
  calibrateAim,
  defaultMarks,
  handAhead,
  learnMarks,
  recentred,
  solveArm,
  tooSteep,
  zoneOf,
  type AimMarks,
  type AimSetup,
  type AimSource,
  type ArmAim,
  type Height,
  type Level,
  type Point,
  type Third,
  type Zone,
} from "./aim";
export {
  GUARD_SHAPE,
  coverOf,
  createGuardShapes,
  guardFromShapes,
  guardShare,
  type GloveShape,
  type GuardShapeReader,
  type GuardShapes,
  type GuardShare,
} from "./guardShape";
export { CONTACT, createContactReader, type Contact, type ContactEvent, type ContactInput, type ContactReader } from "./contact";
export { QUALITY, createQuality, type PunchFacts, type Quality, type QualityMeter } from "./quality";
