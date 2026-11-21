/**
 * exchangeRates.ts — Redis-cached exchange rates with stale fallback (issue #676).
 *
 * Every rate pair is cached under a namespaced key, `rates:<BASE>:<QUOTE>`
 * (e.g. `rates:NGN:USDC`), for `RATES_CACHE_TTL_SECONDS` (default 60s). A
 * second, longer-lived "last known good" copy is kept under
 * `rates:<BASE>:<QUOTE>:last-known` so that when the upstream provider is
 * unreachable the API can keep serving the most recent rate — flagged as stale
 * — instead of failing.
 *
 * The pre-warm cron job (`prewarmExchangeRates`, scheduled every 55s from
 * jobs/index.ts) refreshes every supported pair shortly before its fresh entry
 * expires, so request traffic practically never sees a cold cache.
 *
 * Upstream provider
 * -----------------
 * When `RATES_PROVIDER_URL` is set, rates are fetched from
 * `GET <RATES_PROVIDER_URL>?base=<BASE>&quote=<QUOTE>` and the response must
 * contain a positive numeric `rate` (or `data.rate`). Requests time out after
 * `RATES_PROVIDER_TIMEOUT_MS` (default 2000ms). Without a provider URL the
 * rate comes from `NGN_PER_USDC_RATE` (default 1600), which keeps local
 * development and tests free of network I/O.
 */

import { cache } from "./cache";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types & configuration
// ---------------------------------------------------------------------------

export interface RatePair {
  base: string;
  quote: string;
}

export interface ExchangeRate {
  base: string;
  quote: string;
  rate: number;
  /** ISO timestamp of when the rate was fetched from the provider. */
  fetchedAt: string;
}

export type RateSource = "cache" | "upstream" | "stale";

export interface RateLookup {
  rate: ExchangeRate;
  source: RateSource;
}

/** Thrown when there is neither a fresh rate nor a last-known rate to serve. */
export class RateUnavailableError extends Error {
  status = 503;
  code = "RATE_UNAVAILABLE";

  constructor(pair: RatePair) {
    super(`Exchange rate ${pair.base}/${pair.quote} is unavailable`);
    this.name = "RateUnavailableError";
  }
}

/** Pairs served by the API and refreshed by the pre-warm job. */
export const SUPPORTED_RATE_PAIRS: readonly RatePair[] = [{ base: "NGN", quote: "USDC" }];

export const DEFAULT_RATES_CACHE_TTL_SECONDS = 60;
export const DEFAULT_RATES_STALE_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_RATES_PREWARM_INTERVAL_MS = 55_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 2_000;
const DEFAULT_NGN_PER_USDC = 1600;

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Fresh-entry TTL in seconds (`RATES_CACHE_TTL_SECONDS`, default 60). */
export function getRatesCacheTtlSeconds(): number {
  return positiveIntFromEnv("RATES_CACHE_TTL_SECONDS", DEFAULT_RATES_CACHE_TTL_SECONDS);
}

/** How long a last-known rate may be served when upstream is down (default 24h). */
export function getRatesStaleTtlSeconds(): number {
  return positiveIntFromEnv("RATES_STALE_TTL_SECONDS", DEFAULT_RATES_STALE_TTL_SECONDS);
}

/** Pre-warm interval in ms (`RATES_PREWARM_INTERVAL_MS`, default 55000). */
export function getRatesPrewarmIntervalMs(): number {
  return positiveIntFromEnv("RATES_PREWARM_INTERVAL_MS", DEFAULT_RATES_PREWARM_INTERVAL_MS);
}

/** Namespaced cache key for a pair, e.g. `rates:NGN:USDC`. */
export function rateCacheKey(pair: RatePair): string {
  return `rates:${pair.base.toUpperCase()}:${pair.quote.toUpperCase()}`;
}

function lastKnownKey(pair: RatePair): string {
  return `${rateCacheKey(pair)}:last-known`;
}

// ---------------------------------------------------------------------------
// Upstream provider
// ---------------------------------------------------------------------------

