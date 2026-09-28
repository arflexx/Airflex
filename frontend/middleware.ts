import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Locale prefixes other than the default (`en`) that may appear in the URL.
const NON_DEFAULT_LOCALES = routing.locales.filter(
  (locale) => locale !== routing.defaultLocale
);

/**
 * Routes that require a valid session. Matched against the locale-stripped
 * pathname, so `/yo/wallet` is protected exactly like `/wallet`.
 *
 * `/trades` covers the detail route `/trades/[id]` (Issue #340).
 */
const PROTECTED_PREFIXES = [
  "/wallet",
  "/sell",
  "/profile",
  "/admin",
  "/onboarding",
  "/kyc",
  "/trades",
] as const;

/**
 * Routes that are always reachable without a session. Listed explicitly so a
 * new protected prefix can never accidentally swallow the sign-up flow and
 * lock every visitor out.
 *
 * Checked before PROTECTED_PREFIXES, so a public prefix always wins.
 */
const PUBLIC_PREFIXES = ["/", "/auth", "/docs"] as const;

const intlMiddleware = createIntlMiddleware(routing);

// JWT verification helper (simplified - in production use proper JWT library)
function verifyJWT(token: string): { valid: boolean; payload?: any } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );

    if (payload.exp && payload.exp < Date.now() / 1000) {
      return { valid: false };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

/** Strips a non-default locale prefix (e.g. `/yo/wallet` → `/wallet`). */
function stripLocalePrefix(pathname: string): string {
  if (NON_DEFAULT_LOCALES.length === 0) return pathname;
  const pattern = new RegExp(
    `^/(${NON_DEFAULT_LOCALES.join("|")})(?=/|$)`
  );
  return pathname.replace(pattern, "") || "/";
}

/** True when `pathname` equals `prefix` or sits underneath it. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const unprefixed = stripLocalePrefix(pathname);
  const isPublic = PUBLIC_PREFIXES.some((prefix) =>
    matchesPrefix(unprefixed, prefix)
  );
  const isProtected =
    !isPublic &&
    PROTECTED_PREFIXES.some((prefix) => matchesPrefix(unprefixed, prefix));

  if (isProtected) {
    const authCookie = request.cookies.get("Authorization")?.value;
    const sessionCookie = request.cookies.get("session")?.value;
    const token = authCookie || sessionCookie;
    const verified = token ? verifyJWT(token) : { valid: false as const };

    if (!verified.valid) {
      const redirectUrl = new URL("/auth/signup", request.url);
      // `returnTo` carries the locale-prefixed path so the post-signup bounce
      // lands the user back on the page in the language they were reading.
      redirectUrl.searchParams.set("returnTo", pathname);
      return NextResponse.redirect(redirectUrl);
    }

    const payload = verified.payload!;

    if (unprefixed.startsWith("/admin") && payload.role !== "admin") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  // Handle locale detection, prefixing, redirects, and cookie sync.
  return intlMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
