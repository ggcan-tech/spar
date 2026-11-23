import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputSource } from '../input/InputSource';

// Run the real component's effect setup/cleanup twice without rerendering, which is the
// StrictMode lifecycle that previously left its sound ref pointing to a disposed engine.
const harness = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useEffect: (setup: () => void | (() => void)) => { harness.effects.push(setup); },
}));
vi.mock('../audio/sfx', () => ({ createSfx: vi.fn(() => ({ resume: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() })) }));

import { FightScreen } from './FightScreen';
import { createSfx } from '../audio/sfx';

beforeEach(() => {
  harness.effects = [];
  vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) });
});
afterEach(() => { vi.unstubAllGlobals(); });
const renderSetup = () => FightScreen({ mode: 'bot', input: { kind: 'keyboard' } as InputSource, onDone: vi.fn(), onQuit: vi.fn() });
const mount = () => harness.effects.map((setup) => setup());
const unmount = (cleanups: ReturnType<typeof mount>) => cleanups.forEach((cleanup) => cleanup?.());

describe('fight sound ownership', () => {
  it('creates a fresh sound engine after StrictMode teardown and gestures use it', () => {
    renderSetup();
    expect(createSfx).not.toHaveBeenCalled(); // Abandoned render cannot own an engine.
    const firstCleanup = mount();
    const first = vi.mocked(createSfx).mock.results[0].value;
    window.dispatchEvent(new Event('pointerdown'));
    expect(first.resume).toHaveBeenCalledTimes(1);
    unmount(firstCleanup);
    expect(first.dispose).toHaveBeenCalledTimes(1);

    const secondCleanup = mount();
    expect(createSfx).toHaveBeenCalledTimes(2);
    const second = vi.mocked(createSfx).mock.results[1].value;
    expect(second).not.toBe(first);
    window.dispatchEvent(new Event('keydown'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(second.resume).toHaveBeenCalledTimes(2);
    expect(first.resume).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    unmount(secondCleanup);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('keydown'));
    expect(second.resume).toHaveBeenCalledTimes(2);
  });

  it('preserves saved mute across setup replay', () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => key === 'spar.volume' ? '0' : null);
    renderSetup();
    const cleanup = mount();
    expect(createSfx).toHaveBeenLastCalledWith(0);
    unmount(cleanup);
    unmount(mount());
    expect(createSfx).toHaveBeenLastCalledWith(0);
  });
});
