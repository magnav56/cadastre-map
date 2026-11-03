/// <reference lib="webworker" />
// Service worker: keeps the app and the base map available without internet.
//
// Lots aren't cached here. The app saves them itself, so it can also tap and draw them offline.

import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

const OPENFREEMAP = 'https://tiles.openfreemap.org';
const DAY = 24 * 60 * 60;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Map style and tile index: the latest when online, the last copy offline.
registerRoute(
  ({ url }) =>
    url.origin === OPENFREEMAP && (url.pathname.startsWith('/styles/') || url.pathname === '/planet'),
  new NetworkFirst({ cacheName: 'basemap-style', networkTimeoutSeconds: 5 }),
);

// Base map tiles. OpenFreeMap puts a daily version in each tile's address, so the cache drops it.
// Otherwise tiles saved one day would be missed once the version changes.
registerRoute(
  ({ url }) => url.origin === OPENFREEMAP && /^\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'basemap-tiles',
    plugins: [
      { cacheKeyWillBeUsed: async ({ request }) => request.url.replace(/\/planet\/[^/]+\//, '/planet/') },
      new ExpirationPlugin({ maxEntries: 30_000, maxAgeSeconds: 365 * DAY }),
    ],
  }),
);

// Fonts, icons and the low-zoom shaded relief.
registerRoute(
  ({ url }) => url.origin === OPENFREEMAP,
  new CacheFirst({
    cacheName: 'basemap-assets',
    plugins: [new ExpirationPlugin({ maxEntries: 2_000, maxAgeSeconds: 365 * DAY })],
  }),
);

registerRoute(
  ({ url }) => url.hostname === 'server.arcgisonline.com',
  new CacheFirst({
    cacheName: 'satellite',
    plugins: [new ExpirationPlugin({ maxEntries: 4_000, maxAgeSeconds: 90 * DAY })],
  }),
);
