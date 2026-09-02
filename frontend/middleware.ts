import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Locale prefixes other than the default (`en`) that may appear in the URL.
const NON_DEFAULT_LOCALES = routing.locales.filter(
  (locale) => locale !== routing.defaultLocale
);

const PROTECTED_PREFIXES = [
  "/wallet",
  "/sell",
  "/profile",
  "/admin",
  "/onboarding",
] as const;

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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const unprefixed = stripLocalePrefix(pathname);
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => unprefixed === prefix || unprefixed.startsWith(`${prefix}/`)
  );

  if (isProtected) {
    const authCookie = request.cookies.get("Authorization")?.value;
    const sessionCookie = request.cookies.get("session")?.value;
    const token = authCookie || sessionCookie;

    if (!token || !verifyJWT(token).valid) {
      const redirectUrl = new URL("/auth/signup", request.url);
      redirectUrl.searchParams.set("redirect", unprefixed);
      return NextResponse.redirect(redirectUrl);
    }

    const payload = verifyJWT(token).payload!;

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
