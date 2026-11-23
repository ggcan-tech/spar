# Recognition engineering

The current build is an instrumented browser prototype. A passing synthetic suite
is a regression check, not proof of human boxing recognition or mobile release quality.

## Implemented after the first camera playtest

- Camera height/width is passed to recognition; frame metadata preserves orientation.
- Setup runs automatically after a stable 900 ms observation (at least 18 samples).
  Reach is estimated from upper-arm + forearm segments; no full-extension exercise.
  Motion, cropped joints and malformed data prevent setup. A stance override remains
  because a square-on pose does not uniquely identify the player's lead hand.
- Phone rotation discards the old coordinate frame and reacquires automatically.
- Forward/backward steps require agreement between projected shoulder width and
  shoulder-to-hip length. Torso rotation alone should not count as a depth step.
  Missing hips suppress spatial steps. Combined yaw and translation may be rejected.
- Camera silence expires input after 250 ms. Missing head/guard joints independently
  expire their controls; reappearance cannot reuse old punch trajectories or hidden time.
- Straights require elbow/path evidence. Ambiguous candidates can wait or produce no
  punch; unclassified motion is no longer automatically labeled a jab/cross.
- Lessons demonstrate all 14 movements, describe which hand to use, and allow retries.
- Camera stop/retry invalidates in-flight startup so late model/permission results
  cannot resurrect an old camera session.
- Missing metric landmarks remain absent; normalized coordinates are not metric depth.

## A repeatable human benchmark

Record only when the player explicitly starts the local recorder in the Dojo's
tracking diagnostics. It saves landmarks, dimensions and timing, not camera video.
Nothing uploads automatically. Obtain permission before sharing a person's motion data.

For each recording, annotate action windows relative to its first frame. Example:

```json
{
  "version": 1,
  "source": "human",
  "evaluatedTypes": ["JAB", "CROSS", "LEAD_HOOK", "REAR_HOOK", "LEAD_UPPER", "REAR_UPPER"],
  "segments": [{ "type": "JAB", "startMs": 1800, "endMs": 2300 }]
}
```

Use `source: "synthetic"` for generated trajectories. Include all competing classes
in `evaluatedTypes`; narrowing it to the desired move would hide classification errors.
Idle/negative clips use empty segments and the same complete class list.

```sh
pnpm eval:motion recording.json annotations.json
```

Output includes one-to-one matches, confusion matrix, precision/recall per class,
missed actions, false actions/minute and duplicate detections. Wrong-class matches
count as both a false positive and a missed intended action. Detection delay is
measured from the annotation start, not camera exposure or inference start.
Recordings without verified aspect metadata are rejected rather than guessed square.
Treat recorded annotations as reviewable labels, not infallible ground truth.

The next corpus must include different people, phones and camera placements; left
and right lead; different lighting/clothing; fast combinations; low guard; tight hooks;
rotation without translation; translation with rotation; slips vs sidesteps; walking,
waving, stretching and adjusting clothes; occlusion and leaving/reentering the frame.
Split by person and recording session before tuning. Reserve unseen people for final
evaluation. Record camera/inference timing separately for true pipeline latency.

## Release gates to measure, not claims already achieved

Start with the original straight-punch gate: ≥92% recall, ≤3 false punches/minute,
and ≤120 ms pipeline latency under the declared supported conditions. Report per-class
precision and confusion too: high recall alone can conceal a bad controller. Require
both landscape and portrait tests, camera cancellation/recovery tests and a sustained
thermal/performance run on each supported phone. Expand the supported envelope only
after measuring it. No held-out human results have been collected in this pass.

## Remaining architecture work

The heuristic recognizer still lacks an independently validated temporal classifier,
robust constant-radius hooks, camera-relative metric translation, multi-person identity
tracking and a learned uncertainty model. It must not claim to understand an entire room.
World landmarks are hip-centered body estimates, not absolute position in the room.

Before the intended high-end mobile game is complete, compare pose model variants on
the held-out corpus and target devices, move inference off the rendering thread, and
build the first-person 3D arena with proper fighter assets/animation, spatial combat and
device performance budgets. Native iOS packaging, release testing and polished 3D art
are separate unfinished work; this change does not complete them.

Primary implementation references:
- [MediaPipe Web guide: normalization, hip-centered coordinates and worker advice](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [MediaPipe model overview](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)

## Follow-up engineering: inference and torso slips

The default pose source now tries a classic dedicated worker before the compatible main-thread
path. MediaPipe's WASM bootstrap needs `importScripts`, so the worker dynamically imports the
pinned runtime while remaining a classic worker. One transferred bitmap is processed at a time;
new camera frames are skipped while busy. Detector results older than 250ms are discarded.
Initialization and inference have deadlines, including a one-time longer shader warmup allowance.
Abort/stop terminate workers and dispose late resources. Diagnostics expose actual execution
mode and stale-result count. A worker/model smoke test with an empty bitmap establishes loader
and transport operation only; it says nothing about human punch accuracy or device performance.

Slip estimation now also measures shoulders over the hips relative to initial neutral torso
alignment. That recognizes an upper-body lean where nose-to-shoulder offset remains unchanged.
Hip translation still drives lateral steps, so ordinary whole-body translation does not become
a slip. Missing hips disable the additional torso cue. Combined rotation/translation and
unusual initial poses still require human examples and validation.
