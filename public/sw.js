// Keeps a copy of the app on the phone, so it opens and works with no signal.
const CACHE = `tiretrail-${new URL(location.href).searchParams.get('v') ?? '0'}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  // a new build drops the old copy
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fresh = fetch(req);
  // save what comes back for next time, without making the page wait
  e.waitUntil(fresh.then((res) => {
    if (!res.ok) return;
    // copy now, before the page starts reading it
    const copy = res.clone();
    return caches.open(CACHE).then((c) => c.put(req, copy));
  }).catch(() => {}));
  // the page itself: newest first. Everything else: the saved copy first.
  e.respondWith(req.mode === 'navigate'
    ? fresh.catch(() => caches.match(req).then((r) => r ?? caches.match('./')))
    : caches.match(req).then((r) => r ?? fresh));
});
