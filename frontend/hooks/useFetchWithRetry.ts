"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../lib/apiFetch";
import { getToken } from "../app/lib/auth";
import { cacheKey, isAffectedBy, onHttpCacheInvalidate, resourcePath, sessionScope } from "../lib/httpCache";

/**
 * useFetchWithRetry — GET an API endpoint with retry + request deduplication
 * (Issue #681).
 *
 * Deduplication: requests are keyed by session scope + endpoint. Concurrent
 * identical GETs share one in-flight promise, and a resolved result is reused
 * for `dedupWindowMs` (default 2s) afterwards, so several components mounting
 * together — or a quick remount — make a single network call. Failures are
 * never reused. Entries are dropped when a mutation on the same resource
 * succeeds and on logout (both via lib/httpCache).
 *
 * Longer-lived caching is apiFetch's job: it honours Cache-Control / ETag.
 */

export const DEFAULT_DEDUP_WINDOW_MS = 2_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface FetchWithRetryOptions {
  /** Extra attempts after the first for network errors, 429 and 5xx. Default 2. */
  retries?: number;
  /** Base delay for exponential back-off between attempts. Default 500ms. */
  retryDelayMs?: number;
  /** How long a resolved GET is reused for identical requests. Default 2000ms. */
  dedupWindowMs?: number;
}

export interface UseFetchWithRetryReturn<T> {
  data: T | null;
  error: ApiError | Error | null;
  isLoading: boolean;
  /** Re-fetch, bypassing the dedup window. */
  refetch: () => Promise<void>;
}

interface DedupEntry {
  promise: Promise<unknown>;
  /** Epoch ms when the promise resolved; null while in flight. */
  settledAt: number | null;
}

const dedupCache = new Map<string, DedupEntry>();

onHttpCacheInvalidate((mutatedPath) => {
  if (mutatedPath === null) {
    dedupCache.clear();
    return;
  }
  for (const key of dedupCache.keys()) {
    if (isAffectedBy(resourcePath(key), mutatedPath)) dedupCache.delete(key);
  }
});

/** Empties the dedup cache. Exposed for tests. */
export function clearFetchDedupCache(): void {
  dedupCache.clear();
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  // fetch rejects with a TypeError on network failure.
  return err instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWithRetry<T>(endpoint: string, retries: number, retryDelayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await apiFetch<T>(endpoint);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

/**
 * Deduplicated GET. Identical calls (same session, same endpoint) made while a
 * request is in flight, or within `dedupWindowMs` of it resolving, share its
 * promise instead of hitting the network again.
 */
export function fetchDeduped<T>(
  endpoint: string,
  options: FetchWithRetryOptions & { force?: boolean } = {},
): Promise<T> {
  const {
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS,
    force = false,
  } = options;

  const key = cacheKey(sessionScope(getToken()), endpoint);
  const existing = dedupCache.get(key);
  if (
    !force &&
    existing &&
    (existing.settledAt === null || Date.now() - existing.settledAt < dedupWindowMs)
  ) {
    return existing.promise as Promise<T>;
  }

  const entry: DedupEntry = { promise: Promise.resolve(), settledAt: null };
  entry.promise = getWithRetry<T>(endpoint, retries, retryDelayMs).then(
    (data) => {
      // Only stamp our own entry — it may have been invalidated or replaced.
      if (dedupCache.get(key) === entry) entry.settledAt = Date.now();
      return data;
    },
    (err: unknown) => {
      if (dedupCache.get(key) === entry) dedupCache.delete(key);
      throw err;
    },
  );
  dedupCache.set(key, entry);
  return entry.promise as Promise<T>;
}

export function useFetchWithRetry<T>(
  endpoint: string | null,
  options: FetchWithRetryOptions = {},
): UseFetchWithRetryReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(endpoint !== null);

  // Options are read through a ref so callers can pass an inline object
  // without re-triggering the effect on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const run = useCallback(
    async (force: boolean, isActive: () => boolean) => {
      if (endpoint === null) return;
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetchDeduped<T>(endpoint, { ...optionsRef.current, force });
        if (isActive()) setData(result);
      } catch (err) {
        if (isActive()) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (isActive()) setIsLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    if (endpoint === null) {
      setIsLoading(false);
      return;
    }
    let active = true;
    void run(false, () => active);
    return () => {
      active = false;
    };
  }, [endpoint, run]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback(() => run(true, () => mounted.current), [run]);

  return { data, error, isLoading, refetch };
}
