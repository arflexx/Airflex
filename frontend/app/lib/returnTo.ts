/**
 * returnTo.ts — carries the originally requested path through sign-up.
 *
 * `middleware.ts` turns an unauthenticated request to a protected route into
 * `/auth/signup?returnTo=<path>` (Issue #340). Without this, that parameter is
 * dropped at the OTP step and every signed-in user lands on `/` regardless of
 * where they were headed.
 */

/** Same-origin paths only — an absolute URL here would be an open redirect. */
export function sanitizeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  // Must be a single-slash-rooted path. `//evil.com` and `https://evil.com`
  // are both browser-navigable off-origin and are rejected.
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  return raw;
}

/** Reads and validates `returnTo` from the current URL. */
export function readReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  return sanitizeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
}

/** Where to send the user after a successful sign-in. */
export function postAuthDestination(returnTo: string | null): string {
  return sanitizeReturnTo(returnTo) ?? "/";
}