function extractRate(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { rate?: unknown; data?: { rate?: unknown } };
  const candidate = record.rate ?? record.data?.rate;
  const rate = typeof candidate === "string" ? Number.parseFloat(candidate) : candidate;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Fetches a rate from the configured provider. Throws on any failure. */
export async function fetchUpstreamRate(pair: RatePair): Promise<number> {
  const providerUrl = process.env["RATES_PROVIDER_URL"]?.trim();

  if (!providerUrl) {
    const configured = Number.parseFloat(process.env["NGN_PER_USDC_RATE"] ?? "");
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_NGN_PER_USDC;
  }

  const url = new URL(providerUrl);
  url.searchParams.set("base", pair.base);
  url.searchParams.set("quote", pair.quote);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    positiveIntFromEnv("RATES_PROVIDER_TIMEOUT_MS", DEFAULT_PROVIDER_TIMEOUT_MS)
  );
  timer.unref?.();

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Rate provider responded with HTTP ${res.status}`);
    }
    const rate = extractRate(await res.json());
    if (rate === null) {
      throw new Error("Rate provider response did not contain a valid rate");
    }
    return rate;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cache orchestration
// ---------------------------------------------------------------------------

function parseCachedRate(raw: string | null): ExchangeRate | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExchangeRate>;
    return typeof parsed.rate === "number" && typeof parsed.fetchedAt === "string"
      ? (parsed as ExchangeRate)
      : null;
  } catch {
    return null;
  }
}

/**
 * In-flight upstream refreshes keyed by pair, so a burst of cache misses
 * triggers exactly one provider call (single-flight).
 */
const inflight = new Map<string, Promise<ExchangeRate>>();

/**
 * Fetches the rate from upstream and writes both the fresh entry and the
 * last-known copy. Throws when the provider is unreachable.
 */
export function refreshExchangeRate(pair: RatePair): Promise<ExchangeRate> {
  const key = rateCacheKey(pair);
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const rate: ExchangeRate = {
      base: pair.base.toUpperCase(),
      quote: pair.quote.toUpperCase(),
      rate: await fetchUpstreamRate(pair),
      fetchedAt: new Date().toISOString(),
    };
    const serialised = JSON.stringify(rate);
    await Promise.all([
      cache.set(key, serialised, getRatesCacheTtlSeconds()),
      cache.set(lastKnownKey(pair), serialised, getRatesStaleTtlSeconds()),
    ]);
    return rate;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

/**
 * Returns the rate for `pair`: the fresh cached value when there is one, else
 * a new upstream value, else the last-known value marked `stale`. Throws
 * `RateUnavailableError` only when none of those exist.
 */
export async function getExchangeRate(pair: RatePair): Promise<RateLookup> {
  const cached = parseCachedRate(await cache.get(rateCacheKey(pair)));
  if (cached) return { rate: cached, source: "cache" };

  try {
    return { rate: await refreshExchangeRate(pair), source: "upstream" };
  } catch (err) {
    const lastKnown = parseCachedRate(await cache.get(lastKnownKey(pair)));
    if (lastKnown) {
      logger.warn(
        { base: pair.base, quote: pair.quote, fetchedAt: lastKnown.fetchedAt, err: (err as Error).message },
        "[rates] Upstream provider unreachable — serving last-known rate"
      );
      return { rate: lastKnown, source: "stale" };
    }
    logger.error(
      { base: pair.base, quote: pair.quote, err: (err as Error).message },
      "[rates] Upstream provider unreachable and no cached rate available"
    );
    throw new RateUnavailableError(pair);
  }
}

/**
 * Cron task: refreshes every supported pair so the cache stays warm. A failed
 * pair is logged and does not prevent the others from refreshing; the task
 * only rejects when every pair failed (so the cron runner logs a failure).
 */
export async function prewarmExchangeRates(
  pairs: readonly RatePair[] = SUPPORTED_RATE_PAIRS
): Promise<{ refreshed: number; failed: number }> {
  const results = await Promise.allSettled(pairs.map((pair) => refreshExchangeRate(pair)));

  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failed++;
      const pair = pairs[index]!;
      logger.warn(
        { base: pair.base, quote: pair.quote, err: (result.reason as Error)?.message },
        "[rates] Pre-warm refresh failed"
      );
    }
  });

  if (pairs.length > 0 && failed === pairs.length) {
    throw new Error("Exchange rate pre-warm failed for every pair");
  }
  return { refreshed: pairs.length - failed, failed };
}
