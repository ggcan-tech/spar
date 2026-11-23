import { MobileReadiness } from '../ui/MobileReadiness';
import { Button } from '../ui/Button';
import { KEYMAP } from '../input/keymap';
import { useInputStore, inputStore } from '../input/store';
import { cameraSession, useCameraSession } from '../camera/session';

export interface HomeScreenProps {
  onDojo: () => void;
  onFightBot: () => void;
  onFightOnline: () => void;
  onDodge?: () => void;
  onBox?: () => void;
}

export function HomeScreen({ onDojo, onFightBot, onFightOnline, onDodge, onBox }: HomeScreenProps) {
  const { input, calibration } = useInputStore();
  const cam = useCameraSession();

  const useKeyboard = () => {
    inputStore.resetToKeyboard();
    cameraSession.stop();
  };

  let sourceLine: JSX.Element;
  if (input.kind === 'camera') {
    sourceLine = (
      <>
        Input: <strong>camera · {input.stance()}</strong>
        <button type="button" className="linkish" onClick={useKeyboard}>
          use keyboard instead
        </button>
      </>
    );
  } else if (cam.status === 'live') {
    sourceLine = (
      <>
        Input: <strong>keyboard</strong> · camera is starting — open the Dojo
      </>
    );
  } else {
    sourceLine = (
      <>
        Input: <strong>keyboard</strong>
        {calibration ? ' · tracking preferences saved' : ' · open the Dojo to use your camera'}
      </>
    );
  }

  return (
    <div className="home">
      <h1 className="home__title">SPAR</h1>
      <p className="home__pitch">Real shadow boxing in front of your webcam. Your body is the controller. Fight a human online.</p>

      <div className="home__actions">
        <Button variant="red" onClick={onDojo} autoFocus>
          Dojo (camera setup)
        </Button>
        <Button onClick={onFightBot}>Fight the bot</Button>
        <Button variant="blue" onClick={onFightOnline}>
          Fight online
        </Button>
      </div>

      <div className="home__source">{sourceLine}</div>

      {onBox && <section className="home__experiment" aria-label="First-person boxing">
        <div><span className="home__experiment-label">NEW · FIRST-PERSON BOXING</span><h2>Step into the ring.</h2><p>Box an opponent that stands in front of you. Your camera follows your fists and your head: punch, slip, duck, block.</p></div>
        <Button variant="ghost" onClick={onBox}>Enter the ring</Button>
      </section>}

      {onDodge && <section className="home__experiment" aria-label="First-person ball duel">
        <div><span className="home__experiment-label">MOTION SERIES · POV PLAYTEST</span><h2>Read the flight.</h2><p>A first-person ball duel with continuous movement, curved flight and a bounded play space.</p></div>
        <Button variant="ghost" onClick={onDodge}>Enter POV court</Button>
      </section>}

      <details className="keys">
        <summary>Keyboard controls</summary>
        <div className="keys__grid">
          {KEYMAP.map((b) => (
            <div className="keys__row" key={b.code}>
              <span className="kbd">{b.label}</span>
              <span>{b.description}</span>
            </div>
          ))}
        </div>
      </details>
      <MobileReadiness />
    </div>
  );
}
