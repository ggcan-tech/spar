/**
 * An even clock for motion. A pose is stamped when the page took the frame,
 * which is not when the camera captured it: the frame callback fires late by a
 * varying amount, and a frame that waited for the model is stamped when the
 * model came free. Speeds worked out from those stamps carry that jitter (a
 * hand moving steadily reads as speeding up and slowing down), and the filters
 * and the throw's speed are all built on speeds.
 *
 * `stamp` returns a time on the same clock as the page's stamp, spaced the way
 * the camera's frames really were: from the camera's own frame time when the
 * browser gives one (capture time, else the frame's media time), otherwise by
 * fitting an even beat to the page's stamps.
 */
export function createCaptureClock() {
  let last = -Infinity;
  let lastPage = -Infinity;
  let offset: number | null = null;
  let hadSource = false;
  let deltas: number[] = [];
  const restart = () => {
    offset = null;
    deltas = [];
  };
  return {
    /**
     * `page` is the page's own stamp (ms, monotonic). `source` is the camera's
     * time for the same frame in ms, on any clock, when one is known.
     */
    stamp(page: number, source?: number): number {
      const gap = page - lastPage;
      const fresh = !(gap > 0) || gap > 250;
      const usable = typeof source === "number" && Number.isFinite(source);
      if (fresh || usable !== hadSource) restart();
      hadSource = usable;
      let out = page;
      if (usable) {
        // The camera's clock, moved onto the page's by the usual delay
        // between them. The delay is averaged slowly, so its jitter is not
        // passed on, and a camera clock that drifts is still followed.
        const delay = page - source!;
        offset = offset === null ? delay : offset + 0.03 * (delay - offset);
        out = source! + offset;
      } else if (!fresh) {
        deltas.push(gap);
        if (deltas.length > 30) deltas.shift();
        const sorted = [...deltas].sort((a, b) => a - b);
        const beat = sorted[sorted.length >> 1];
        // Whole beats since the last frame (a skipped frame is two), then
        // pulled a little toward the page's stamp so it cannot wander off.
        const even = last + Math.max(1, Math.round(gap / beat)) * beat;
        out = deltas.length < 4 ? page : even + 0.1 * (page - even);
      }
      // Never backwards, never far from the page's own stamp.
      if (Number.isFinite(last)) out = Math.max(out, last + 0.5);
      out = Math.max(page - 60, Math.min(page + 20, out));
      last = out;
      lastPage = page;
      return out;
    },
    reset() {
      last = lastPage = -Infinity;
      hadSource = false;
      restart();
    },
  };
}
