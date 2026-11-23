// How a clip's frames are stored in the pack: every point as three whole
// numbers of half-millimetres, 16 bits each, little-endian, base64. Eleven
// points a frame, so 66 bytes a frame and about 5 KB a second of motion.

/** The points of a frame, in the order they are stored. */
export const JOINTS = ["hips", "chest", "head", "shoulderL", "shoulderR", "elbowL", "elbowR", "wristL", "wristR", "footL", "footR"];
/** Metres per stored unit. */
export const UNIT = 0.0005;

const points = (f) => [f.hips, f.chest, f.head, f.shoulders[0], f.shoulders[1], f.elbows[0], f.elbows[1], f.wrists[0], f.wrists[1], f.feet[0], f.feet[1]];

/** Frames to base64 text. */
export function encodeFrames(frames) {
  const values = new Int16Array(frames.length * JOINTS.length * 3);
  let k = 0;
  for (const f of frames)
    for (const p of points(f))
      for (const x of p) {
        const q = Math.round(x / UNIT);
        if (q > 32767 || q < -32768) throw new Error("a point is too far from the origin to store");
        values[k++] = q;
      }
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => bytes.writeInt16LE(v, i * 2));
  return bytes.toString("base64");
}
