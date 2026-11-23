// Types for asf.mjs, so the web app's tests can check the reader.
export interface AsfBone {
  name: string;
  parent: string;
  offset: number[];
  length: number;
  dof: string[];
}
export interface AsfSkeleton {
  /** File units to metres. */
  scale: number;
  bones: AsfBone[];
}
/** One frame: each joint's position in metres, by bone name ("root" is the pelvis). */
export type AsfFrame = Record<string, number[]>;
export interface AsfTrial {
  name: string;
  skeleton: AsfSkeleton;
  frames: AsfFrame[];
}
export const SOURCE_DIR: string;
export const SOURCE_FPS: number;
export const TRIALS: string[];
export function parseAsf(text: string): AsfSkeleton;
export function parseAmc(text: string): Map<string, number[]>[];
export function jointsOf(skeleton: AsfSkeleton, frame: Map<string, number[]>): AsfFrame;
export function readTrial(name: string, dir?: string): AsfTrial;
export function boneLengthSpread(trial: AsfTrial): number;
