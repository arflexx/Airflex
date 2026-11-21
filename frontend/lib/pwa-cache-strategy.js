/**
 * PWA service-worker cache strategy (issue #463).
 *
 * Single source of truth for how the generated service worker (next-pwa /
 * Workbox) caches requests. The rule descriptors here are consumed by
 * `next.config.js` to build the `runtimeCaching` array, and the predicates are
 * unit-tested in `pwa-cache-strategy.test.ts`. `ServiceWorkerRegister.tsx`
 * imports `SW_CACHE_STRATEGY_VERSION` so the registration is explicitly tied
 * to this strategy module — bumping the version lets the SW purge stale caches
 * on the next activation.
 *
 * Strategy:
 *  - Hashed static assets served under `/_next/static/**` → CacheFirst. A
 *    cache miss falls back to the network and populates the cache for the next
 *    load; stale assets are updated in the background and activate without a
 *    manual reload (next-pwa `skipWaiting: true`).
 *  - Same-origin GET `/api/**` → StaleWhileRevalidate.
 *  - Non-GET requests and cross-origin / authenticated requests bypass the
 *    cache entirely (never intercepted).
 *  - Failed document (navigation) requests → the precached offline fallback
 *    page at `OFFLINE_FALLBACK_PATH` (issue #613). `next.config.js` reads this
 *    constant to configure next-pwa's `fallbacks.document`, so the route a
 *    user lands on when offline and the route this module advertises can
 *    never drift apart.
 */

"use strict";

/** Bumped whenever the cache strategy changes so the SW can purge stale caches. */
const SW_CACHE_STRATEGY_VERSION = "v1";

const STATIC_CACHE_NAME = "next-static";
const API_CACHE_NAME = "apis";

/**
 * Route served as the navigation fallback when a document request fails
 * offline and isn't already cached (issue #613). Must match an actual route
 * under `app/` — see `app/offline/page.tsx`.
 */
const OFFLINE_FALLBACK_PATH = "/offline";

/** One month — hashed asset names change when content changes, so a long TTL is safe. */
const STATIC_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const API_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * True for hashed assets Next.js serves under `/_next/static/`
 * (build output whose filename includes a content hash).
 */
function isHashedStatic(url) {
  return url.pathname.startsWith("/_next/static/");
}

/**
 * True only for same-origin GET requests that are eligible for caching.
 *
 * `origin` is resolved from `self.origin` (the service-worker global) but can
 * be passed explicitly for unit tests. Non-GET requests, cross-origin
 * requests (e.g. Paystack iframe, Termii) and any environment without a
 * resolvable origin are never cached.
 */
function isCacheableGet(url, method, origin) {
  if (method !== "GET") return false;
  const selfOrigin =
    origin ?? (typeof self !== "undefined" ? self.origin : undefined);
  if (selfOrigin === undefined) return false;
  return selfOrigin === url.origin;
}

/** CacheFirst rule for hashed static assets. */
const staticAssetRule = {
  urlPattern: ({ url, method }) =>
    isCacheableGet(url, method) && isHashedStatic(url),
  handler: "CacheFirst",
  method: "GET",
  options: {
    cacheName: STATIC_CACHE_NAME,
    expiration: {
      maxEntries: 200,
      maxAgeSeconds: STATIC_MAX_AGE_SECONDS,
    },
  },
};

/** StaleWhileRevalidate rule for same-origin GET `/api/**` requests. */
const apiRule = {
  urlPattern: ({ url, method }) =>
    isCacheableGet(url, method) && url.pathname.startsWith("/api/"),
  handler: "StaleWhileRevalidate",
  method: "GET",
  options: {
    cacheName: API_CACHE_NAME,
    expiration: {
      maxEntries: 64,
      maxAgeSeconds: API_MAX_AGE_SECONDS,
    },
  },
};

module.exports = {
  SW_CACHE_STRATEGY_VERSION,
  STATIC_CACHE_NAME,
  API_CACHE_NAME,
  STATIC_MAX_AGE_SECONDS,
  API_MAX_AGE_SECONDS,
  OFFLINE_FALLBACK_PATH,
  isHashedStatic,
  isCacheableGet,
  staticAssetRule,
  apiRule,
};
