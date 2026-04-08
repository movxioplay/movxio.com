/**
 * MOVXIO Service Worker — KILL SWITCH
 * Immediately unregisters and clears all caches
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))),
      self.clients.claim()
    ]).then(() => self.registration.unregister())
  );
});
