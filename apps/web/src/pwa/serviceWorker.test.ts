import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const events = new Map<string, (event: unknown) => void>();
  const fallback = new Response('saved offline screen', { headers: { 'Content-Type': 'text/html' } });
  const cache = { add: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(fallback) };
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(['spar-offline-v0', 'spar-offline-v1', 'another-app']), delete: vi.fn().mockResolvedValue(true) };
  const fetch = vi.fn().mockResolvedValue(new Response('live game'));
  const claim = vi.fn().mockResolvedValue(undefined);
  // Browser Request accepts relative URLs; Node's Request needs an absolute base.
  class BrowserRequest extends Request { constructor(url: string, init?: RequestInit) { super(new URL(url, 'https://spar.test'), init); } }
  runInNewContext(source, { self: { addEventListener: (name: string, fn: (event: unknown) => void) => events.set(name, fn), location: { origin: 'https://spar.test' }, clients: { claim } }, caches, fetch, Request: BrowserRequest, Response, URL });
  const navigate = () => {
    const respondWith = vi.fn();
    events.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://spar.test/' }, respondWith });
    return respondWith.mock.calls[0][0] as Promise<Response>;
  };
  return { events, cache, caches, fetch, fallback, claim, navigate };
}

describe('offline reconnect worker', () => {
  it('requires the offline page to be cached before installation succeeds', async () => {
    const w = worker();
    const waitUntil = vi.fn();
    w.events.get('install')!({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(w.cache.add.mock.calls[0][0].url).toBe('https://spar.test/offline.html');
    w.cache.add.mockRejectedValueOnce(new Error('offline file missing'));
    w.events.get('install')!({ waitUntil });
    await expect(waitUntil.mock.calls[1][0]).rejects.toThrow('offline file missing');
  });

  it('returns a fresh page online and the explicit reconnect page on network failure', async () => {
    const w = worker();
    expect(await (await w.navigate()).text()).toBe('live game');
    w.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await w.navigate()).toBe(w.fallback);
    w.fetch.mockResolvedValueOnce(new Response('gateway failure', { status: 503 }));
    expect(await w.navigate()).toBe(w.fallback);
  });

  it('does not intercept models, assets or cross-origin navigations', () => {
    const w = worker();
    for (const request of [
      { method: 'GET', mode: 'cors', url: 'https://storage.googleapis.com/model.task' },
      { method: 'GET', mode: 'cors', url: 'https://spar.test/assets/main.js' },
      { method: 'POST', mode: 'navigate', url: 'https://spar.test/match' },
      { method: 'GET', mode: 'navigate', url: 'https://other.test/' },
    ]) {
      const respondWith = vi.fn();
      w.events.get('fetch')!({ request, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it('only removes obsolete SPAR fallback caches on activation', async () => {
    const w = worker();
    const waitUntil = vi.fn();
    w.events.get('activate')!({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(w.caches.delete.mock.calls).toEqual([['spar-offline-v0']]);
    expect(w.claim).toHaveBeenCalledOnce();
  });
});
