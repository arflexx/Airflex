/** @type {import('next').NextConfig} */
const withPWA = require("next-pwa")({
  dest: "public",
  // next-pwa only runs at build time; in dev there is no /sw.js to serve.
  disable: process.env.NODE_ENV === "development",
  // Registration is handled by components/ServiceWorkerRegister so it works
  // with the App Router (see that file for details).
  register: false,
  skipWaiting: true,
  // Serve /offline when a navigation fails because the user is offline and
  // the page is not in the cache (issue #107).
  fallbacks: {
    document: "/offline",
  },
  // Replace the default /api/ NetworkFirst rule with stale-while-revalidate so
  // API GET responses are served instantly from cache while being refreshed in
  // the background. Same-origin only — Paystack iframe and Termii requests
  // (cross-origin) are never intercepted. Static asset rules keep the defaults.
  runtimeCaching: require("next-pwa/cache").map((rule) =>
    rule.options?.cacheName === "apis"
      ? {
          urlPattern: ({ url }) => {
            const isSameOrigin = self.origin === url.origin;
            if (!isSameOrigin) return false;
            return url.pathname.startsWith("/api/");
          },
          handler: "StaleWhileRevalidate",
          method: "GET",
          options: {
            cacheName: "apis",
            expiration: {
              maxEntries: 64,
              maxAgeSeconds: 24 * 60 * 60, // 24 hours
            },
          },
        }
      : rule
  ),
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    domains: [],
  },
};

module.exports = withPWA(nextConfig);
