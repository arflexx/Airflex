import { Router, type Request, type Response } from "express";
import {
  getExchangeRate,
  getRatesCacheTtlSeconds,
  getRatesStaleTtlSeconds,
  RateUnavailableError,
  type RateLookup,
  type RatePair,
} from "../services/exchangeRates";

const router = Router();

const NGN_USDC: RatePair = { base: "NGN", quote: "USDC" };

/**
 * GET /api/v1/rates
 * Returns conversion rate for fiat (NGN) to stablecoin (USDC).
 *
 * Served from the Redis cache (`rates:NGN:USDC`, issue #676), which the
 * pre-warm cron job keeps warm. Response headers describe freshness:
 *  - `X-Cache: HIT | MISS | STALE`
 *  - `Cache-Control` carries `max-age` (time left on the fresh entry) and
 *    `stale-while-revalidate`; when the upstream provider is unreachable and
 *    the last-known rate is served, `max-age=0`, `stale-if-error` and a
 *    `Warning: 110` header flag the response as stale.
 */
router.get("/", async (_req: Request, res: Response) => {
  const ttl = getRatesCacheTtlSeconds();

  let lookup: RateLookup;
  try {
    lookup = await getExchangeRate(NGN_USDC);
  } catch (err) {
    if (err instanceof RateUnavailableError) {
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({ error: "Exchange rate temporarily unavailable", code: err.code });
      return;
    }
    throw err;
  }

  const { rate, source } = lookup;

  if (source === "stale") {
    res.setHeader(
      "Cache-Control",
      `public, max-age=0, stale-while-revalidate=${ttl}, stale-if-error=${getRatesStaleTtlSeconds()}`
    );
    res.setHeader("Warning", '110 - "Response is Stale"');
    res.setHeader("X-Cache", "STALE");
  } else {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(rate.fetchedAt)) / 1000));
    const maxAge = Math.max(0, ttl - ageSeconds);
    res.setHeader("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${ttl}`);
    res.setHeader("X-Cache", source === "cache" ? "HIT" : "MISS");
  }
  res.setHeader("Last-Modified", new Date(rate.fetchedAt).toUTCString());

  res.status(200).json({
    rate: rate.rate,
    base: rate.base,
    target: rate.quote,
    data: {
      rate: rate.rate,
      base: rate.base,
      target: rate.quote,
    },
  });
});

export default router;
