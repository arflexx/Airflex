/**
 * PWA cache strategy unit tests (issue #463).
 *
 * Pins the predicates and Workbox rule descriptors that next.config.js feeds
 * into next-pwa, so the cache strategy stays explicit and testable rather than
 * inlined in the Next config.
 */

import {
  SW_CACHE_STRATEGY_VERSION,
  STATIC_CACHE_NAME,
  API_CACHE_NAME,
  OFFLINE_FALLBACK_ROUTE,
  navigationFallback,
  isHashedStatic,
  isCacheableGet,
  staticAssetRule,
  apiRule,
} from "./pwa-cache-strategy";

const ORIGIN = "https://airflex.example";

function u(pathname: string, origin = ORIGIN): URL {
  return new URL(pathname, origin);
}

describe("isHashedStatic", () => {
  it("matches assets under /_next/static/", () => {
    expect(isHashedStatic(u("/_next/static/chunks/main-abc123.js"))).toBe(true);
    expect(isHashedStatic(u("/_next/static/css/app.css"))).toBe(true);
  });

  it("rejects non-static paths", () => {
    expect(isHashedStatic(u("/"))).toBe(false);
    expect(isHashedStatic(u("/api/v1/trades"))).toBe(false);
    expect(isHashedStatic(u("/_next/data/abc/trades.json"))).toBe(false);
  });
});

describe("isCacheableGet", () => {
  it("allows same-origin GET requests", () => {
    expect(isCacheableGet(u("/api/v1/trades"), "GET", ORIGIN)).toBe(true);
  });

  it("rejects non-GET methods", () => {
    expect(isCacheableGet(u("/api/v1/trades"), "POST", ORIGIN)).toBe(false);
    expect(isCacheableGet(u("/api/v1/trades"), "PUT", ORIGIN)).toBe(false);
    expect(isCacheableGet(u("/_next/static/a.js"), "HEAD", ORIGIN)).toBe(false);
  });

  it("rejects cross-origin requests (e.g. Paystack / Termii)", () => {
    expect(
      isCacheableGet(u("/api/v1/trades", "https://api.paystack.co"), "GET", ORIGIN)
    ).toBe(false);
  });

  it("rejects when no origin can be resolved", () => {
    expect(isCacheableGet(u("/api/v1/trades"), "GET", undefined)).toBe(false);
  });
});

describe("staticAssetRule", () => {
  it("is CacheFirst, GET-only, with the static cache name", () => {
    expect(staticAssetRule.handler).toBe("CacheFirst");
    expect(staticAssetRule.method).toBe("GET");
    expect(staticAssetRule.options?.cacheName).toBe(STATIC_CACHE_NAME);
    expect(staticAssetRule.options?.expiration?.maxEntries).toBe(200);
  });

  it("matches same-origin GET /_next/static/**", () => {
    expect(
      staticAssetRule.urlPattern!({
        url: u("/_next/static/chunks/main.js"),
        method: "GET",
      })
    ).toBe(true);
  });

  it("does not match non-static paths", () => {
    expect(
      staticAssetRule.urlPattern!({ url: u("/"), method: "GET" })
    ).toBe(false);
  });

  it("bypasses non-GET static requests", () => {
    expect(
      staticAssetRule.urlPattern!({
        url: u("/_next/static/chunks/main.js"),
        method: "POST",
      })
    ).toBe(false);
  });

  it("bypasses cross-origin static requests", () => {
    expect(
      staticAssetRule.urlPattern!({
        url: u("/_next/static/chunks/main.js", "https://cdn.evil.example"),
        method: "GET",
      })
    ).toBe(false);
  });
});

describe("apiRule", () => {
  it("is StaleWhileRevalidate, GET-only, with the api cache name", () => {
    expect(apiRule.handler).toBe("StaleWhileRevalidate");
    expect(apiRule.method).toBe("GET");
    expect(apiRule.options?.cacheName).toBe(API_CACHE_NAME);
  });

  it("matches same-origin GET /api/**", () => {
    expect(
      apiRule.urlPattern!({ url: u("/api/v1/trades"), method: "GET" })
    ).toBe(true);
  });

  it("bypasses non-GET /api requests", () => {
    expect(
      apiRule.urlPattern!({ url: u("/api/v1/trades"), method: "POST" })
    ).toBe(false);
  });

  it("bypasses cross-origin /api requests", () => {
    expect(
      apiRule.urlPattern!({
        url: u("/api/v1/trades", "https://api.termii.example"),
        method: "GET",
      })
    ).toBe(false);
  });

  it("does not match non-api paths", () => {
    expect(apiRule.urlPattern!({ url: u("/sell"), method: "GET" })).toBe(false);
  });
});

describe("SW_CACHE_STRATEGY_VERSION", () => {
  it("is a non-empty version string", () => {
    expect(typeof SW_CACHE_STRATEGY_VERSION).toBe("string");
    expect(SW_CACHE_STRATEGY_VERSION.length).toBeGreaterThan(0);
  });
});

// Issue #610 — pwa-cache-strategy.js is the single source of truth for which
// route the generated service worker falls back to on an offline navigation.
describe("navigationFallback", () => {
  it("registers /offline as the navigation fallback document", () => {
    expect(OFFLINE_FALLBACK_ROUTE).toBe("/offline");
    expect(navigationFallback).toEqual({ document: "/offline" });
  });

  it("points at the same route the App Router offline page is served from", () => {
    // Keeps this module and app/offline/page.tsx from drifting apart.
    expect(navigationFallback.document).toBe(OFFLINE_FALLBACK_ROUTE);
  });
});
