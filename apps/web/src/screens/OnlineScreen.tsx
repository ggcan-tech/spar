import { useEffect, useRef, useState } from 'react';
import type { MatchView } from '@spar/protocol';
import { sim } from '@spar/sim';
import type { InputSource } from '../input/InputSource';
import { startOnline, type OnlineStarter } from '../net/online';
import type { OnlineHandles, OnlineStatus, VerifiedMsg } from '../net/types';
import { signalUrl } from '../net/signaling';
import { FightScreen } from './FightScreen';
import '../render/fight.css';

export interface OnlineScreenProps {
  input: InputSource;
  onDone: (result: MatchView, localPlayer?: 0 | 1) => void;
  onQuit: () => void;
}

const NAME_KEY = 'spar.name';

type Phase =
  | { kind: 'idle' }
  | { kind: 'searching'; status: OnlineStatus; detail?: string }
  | { kind: 'fighting'; handles: OnlineHandles }
  | { kind: 'finished'; handles: OnlineHandles; result: MatchView }
  | { kind: 'peer_left'; reason: string; result?: MatchView; localPlayer?: 0 | 1 }
  | { kind: 'error'; message: string };

const STATUS_TEXT: Record<OnlineStatus, string> = {
  connecting: 'Connecting to the lobby…',
  queued: 'In queue',
  matched: 'Matched with',
  'connecting-peer': 'Connecting to your opponent…',
  ready: 'Ready — entering the ring',
  error: 'Something went wrong',
};

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
}

function winnerLabel(winner: MatchView['winner'], localPlayer: 0 | 1): string {
  if (winner === 'DRAW') return 'Draw';
  if (winner === null) return 'No result';
  return winner === localPlayer ? 'You win' : 'You lose';
}

