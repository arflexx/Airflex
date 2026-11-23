/**
 * cors.ts — explicit CORS origin allowlist (issue #539).
 *
 * Origins are read from CORS_ALLOWED_ORIGINS (comma-separated), falling back
 * to the legacy single-value CORS_ORIGIN. Every request's Origin header is
 * matched exactly against the list; an unlisted origin gets no
 * Access-Control-Allow-Origin header, so the browser blocks the response.
 *
 * Production rules:
 *   - The wildcard `*` is forbidden. validateEnv refuses to boot with it, and
 *     parseAllowedOrigins throws if it is reached anyway.
 *   - An empty allowlist fails closed (no cross-origin access) rather than
 *     falling back to `*` as the old configuration did.
 *
 * Outside production an unset allowlist defaults to the local Next.js dev
 * server, and `*` is honoured so ad-hoc tooling keeps working.
 *
 * Requests without an Origin header (curl, server-to-server calls, Paystack
 * webhooks) are not cross-origin browser requests and pass through untouched.
 */

import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";
import logger from "../utils/logger";

export const DEV_DEFAULT_ORIGINS = ["http://localhost:3000"] as const;

/** Methods advertised in preflight responses. */
export const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Request headers browsers may send cross-origin. */
export const CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"];

/** Response headers exposed to browser JavaScript. */
export const CORS_EXPOSED_HEADERS = ["X-Api-Version", "X-Request-Id", "Retry-After"];

/** Seconds browsers may cache a successful preflight. */
export const CORS_PREFLIGHT_MAX_AGE = 600;

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface AllowedOrigins {
  /** True only outside production when `*` is configured. */
  allowAll: boolean;
  origins: string[];
}

function rawOriginList(env: Env): string | undefined {
  return env["CORS_ALLOWED_ORIGINS"] || env["CORS_ORIGIN"] || undefined;
}

/**
 * Normalises one configured entry to a bare origin (`scheme://host[:port]`).
 * Returns null for anything that is not an http(s) origin.
 */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Validates that a configured origin string is a strict bare origin —
 * `scheme://host[:port]` with no trailing slash, path, query string, or
 * fragment. Returns a descriptive error string on failure, or null on success.
 *
 * A bare origin is defined as a URL whose pathname is exactly `/`, whose
 * search and hash are empty, and whose string representation — after
 * normalisation — matches the input (modulo leading/trailing whitespace that
 * callers must strip before calling this function).
 *
 * Examples:
 *   "https://airflex.app"        → null       (valid)
 *   "https://airflex.app/"       → error      (trailing slash)
 *   "https://airflex.app/foo"    → error      (path)
 *   "https://airflex.app?x=1"    → error      (query string)
 *   "https://airflex.app#top"    → error      (fragment)
 *   "airflex.app"                → error      (no scheme)
 *   "ftp://airflex.app"          → error      (non-http scheme)
 */
export function strictOriginError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a valid URL`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `"${value}" must use http or https (got "${url.protocol.replace(":", "")}")`;
  }

  // pathname is always at least "/" for valid URLs; a bare origin has exactly "/".
  if (url.pathname !== "/") {
    return `"${value}" must not include a path (got pathname "${url.pathname}"). Use "${url.origin}" instead`;
  }

  if (url.search !== "") {
    return `"${value}" must not include a query string (got "${url.search}")`;
  }

  if (url.hash !== "") {
    return `"${value}" must not include a fragment (got "${url.hash}")`;
  }

  // Guard against inputs like "https://airflex.app/" where `url.origin` is
  // "https://airflex.app" but the input had a trailing slash. The pathname
  // check above already catches this, but be explicit for clarity.
  if (value !== url.origin) {
    return `"${value}" must be a bare origin with no trailing slash. Use "${url.origin}" instead`;
  }

  return null;
}

/**
 * Returns configuration errors for the CORS variables. Used by validateEnv so
 * a misconfigured production deploy refuses to start.
 *
 * Checks performed for each non-wildcard entry:
 *   1. Must be a valid URL with an http(s) scheme.
 *   2. Must be a bare origin — no trailing slash, path, query string, or fragment.
 *
 * The wildcard `*` is only checked in production (where it is forbidden); in
 * development it is allowed so ad-hoc tooling keeps working.
 */
export function validateCorsEnv(env: Env): string[] {
  const raw = rawOriginList(env);
  if (!raw) return [];

  const entries = raw.split(",").map((o) => o.trim()).filter(Boolean);
  const errors: string[] = [];

  if (env["NODE_ENV"] === "production" && entries.includes("*")) {
    errors.push(
      "[startup] Wildcard CORS origin (*) is not allowed in production. " +
        "Set CORS_ALLOWED_ORIGINS to a comma-separated list of exact frontend origins."
    );
  }

  for (const entry of entries) {
    if (entry === "*") continue; // wildcard is handled above; skip format check

    const err = strictOriginError(entry);
    if (err) {
      errors.push(
        `[startup] Invalid CORS origin ${err}. ` +
          "Each entry must be a bare http(s) origin, e.g. https://airflex.app"
      );
    }
  }

  return errors;
}

/**
 * Parses the configured allowlist.
 *
 * @throws Error when `*` is configured in production.
 */
export function parseAllowedOrigins(env: Env = process.env): AllowedOrigins {
  const isProduction = env["NODE_ENV"] === "production";
  const raw = rawOriginList(env);

  if (!raw) {
    return { allowAll: false, origins: isProduction ? [] : [...DEV_DEFAULT_ORIGINS] };
  }

  const entries = raw.split(",").map((o) => o.trim()).filter(Boolean);

  if (entries.includes("*")) {
    if (isProduction) {
      throw new Error("Wildcard CORS origin (*) is not allowed in production");
    }
    return { allowAll: true, origins: [] };
  }

  const origins = [
    ...new Set(entries.map(normalizeOrigin).filter((o): o is string => o !== null)),
  ];
  return { allowAll: false, origins };
}

/** True when `origin` may make cross-origin requests under `allowed`. */
export function isOriginAllowed(origin: string, allowed: AllowedOrigins): boolean {
  if (allowed.allowAll) return true;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.origins.includes(normalized);
}

/**
 * Builds the `cors` options for the configured allowlist.
 *
 * `preflightContinue` is true so OPTIONS requests fall through to the
 * explicit preflight terminator registered in routes/index.ts, which answers
 * them for every route (including authenticated ones) before any auth
 * middleware can reject a credential-less preflight.
 */
export function buildCorsOptions(env: Env = process.env): CorsOptions {
  const allowed = parseAllowedOrigins(env);

  if (env["NODE_ENV"] === "production" && allowed.origins.length === 0) {
    logger.warn(
      "[cors] CORS_ALLOWED_ORIGINS is not set in production — all cross-origin browser requests will be rejected"
    );
  }

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const ok = isOriginAllowed(origin, allowed);
      if (!ok) {
        logger.warn({ origin }, "[cors] Rejected request from unlisted origin");
      }
      // `false` omits the CORS headers rather than raising an error, so the
      // browser blocks the response without the server returning a 500.
      callback(null, ok);
    },
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_PREFLIGHT_MAX_AGE,
    preflightContinue: true,
    optionsSuccessStatus: 204,
  };
}

let _middleware: RequestHandler | null = null;

/** Singleton CORS middleware built from process.env. */
export function corsMiddleware(): RequestHandler {
  if (!_middleware) {
    _middleware = cors(buildCorsOptions());
  }
  return _middleware;
}
