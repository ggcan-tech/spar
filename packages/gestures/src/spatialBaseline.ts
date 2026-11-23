import type { PoseFrame } from '@spar/protocol';
import { parseSpatialTrack, type JointPositions, type SpatialJoint, type SpatialTrack } from './spatialEvaluation';

export interface BaselineMetadata {
  clipId: string;
  subjectId: string;
  sessionId: string;
  source: 'human' | 'synthetic';
  coordinateFrameId: string;
  /** Recorded clock value at the independently synchronized clip start. */
  clipStartTimestampMs: number;
  producer: string;
}
const joints: Partial<Record<SpatialJoint, number>> = {
  nose: 0, leftShoulder: 11, rightShoulder: 12, leftWrist: 15, rightWrist: 16, leftAnkle: 27, rightAnkle: 28,
};
/** MediaPipe 'world' is body-relative. Never invent global position or pipeline timing. */
export function mediaPipeSpatialBaseline(frames: readonly PoseFrame[], metadata: BaselineMetadata, minVisibility = .5): SpatialTrack {
  if (!Number.isFinite(metadata.clipStartTimestampMs) || !Number.isFinite(minVisibility) || minVisibility < 0 || minVisibility > 1) throw new Error('Invalid synchronization timestamp or visibility threshold.');
  return parseSpatialTrack({
    version: 1, ...metadata, units: 'metres', axes: 'x-right_y-up_z-toward-camera', timing: 'unknown',
    samples: frames.map(frame => {
      const body: JointPositions = {};
      const landmarks = frame.world;
      const usable = (i: number) => landmarks?.length === 33 && landmarks[i] &&
        [landmarks[i].x, landmarks[i].y, landmarks[i].z, landmarks[i].v].every(Number.isFinite) && landmarks[i].v >= minVisibility && landmarks[i].v <= 1;
      if (usable(23) && usable(24)) {
        const a = landmarks![23], b = landmarks![24];
        const origin = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        body.root = [0, 0, 0];
        for (const [joint, index] of Object.entries(joints)) {
          if (!usable(index)) continue;
          const p = landmarks![index];
          body[joint as SpatialJoint] = [p.x - origin.x, origin.y - p.y, origin.z - p.z];
        }
      }
      return { tMs: frame.t - metadata.clipStartTimestampMs, body };
    }),
  });
}
