import type { MetadataRoute } from "next";
import { SITE_NAME, SITE_DESCRIPTION } from "./lib/seo";

/**
 * Screenshot descriptor accepted by the W3C Web App Manifest spec.
 *
 * Next's `MetadataRoute.Manifest` types only cover `src`/`sizes`/`type`, but
 * Chrome's richer install prompt keys off `form_factor` (and the `label` that
 * goes with it). Extending the entry type keeps the manifest fully typed while
 * still being assignable to Next's narrower shape.
 */
type Screenshot = NonNullable<MetadataRoute.Manifest["screenshots"]>[number] & {
  form_factor?: "narrow" | "wide";
  label?: string;
};

/**
 * Phone-sized previews shown in Chrome's "Add to Home Screen" sheet
 * (issue #293). Both are 1080x1920 (9:16), the portrait viewport the app
 * targets, and both are tagged `form_factor: "narrow"` so Chrome treats them
 * as mobile screenshots in the richer install prompt.
 */
const SCREENSHOTS: Screenshot[] = [
  {
    src: "/screenshots/signup-mobile.png",
    sizes: "1080x1920",
    type: "image/png",
    form_factor: "narrow",
    label: "Create an account with your phone number",
  },
  {
    src: "/screenshots/sell-mobile.png",
    sizes: "1080x1920",
    type: "image/png",
    form_factor: "narrow",
    label: "Create a listing and set your own rate",
  },
];

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
    screenshots: SCREENSHOTS,
  };
}
