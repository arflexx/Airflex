const createNextIntlPlugin = require("next-intl/plugin");
const {
  buildContentSecurityPolicy,
  reportingEndpoints,
  STATIC_SECURITY_HEADERS,
} = require("./lib/cspPolicy");

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Cache strategy lives in a reusable lib module (issue #463) so it can be
// unit-tested and referenced from the service-worker registration component.
const {
  staticAssetRule,
  apiRule,
  OFFLINE_FALLBACK_PATH,
} = require("./lib/pwa-cache-strategy");

/** @type {import('next').NextConfig} */
const withPWA = require("next-pwa")({
  dest: "public",
  // next-pwa only runs at build time; in dev there is no /sw.js to serve.
  disable: process.env.NODE_ENV === "development",
  // Registration is handled by components/ServiceWorkerRegister so it works
  // with the App Router (see that file for details).
  register: false,
  // Activate a waiting service worker immediately so updated static assets go
  // live without forcing a manual reload (issue #463).
  skipWaiting: true,
  // Serve /offline when a navigation fails because the user is offline and
  // the page is not in the cache (issue #107, issue #613). Sourced from
  // pwa-cache-strategy.js so the fallback route is defined in one place.
  fallbacks: {
    document: OFFLINE_FALLBACK_PATH,
  },
  // Runtime caching rules. The static-asset (CacheFirst) and /api/
  // (StaleWhileRevalidate) rules are defined in lib/pwa-cache-strategy.js and
  // placed first so they take precedence. The remaining next-pwa defaults
  // (images, fonts, etc.) are kept verbatim, with the now-redundant default
  // /api/ rule replaced by apiRule.
  runtimeCaching: [
    staticAssetRule,
    ...require("next-pwa/cache").map((rule) =>
      rule.options?.cacheName === "apis" ? apiRule : rule
    ),
  ],
});

/**
 * remotePatterns for next/image derived from NEXT_PUBLIC_API_URL (issue #679).
 * Returns [] when the variable is unset or not an absolute http(s) URL.
 */
function apiImageRemotePatterns() {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw) return [];
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [
      {
        protocol: url.protocol.slice(0, -1),
        hostname: url.hostname,
        port: url.port,
        pathname: "/**",
      },
    ];
  } catch {
    return [];
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Enforced CSP on every response (#539). Directives are shared with
  // middleware.ts via lib/cspPolicy.js; the middleware swaps in a per-request
  // nonce variant for HTML pages.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildContentSecurityPolicy(),
          },
          {
            key: "Reporting-Endpoints",
            value: reportingEndpoints(),
          },
          ...STATIC_SECURITY_HEADERS,
        ],
      },
    ];
  },
  // next/image (issue #679). `domains` is deprecated in Next 14, so hosts are
  // allow-listed with remotePatterns. The only remote host the app serves
  // images from is the API (user-uploaded assets); its origin comes from
  // NEXT_PUBLIC_API_URL. Local KYC previews are blob: URLs and render with
  // `unoptimized`, so they need no entry here.
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: apiImageRemotePatterns(),
    // Optimised variants are immutable per URL; cache them for a day.
    minimumCacheTTL: 86400,
  },
};

/**
 * Bundle analysis (Issue #544): `ANALYZE=true pnpm build` writes interactive
 * treemaps to .next/analyze/{client,nodejs,edge}.html. Loaded only when
 * requested so regular builds don't depend on the analyzer package.
 */
function withBundleAnalyzer(config) {
  if (process.env.ANALYZE !== "true") return config;
  let analyzer;
  try {
    analyzer = require("@next/bundle-analyzer");
  } catch {
    throw new Error(
      "ANALYZE=true requires @next/bundle-analyzer: pnpm --filter airflex-frontend add -D @next/bundle-analyzer"
    );
  }
  return analyzer({ enabled: true, openAnalyzer: false })(config);
}

module.exports = withBundleAnalyzer(withPWA(withNextIntl(nextConfig)));
