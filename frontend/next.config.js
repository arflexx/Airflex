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
  navigationFallback,
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
  // the page is not in the cache (issue #107). The route itself is declared
  // in lib/pwa-cache-strategy.js (issue #610) so it stays in one place and is
  // unit-testable alongside the rest of the cache strategy.
  fallbacks: navigationFallback,
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
  images: {
    domains: [],
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
