"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker (issue #107).
 *
 * next-pwa generates `public/sw.js` (and workbox runtime) at build time.
 * `register` is left off in next.config.js and registration happens here so it
 * works identically in the App Router — the plugin's own auto-registration
 * hooks into the pages-router document model.
 *
 * Renders nothing.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      process.env.NODE_ENV !== "production"
    ) {
      return;
    }

    // next-pwa disables itself in development (`disable` flag in
    // next.config.js), so /sw.js only exists in production builds.
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        console.error("[pwa] Service worker registration failed:", err);
      });
  }, []);

  return null;
}