export function OnlineScreen({ input, onDone, onQuit }: OnlineScreenProps) {
  const [name, setName] = useState<string>(loadName);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [verified, setVerified] = useState<VerifiedMsg | null>(null);
  const starterRef = useRef<OnlineStarter | null>(null);
  const handlesRef = useRef<OnlineHandles | null>(null);
  const onDoneRef = useRef(onDone);
  const onQuitRef = useRef(onQuit);
  onDoneRef.current = onDone;
  onQuitRef.current = onQuit;

  // Tear everything down if the screen unmounts mid-flow.
  useEffect(
    () => () => {
      starterRef.current?.cancel();
      handlesRef.current?.close();
      starterRef.current = null;
      handlesRef.current = null;
    },
    [],
  );

  const trimmedName = name.trim();
  const onlineAvailable = Boolean(signalUrl());

  const find = () => {
    if (!trimmedName || !onlineAvailable || starterRef.current) return;
    saveName(trimmedName);
    setVerified(null);
    setPhase({ kind: 'searching', status: 'connecting' });
    const starter = startOnline({ name: trimmedName, sim, input });
    starterRef.current = starter;
    starter.onStatus((status, detail) => {
      if (starterRef.current !== starter) return;
      if (status !== 'error') setPhase({ kind: 'searching', status, detail });
    });
    starter.ready.then(
      (handles) => {
        if (starterRef.current !== starter) {
          handles.close();
          return;
        }
        starterRef.current = null;
        handlesRef.current = handles;
        handles.onVerified((m) => setVerified(m));
        handles.onPeerLeft((reason) => {
          setPhase((p) => {
            if (p.kind === 'finished') return { kind: 'peer_left', reason, result: p.result, localPlayer: handles.localPlayer };
            if (p.kind === 'fighting') return { kind: 'peer_left', reason, localPlayer: handles.localPlayer };
            return p;
          });
        });
        setPhase({ kind: 'fighting', handles });
      },
      (err: unknown) => {
        if (starterRef.current !== starter) return;
        starterRef.current = null;
        const message = err instanceof Error ? err.message : String(err);
        setPhase(message === 'cancelled' ? { kind: 'idle' } : { kind: 'error', message });
      },
    );
  };

  const cancel = () => {
    starterRef.current?.cancel();
    starterRef.current = null;
    setPhase({ kind: 'idle' });
  };

  const closeHandles = () => {
    handlesRef.current?.close();
    handlesRef.current = null;
  };

  const quit = () => {
    starterRef.current?.cancel();
    starterRef.current = null;
    closeHandles();
    onQuitRef.current();
  };

  // ── fight ──
  if (phase.kind === 'fighting') {
    const { handles } = phase;
    return (
      <div className="os__fight">
        <FightScreen
          mode="online"
          input={input}
          online={handles}
          onDone={(result) => setPhase({ kind: 'finished', handles, result })}
          onQuit={quit}
        />
      </div>
    );
  }

  // ── post-fight: wait for the server's verdict ──
  if (phase.kind === 'finished') {
    const { handles, result } = phase;
    const continueToResult = () => {
      closeHandles();
      onDoneRef.current(result, handles.localPlayer);
    };
    return (
      <div className="os">
        <div className="os__panel">
          <h2>
            {winnerLabel(result.winner, handles.localPlayer)}
            {result.method ? <small> · {result.method}</small> : null}
          </h2>
          <div className="os__meta">
            vs {handles.peerName} · match {handles.matchId.slice(0, 8)} · seed {handles.seed}
          </div>
          {verified ? (
            <VerifiedPanel v={verified} localPlayer={handles.localPlayer} />
          ) : (
            <div className="os__status">
              <span className="os__dot os__dot--busy" />
              Result submitted — waiting for both completed replays to be checked…
            </div>
          )}
          <div className="os__row">
            <button type="button" className="fs__btn fs__btn--blue fs__btn--lg" onClick={continueToResult}>
              See full result
            </button>
            <button type="button" className="fs__btn fs__btn--ghost" onClick={quit}>
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'peer_left') {
    const leftResult = phase.result;
    const leftPlayer = phase.localPlayer;
    return (
      <div className="os">
        <div className="os__panel">
          <h2>Opponent disconnected</h2>
          <div className="os__status os__status--err">
            <span className="os__dot os__dot--err" />
            {phase.reason}
          </div>
          {verified && phase.localPlayer !== undefined && <VerifiedPanel v={verified} localPlayer={phase.localPlayer} />}
          <div className="os__row">
            {leftResult && leftPlayer !== undefined && (
              <button
                type="button"
                className="fs__btn fs__btn--blue"
                onClick={() => {
                  closeHandles();
                  onDoneRef.current(leftResult, leftPlayer);
                }}
              >
                See result
              </button>
            )}
            <button type="button" className="fs__btn" onClick={quit}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── lobby ──
  const searching = phase.kind === 'searching';
  return (
    <div className="os">
      <div className="os__panel">
        <h2>
          Fight <em>online</em>
        </h2>
        {!onlineAvailable && <p role="status">Online fights are not available in this build yet. You can still train and fight the bot.</p>}
        <div className="os__field">
          <label className="os__label" htmlFor="os-name">
            Your name
          </label>
          <input
            id="os-name"
            className="os__input"
            value={name}
            maxLength={20}
            placeholder="ring name"
            disabled={searching}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find();
            }}
            autoComplete="off"
          />
        </div>

        {phase.kind === 'searching' && (
          <div className={`os__status${phase.status === 'ready' ? ' os__status--ok' : ''}`}>
            <span className={`os__dot ${phase.status === 'ready' ? 'os__dot--live' : 'os__dot--busy'}`} />
            <span>
              {STATUS_TEXT[phase.status]}
              {phase.status === 'matched' && phase.detail ? <strong> {phase.detail}</strong> : null}
              {phase.status !== 'matched' && phase.detail ? <small> · {phase.detail}</small> : null}
            </span>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="os__status os__status--err">
            <span className="os__dot os__dot--err" />
            <span>{phase.message}</span>
          </div>
        )}

        <div className="os__row">
          {searching ? (
            <button type="button" className="fs__btn" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="fs__btn fs__btn--blue fs__btn--lg"
              disabled={!trimmedName || !onlineAvailable}
              onClick={find}
            >
              Find opponent
            </button>
          )}
          <button type="button" className="fs__btn fs__btn--ghost" onClick={quit}>
            Back
          </button>
        </div>

        <div className="os__meta">
          input: {input.kind}
          {input.kind === 'camera' ? ` · ${input.stance()}` : ''}
          {import.meta.env.DEV && ` · signal: ${signalUrl() || 'not configured'}`}
        </div>
      </div>
    </div>
  );
}

function VerifiedPanel({ v, localPlayer }: { v: VerifiedMsg; localPlayer: 0 | 1 }) {
  const mine = v.ratings[localPlayer];
  const theirs = v.ratings[1 - localPlayer];
  return (
    <div className="os__verified">
      <strong>{v.ok ? 'Replays agree ✓' : 'Result unverified'}</strong>
      {v.ok && <><span>Replay result: {winnerLabel(v.winner, localPlayer)}</span><span className="os__meta">Both submitted replays were checked.</span></>}
      <span className="os__meta">
        rating · you {Math.round(mine)} · them {Math.round(theirs)}
      </span>
      {!v.ok && <span className="os__meta">Both completed replays could not be confirmed. Ratings unchanged.</span>}
    </div>
  );
}
