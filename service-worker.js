/**
 * MOVXIO Service Worker v3
 * Fixed redirect handling — let browser follow all redirects natively
 */

const SW_VERSION    = 'movxio-v4';
const SHELL_CACHE   = `${SW_VERSION}-shell`;
const IMAGE_CACHE   = `${SW_VERSION}-images`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

const SHELL_ASSETS = [
  '/index.html',
  '/browse.html',
  '/watch.html',
  '/admin.html',
  '/search.html',
  '/site.webmanifest',
];

const IMAGE_CACHE_MAX   = 150;
const RUNTIME_CACHE_MAX = 30;

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        // Use individual try/catch so one fail doesn't block all
        return Promise.allSettled(
          SHELL_ASSETS.map(url =>
            fetch(url, { redirect: 'follow' })
              .then(res => {
                if (res.ok && !res.redirected) return cache.put(url, res);
              })
              .catch(() => {}) // ignore individual failures
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — delete old caches ─────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('movxio-') && ![SHELL_CACHE, IMAGE_CACHE, RUNTIME_CACHE].includes(key))
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // ── CRITICAL: Skip if origin doesn't match SW scope ──────
  // This prevents the redirect loop — if Cloudflare redirects
  // movxio.com → www.movxio.com, let the browser handle it
  if (url.origin !== self.location.origin) return;

  // ── Never cache Supabase API calls ───────────────────────
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.com')) return;

  // ── Never cache chrome-extension or non-http ─────────────
  if (!url.protocol.startsWith('http')) return;

  // ── Google Fonts — Cache First ───────────────────────────
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // ── CDN libs (Video.js etc) — Cache First ────────────────
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // ── Poster images — Stale While Revalidate ───────────────
  if (isImageRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, IMAGE_CACHE_MAX));
    return;
  }

  // ── HTML pages — Network First (always fresh) ────────────
  if (request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // ── Everything else — Network First ──────────────────────
  event.respondWith(networkFirst(request, RUNTIME_CACHE, RUNTIME_CACHE_MAX));
});

// ── STRATEGIES ───────────────────────────────────────────────

async function safeFetch(request) {
  // Always follow redirects, and return null if the response
  // is a redirect (opaque) so we never cache a redirect response
  try {
    // IMPORTANT: passing { redirect: 'follow' } as a second arg is ignored
    // when request is a Request object — its own redirect mode wins.
    // We must construct a new Request with redirect:'follow' forced.
    const req = new Request(request, { redirect: 'follow' });
    const response = await fetch(req);
    // response.redirected means browser followed a redirect
    // We still return it to the page, just don't cache it
    return response;
  } catch {
    return null;
  }
}

async function safeCache(cache, request, response) {
  // Only put in cache if: ok status, same origin, not a redirect response
  if (
    response &&
    response.ok &&
    response.status === 200 &&
    !response.redirected &&
    response.type !== 'opaqueredirect' &&
    response.type !== 'error'
  ) {
    try {
      await cache.put(request, response.clone());
    } catch {}
  }
}

/** Cache First */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await safeFetch(request);
  if (response) {
    const cache = await caches.open(cacheName);
    await safeCache(cache, request, response);
    return response;
  }
  return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

/** Network First */
async function networkFirst(request, cacheName, maxEntries) {
  const response = await safeFetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    await safeCache(cache, request, response);
    if (maxEntries) await trimCache(cacheName, maxEntries);
    return response;
  }
  if (response) return response; // return error responses as-is (404 etc)
  // Network failed — try cache
  const cached = await caches.match(request);
  return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

/** Stale While Revalidate */
async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const revalidate = safeFetch(request).then(async response => {
    if (response) await safeCache(cache, request, response);
    if (maxEntries) await trimCache(cacheName, maxEntries);
    return response;
  });

  return cached || await revalidate;
}

/** Trim cache to max entries */
async function trimCache(cacheName, maxEntries) {
  if (!maxEntries) return;
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map(k => cache.delete(k)));
  }
}

/** Image request detection */
function isImageRequest(url) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
  const isExt  = imageExts.some(ext => url.pathname.toLowerCase().endsWith(ext));
  const isHost = ['images.unsplash.com', 'res.cloudinary.com', 'videos.movxio.com', 'img.movxio.com']
    .some(h => url.hostname.includes(h));
  return isExt || isHost;
}

// ── PUSH NOTIFICATIONS (stub) ─────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'MOVXIO', {
    body: data.body || 'New films added!',
    icon: '/favicon-96x96.png',
    badge: '/favicon-32x32.png',
    data: { url: data.url || '/index.html' }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/index.html'));
});
