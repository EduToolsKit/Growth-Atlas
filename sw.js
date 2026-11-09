/* Growth Atlas service worker.
 *
 * Strategy
 *  - Precache the offline shell on install (relative URLs — the SW is served
 *    from the deployment base, so root and GitHub-Pages subpaths both work).
 *  - Runtime: cache-first for same-origin static assets, network-first with
 *    cache fallback for navigations, offline.html as the last resort.
 *  - Versioned cache names; old caches are removed on activate.
 *  - Update lifecycle is multi-tab safe: the new worker waits until a page
 *    explicitly posts SKIP_WAITING (the "Update now" toast), then claims.
 *
 * Keep VERSION in sync with src/config.js (scripts/verify-data.mjs checks it).
 */

const VERSION = '1.0.0';
const STATIC_CACHE = `ga-static-v${VERSION}`;
const RUNTIME_CACHE = `ga-runtime-v${VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Resolve each entry individually so one failure never blocks install.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] precache miss:', url, error);
          }
        })
      );
      // Never force-activate: wait for SKIP_WAITING (multi-tab safe).
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('ga-') && !key.endsWith(VERSION))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}

/** Cache-first for hashed build assets. */
async function staticAssetStrategy(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

/** Network-first for navigations with a cache fallback, then offline.html. */
async function navigationStrategy(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    const cachedIndex =
      (await caches.match('./index.html')) || (await caches.match('./'));
    return cachedIndex || caches.match('./offline.html');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !isSameOrigin(request)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }

  const url = new URL(request.url);
  const isAsset =
    /\.(?:js|mjs|css|woff2?|png|svg|webp|ico|json|webmanifest)$/.test(url.pathname) ||
    url.pathname.includes('/assets/');

  if (isAsset) {
    event.respondWith(staticAssetStrategy(request));
  }
  // Anything else (e.g. ranged media) passes straight through.
});
