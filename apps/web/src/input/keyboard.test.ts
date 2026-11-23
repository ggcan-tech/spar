import { BIT } from '@spar/protocol';
import { createKeyboardInput } from './keyboard';

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}) {
  const ev = new Event(type, { cancelable: true });
  Object.assign(ev, { code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  target.dispatchEvent(ev);
}

describe('createKeyboardInput', () => {
  it('fires an impulse once per keydown and ignores auto-repeat', () => {
    const t = new EventTarget();
    let now = 100;
    const input = createKeyboardInput({ target: t, now: () => now });
    key(t, 'keydown', 'KeyJ');
    key(t, 'keydown', 'KeyJ', { repeat: true });
    key(t, 'keydown', 'KeyJ'); // still down → no double fire
    expect(input.sample()).toBe(BIT.JAB);
    expect(input.sample()).toBe(0); // drained
    const evs = input.events();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'JAB', t: 100, confidence: 1, body: false });
    key(t, 'keyup', 'KeyJ');
    now = 250;
    key(t, 'keydown', 'KeyJ');
    expect(input.sample()).toBe(BIT.JAB);
    expect(input.events()[0].t).toBe(250);
    input.dispose();
  });

  it('maps held keys to held bits and reports transitions as events', () => {
    const t = new EventTarget();
    const input = createKeyboardInput({ target: t, now: () => 0 });
    key(t, 'keydown', 'Space');
    key(t, 'keydown', 'KeyA');
    expect(input.sample()).toBe(BIT.GUARD_HIGH | BIT.SLIP_L);
    expect(input.sample()).toBe(BIT.GUARD_HIGH | BIT.SLIP_L); // held bits persist
    expect(input.events().map((e) => e.type)).toEqual(['GUARD_HIGH', 'SLIP_L']);
    key(t, 'keydown', 'KeyD');
    key(t, 'keyup', 'KeyA'); // D still held → no HEAD_CENTER yet
    expect(input.events().map((e) => e.type)).toEqual(['SLIP_R']);
    key(t, 'keyup', 'KeyD');
    key(t, 'keyup', 'Space');
    expect(input.events().map((e) => e.type)).toEqual(['HEAD_CENTER', 'GUARD_LOW']);
    expect(input.sample()).toBe(0);
    input.dispose();
  });

  it('applies the BODY modifier to a punch thrown while B is held', () => {
    const t = new EventTarget();
    const input = createKeyboardInput({ target: t, now: () => 0 });
    key(t, 'keydown', 'KeyB');
    expect(input.sample()).toBe(0); // B alone is nothing
    key(t, 'keydown', 'KeyK');
    expect(input.sample()).toBe(BIT.CROSS | BIT.BODY);
    expect(input.events()[0]).toMatchObject({ type: 'CROSS', body: true });
    key(t, 'keyup', 'KeyB');
    key(t, 'keyup', 'KeyK');
    key(t, 'keydown', 'KeyK');
    expect(input.sample()).toBe(BIT.CROSS);
    input.dispose();
  });

  it('ignores modifier combos, text fields, and clears held keys on blur', () => {
    const t = new EventTarget();
    const input = createKeyboardInput({ target: t, now: () => 0 });
    key(t, 'keydown', 'KeyJ', { metaKey: true });
    expect(input.sample()).toBe(0);
    // Simulate typing in a text field: dispatch from an element-like target.
    const ev = new Event('keydown', { cancelable: true });
    Object.assign(ev, { code: 'KeyJ', repeat: false });
    Object.defineProperty(ev, 'target', { value: { tagName: 'INPUT' } });
    t.dispatchEvent(ev);
    expect(input.sample()).toBe(0);
    key(t, 'keydown', 'Space');
    expect(input.sample()).toBe(BIT.GUARD_HIGH);
    t.dispatchEvent(new Event('blur'));
    expect(input.sample()).toBe(0);
    expect(input.events().map((e) => e.type)).toEqual(['GUARD_HIGH', 'GUARD_LOW']);
    input.dispose();
    key(t, 'keydown', 'KeyJ');
    expect(input.sample()).toBe(0);
  });

  it('falls back to `key` when the event carries no `code`', () => {
    const t = new EventTarget();
    const input = createKeyboardInput({ target: t, now: () => 0 });
    key(t, 'keydown', '', { key: 'J' }); // caps lock
    key(t, 'keydown', '', { key: ' ' });
    expect(input.sample()).toBe(BIT.JAB | BIT.GUARD_HIGH);
    key(t, 'keyup', 'KeyJ'); // release may come with a code — same identity
    key(t, 'keyup', '', { key: ' ' });
    expect(input.sample()).toBe(0);
    expect(input.events().map((e) => e.type)).toEqual(['JAB', 'GUARD_HIGH', 'GUARD_LOW']);
    input.dispose();
  });

  it('caps the event buffer so an undrained source cannot grow unbounded', () => {
    const t = new EventTarget();
    const input = createKeyboardInput({ target: t, now: () => 0 });
    for (let i = 0; i < 600; i++) {
      key(t, 'keydown', 'KeyJ');
      key(t, 'keyup', 'KeyJ');
    }
    expect(input.events().length).toBeLessThanOrEqual(256);
    input.dispose();
  });
});
