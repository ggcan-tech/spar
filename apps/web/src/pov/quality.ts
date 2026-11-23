/**
 * Keeping up on a slow device, and using a fast one. Both are decided from
 * what the game measures while it runs, never from the device's name.
 */

/** 0: everything on. 1: half-resolution picture, no finger model. 2: also no cast shadows, lower resolution. */
export type RenderQuality = 0 | 1 | 2;
export const QUALITY = [
  { pixelRatio: 2, shadows: true, fingers: true },
  { pixelRatio: 1, shadows: true, fingers: false },
  { pixelRatio: 0.75, shadows: false, fingers: false },
] as const;
export interface Load {
  /** Frames drawn a second. */
  renderFps: number;
  /** Body poses a second; 0 when there is no camera. */
  poseFps: number;
}
/** Below this many poses a second a dodge feels late whatever else is done. */
const SLOW_POSES = 18;
const FINE_POSES = 24;

/**
 * Steps the picture down when drawing or tracking cannot keep up for three
 * seconds, and back up only after fifteen good ones, so it cannot flap.
 */
export function createQualityLadder() {
  let level: RenderQuality = 0;
  let badSince = -1,
    goodSince = -1;
  return {
    update(load: Load, now: number): RenderQuality {
      const struggling =
        load.renderFps < 40 || (load.poseFps > 0 && load.poseFps < SLOW_POSES);
      const easy =
        load.renderFps > 55 && (load.poseFps === 0 || load.poseFps >= FINE_POSES);
      if (struggling) {
        goodSince = -1;
        if (badSince < 0) badSince = now;
        if (now - badSince >= 3000 && level < 2) {
          level = (level + 1) as RenderQuality;
          badSince = now;
        }
      } else {
        badSince = -1;
        if (!easy) goodSince = -1;
        else {
          if (goodSince < 0) goodSince = now;
          if (now - goodSince >= 15000 && level > 0) {
            level = (level - 1) as RenderQuality;
            goodSince = now;
          }
        }
      }
      return level;
    },
    level: () => level,
  };
}

export type ModelTier = "lite" | "full" | "heavy";
export const isModelTier = (v: unknown): v is ModelTier =>
  v === "lite" || v === "full" || v === "heavy";
export const poseModelUrl = (tier: ModelTier) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${tier}/float16/1/pose_landmarker_${tier}.task`;
export interface ModelLoad {
  /** The model's own time for one pose, ms. 0 when not known. */
  inferenceMs: number;
  poseFps: number;
  /** Frames a second the camera gives. */
  cameraFps: number;
}
/** The larger body model costs about this many times the small one. */
const FULL_COST = 2.5;

/**
 * The heaviest body model that still gives a pose for every camera frame.
 * Asked every couple of seconds; answers with a model to change to, or null.
 * Up only after ten seconds with plenty of room; down after six seconds of
 * not keeping up. Never to the heaviest model on its own.
 */
export function createTierAdvisor() {
  let room = 0,
    behind = 0;
  return {
    advise(tier: ModelTier, load: ModelLoad): ModelTier | null {
      const camera = load.cameraFps > 0 ? Math.min(load.cameraFps, 60) : 30;
      const interval = 1000 / camera;
      if (tier === "lite") {
        const spare =
          load.inferenceMs > 0 &&
          load.inferenceMs * FULL_COST < interval * 0.8 &&
          load.poseFps >= camera * 0.9;
        room = spare ? room + 1 : 0;
        if (room >= 5) {
          room = 0;
          return "full";
        }
        return null;
      }
      const slow =
        load.poseFps > 0 &&
        (load.poseFps < Math.min(20, camera * 0.75) ||
          load.inferenceMs > interval);
      behind = slow ? behind + 1 : 0;
      if (behind >= 3) {
        behind = 0;
        return "lite";
      }
      return null;
    },
  };
}
