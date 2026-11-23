import { useEffect, useRef, useState } from 'react';
import type { MatchView, NetStats, PoseFrame, RollbackSessionLike, SimEvent } from '@spar/protocol';
import { POSE_STREAM_HZ } from '@spar/protocol';
import { createBot, replay, sim } from '@spar/sim';
import { createLocalSession } from '@spar/netcode';
import type { InputSource } from '../input/InputSource';
import type { OnlineHandles } from '../net/types';
import { createEventFeed, createGameLoop } from '../game/loop';
import { createRenderer } from '../render/Renderer';
import { createSfx, type Sfx } from '../audio/sfx';
import '../render/fight.css';

export interface FightScreenProps {
  mode: 'bot' | 'online';
  input: InputSource;
  onDone: (result: MatchView) => void;
  onQuit: () => void;
  online?: OnlineHandles;
}

type Difficulty = 'easy' | 'normal' | 'hard';
const DIFFICULTY: Record<Difficulty, number> = { easy: 0.25, normal: 0.5, hard: 0.8 };
const DIFFICULTY_KEY = 'spar.difficulty';
const VOLUME_KEY = 'spar.volume';

/** Keep the winner card up this long before handing the result to the parent. */
const END_LINGER_MS = 3000;
/** Wait for the last remote inputs to confirm before hashing the log. */
const SUBMIT_AFTER_MS = 800;
/** Ignore an opponent pose older than this (stream dropped) and fall back to the canned figure. */
const POSE_STALE_MS = 1500;
const KNOCKDOWN_COUNT_FRAMES = 600;
const CROWD_BASE = 0.12;

const KEY_HINT =
  'J jab · K cross · U/I hooks · N/M uppers · B (hold) body\n' +
  'A/D slip · S duck · Space guard · W/X step in/out · Q/E step · G get up';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function isDifficulty(v: string | null): v is Difficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

