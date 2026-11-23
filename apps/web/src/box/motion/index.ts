/**
 * Recorded motion for the opponent: the pack, the player that turns the
 * game's description of a frame into a body, and the real punch times.
 * See docs/production/evidence/real-clips.md for what the clips are.
 */
export * from "./types";
export { PACK_URL, loadPack, parsePack, type RawPack } from "./pack";
export { bodyOfPose, fromRig, gloveOf, mirrorBody, poseOf, sampleAt, sampleClip, toRig } from "./sampler";
export { BLEND, applyBlend, decay, startBlend } from "./inertial";
export { RATE_LIMITS, clipTimeAt, planFeint, planPunch, type ClipTimes, type TimeMap, type WantedTimes } from "./timewarp";
export { AIM, STOP_SHORT, aimWeight, bendOf, gloveTarget, keepClear, reachTo, settleTarget } from "./aim";
export { applyHit, placeGuard, slump } from "./posture";
export { createMotionPlayer, shapeFor, slotOf, type MotionPlayer, type PlayerOptions } from "./player";
export { CLIP_TIMES, COMBO_GAPS, FOUND_TIMES, KIND_TIMES, PUNCH_SPAN, PUNCH_TIMES, STEP_TIMES, TELLS, rulesTimes, type PunchTime } from "./times";
