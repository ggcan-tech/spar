import type { InputSource } from './InputSource';
import { createCombinedInput } from './InputSource';
import { createKeyboardInput } from './keyboard';
import { inputStore } from './store';

function fake(kind: InputSource['kind'], bits = 0): InputSource & { disposed: boolean } {
  const src = {
    kind,
    disposed: false,
    sample: () => bits,
    events: () => [],
    latestPose: () => null,
    stance: () => 'orthodox' as const,
    dispose() {
      src.disposed = true;
    },
  };
  return src;
}

describe('inputStore', () => {
  it('defaults to a keyboard source and notifies subscribers on set', () => {
    expect(inputStore.get().kind).toBe('keyboard');
    let calls = 0;
    const off = inputStore.subscribe(() => calls++);
    const prev = inputStore.get();
    const cam = fake('camera');
    inputStore.set(cam, { calibration: { stance: 'orthodox' } as never });
    expect(inputStore.get()).toBe(cam);
    expect(inputStore.state().calibration).toEqual({ stance: 'orthodox' });
    expect(calls).toBe(1);
    // previous source was disposed (keyboard listeners removed)
    expect(prev.sample()).toBe(0);
    off();
    inputStore.resetToKeyboard();
    expect(cam.disposed).toBe(true);
    expect(inputStore.get().kind).toBe('keyboard');
    expect(inputStore.state().calibration).toBeNull();
    expect(calls).toBe(1); // unsubscribed
  });

  it('keeps calibration when a camera source is replaced without extras', () => {
    const a = fake('camera');
    inputStore.set(a, { calibration: { stance: 'southpaw' } as never });
    const b = fake('camera');
    inputStore.set(b);
    expect(a.disposed).toBe(true);
    expect(inputStore.state().calibration).toEqual({ stance: 'southpaw' });
    inputStore.resetToKeyboard();
  });
});

describe('createCombinedInput', () => {
  it('ORs samples and merges events by time', () => {
    const t = new EventTarget();
    const kb = createKeyboardInput({ target: t, now: () => 5 });
    const cam = fake('camera', 1 << 10);
    const combined = createCombinedInput(cam, kb);
    expect(combined.kind).toBe('camera');
    const ev = new Event('keydown', { cancelable: true });
    Object.assign(ev, { code: 'KeyJ', repeat: false });
    t.dispatchEvent(ev);
    expect(combined.sample()).toBe((1 << 10) | 1);
    expect(combined.events().map((e) => e.type)).toEqual(['JAB']);
    combined.dispose();
    expect(cam.disposed).toBe(true);
  });
});
