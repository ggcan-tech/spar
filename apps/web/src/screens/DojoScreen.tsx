import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ActionEvent, GestureEngineLike, InputBits, PoseFrame, Stance } from '@spar/protocol';
import { createAutomaticGestureEngine, type AutomaticGestureEngine, type TrackingStatus, type Calibration } from '@spar/gestures';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Meter } from '../ui/Meter';
import { MovementDemo } from '../ui/MovementDemo';
import { cameraSession, useCameraSession, type CameraSession } from '../camera/session';
import { CameraError } from '../camera/camera';
import { drawPose, wristStateFromLabel, type WristState } from '../camera/skeleton';
import type { PoseDelegate } from '../camera/pose';
import { createCameraInput } from '../input/cameraInput';
import { createKeyboardInput } from '../input/keyboard';
import { createCombinedInput, type InputSource } from '../input/InputSource';
import { inputStore, useInputStore } from '../input/store';
import { handOfEvent, readEngineDebug, type EngineDebugView } from '../input/engineDebug';
import { DRILL_PROMPTS, createDrill, drillSummary, type DrillState } from '../input/drill';
import { BIT_NAMES } from '../input/keymap';
import {
  createRecorder,
  createRecordingEngine,
  downloadRecording,
  makeRecording,
  parseRecording,
  replayRecording,
  type ReplayResult,
} from '../recorder/recorder';

export interface DojoScreenProps {
  onBack: () => void;
  onFightBot: () => void;
  onFightOnline: () => void;
}

type StanceChoice = 'auto' | Stance;

interface TickerEntry {
  id: number;
  ev: ActionEvent;
}

interface PerfView {
  fps: number;
  inferMs: number;
  delegate: PoseDelegate | null;
  frames: number;
  detected: number;
  driver: string | null;
  execution?: string;
  staleFrames?: number;
  pipelineP95Ms?: number;
}

interface ReplayView {
  name: string;
  result: ReplayResult;
  calibrationSource: 'file' | 'automatic';
  stance: string;
}

const TICKER_MAX = 8;
const IMPULSE_LATCH_MS = 250;
const WRIST_FLASH_MS = 220;
const IMPULSE_BITS = BIT_NAMES.filter((b) => b.kind !== 'held').reduce((m, b) => m | b.bit, 0);