export function FightScreen({ mode, input, onDone, onQuit, online }: FightScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sfxRef = useRef<Sfx | null>(null);
  const onDoneRef = useRef(onDone);
  const onQuitRef = useRef(onQuit);
  onDoneRef.current = onDone;
  onQuitRef.current = onQuit;

  const [difficulty, setDifficulty] = useState<Difficulty>(() => {
    const v = readStorage(DIFFICULTY_KEY);
    return isDifficulty(v) ? v : 'normal';
  });
  const [started, setStarted] = useState(mode === 'online');
  const [volume, setVolume] = useState(() => {
    const saved = readStorage(VOLUME_KEY);
    const value = saved === null ? 0.8 : Number(saved);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
  });
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const [netLine, setNetLine] = useState('');

  // Own sound inside effect setup: StrictMode can tear down and set up effects again
  // without another render. Each setup must get a fresh, undisposed sound engine.
  useEffect(() => {
    const sfx = createSfx(volumeRef.current);
    sfxRef.current = sfx;
    // Online mode has no Start button; unlock on a gesture using the current engine.
    const unlock = () => {
      void sfxRef.current?.resume();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      if (sfxRef.current === sfx) sfxRef.current = null;
      sfx.dispose();
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sfx = sfxRef.current!;
    void sfx.resume();

    let alive = true;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(() => alive && fn(), ms));
    };

    // ── session ──
    let localPlayer: 0 | 1;
    let session: RollbackSessionLike;
    let ownsSession = false;
    if (mode === 'online') {
      if (!online) throw new Error('FightScreen mode="online" requires `online` handles');
      localPlayer = online.localPlayer;
      session = online.session;
    } else {
      const seed = (Date.now() & 0xffffffff) >>> 0;
      localPlayer = 0;
      const bot = createBot(seed, DIFFICULTY[difficulty]);
      session = createLocalSession({
        sim,
        seed,
        localPlayer: 0,
        // The bot is player 1; the session hands us (view, frame) and the bot wants (view, player).
        remoteInput: (view) => bot(view, 1),
      });
      ownsSession = true;
    }
    const names = {
      local: 'YOU',
      opponent: mode === 'online' && online?.peerName ? online.peerName.toUpperCase().slice(0, 14) : 'THEM',
    };

    let renderer = createRenderer(canvas);
    // Keep the large 3D engine off the home/Dojo path; the compatible view runs while it loads.
    void import('../render/ArenaRenderer').then(({ createArenaRenderer }) => {
      if (!alive) return;
      const next = createArenaRenderer(canvas, () => {
        if (!alive) return;
        renderer.dispose();
        renderer = createRenderer(canvas);
      });
      renderer.dispose();
      renderer = next;
    }).catch((error) => {
      if (alive) console.warn('[fight] 3D unavailable, using the compatibility renderer', error);
    });
    const feed = createEventFeed();

    let latestView: MatchView | null = null;
    let latestStats: NetStats | null = null;
    let stalled = false;
    let pendingEvents: SimEvent[] = [];
    let opponentPose: PoseFrame | null = null;
    let opponentPoseAt = 0;
    let crowd = CROWD_BASE;
    let lastCrowdSent = -1;
    let lastFrameMs = performance.now();
    let lastNetLineAt = 0;
    let overAt = -1;
    let submitted = false;
    let finished = false;
    let lastCount = 0;

    const offPose = online?.poseStream.onFrame((f) => {
      opponentPose = f;
      opponentPoseAt = performance.now();
    });

    const poseTimer =
      mode === 'online' && online
        ? setInterval(() => {
            const p = input.latestPose();
            if (p) online.poseStream.send(p);
          }, 1000 / POSE_STREAM_HZ)
        : null;

    function onEvents(events: SimEvent[]): void {
      for (const e of events) {
        switch (e.kind) {
          case 'HIT':
            sfx.hit(e.damage ?? 40);
            crowd = Math.min(1, crowd + 0.08 + (e.damage ?? 0) / 600);
            break;
          case 'COUNTER':
            crowd = Math.min(1, crowd + 0.12);
            break;
          case 'BLOCK':
            sfx.block();
            break;
          case 'MISS':
            sfx.whiff();
            break;
          case 'EVADE':
            sfx.whiff();
            crowd = Math.min(1, crowd + 0.04);
            break;
          case 'STUN':
            crowd = Math.min(1, crowd + 0.18);
            break;
          case 'KNOCKDOWN':
            sfx.knockdown();
            crowd = 1;
            break;
          case 'GET_UP':
            crowd = Math.min(1, crowd + 0.25);
            break;
          case 'BELL':
            sfx.bell();
            if (e.detail === 'END') later(() => sfx.bell(), 260);
            break;
          case 'MATCH_END':
            crowd = 1;
            sfx.bell();
            later(() => sfx.bell(), 220);
            later(() => sfx.bell(), 440);
            break;
          case 'ROUND_END':
          case 'STEP':
            break;
        }
      }
    }

    const loop = createGameLoop({
      session,
      input,
      onTick: (r) => {
        latestView = r.view;
        latestStats = r.stats;
        stalled = r.stalled;
        if (import.meta.env.DEV) (window as unknown as { __sparView?: unknown }).__sparView = r.view;
        const fresh = feed.push(r.events);
        if (fresh.length) {
          pendingEvents.push(...fresh);
          onEvents(fresh);
        }
        let count = 0;
        for (const f of r.view.fighters) {
          if (f.phase === 'KNOCKDOWN') {
            count = Math.max(count, Math.floor((KNOCKDOWN_COUNT_FRAMES - f.phaseFrames) / 60) + 1);
          }
        }
        if (count !== lastCount) {
          if (count > 0) sfx.countdownTick();
          lastCount = count;
        }
        if (r.view.state === 'OVER' && overAt < 0) overAt = performance.now();
      },
      onFrameRender: () => {
        const now = performance.now();
        const dt = Math.min(100, now - lastFrameMs);
        lastFrameMs = now;
        if (!latestView) return;

        crowd = Math.max(CROWD_BASE, crowd - dt / 6000);
        if (Math.abs(crowd - lastCrowdSent) > 0.01 || now - lastNetLineAt > 500) {
          sfx.crowd(crowd);
          lastCrowdSent = crowd;
        }

        const pose = opponentPose && now - opponentPoseAt < POSE_STALE_MS ? opponentPose : null;
        const stats =
          mode === 'online' && latestStats
            ? {
                // Peer-path measurement only; signaling RTT is a different connection.
                rttMs: latestStats.rttMs,
                rollbackFrames: latestStats.rollbackFrames,
                framesAhead: latestStats.framesAhead,
              }
            : undefined;
        renderer.draw({
          view: latestView,
          localPlayer,
          opponentPose: pose,
          localPose: input.latestPose(),
          inputKind: input.kind,
          events: pendingEvents,
          nowMs: now,
          stalled,
          stats,
          names,
        });
        pendingEvents = [];

        if (stats && now - lastNetLineAt > 500) {
          lastNetLineAt = now;
          setNetLine(`${stats.rttMs > 0 ? `Peer RTT ${Math.round(stats.rttMs)} ms` : 'Peer RTT pending'} · rollback ${stats.rollbackFrames}f${stalled ? ' · SYNC' : ''}`);
        }

        if (overAt >= 0 && !submitted && now - overAt >= SUBMIT_AFTER_MS) {
          submitted = true;
          if (mode === 'online' && online) {
            try {
              const log = session.inputLog();
              const { hash } = replay(online.seed, log);
              online.submitResult(hash, log);
            } catch (err) {
              console.error('[fight] result submission failed', err);
            }
          }
        }
        if (overAt >= 0 && !finished && now - overAt >= END_LINGER_MS) {
          finished = true;
          loop.stop();
          onDoneRef.current(latestView);
        }
      },
    });
    loop.start();

    return () => {
      alive = false;
      for (const t of timers) clearTimeout(t);
      loop.stop();
      if (poseTimer !== null) clearInterval(poseTimer);
      offPose?.();
      renderer.dispose();
      sfx.crowd(0);
      if (ownsSession) session.close();
    };
    // `difficulty` is read once when the fight starts; changing it later is a new fight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, mode, input, online]);

  const pickDifficulty = (d: Difficulty) => {
    setDifficulty(d);
    writeStorage(DIFFICULTY_KEY, d);
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    sfxRef.current?.setVolume(v);
    writeStorage(VOLUME_KEY, String(v));
  };

  const start = () => {
    void sfxRef.current?.resume();
    setStarted(true);
  };

  return (
    <div className="fs">
      <div className="fs__bar">
        <span className={`fs__mode${mode === 'online' ? ' fs__mode--blue' : ''}`}>
          {mode === 'bot' ? (
            <>
              vs <em>bot</em> · {difficulty}
            </>
          ) : (
            <>
              vs <em>{online?.peerName ?? 'peer'}</em>
            </>
          )}
        </span>
        {netLine && <span className="fs__hint">{netLine}</span>}
        <span className="fs__bar-spacer" />
        <label className="fs__vol">
          vol
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="Volume"
          />
        </label>
        <button type="button" className="fs__btn fs__btn--ghost" onClick={() => onQuitRef.current()}>
          Quit
        </button>
      </div>

      <div className="fs__stage">
        <canvas ref={canvasRef} className="fs__canvas" />
        {!started && mode === 'bot' && (
          <div className="fs__setup">
            <div className="fs__card">
              <h2>ENTER THE RING</h2>
              <p>Find your distance, protect your head, and pick your opening. Higher difficulties react faster and defend more often.</p>
              <div className="fs__seg" role="radiogroup" aria-label="Difficulty">
                {(['easy', 'normal', 'hard'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="fs__btn"
                    aria-pressed={difficulty === d}
                    onClick={() => pickDifficulty(d)}
                  >
                    {d[0].toUpperCase() + d.slice(1)}
                  </button>
                ))}
              </div>
              {input.kind === 'keyboard' && <div className="fs__hint">{KEY_HINT}</div>}
              {input.kind === 'camera' && (
                <div className="fs__hint">camera input · stance {input.stance()}</div>
              )}
              <button type="button" className="fs__btn fs__btn--red fs__btn--lg" onClick={start}>
                Start
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
