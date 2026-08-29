/**
 * Shared SEO constants and helpers (Issue #28).
 *
 * Kept in one place so the brand name and description cannot drift between the
 * root layout, per-route metadata, the sitemap and robots.txt.
 */

export const SITE_NAME = "AirFlex";

export const SITE_DESCRIPTION =
  "AirFlex is an open marketplace for Nigerian airtime and mobile data secured by Soroban escrow contracts on Stellar.";

/**
 * Absolute site origin.
 *
 * Falls back to localhost so a developer build still produces valid absolute
 * URLs rather than throwing inside `new URL()` — metadataBase requires an
 * absolute base, and a missing env var should not break the dev server.
 */
export function siteUrl(): string {
  return (
    process.env["NEXT_PUBLIC_SITE_URL"] ??
    (process.env["VERCEL_URL"] ? `https://${process.env["VERCEL_URL"]}` : null) ??
    "http://localhost:3000"
  );
}

/** Routes that must never be indexed, and never appear in the sitemap. */
export const PRIVATE_ROUTES = ["/admin", "/profile", "/wallet", "/auth"] as const;

/** Public routes listed in the sitemap, with their relative crawl priority. */
export const PUBLIC_ROUTES: { path: string; priority: number; changeFrequency: "daily" | "weekly" | "monthly" }[] = [
  { path: "/", priority: 1.0, changeFrequency: "daily" },
  { path: "/sell", priority: 0.8, changeFrequency: "weekly" },
];

/** Is this path one the crawlers should be kept out of? */
export function isPrivateRoute(path: string): boolean {
  return PRIVATE_ROUTES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
