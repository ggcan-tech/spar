import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
import { Capacitor } from '@capacitor/core';
import { signalUrl, createSignaling } from './signaling';
beforeEach(() => {
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  vi.stubEnv('VITE_SIGNAL_URL', '');
  vi.stubGlobal('location', { search: '', hostname: 'localhost', protocol: 'http:' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('signaling endpoint selection', () => {
  it('keeps the local web development endpoint', () => { expect(signalUrl()).toBe('ws://localhost:8787'); });
  it('uses secure WebSockets from secure web pages', () => {
    vi.stubGlobal('location', { search: '', hostname: 'spar.example', protocol: 'https:' });
    expect(signalUrl()).toBe('wss://spar.example:8787');
  });
  it('does not silently connect a packaged app to its own localhost', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(signalUrl()).toBe('');
    await expect(createSignaling().connect()).rejects.toThrow('not configured');
  });
  it('uses an explicitly configured endpoint in native builds', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.stubEnv('VITE_SIGNAL_URL', 'wss://matches.example');
    expect(signalUrl()).toBe('wss://matches.example');
  });
  it('allows an explicit query override for a test server', () => {
    vi.stubGlobal('location', { search: '?signal=wss%3A%2F%2Ftest.example', hostname: 'localhost', protocol: 'http:' });
    vi.stubEnv('VITE_SIGNAL_URL', 'wss://matches.example');
    expect(signalUrl()).toBe('wss://test.example');
  });
});
