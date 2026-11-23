import { Suspense, lazy, useCallback, useState } from 'react';
import type { MatchView } from '@spar/protocol';
import { FightScreen } from './screens/FightScreen';
import { OnlineScreen } from './screens/OnlineScreen';
import { ResultScreen } from './screens/ResultScreen';
import { HomeScreen } from './screens/HomeScreen';
import { useInputStore } from './input/store';
import { cameraSession } from './camera/session';

// The Dojo pulls in MediaPipe (~MB of JS + WASM loader); keep it off the home screen's critical path.
const DojoScreen = lazy(() => import('./screens/DojoScreen').then((m) => ({ default: m.DojoScreen })));
const POVScreen = lazy(() => import('./pov/POVScreen').then((m) => ({ default: m.POVScreen })));
const BoxScreen = lazy(() => import('./box/BoxScreen').then((m) => ({ default: m.BoxScreen })));
const ProbeScreen = lazy(() => import('./box/ProbeScreen').then((m) => ({ default: m.ProbeScreen })));
const RealScreen = lazy(() => import('./box/real/RealScreen').then((m) => ({ default: m.RealScreen })));
const ClipViewer = lazy(() => import('./box/motion/ClipViewer').then((m) => ({ default: m.ClipViewer })));
// The sling-and-dodge duel's test pages: /?duel=1 (&probe, &sling, &dodge).
const DuelScreen = lazy(() => import('./duel/DuelScreen').then((m) => ({ default: m.DuelScreen })));
// The delay test page: /?lab=latency (CORE.md stage 1).
const LatencyLab = lazy(() => import('./camera/LatencyLab').then((m) => ({ default: m.LatencyLab })));

type Screen = 'home' | 'dojo' | 'bot' | 'online' | 'result' | 'dodge' | 'box' | 'duel' | 'lab';
type FightMode = 'bot' | 'online';

interface LastResult {
  view: MatchView;
  localPlayer: 0 | 1;
  mode: FightMode;
}

const SCREEN_LABEL: Record<Screen, string> = {
  home: '',
  dojo: 'Dojo',
  bot: 'vs Bot',
  online: 'Online',
  result: 'Result',
  dodge: 'POV ball duel',
  box: 'Boxing',
  duel: 'Duel',
  lab: 'Delay test',
};

export function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const query = new URLSearchParams(location.search);
    // /?tap=1 is the dodgeball screen in tap mode: aim by touching the screen, dodge with the body.
    if (query.get('lab') === 'latency') return 'lab';
    return query.has('duel') ? 'duel' : query.has('box') ? 'box' : query.has('pov') || query.has('tap') || query.has('play') ? 'dodge' : 'home';
  });
  const [last, setLast] = useState<LastResult | null>(null);
  const { input } = useInputStore();

  const goHome = useCallback(() => setScreen('home'), []);

  /** Tolerant onDone: FightScreen/OnlineScreen may pass only the view; localPlayer defaults to 0. */
  const makeOnDone = useCallback(
    (mode: FightMode) => (view: MatchView, localPlayer?: 0 | 1) => {
      setLast({ view, localPlayer: localPlayer ?? 0, mode });
      setScreen('result');
    },
    [],
  );

  const leaveDojo = useCallback(() => {
    // Camera stays on only if it's actually the active input (calibrated); otherwise release it.
    if (input.kind !== 'camera') cameraSession.stop();
    setScreen('home');
  }, [input]);

  let body: JSX.Element;
  switch (screen) {
    case 'home':
      body = <HomeScreen onDojo={() => setScreen('dojo')} onFightBot={() => setScreen('bot')} onFightOnline={() => setScreen('online')} onDodge={() => setScreen('dodge')} onBox={() => setScreen('box')} />;
      break;
    case 'box':
      // The real exchange is the game: /?box=1. The one-minute camera check: /?box=1&probe.
      // The first build (lit gloves, cue words, drills) is kept for comparison: /?box=1&classic, or any of its ?mode= pages.
      body = (() => {
        const query = new URLSearchParams(location.search);
        if (query.has('probe'))
          return <Suspense fallback={<div className="center-screen">Loading the camera check…</div>}><ProbeScreen onBack={() => { location.search = '?box=1'; }} /></Suspense>;
        // Every recorded clip on the figure, with its events on a speed and reach graph: /?box=1&clips
        if (query.has('clips'))
          return <Suspense fallback={<div className="center-screen">Loading the clips…</div>}><ClipViewer /></Suspense>;
        if (query.has('classic') || query.has('mode'))
          return <Suspense fallback={<div className="center-screen">Loading the ring…</div>}><BoxScreen onBack={goHome} /></Suspense>;
        return <Suspense fallback={<div className="center-screen">Loading the ring…</div>}><RealScreen onBack={goHome} /></Suspense>;
      })();
      break;
    case 'dodge':
      body = <Suspense fallback={<div className="center-screen">Loading your court…</div>}><POVScreen onBack={goHome} /></Suspense>;
      break;
    case 'lab':
      body = <Suspense fallback={<div className="center-screen">Loading…</div>}><LatencyLab /></Suspense>;
      break;
    case 'duel':
      body = <Suspense fallback={<div className="center-screen">Loading the duel…</div>}><DuelScreen onBack={() => { location.search = ''; }} /></Suspense>;
      break;
    case 'dojo':
      body = (
        <Suspense fallback={<div className="center-screen"><span className="topbar__status">Loading the Dojo…</span></div>}>
          <DojoScreen onBack={leaveDojo} onFightBot={() => setScreen('bot')} onFightOnline={() => setScreen('online')} />
        </Suspense>
      );
      break;
    case 'bot':
      body = <FightScreen key={`bot-${input.kind}`} mode="bot" input={input} onDone={makeOnDone('bot')} onQuit={goHome} />;
      break;
    case 'online':
      body = <OnlineScreen key={`online-${input.kind}`} input={input} onDone={makeOnDone('online')} onQuit={goHome} />;
      break;
    case 'result':
      if (!last) {
        body = <HomeScreen onDojo={() => setScreen('dojo')} onFightBot={() => setScreen('bot')} onFightOnline={() => setScreen('online')} onDodge={() => setScreen('dodge')} onBox={() => setScreen('box')} />;
      } else {
        body = <ResultScreen result={last.view} localPlayer={last.localPlayer} onHome={goHome} onRematch={() => setScreen(last.mode)} />;
      }
      break;
  }

  return (
    <div className="app">
      {screen !== 'home' && screen !== 'dodge' && screen !== 'box' && screen !== 'duel' && screen !== 'lab' && (
        <header className="topbar">
          <span className="topbar__brand">
            SP<em>A</em>R
          </span>
          <span className="topbar__screen">{SCREEN_LABEL[screen]}</span>
          <span className="topbar__spacer" />
          <span className="topbar__status">{input.kind === 'camera' ? `camera · ${input.stance()}` : 'keyboard'}</span>
        </header>
      )}
      {body}
    </div>
  );
}
