import { Request, Response, NextFunction } from "express";

import { cache } from "../services/cache";
import { AuthenticatedRequest } from "./authenticate";
import { TradeErrorCode } from "../types/trade";

/**
 * Per-user rate limit for trade creation (POST /api/v1/trades) — issue #617 / #614.
 *
 * `FraudDetectionService.checkVelocity` in `services/fraudDetection.ts` already
 * implements a general-purpose velocity check keyed on `MAX_TRADES_PER_HOUR`,
 * but nothing in `routes/trades.ts` actually calls it for trade creation, so
 * a single user could burst-create trade listings without limit. Rather than
 * wire the fraud-detection service into the route (a larger, riskier change
 * touching AML bookkeeping), this adds a dedicated, self-contained middleware
 * that follows the same shape as `rateLimitKyc.ts`: a fixed-window counter,
 * keyed on the authenticated user (falling back to IP when unauthenticated),
 * that fails open on a cache error.
 *
 * Unlike `rateLimitKyc.ts` (Postgres-backed), state here is stored via
 * `services/cache.ts`, which is Redis-backed when `REDIS_URL` is set and
 * falls back to an in-process Map otherwise — matching the acceptance
 * criteria for this issue.
 */

/** Trade creation requests allowed per user per window. */
function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const TRADE_MAX_PER_HOUR = positiveInteger(process.env["MAX_TRADES_PER_HOUR"], 10);

/** Fixed window length, in seconds. */
export const TRADE_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

export interface TradeRateLimitState {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window rolls over. */
  retryAfterSeconds: number;
}

function tradeRateLimitKey(identifier: string): string {
  return `rate-limit:trade-create:${identifier}`;
}

interface TradeRateLimitEntry {
  count: number;
  /** Epoch ms the current window resets at. */
  resetAt: number;
}

/**
 * Records a trade-creation attempt and reports whether it is allowed.
 *
 * Uses a fixed window (not sliding): the counter and its reset time are
 * stored as one JSON value via `cache.get`/`cache.set`, since the minimal
 * Redis client in `services/cache.ts` only implements GET/SET (no INCR), so
 * there is no atomic counter primitive to build a sliding window on. The
 * window resets at a fixed boundary per identifier instead of per request,
 * which is a reasonable trade-off for this limit (unlike OTP/KYC abuse,
 * bursting trade creation right at a window boundary is low-stakes).
 */
export async function checkTradeRateLimit(
  userId: string | null,
  ipAddress: string | null = null
): Promise<TradeRateLimitState> {
  const identifier = userId ?? ipAddress;
  if (!identifier) {
    throw new Error("A user ID or IP address is required for trade rate limiting.");
  }

  const key = tradeRateLimitKey(identifier);
  const now = Date.now();

  let entry: TradeRateLimitEntry | null = null;
  const raw = await cache.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TradeRateLimitEntry;
      if (parsed.resetAt > now) {
        entry = parsed;
      }
    } catch {
      // Corrupt entry — treat as a fresh window.
    }
  }

  const resetAt = entry?.resetAt ?? now + TRADE_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const newCount = (entry?.count ?? 0) + 1;
  const ttlSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

  // Persist the increment before deciding, so a caller already past the
  // limit can't retry for free while waiting out the window — same
  // trade-off `rateLimitKyc.ts` makes.
  await cache.set(key, JSON.stringify({ count: newCount, resetAt }), ttlSeconds);

  return {
    allowed: newCount <= TRADE_MAX_PER_HOUR,
    remaining: Math.max(0, TRADE_MAX_PER_HOUR - newCount),
    retryAfterSeconds: ttlSeconds,
  };
}

/**
 * Express middleware enforcing the trade-creation rate limit.
 *
 * Must run after `authenticate` (needs `req.user.sub`) and is applied only
 * to `POST /api/v1/trades`. Fails open on a cache error — losing the limit
 * for the duration of a blip is cheaper than blocking every trade listing.
 */
export async function rateLimitTrade(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = (req as AuthenticatedRequest).user?.sub;
  const ipAddress = req.ip || req.socket.remoteAddress || null;

  if (!userId && !ipAddress) {
    next();
    return;
  }

  try {
    const state = await checkTradeRateLimit(userId ?? null, ipAddress);

    res.setHeader("X-RateLimit-Limit", String(TRADE_MAX_PER_HOUR));
    res.setHeader("X-RateLimit-Remaining", String(state.remaining));

    if (!state.allowed) {
      res.setHeader("Retry-After", String(state.retryAfterSeconds));
      res.status(429).json({
        error: `Too many trade creation requests. Try again in ${Math.ceil(
          state.retryAfterSeconds / 60
        )} minute(s).`,
        code: TradeErrorCode.TRADE_RATE_LIMITED,
      });
      return;
    }

    next();
  } catch (err) {
    console.error("[rateLimitTrade] Rate limit check failed:", (err as Error).message);
    next();
  }
}
