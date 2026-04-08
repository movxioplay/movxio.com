/**
 * MOVXIO Service Worker
 * Strategy:
 *  - App shell (HTML/CSS/JS/fonts) → Cache First
 *  - Film poster images            → Stale-While-Revalidate
 *  - Supabase API calls            → Network First (never cache)
 *  - Everything else               → Network First with cache fallback
 */

const SW_VERSION    = 'movxio-v2';
const SHELL_CACHE   = `${SW_VERSION}-shell`;
const IMAGE_CACHE   = `${SW_VERSION}-images`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

// ── App shell — cached on install ────────────────────────────
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/browse.html',
  '/watch.html',
  '/admin.html',
  '/site.webmanifest',
  '/favicon.ico',
  '/favicon-32x32.png',
  '/favicon-96x96.png',
  '/apple-touch-icon.png',
];

// ── Cache size limits ────────────────────────────────────────
const IMAGE_CACHE_MAX  = 150;   // max poster images cached
const RUNTIME_CACHE_MAX = 30;   // max other runtime responses

// ────────────────────────────────────────────────────────────
// INSTALL — cache app shell
// ────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Shell cache error:', err))
  );
});

// ────────────────────────────────────────────────────────────
// ACTIVATE — clean old caches
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// FETCH — routing strategies
// ────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // ── 1. Supabase API — always Network Only (never cache) ──
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.com')) {
    return; // let browser handle normally
  }

  // ── 2. Google Fonts — Cache First ───────────────────────
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // ── 3. cdnjs (Video.js) — Cache First ───────────────────
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // ── 4. Film poster images (Unsplash, Cloudinary, R2) ────
  //    Stale-While-Revalidate — show cached instantly, update in background
  if (isImageRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, IMAGE_CACHE_MAX));
    return;
  }

  // ── 5. App shell HTML pages — Cache First ───────────────
  if (request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── 6. Everything else — Network First ──────────────────
  event.respondWith(networkFirst(request, RUNTIME_CACHE, RUNTIME_CACHE_MAX));
});

// ────────────────────────────────────────────────────────────
// STRATEGIES
// ────────────────────────────────────────────────────────────

/** Cache First — serve from cache, fall back to network */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request, { redirect: 'follow' });
    // Only cache final, non-redirected, successful responses
    if (response.ok && response.type !== 'opaqueredirect' && response.redirected === false) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — please check your connection.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/** Network First — try network, fall back to cache */
async function networkFirst(request, cacheName, maxEntries) {
  try {
    const response = await fetch(request, { redirect: 'follow' });
    if (response.ok && response.type !== 'opaqueredirect' && response.redirected === false) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
      await trimCache(cacheName, maxEntries);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

/** Stale While Revalidate — serve cached immediately, update in background */
async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request, { redirect: 'follow' }).then(async response => {
    if (response.ok && response.type !== 'opaqueredirect' && response.redirected === false) {
      await cache.put(request, response.clone());
      await trimCache(cacheName, maxEntries);
    }
    return response;
  }).catch(() => null);

  return cached || await fetchPromise;
}

/** Trim a cache to maxEntries */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxEntries) {
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map(key => cache.delete(key)));
  }
}

/** Check if a URL is an image */
function isImageRequest(url) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif'];
  const isImageExt = imageExts.some(ext => url.pathname.toLowerCase().endsWith(ext));
  const isImageHost = [
    'images.unsplash.com',
    'res.cloudinary.com',
    'videos.movxio.com',
    'img.movxio.com',
  ].some(host => url.hostname.includes(host));
  return isImageExt || isImageHost;
}

// ────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS (future use — stub)
// ────────────────────────────────────────────────────────────
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
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/index.html')
  );
});
