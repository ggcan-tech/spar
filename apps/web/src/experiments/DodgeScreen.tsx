import { useEffect, useRef, useState } from 'react';
import { BIT, HELD_MASK } from '@spar/protocol';
import type { InputSource } from '../input/InputSource';
import { newDodge, stepDodge, dodgeResult, DODGE_FRAMES } from './dodge';
import { controlPauseReason } from './controlReadiness';
import './dodge.css';

export function DodgeScreen({ input, onBack, onSetup }: { input: InputSource; onBack: () => void; onSetup: () => void }) {
  const [game, setGame] = useState(newDodge);
  const [playing, setPlaying] = useState(false);
  const [pause, setPause] = useState('');
  const [choice, setChoice] = useState<'again' | 'boxing' | null>(null);
  const [saved, setSaved] = useState(false);
  const current = useRef(game);
  const touch = useRef(0);
  const touchUsed = useRef(false);
  const stats = useRef({ pausedMs: 0, maxPoseAgeMs: 0, sessionStarted: '' });

  useEffect(() => {
    if (!playing) return;
    let id = 0, last = performance.now(), accumulator = 0, wasPaused = false;
    const frame = (now: number) => {
      const elapsed = now - last; last = now;
      const pose = input.kind === 'camera' ? input.latestPose() : null;
      const age = pose ? now - pose.t : null;
      if (age !== null && Number.isFinite(age)) stats.current.maxPoseAgeMs = Math.max(stats.current.maxPoseAgeMs, age);
      const reason = controlPauseReason(input.kind, pose, now, document.hidden, elapsed);
      // A long frame must not turn into an unseen burst of attacks.
      if (reason) {
        stats.current.pausedMs += elapsed; accumulator = 0; input.sample(); input.events();
        touch.current = 0; wasPaused = true; setPause(reason);
      } else {
        if (wasPaused) {
          // Do not deliver an impulse accumulated between the final stale frame and reacquisition.
          input.sample(); input.events(); touch.current = 0; accumulator = 0; wasPaused = false;
        }
        setPause(''); accumulator += elapsed;
        while (accumulator >= 1000 / 60 && !current.current.over) {
          current.current = stepDodge(current.current, input.sample() | touch.current);
          touch.current &= HELD_MASK;
          input.events(); accumulator -= 1000 / 60;
        }
        setGame(current.current);
      }
      if (current.current.over) { setPlaying(false); return; }
      id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }, [playing, input]);

  function start() {
    input.sample(); input.events();
    const next = newDodge(); current.current = next; setGame(next);
    stats.current = { pausedMs: 0, maxPoseAgeMs: 0, sessionStarted: new Date().toISOString() };
    touch.current = 0; touchUsed.current = false;
    setPause(''); setChoice(null); setSaved(false); setPlaying(true);
  }
  function download() {
    const report = { schema: 'spar-control-study-v1', mode: 'dodge-bot', input: input.kind, touchPreviewUsed: touchUsed.current,
      status: game.over ? 'complete' : 'incomplete', result: game.over ? dodgeResult(game) : null,
      simulatedSeconds: game.frame / 60, shots: game.shots, hits: game.hits,
      dodges: game.dodges, received: game.received, preference: choice, ...stats.current,
      limits: ['Local bot only', 'Throws use existing punch recognition', 'No human accuracy or online latency measurement', 'No video or landmarks included'] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'spar-control-study.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setSaved(true);
  }
  const seconds = Math.ceil((DODGE_FRAMES - game.frame) / 60);
  const result = dodgeResult(game);
  const x = (lane: number) => 400 + lane * 185;
  return <main className="dodge-page">
    <div className="dodge-heading">
      <div><p className="dodge-eyebrow">SPAR / CONTROL STUDY 02</p><h1>Read the throw.<br /><span>Find the gap.</span></h1></div>
      <button className="btn btn--ghost btn--md" onClick={onBack}>Back to boxing</button>
    </div>
    <div className="dodge-layout">
      <section className="dodge-arena" aria-label="Dodge duel practice arena">
        <div className="dodge-score"><div><small>YOU</small><b>{game.hp}<span> / 8</span></b></div><div className="dodge-clock" aria-label={`${seconds} seconds remaining`}>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</div><div><small>BOT</small><b>{game.rivalHp}<span> / 8</span></b></div></div>
        <svg viewBox="0 0 800 650" role="img" aria-label="Three lanes. Move away from the incoming orange ball; throw toward the bot.">
          <defs>
            <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#141f2a" /><stop offset="1" stopColor="#27363a" /></linearGradient>
            <radialGradient id="ball"><stop stopColor="#fff1cc" /><stop offset=".35" stopColor="#ffba66" /><stop offset="1" stopColor="#ef6647" /></radialGradient>
          </defs>
          <path d="M220 240H580L800 650H0Z" fill="url(#floor)" />
          <path d="M220 240L0 650M340 240L270 650M460 240L530 650M580 240L800 650" stroke="#5b7475" strokeWidth="1" />
          {[300, 380, 490, 630].map(y => <path key={y} d={`M${220 - (y - 240) * .54} ${y}H${580 + (y - 240) * .54}`} stroke="#597273" opacity=".35" />)}
          <text x="400" y="105" textAnchor="middle" fill="#668187" fontSize="15" letterSpacing="7">STAY IN YOUR SPACE</text>
          <g transform={`translate(${400 + game.rivalLane * 110},185)`}>
            <ellipse cy="80" rx="46" ry="10" fill="#000" opacity=".35" />
            <circle cy="-10" r="20" fill="#d8e7e5" /><path d="M-30 55L-25 15Q0 0 25 15L30 55Z" fill="#78b9ad" />
            <path d="M-15 55L-20 76M15 55L20 76" stroke="#d8e7e5" strokeWidth="10" strokeLinecap="round" />
          </g>
          {game.outgoing.map(b => { const p = (game.frame - b.born) / (b.arrives - b.born); return <circle key={b.id} cx={x(b.lane) + (400 + b.lane * 110 - x(b.lane)) * p} cy={520 - 300 * p} r={18 - 10 * p} fill="#a5f4df" />; })}
          {game.incoming.map(b => { const p = (game.frame - b.born) / (b.arrives - b.born); return <g key={b.id}>
            <ellipse cx={x(b.lane)} cy={b.low ? 594 : 510} rx="64" ry="17" fill="none" stroke="#ff9a71" strokeWidth="2" strokeDasharray="6 7" opacity={.35 + p * .6} />
            <circle cx={400 + b.lane * (110 + 75 * p)} cy={225 + (b.low ? 370 : 275) * p} r={10 + p * 27} fill="url(#ball)" />
          </g>; })}
          <g transform={`translate(${x(game.lane)},${game.duck ? 590 : 515})`}>
            <ellipse cy="35" rx="60" ry="13" fill="#a5f4df" opacity=".18" />
            <circle r="23" fill="#a5f4df" fillOpacity=".12" stroke="#a5f4df" strokeWidth="3" />
            <path d="M-36 40Q-32 12 0 17Q32 12 36 40" fill="none" stroke="#a5f4df" strokeWidth="3" />
          </g>
          {[-1, 0, 1].map(l => <text key={l} x={x(l)} y="640" textAnchor="middle" fill="#879b9e" fontSize="12" letterSpacing="3">{l === -1 ? 'LEFT' : l === 0 ? 'CENTRE' : 'RIGHT'}</text>)}
        </svg>
        <div className="dodge-feedback" aria-live="polite">{pause || (game.frame < game.feedbackUntil ? game.feedback : 'Watch the orange ball')}</div>
        {!playing && <div className="dodge-overlay">
          <p className="dodge-eyebrow">{game.over ? 'ROUND COMPLETE' : 'BOT ROUND · UP TO 60 SECONDS'}</p>
          <h2>{game.over ? result === 'win' ? 'You found the gaps.' : result === 'loss' ? 'One more read.' : 'Evenly matched.' : 'Move first.\nThrow second.'}</h2>
          <p>{game.over ? `${game.hits} hits · ${game.dodges} escapes · ${game.received} hits taken` : 'Lean left or right. Duck high throws. Punch to send a ball down your lane.'}</p>
          <button className="btn btn--red" onClick={start}>{game.over ? 'Play again' : 'Start round'}</button>
        </div>}
        {input.kind === 'keyboard' && playing && <div className="dodge-touch" aria-label="Touch preview controls">
          {([{label:'Lean left',bit:BIT.SLIP_L},{label:'Duck',bit:BIT.DUCK},{label:'Lean right',bit:BIT.SLIP_R}]).map(({label,bit}) => <button key={bit} type="button" onPointerDown={e => {e.currentTarget.setPointerCapture(e.pointerId); touch.current |= bit; touchUsed.current = true;}} onPointerUp={() => {touch.current &= ~bit;}} onPointerCancel={() => {touch.current &= ~bit;}} onLostPointerCapture={() => {touch.current &= ~bit;}}>{label}</button>)}
          <button type="button" disabled={game.frame < game.nextShot} onClick={() => {touch.current |= BIT.JAB; touchUsed.current = true;}}>{game.frame < game.nextShot ? 'Recharging' : 'Throw'}</button>
        </div>}
      </section>
      <aside className="dodge-guide">
        <p className="dodge-eyebrow">THE CHALLENGER</p><h2>Dodge duel</h2>
        <p>A small playable experiment to compare with boxing. The orange ball commits to your position when it launches. Move after the release.</p>
        <ol><li><strong>Read</strong><span>Orange circles show where the throw will arrive.</span></li><li><strong>Escape</strong><span>Lean left, lean right, or duck. Staying crouched will not keep you safe.</span></li><li><strong>Answer</strong><span>Line up with the bot and throw. Your ball stays in its lane.</span></li></ol>
        <div className="dodge-input"><strong>{input.kind === 'camera' ? 'Camera controls active' : 'Keyboard / touch preview'}</strong><p>{input.kind === 'camera' ? 'Keep your head and hips visible. Uses calibrated boxing gestures; a punch launches the ball. Natural throwing is not implemented.' : 'A / D: lean · S: duck · J: throw. Or hold the on-screen controls during a round. Set up the camera to compare physical controls.'}</p><button className="linkish" onClick={onSetup}>Set up camera</button></div>
        <p className="dodge-limit">Local bot only. This experiment does not validate online play or camera accuracy.</p>
        {game.over && <div className="dodge-study"><h3>What would you play next?</h3><div className="btn-row"><button className="btn btn--sm" aria-pressed={choice === 'again'} onClick={() => setChoice('again')}>Dodge duel</button><button className="btn btn--sm" aria-pressed={choice === 'boxing'} onClick={() => setChoice('boxing')}>Boxing</button></div><button className="linkish" onClick={download}>Save this round locally</button><p>{saved ? 'Round report downloaded.' : 'Only scores, input mode, timing and your choice. No camera images. Nothing uploaded.'}</p></div>}
      </aside>
    </div>
  </main>;
}
