// Classic worker is required by the MediaPipe WASM bootstrap; load its pinned ESM dynamically.
(() => {
  type Request = import("./hands").HandRequest;
  type Response = import("./hands").HandResponse;
  type Point = import("./hands").HandPoint;
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  let detector: import("@mediapipe/tasks-vision").HandLandmarker | null = null;
  let initializing = false;
  const send = (data: Response) => scope.postMessage(data);
  const point = ({ x, y, z }: Point): Point => ({ x, y, z });
  scope.onmessage = async ({ data }: MessageEvent<Request>) => {
    if (data.type === "init") {
      if (initializing || detector) return;
      initializing = true;
      try {
        const runtime: typeof import("@mediapipe/tasks-vision") = await import(
          /* @vite-ignore */ data.runtimeUrl
        );
        const fileset = await runtime.FilesetResolver.forVisionTasks(
          data.wasmBaseUrl,
        );
        const create = (delegate: "GPU" | "CPU") =>
          runtime.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: data.modelUrl, delegate },
            canvas: new OffscreenCanvas(1, 1),
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.6,
            minHandPresenceConfidence: 0.6,
            minTrackingConfidence: 0.6,
          });
        try {
          detector = await create("GPU");
        } catch {
          detector = await create("CPU");
        }
        send({ type: "ready" });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    try {
      if (!detector) throw new Error("Hand worker has not initialized");
      const start = performance.now();
      const result = detector.detectForVideo(data.bitmap, data.timestamp);
      const hands: import("./hands").HandFrame["hands"] = [];
      for (let i = 0; i < result.landmarks.length; i++) {
        const category = result.handedness[i]?.[0];
        const side = category?.categoryName;
        const landmarks = result.landmarks[i];
        if (
          (side !== "Left" && side !== "Right") ||
          landmarks.length !== 21 ||
          !landmarks.every(
            (p) =>
              Number.isFinite(p.x) &&
              Number.isFinite(p.y) &&
              Number.isFinite(p.z),
          )
        )
          continue;
        hands.push({
          side,
          landmarks: landmarks.map(point),
          world: (result.worldLandmarks[i] ?? []).map(point),
          confidence: category.score,
        });
      }
      send({
        type: "result",
        id: data.id,
        inferenceMs: performance.now() - start,
        frame: { t: data.timestamp, hands },
      });
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      data.bitmap.close();
    }
  };
})();
