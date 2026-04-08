/**
 * MOVXIO Service Worker — KILL SWITCH
 * Immediately unregisters and clears all caches
 * Deploy this to fix navigation breaking
 */

// Install immediately without waiting
self.addEventListener('install', event => {
  self.skipWaiting();
});

// On activate: wipe everything and unregister
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      // Delete ALL caches
      caches.keys().then(keys =>
        Promise.all(keys.map(k => {
          console.log('[SW] Clearing cache:', k);
          return caches.delete(k);
        }))
      ),
      // Claim all clients so this SW takes over immediately
      self.clients.claim()
    ]).then(() => {
      // Unregister this SW completely
      console.log('[SW] Unregistering service worker...');
      return self.registration.unregister();
    }).then(() => {
      // Tell all open tabs to reload
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.navigate(client.url));
      });
    })
  );
});

// CRITICAL: For fetch events, do NOT intercept — pass everything through
// This prevents the redirect error on navigation
self.addEventListener('fetch', event => {
  // Return nothing — browser handles the request normally
  return;
});
