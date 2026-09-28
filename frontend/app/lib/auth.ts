/**
 * auth.ts — Client-side JWT storage utilities
 *
 * SECURITY NOTE: The JWT is stored in localStorage for simplicity in this
 * initial implementation. This exposes it to XSS attacks. For production:
 *   - Prefer httpOnly cookies set by the server (not accessible via JS).
 *   - If localStorage is required, pair it with a strict Content-Security-Policy
 *     (CSP) to mitigate XSS risk, and keep token TTLs short.
 *   - Never store the token in sessionStorage either — same XSS exposure.
 *
 * The token key is namespaced to avoid collisions with other apps on the
 * same origin.
 */

import { clearSessionKey } from "./stellarSession";

const TOKEN_KEY = "airflex:token";

/**
 * Cookie mirror of the JWT, read by `middleware.ts` so unauthenticated
 * requests to protected routes are turned away at the edge instead of after
 * the page has already been server-rendered (Issue #340).
 *
 * This is deliberately *not* httpOnly: the same token already lives in
 * localStorage, so making the cookie script-invisible would buy nothing while
 * breaking sign-out. It is not a security boundary — every API route still
 * verifies the bearer token server-side. Its only job is to let the edge see
 * "there is a session" before rendering.
 */
const SESSION_COOKIE = "session";

/** Reads `exp` out of a JWT payload without verifying the signature. */
function readExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

function writeSessionCookie(token: string): void {
  const exp = readExpiry(token);
  const maxAge = exp
    ? Math.max(0, Math.floor(exp - Date.now() / 1000))
    : 60 * 60 * 24; // fall back to a day for tokens without `exp`

  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function clearSessionCookie(): void {
  document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export interface StoredUser {
  id: string;
  phone: string;
  stellarPublicKey: string;
  /**
   * Account role, used to decide whether to render the admin dashboard
   * (Issue #23).
   *
   * Optional because tokens issued before this field existed do not carry it,
   * and absent is correctly treated as non-admin. This is a rendering hint
   * only - it lives in the browser and is editable by the holder, so the
   * server re-checks the role on every admin endpoint.
   */
  role?: "user" | "admin";
}

const USER_KEY = "airflex:user";

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** Persist the JWT after successful OTP verification. */
export function saveToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
  writeSessionCookie(token);
}

/** Retrieve the stored JWT, or null if not signed in. */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

/** Remove the JWT — call on sign-out. */
export function clearToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  clearSessionCookie();
}

/** True when a token is present (does not validate expiry client-side). */
export function isAuthenticated(): boolean {
  return getToken() !== null;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/** Persist basic user info returned from /api/v1/auth/verify-otp. */
export function saveUser(user: StoredUser): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** Retrieve stored user info, or null. */
export function getUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authorization header helper
// ---------------------------------------------------------------------------

/**
 * Returns the Authorization header value ready for use in fetch calls.
 *
 * @example
 * fetch("/api/v1/trades", { headers: { Authorization: bearerHeader() ?? "" } })
 */
export function bearerHeader(): string | null {
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}
