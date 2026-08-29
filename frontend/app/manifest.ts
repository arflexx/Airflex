import type { MetadataRoute } from "next";
import { SITE_NAME, SITE_DESCRIPTION } from "./lib/seo";

/**
 * Web App Manifest (issue #107).
 *
 * Served at /manifest.webmanifest. Next.js automatically injects the
 * `<link rel="manifest">` tag into the root layout's <head> when this file
 * convention exists.
 *
 * The manifest makes AirFlex installable on mobile home screens — the primary
 * distribution channel for our Nigeria-first, mobile-first audience.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — Buy & Sell Airtime Peer-to-Peer`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#7c3aed",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
