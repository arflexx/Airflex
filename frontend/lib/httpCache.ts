/**
 * httpCache.ts — In-memory, per-session HTTP response cache (Issue #681).
 *
 * Used by apiFetch to honour `Cache-Control` and `ETag` on GET responses:
 *
 *   - `Cache-Control: no-store`      → never cached.
 *   - `Cache-Control: max-age=N`     → served from memory for N seconds.
 *   - `no-cache` / no max-age + ETag → stored, but revalidated on every
 *                                      request with `If-None-Match`; a 304
 *                                      reuses the stored body.
 *   - neither max-age nor ETag       → not cached.
 *
 * Every key is prefixed with a session scope derived from the bearer token,
 * so one user's responses can never be served to another on a shared device.
 * The whole cache is also cleared on logout (see clearToken in app/lib/auth).
 *
 * A successful mutation (POST/PUT/PATCH/DELETE) invalidates cached GETs for the
 * same resource — see invalidateResource for the matching rule. Listeners
 * (e.g. the GET dedup cache in hooks/useFetchWithRetry) are notified so they
 * drop their entries too.
 *
 * Deliberately has no imports: app/lib/auth imports it, and apiFetch imports
 * app/lib/auth.
 */

export interface CachedResponse {
  data: unknown;
  etag: string | null;
  /** Epoch ms after which the entry must be revalidated (0 = always revalidate). */
  freshUntil: number;
}

/** Parsed subset of a Cache-Control response header. */
export interface CacheDirectives {
  noStore: boolean;
  noCache: boolean;
  maxAgeSeconds: number | null;
}

type InvalidationListener = (pathname: string | null) => void;

const responses = new Map<string, CachedResponse>();
const listeners = new Set<InvalidationListener>();

// ---------------------------------------------------------------------------
// Keys & session scope
// ---------------------------------------------------------------------------

/**
 * Short, non-reversible scope id for a bearer token (FNV-1a), so the token
 * itself is never used as a map key. Anonymous requests share "anon".
 */
export function sessionScope(token: string | null): string {
  if (!token) return "anon";
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function cacheKey(scope: string, url: string): string {
  return `${scope} ${url}`;
}

/** Pathname of a URL or key, without query string or trailing slash. */
export function resourcePath(urlOrKey: string): string {
  const url = urlOrKey.includes(" ") ? urlOrKey.slice(urlOrKey.indexOf(" ") + 1) : urlOrKey;
  let path: string;
  try {
    path = new URL(url, "http://local").pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Whether a cached GET for `cachedPath` is affected by a mutation on
 * `mutatedPath`: the same resource, anything beneath it, or one of its parent
 * collections. E.g. PATCH /api/v1/trades/42 invalidates /api/v1/trades/42,
 * /api/v1/trades/42/rating and the /api/v1/trades list.
 */
export function isAffectedBy(cachedPath: string, mutatedPath: string): boolean {
  return (
    cachedPath === mutatedPath ||
    cachedPath.startsWith(`${mutatedPath}/`) ||
    mutatedPath.startsWith(`${cachedPath}/`)
  );
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export function parseCacheControl(header: string | null | undefined): CacheDirectives {
  const directives: CacheDirectives = { noStore: false, noCache: false, maxAgeSeconds: null };
  if (!header) return directives;

  for (const part of header.toLowerCase().split(",")) {
    const [name, value] = part.trim().split("=");
    if (name === "no-store") directives.noStore = true;
    else if (name === "no-cache") directives.noCache = true;
    else if (name === "max-age" && value !== undefined) {
      const seconds = parseInt(value.replace(/"/g, ""), 10);
      if (Number.isFinite(seconds) && seconds >= 0) directives.maxAgeSeconds = seconds;
    }
  }
  return directives;
}

// ---------------------------------------------------------------------------
// Cache operations
// ---------------------------------------------------------------------------

export function getCachedResponse(key: string): CachedResponse | undefined {
  return responses.get(key);
}

export function isFresh(entry: CachedResponse, now = Date.now()): boolean {
  return entry.freshUntil > now;
}

/**
 * Stores (or drops) a GET response according to its caching headers.
 * Returns the stored entry, or undefined when the response is not cacheable.
 */
export function storeResponse(
  key: string,
  data: unknown,
  cacheControl: string | null | undefined,
  etag: string | null | undefined,
  now = Date.now(),
): CachedResponse | undefined {
  const directives = parseCacheControl(cacheControl);
  const maxAgeMs =
    !directives.noCache && directives.maxAgeSeconds !== null ? directives.maxAgeSeconds * 1000 : 0;

  if (directives.noStore || (maxAgeMs === 0 && !etag)) {
    responses.delete(key);
    return undefined;
  }

  const entry: CachedResponse = { data, etag: etag ?? null, freshUntil: maxAgeMs > 0 ? now + maxAgeMs : 0 };
  responses.set(key, entry);
  return entry;
}

/** Drops every cached GET affected by a mutation on `url`, across all scopes. */
export function invalidateResource(url: string): void {
  const mutatedPath = resourcePath(url);
  for (const key of responses.keys()) {
    if (isAffectedBy(resourcePath(key), mutatedPath)) responses.delete(key);
  }
  for (const listener of listeners) listener(mutatedPath);
}

/** Empties the cache entirely — called on logout. */
export function clearHttpCache(): void {
  responses.clear();
  for (const listener of listeners) listener(null);
}

/**
 * Subscribe to invalidations. The listener receives the mutated pathname, or
 * null when the whole cache was cleared. Returns an unsubscribe function.
 */
export function onHttpCacheInvalidate(listener: InvalidationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
