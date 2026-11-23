// No static imports or exports: this must remain a classic worker for MediaPipe importScripts.
// Dynamic import loads the pinned ESM bundle while preserving classic-worker WASM bootstrap.
(() => {
  type Request = import('./workerDetector').WorkerRequest;
  type Response = import('./workerDetector').WorkerResponse;
  type Options = import('./workerDetector').DetectorOptions;
  type Landmark = import('@spar/protocol').Landmark;
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  let detector: import('@mediapipe/tasks-vision').PoseLandmarker | null = null;
  let runtime: typeof import('@mediapipe/tasks-vision');
  let fileset: Awaited<ReturnType<typeof runtime.FilesetResolver.forVisionTasks>>;
  let options: Options;
  let delegate: 'GPU' | 'CPU' = 'GPU';
  let initializing = false;
  /** One fresh GPU detector is tried after a GPU failure before settling for the CPU. */
  let gpuRetries = 0;
  /** The model file's bytes, kept by the browser between visits; null to let MediaPipe fetch it. */
  let modelBytes: Uint8Array | null = null;
  const send = (message: Response) => scope.postMessage(message);
  // The model is several megabytes. Kept in the browser's own cache store, the
  // second start does not depend on the network or on the CDN's headers.
  // Anything that goes wrong here falls back to the plain download.
  const loadModel = async (): Promise<Uint8Array | null> => {
    try {
      if (typeof caches === 'undefined') return null;
      const cache = await caches.open('spar-models-v1');
      let hit = await cache.match(options.modelUrl);
      if (!hit) {
        const response = await fetch(options.modelUrl);
        if (!response.ok) return null;
        await cache.put(options.modelUrl, response.clone());
        hit = response;
      }
      const bytes = new Uint8Array(await hit.arrayBuffer());
      return bytes.length > 100_000 ? bytes : null;
    } catch { return null; }
  };
  const create = () => runtime.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: modelBytes ? { modelAssetBuffer: modelBytes, delegate } : { modelAssetPath: options.modelUrl, delegate },
    canvas: new OffscreenCanvas(1, 1),
    runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: false,
    minPoseDetectionConfidence: options.minPoseDetectionConfidence,
    minPosePresenceConfidence: options.minPosePresenceConfidence,
    minTrackingConfidence: options.minTrackingConfidence,
  });
  const mapLandmark = (point: import('@mediapipe/tasks-vision').NormalizedLandmark): Landmark => ({
    x: point.x, y: point.y, z: point.z,
    v: Number.isFinite(point.visibility) ? point.visibility : 0,
  });
  scope.onmessage = async ({ data }: MessageEvent<Request>) => {
    if (data.type === 'init') {
      if (initializing || detector) return;
      initializing = true;
      try {
        options = data.options; delegate = options.delegate;
        runtime = await import(/* @vite-ignore */ data.runtimeUrl);
        fileset = await runtime.FilesetResolver.forVisionTasks(options.wasmBaseUrl);
        modelBytes = await loadModel();
        try { detector = await create(); }
        catch (error) {
          // The saved copy may be what failed: go back to the plain download.
          modelBytes = null;
          if (delegate === 'CPU') { detector = await create(); }
          else {
            // A GPU that fails to start once often starts the second time.
            try { detector = await create(); }
            catch { delegate = 'CPU'; detector = await create(); }
          }
          void error;
        }
        // The first inference compiles the GPU programs and can take several
        // hundred milliseconds. Spend that now, on an empty picture, instead
        // of on the player's first frames.
        try {
          const warm = new OffscreenCanvas(256, 256);
          warm.getContext('2d')?.fillRect(0, 0, 256, 256);
          detector.detectForVideo(warm, 1);
        } catch { /* Warm-up is a courtesy. */ }
        send({ type: 'ready', delegate });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const { bitmap, timestamp, id, imageAspect } = data;
    try {
      if (!detector) throw new Error('Pose worker has not initialized.');
      const before = performance.now();
      let result;
      try { result = detector.detectForVideo(bitmap, timestamp); }
      catch (error) {
        if (delegate === 'CPU') throw error;
        detector.close(); detector = null;
        // A lost graphics context usually comes back. One fresh GPU detector
        // is tried before the whole session is moved to the CPU.
        if (gpuRetries < 1) {
          gpuRetries++;
          try {
            detector = await create();
            result = detector.detectForVideo(bitmap, timestamp);
          } catch {
            (detector as import('@mediapipe/tasks-vision').PoseLandmarker | null)?.close();
            detector = null; result = undefined;
          }
        }
        if (!detector || !result) {
          delegate = 'CPU'; detector = await create();
          result = detector.detectForVideo(bitmap, timestamp);
        }
      }
      const inferenceMs = performance.now() - before;
      const lm = result.landmarks[0];
      const world = result.worldLandmarks[0];
      send({ type: 'result', id, result: {
        delegate, inferenceMs,
        frame: lm?.length ? {
          t: timestamp, lm: lm.map(mapLandmark),
          world: world?.length === lm.length ? world.map(mapLandmark) : [], imageAspect,
        } : null,
      } });
    } catch (error) {
      send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
    } finally { bitmap.close(); }
  };
})();
