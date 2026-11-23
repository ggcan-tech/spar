/**
 * Is the camera's picture too dark to track in? In poor light a camera
 * lengthens its exposure, which halves its frame rate and smears a moving
 * hand, and the body model starts losing joints. The player sees none of
 * that; they see a game that does not respond. So say so.
 */

/** Mean brightness of RGBA pixels, 0 (black) to 255. */
export function meanLuma(rgba: ArrayLike<number>): number {
  let sum = 0,
    count = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    count++;
  }
  return count ? sum / count : 0;
}

/** Starting values; a real room and camera will move them. */
export const DIM = { below: 45, clear: 60, afterMs: 2500 };

/** Dark for a couple of seconds counts as dim; it clears only once clearly brighter. */
export function createDimLatch() {
  let dim = false;
  let since = -1;
  return {
    update(luma: number, now: number): boolean {
      if (!Number.isFinite(luma)) return dim;
      if (dim) {
        if (luma >= DIM.clear) {
          dim = false;
          since = -1;
        }
      } else if (luma < DIM.below) {
        if (since < 0) since = now;
        if (now - since >= DIM.afterMs) dim = true;
      } else since = -1;
      return dim;
    },
    reset() {
      dim = false;
      since = -1;
    },
  };
}

/** Reads the picture's brightness from the video about once a second. Safe where there is no canvas. */
export function createLightMeter() {
  const latch = createDimLatch();
  let canvas: HTMLCanvasElement | null = null;
  let lastAt = -Infinity;
  let luma: number | null = null;
  let broken = false;
  return {
    read(video: HTMLVideoElement | null, now: number) {
      if (broken || !video || now - lastAt < 1000)
        return { luma, dim: luma !== null && latch.update(luma, now) };
      lastAt = now;
      try {
        if (!(video.readyState >= 2) || !video.videoWidth)
          return { luma, dim: false };
        canvas ??= document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no 2d context");
        context.drawImage(video, 0, 0, 32, 18);
        luma = meanLuma(context.getImageData(0, 0, 32, 18).data);
      } catch {
        // No canvas, or a picture that cannot be read: do without.
        broken = true;
        luma = null;
        return { luma, dim: false };
      }
      return { luma, dim: latch.update(luma, now) };
    },
    reset() {
      latch.reset();
      luma = null;
      lastAt = -Infinity;
    },
  };
}