const fmtNum = (v: unknown, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');
const fmtT = (t: number) => `${(t / 1000).toFixed(2)}s`;

function describeError(e: unknown): string {
  if (e instanceof CameraError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function calibField(cal: Calibration | null, path: string[]): unknown {
  let cur: unknown = cal;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function DojoScreen({ onBack, onFightBot, onFightOnline }: DojoScreenProps) {
  const cam = useCameraSession();
  const session: CameraSession | null = cam.status === 'live' ? cam.session : null;
  const { input, calibration, engine } = useInputStore();

  const [stanceSel, setStanceSel] = useState<StanceChoice>('auto');
  const [tracking, setTracking] = useState<TrackingStatus>({ phase: 'looking', message: 'Step into view with your head, hands and hips visible.', progress: 0 });
  const [debug, setDebug] = useState<EngineDebugView | null>(null);
  const [perf, setPerf] = useState<PerfView>({ fps: 0, inferMs: 0, delegate: null, frames: 0, detected: 0, driver: null });
  const [bitsView, setBitsView] = useState<InputBits>(0);
  const [ticker, setTicker] = useState<TickerEntry[]>([]);
  const [drillState, setDrillState] = useState<DrillState>(() => createDrill().state());
  const [rec, setRec] = useState({ recording: false, frames: 0, durationMs: 0 });
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<InputSource>(input);
  const engineRef = useRef<GestureEngineLike | null>(engine);
  const stanceSelRef = useRef<StanceChoice>(stanceSel);
  const drillRef = useRef(createDrill());
  const recorderRef = useRef(createRecorder());
  const recordingCalibrationRef = useRef<Calibration | null>(null);
  const flashRef = useRef({ lead: 0, rear: 0 });
  const latchRef = useRef({ bits: 0, impulses: 0, impulseAt: 0 });
  const frameRef = useRef<{ frame: PoseFrame | null; at: number }>({ frame: null, at: 0 });
  const tickerIdRef = useRef(0);

  useEffect(() => {
    inputRef.current = input;
    engineRef.current = engine;
  }, [input, engine]);
  useEffect(() => {
    stanceSelRef.current = stanceSel;
  }, [stanceSel]);
  // Camera permission starts from an explicit button. Players can inspect the
  // lesson or practice with keys without a pending permission prompt blocking UI.

  const retryCamera = useCallback(() => {
    cameraSession.stop();
    cameraSession.start().catch(() => {});
  }, []);

  // 2) Preview <video> shares the session's MediaStream.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!session) {
      v.srcObject = null;
      return;
    }
    v.srcObject = session.stream;
    v.play().catch(() => {});
    if (stageRef.current && session.width > 0 && session.height > 0) {
      stageRef.current.style.aspectRatio = `${session.width} / ${session.height}`;
    }
    return () => {
      v.srcObject = null;
    };
  }, [session]);

  // 3) Overlay: draw on every pose frame; keep canvas sized to the stage.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const now = performance.now();
    const dbg = readEngineDebug(engineRef.current);
    const lead: WristState = now - flashRef.current.lead < WRIST_FLASH_MS ? 'fired' : wristStateFromLabel(dbg.lead.state);
    const rear: WristState = now - flashRef.current.rear < WRIST_FLASH_MS ? 'fired' : wristStateFromLabel(dbg.rear.state);
    const src = inputRef.current;
    const stance: Stance = src.kind === 'camera' ? src.stance() : stanceSelRef.current === 'southpaw' ? 'southpaw' : 'orthodox';
    drawPose(ctx, frameRef.current.frame, { width: canvas.width, height: canvas.height, mirror: true, stance, wrists: { lead, rear } });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(stage.clientWidth * dpr));
      const h = Math.max(1, Math.round(stage.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        draw();
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    if (!session) {
      frameRef.current = { frame: null, at: 0 };
      draw();
      return;
    }
    const off = session.pose.onFrame((f) => {
      frameRef.current = { frame: f, at: performance.now() };
      if (f.imageAspect && stageRef.current) stageRef.current.style.aspectRatio = String(1 / f.imageAspect);
      recorderRef.current.push(f);
      draw();
    });
    return off;
  }, [session, draw]);

  // 4) 60 Hz consumer loop: drain events + sample bits → drill, ticker, wrist flashes, bit chips.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const src = inputRef.current;
      const now = performance.now();
      const evs = src.events();
      const bits = src.sample();
      const latch = latchRef.current;
      latch.bits = bits;
      const impulses = bits & IMPULSE_BITS;
      if (impulses) {
        latch.impulses |= impulses;
        latch.impulseAt = now;
      } else if (now - latch.impulseAt > IMPULSE_LATCH_MS) {
        latch.impulses = 0;
      }
      if (evs.length > 0) {
        for (const ev of evs) {
          const hand = handOfEvent(ev.type);
          if (hand) flashRef.current[hand] = now;
        }
        setTicker((prev) => {
          const next = prev.slice();
          for (const ev of evs) next.unshift({ id: ++tickerIdRef.current, ev });
          return next.slice(0, TICKER_MAX);
        });
      }
      if (drillRef.current.feed(evs, bits, now)) setDrillState(drillRef.current.state());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 5) ~15 Hz UI refresh for engine debug, perf, bit chips, recorder count.
  useEffect(() => {
    const id = setInterval(() => {
      setDebug(engineRef.current ? readEngineDebug(engineRef.current) : null);
      const active = engineRef.current as AutomaticGestureEngine | null;
      if (active?.tracking) setTracking(active.tracking());
      const s = cameraSession.current();
      if (s) {
        const st = s.pose.stats();
        setPerf({ fps: s.pose.fps(), inferMs: s.pose.inferenceMs(), delegate: s.pose.delegate(), frames: st.frames, detected: st.detected, driver: st.driver, execution: st.execution, staleFrames: st.staleFrames, pipelineP95Ms: st.pipelineP95Ms });
      }
      const latch = latchRef.current;
      setBitsView(latch.bits | latch.impulses);
      const r = recorderRef.current;
      setRec({ recording: r.isRecording(), frames: r.count(), durationMs: r.durationMs() });
      if (frameRef.current.frame && performance.now() - frameRef.current.at > 600) {
        frameRef.current = { frame: null, at: 0 };
        draw();
      }
    }, 66);
    return () => clearInterval(id);
  }, [draw]);

  // Camera input is attached as soon as inference starts. Setup happens passively;
  // the engine suppresses actions until a stable body observation is available.
  useEffect(() => {
    if (!session) {
      if (inputStore.get().kind === 'camera') inputStore.resetToKeyboard();
      return;
    }
    const eng = createAutomaticGestureEngine(stanceSel === 'auto' ? undefined : stanceSel, {
      aspect: session.height / session.width,
    });
    const combined = createCombinedInput(createCameraInput(eng, session.pose), createKeyboardInput());
    inputStore.set(combined, { engine: eng, calibration: null });
    engineRef.current = eng;
    inputRef.current = combined;
    setTracking(eng.tracking());
    drillRef.current.reset();
    setDrillState(drillRef.current.state());
    // The input owns its subscription and persists into fights. The store disposes
    // it when replaced, including on camera restart or stance change.
  }, [session, stanceSel]);

  // ── Drill ────────────────────────────────────────────────────────────────
  const drillStart = () => {
    drillRef.current.start(performance.now());
    setDrillState(drillRef.current.state());
  };
  const drillSkip = () => {
    drillRef.current.skip(performance.now());
    setDrillState(drillRef.current.state());
  };
  const drillReset = () => {
    drillRef.current.reset();
    setDrillState(drillRef.current.state());
  };

  // ── Recorder ─────────────────────────────────────────────────────────────
  const toggleRecord = () => {
    const r = recorderRef.current;
    if (r.isRecording()) r.stop();
    else {
      r.clear();
      const active = engineRef.current as AutomaticGestureEngine | null;
      recordingCalibrationRef.current = active?.tracking?.().phase === 'ready' ? active.calibration() : null;
      r.start();
    }
    setRec({ recording: r.isRecording(), frames: r.count(), durationMs: r.durationMs() });
  };
  const download = () => {
    const r = recorderRef.current;
    if (r.count() === 0) return;
    const stance: Stance | 'auto' = input.kind === 'camera' ? input.stance() : stanceSel;
    const s = cameraSession.current();
    downloadRecording(
      makeRecording(r.frames(), stance, recordingCalibrationRef.current, {
        recordedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        fps: s ? Math.round(s.pose.fps()) : undefined,
        delegate: s?.pose.delegate(),
        aspect: r.frames()[0]?.imageAspect ?? (s ? s.height / s.width : undefined),
        width: s?.width,
        height: s?.height,
      }),
    );
  };
  const clearRecording = () => {
    recorderRef.current.clear();
    setRec({ recording: recorderRef.current.isRecording(), frames: 0, durationMs: 0 });
  };
  const loadRecording = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setReplayError(null);
    try {
      const parsed = parseRecording(await file.text());
      const source: ReplayView['calibrationSource'] = parsed.calibration ? 'file' : 'automatic';
      const eng = createRecordingEngine(parsed);
      const result = replayRecording(parsed, eng);
      setReplay({ name: file.name, result, calibrationSource: source, stance: eng.stance() });
    } catch (err) {
      setReplay(null);
      setReplayError(describeError(err));
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const cameraLive = cam.status === 'live';
  const calibrated = input.kind === 'camera' && tracking.phase === 'ready';
  const liveCalibration = (engine as AutomaticGestureEngine | null)?.calibration?.() ?? calibration;
  const summary = drillSummary(drillState);
  const prompt = drillState.status === 'running' ? DRILL_PROMPTS[drillState.index] : null;
  const promptTone = drillState.lastResult?.ok ? 'drill__prompt--hit' : '';

  let camText: string;
  let camDot: string;
  switch (cam.status) {
    case 'off':
      camText = 'off';
      camDot = '';
      break;
    case 'starting':
      camText = cam.step === 'camera' ? 'asking for the camera…' : 'loading pose model…';
      camDot = 'status-dot--warn';
      break;
    case 'live':
      camText = `live · ${cam.session.width}×${cam.session.height}`;
      camDot = 'status-dot--live';
      break;
    case 'error':
      camText = describeError(cam.error);
      camDot = 'status-dot--err';
      break;
  }

  return (
    <div className="dojo">
      {/* ─────────────── Left: stage + drill + ticker ─────────────── */}
      <div className="dojo__left">
        <div className="stage" ref={stageRef}>
          <video ref={videoRef} muted playsInline autoPlay />
          <canvas ref={canvasRef} />
          <span className="stage__corner">
            {cameraLive ? `${perf.fps.toFixed(0)} fps · ${perf.inferMs.toFixed(1)} ms · ${perf.delegate ?? ''}` : camText}
          </span>
          <span className="stage__corner stage__corner--right">{calibrated ? `tracking · ${input.stance()}` : 'finding your position'}</span>

          {cameraLive && !calibrated && (
            <div className="stage__overlay">
              <span className="stage__sub" role="status">{tracking.message}</span>
              {tracking.phase === 'settling' && <progress aria-label="Finding your stance" max={1} value={tracking.progress} />}
            </div>
          )}
          {cam.status === 'error' && (
            <div className="stage__overlay stage__overlay--dim">
              <span className="stage__sub">Camera unavailable</span>
              <p className="note note--err" style={{ maxWidth: 480, pointerEvents: 'auto' }}>
                {describeError(cam.error)}
              </p>
              <div className="stage__actions" style={{ position: 'static' }}>
                <Button size="md" onClick={retryCamera}>
                  Retry
                </Button>
              </div>
            </div>
          )}
          {cam.status === 'starting' && (
            <div className="stage__overlay stage__overlay--dim">
              <span className="stage__sub">{camText}</span>
            </div>
          )}
          {cam.status === 'off' && (
            <div className="stage__overlay stage__overlay--dim">
              <span className="stage__sub">Camera off</span>
              <div className="stage__actions" style={{ position: 'static' }}>
                <Button size="md" onClick={retryCamera}>
                  Enable camera
                </Button>
              </div>
            </div>
          )}
        </div>

        <Panel
          title="Learn the moves"
          tone="red"
          aside={
            drillState.status === 'idle'
              ? `${DRILL_PROMPTS.length} prompts`
              : `${summary.hits} learned · ${summary.misses} retries · ${summary.skips} skipped`
          }
        >
          {drillState.status === 'idle' && (
            <div className="row">
              <p className="note" style={{ margin: 0, flex: 1 }}>
                Watch the demonstration, then copy it at your own pace. We stay on each move until it is recognized. Keyboard practice works too.
              </p>
              <Button size="md" variant="red" onClick={drillStart}>
                Learn the moves
              </Button>
            </div>
          )}
          {drillState.status === 'running' && prompt && (
            <>
            <MovementDemo prompt={prompt} stance={input.stance()} />
            <div className="drill">
              <div>
                <div className={`drill__prompt ${promptTone}`}>
                  {drillState.lastResult?.ok ? `✓ ${prompt.label}` : prompt.label}
                </div>
                {drillState.lastResult?.got && !drillState.lastResult.ok && <p className="note" role="status">
                  Detected {DRILL_PROMPTS.find(p => p.type === drillState.lastResult?.got)?.label ?? drillState.lastResult.got}. Try again — {prompt.cue}
                </p>}
                <div className="drill__meta">
                  {drillState.index + 1} / {DRILL_PROMPTS.length}
                  {drillState.lastResult?.ok && drillState.lastResult.latencyMs !== null && (
                    <>
                      {' '}
                      · <strong>{drillState.lastResult.latencyMs.toFixed(0)} ms</strong>
                    </>
                  )}
                </div>
              </div>
              <div className="btn-row">
                <Button size="sm" variant="ghost" onClick={drillSkip}>
                  Skip
                </Button>
                <Button size="sm" variant="ghost" onClick={drillReset}>
                  Reset
                </Button>
              </div>
            </div>
            </>
          )}
          {drillState.status === 'done' && (
            <div className="drill">
              <div>
                <div className="drill__prompt">Done</div>
                <div className="drill__meta">
                  <strong>{summary.hits}</strong> learned · <strong>{summary.misses}</strong> retries · <strong>{summary.skips}</strong> skipped
                  {summary.meanLatencyMs !== null && (
                    <>
                      {' '}
                      · mean response time <strong>{summary.meanLatencyMs.toFixed(0)} ms</strong>
                    </>
                  )}
                </div>
              </div>
              <div className="btn-row">
                <Button size="sm" variant="red" onClick={drillStart}>
                  Again
                </Button>
                <Button size="sm" variant="ghost" onClick={drillReset}>
                  Reset
                </Button>
              </div>
            </div>
          )}
          {drillState.status !== 'idle' && (
            <div className="drill__tallies">
              {DRILL_PROMPTS.map((p, i) => {
                const t = drillState.tallies[i];
                const mean = t.latencies.length ? t.latencies.reduce((a, b) => a + b, 0) / t.latencies.length : null;
                return (
                  <div key={p.type} className={`drill__tally ${drillState.status === 'running' && i === drillState.index ? 'drill__tally--active' : ''}`}>
                    <span>{p.label}</span>
                    <span>
                      {t.hits}/{t.misses}
                      {t.skips ? `/${t.skips}s` : ''}
                      {mean !== null ? ` ${mean.toFixed(0)}ms` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <div className="grid-2">
          <Panel title="Action ticker" aside={`last ${TICKER_MAX}`}>
            {ticker.length === 0 ? (
              <div className="ticker--empty">No actions yet. Throw a punch, or press J.</div>
            ) : (
              <ul className="ticker">
                {ticker.map(({ id, ev }) => (
                  <li key={id}>
                    <span className="ticker__t">{fmtT(ev.t)}</span>
                    <span className="ticker__type">{DRILL_PROMPTS.find(p => p.type === ev.type)?.label ?? ev.type.replaceAll('_', ' ').toLowerCase()}</span>
                    {ev.body && <span className="tag tag--body">body</span>}
                    {ev.early && <span className="tag tag--early">early</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <details className="sub"><summary>Input diagnostics</summary>
          <Panel title="Live input bits" aside={`0x${bitsView.toString(16).padStart(4, '0')}`}>
            <div className="chips">
              {BIT_NAMES.map((b) => (
                <span key={b.name} className={`chip chip--${b.kind} ${(bitsView & b.bit) !== 0 ? 'chip--on' : ''}`}>
                  {b.name}
                </span>
              ))}
            </div>
            <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
              What <code>sample()</code> hands the sim each tick. Impulses are latched for a moment so you can see them.
            </p>
          </Panel>
          </details>
        </div>
      </div>

      {/* ─────────────── Right: status, gesture debug, recorder, actions ─────────────── */}
      <div className="dojo__right">
        <Panel title="Status" aside={input.kind === 'camera' ? 'camera input' : 'keyboard input'} tone="blue">
          <dl className="kv">
            <dt>Camera</dt>
            <dd>
              <span className={`status-dot ${camDot}`} />
              {camText}
            </dd>
            <dt>Pose</dt>
            <dd>
              {cameraLive
                ? `${perf.delegate ?? '…'} · ${perf.fps.toFixed(1)} fps · ${perf.inferMs.toFixed(1)} ms · ${perf.detected}/${perf.frames} frames${perf.driver ? ` · ${perf.driver}` : ''} · ${perf.execution ?? 'starting'} · ${perf.staleFrames ?? 0} stale results discarded · ${(perf.pipelineP95Ms ?? 0).toFixed(0)} ms capture-to-result p95`
                : '—'}
            </dd>
            <dt>Stance</dt>
            <dd>
              <div className="seg" role="group" aria-label="Stance">
                {(['auto', 'orthodox', 'southpaw'] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={stanceSel === s} onClick={() => setStanceSel(s)}>
                    {s === 'auto' ? 'Automatic' : s === 'orthodox' ? 'Left hand forward' : 'Right hand forward'}
                  </button>
                ))}
              </div>
              {calibrated && <span className="note" style={{ marginLeft: 8 }}>resolved: {input.stance()}</span>}
            </dd>
          </dl>
          <p className="note" role="status">{cameraLive ? tracking.message : 'Turn on the camera to start automatic tracking.'}</p>
          <p className="note">Place your camera where it can see your head, hands and hips. Your reach is learned automatically. No calibration exercise.</p>
          {liveCalibration && (
            <details className="sub" style={{ marginTop: 8 }}>
              <summary>Tracking measurements</summary>
              <dl className="kv" style={{ marginTop: 6 }}>
                <dt>stance</dt>
                <dd>{String(calibField(liveCalibration, ['stance']) ?? '—')}</dd>
                <dt>armLen lead</dt>
                <dd>{fmtNum(calibField(liveCalibration, ['armLen', 'lead']), 3)}</dd>
                <dt>armLen rear</dt>
                <dd>{fmtNum(calibField(liveCalibration, ['armLen', 'rear']), 3)}</dd>
                <dt>shoulderW</dt>
                <dd>{fmtNum(calibField(liveCalibration, ['shoulderWBaseline']), 4)}</dd>
                <dt>chinY</dt>
                <dd>{fmtNum(calibField(liveCalibration, ['chinY']), 3)}</dd>
                <dt>neutralNoseY</dt>
                <dd>{fmtNum(calibField(liveCalibration, ['neutralNoseY']), 3)}</dd>
                <dt>neutralNoseX</dt>
                <dd>{fmtNum(calibField(liveCalibration, ['neutralNoseX']), 3)}</dd>
                <dt>auto</dt>
                <dd>{String(calibField(liveCalibration, ['auto']) ?? '—')}</dd>
              </dl>
            </details>
          )}
        </Panel>

        <details className="sub"><summary>Tracking diagnostics & motion recordings</summary>
        <Panel title="Live gesture" aside={debug ? (debug.lastEvent ? `last: ${debug.lastEvent.type}` : 'engine running') : 'waiting for camera'}>
          <Meter label="Lead ext" value={debug?.lead.extension} max={1.2} marks={[0.45, 0.65, 0.8]} color="var(--red)" />
          <Meter label="Lead vel" value={debug?.lead.velocity} min={-8} max={8} marks={[0, 3, 4]} color="var(--red-dim)" format={(v) => `${v.toFixed(1)}/s`} />
          <Meter label="Rear ext" value={debug?.rear.extension} max={1.2} marks={[0.45, 0.65, 0.8]} color="var(--blue)" />
          <Meter label="Rear vel" value={debug?.rear.velocity} min={-8} max={8} marks={[0, 3, 4]} color="var(--blue-dim)" format={(v) => `${v.toFixed(1)}/s`} />
          <Meter label="Head X" value={debug?.headX} min={-0.6} max={0.6} marks={[-0.35, -0.2, 0, 0.2, 0.35]} color="var(--amber)" hint="slip: |x| > 0.35 enter, < 0.20 exit" />
          <Meter label="Head drop" value={debug?.headY} min={-0.3} max={0.6} marks={[0, 0.35]} color="var(--amber)" hint="duck: drop > 0.35 with knees bent" />
          <Meter label="Scale" value={debug?.scale} min={0.7} max={1.3} marks={[0.89, 1, 1.12]} color="var(--text-dim)" hint="step in > 1.12 · step out < 0.89" />
          <div className="row" style={{ marginTop: 8 }}>
            <span className="field__label">Guard</span>
            <span className={`chip chip--held ${debug?.guard ? 'chip--on' : ''}`}>{debug?.guard === null || debug === null ? '—' : debug.guard ? 'HIGH' : 'LOW'}</span>
            <span className="field__label" style={{ marginLeft: 12 }}>
              Head
            </span>
            <span className={`chip chip--held ${debug?.headState && debug.headState !== 'CENTER' ? 'chip--on' : ''}`}>{debug?.headState ?? '—'}</span>
            {debug && debug.valid === false && <span className="chip chip--punch chip--on">no shoulders</span>}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="field__label">Hands</span>
            <span className={`chip ${debug?.lead.state && debug.lead.state !== 'IDLE' ? 'chip--on' : ''}`}>
              lead {debug?.lead.state ?? '—'}
              {debug?.lead.visible === false ? ' (hidden)' : ''}
            </span>
            <span className={`chip ${debug?.rear.state && debug.rear.state !== 'IDLE' ? 'chip--on' : ''}`}>
              rear {debug?.rear.state ?? '—'}
              {debug?.rear.visible === false ? ' (hidden)' : ''}
            </span>
            <span className="note">elbow {fmtNum(debug?.lead.elbowAngle, 0)}° / {fmtNum(debug?.rear.elbowAngle, 0)}°</span>
          </div>
          {debug?.raw !== undefined && debug?.raw !== null && (
            <details className="sub" style={{ marginTop: 8 }}>
              <summary>Raw engine.debug()</summary>
              <pre className="raw">{safeJson(debug.raw)}</pre>
            </details>
          )}
        </Panel>

        <Panel title="Recorder" aside={rec.recording ? `● REC · ${rec.frames} frames` : rec.frames ? `${rec.frames} frames · ${(rec.durationMs / 1000).toFixed(1)}s` : 'idle'}>
          <div className="btn-row">
            <Button size="sm" variant={rec.recording ? 'red' : 'default'} onClick={toggleRecord} disabled={!cameraLive}>
              {rec.recording ? '■ Stop' : '● Record'}
            </Button>
            <Button size="sm" onClick={download} disabled={rec.frames === 0 || rec.recording}>
              Download JSON
            </Button>
            <Button size="sm" variant="ghost" onClick={clearRecording} disabled={rec.frames === 0 || rec.recording}>
              Clear
            </Button>
            <label className="btn btn--default btn--sm file-btn">
              Load recording
              <input type="file" accept="application/json,.json" onChange={(e) => void loadRecording(e)} />
            </label>
          </div>
          <p className="note" style={{ margin: '8px 0 0' }}>
            Saves pose landmarks and camera dimensions locally as <code>{'{ version: 1, stance, calibration, frames }'}</code>. Load one to replay it through
            the engine and see the event list.
          </p>
          {replayError && <p className="note note--err" style={{ marginTop: 8 }}>{replayError}</p>}
          {replay && (
            <div style={{ marginTop: 10 }}>
              <div className="note" style={{ marginBottom: 6 }}>
                <strong style={{ color: 'var(--text)' }}>{replay.name}</strong> · {replay.result.frames} frames · {(replay.result.durationMs / 1000).toFixed(1)}s · {replay.stance} ·
                calibration {replay.calibrationSource} · <strong style={{ color: 'var(--text)' }}>{replay.result.events.length}</strong> events
              </div>
              {replay.result.events.length > 0 ? (
                <ul className="ticker scroll-list">
                  {replay.result.events.map((ev, i) => (
                    <li key={i}>
                      <span className="ticker__t">{(ev.rel / 1000).toFixed(2)}s</span>
                      <span className="ticker__type">{ev.type}</span>
                      {ev.body && <span className="tag tag--body">body</span>}
                      {ev.early && <span className="tag tag--early">early</span>}
                      <span className="ticker__conf">
                        #{ev.frame} · {ev.confidence.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="ticker--empty">The engine emitted nothing for this recording.</div>
              )}
            </div>
          )}
        </Panel>
        </details>

        <div className="stack">
          <Button variant="red" onClick={onFightBot} disabled={!calibrated} title={calibrated ? undefined : tracking.message}>
            Fight the bot with camera
          </Button>
          <Button variant="blue" onClick={onFightOnline}>
            Fight online
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          {!calibrated && <span className="note">Camera fights unlock when your body is visible and tracking is ready.</span>}
        </div>
      </div>
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v, (_k, val) => (typeof val === 'number' ? Number(val.toFixed(3)) : val), 1);
    return s.length > 1500 ? `${s.slice(0, 1500)}…` : s;
  } catch {
    return String(v);
  }
}
