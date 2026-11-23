/* SPAR's offline fallback only. Game assets, camera models and match traffic stay on network.
 * Bump this version when offline.html changes. No forced takeover during an active match. */
const CACHE = 'spar-offline-v1';
const OFFLINE = '/offline.html';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE, { cache: 'reload' }))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('spar-offline-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.status < 500) return response;
    } catch { /* Show the installed offline shell if the network cannot be reached. */ }
    const cache = await caches.open(CACHE);
    return await cache.match(OFFLINE) ?? new Response('SPAR needs a connection. Reconnect and reload.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
