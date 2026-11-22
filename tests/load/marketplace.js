import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const baseUrl = __ENV.LOAD_TEST_BASE_URL;
if (!baseUrl) {
  throw new Error("LOAD_TEST_BASE_URL is required");
}

/** Share of rates responses served from the Redis cache (X-Cache: HIT). */
const ratesCacheHits = new Rate("rates_cache_hits");

export const options = {
  scenarios: {
    // Marketplace listing feed.
    marketplace: {
      executor: "constant-vus",
      vus: 100,
      duration: "5m",
      exec: "marketplaceListing",
      tags: { endpoint: "marketplace" },
    },
    // Exchange-rate endpoint, served from the Redis cache (issue #676). The
    // pre-warm cron keeps the cache hot, so this should never hit upstream.
    rates: {
      executor: "constant-vus",
      vus: 50,
      duration: "5m",
      exec: "exchangeRates",
      tags: { endpoint: "rates" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:marketplace}": ["p(95)<500"],
    // Cached rates must stay under 50ms at p95 (issue #676).
    "http_req_duration{endpoint:rates}": ["p(95)<50"],
    // Nearly every rates request should be a cache hit once warm.
    rates_cache_hits: ["rate>0.95"],
  },
};

export function marketplaceListing() {
  const res = http.get(`${baseUrl}/api/v1/trades?page=1&limit=10`);
  check(res, { "marketplace status 200": (r) => r.status === 200 });
  sleep(1);
}

export function exchangeRates() {
  const res = http.get(`${baseUrl}/api/v1/rates`);
  const cacheStatus = res.headers["X-Cache"];
  ratesCacheHits.add(cacheStatus === "HIT");
  check(res, {
    "rates status 200": (r) => r.status === 200,
    "rates has a numeric rate": (r) => typeof r.json("rate") === "number",
    "rates carries Cache-Control": (r) => Boolean(r.headers["Cache-Control"]),
    "rates not stale": () => cacheStatus !== "STALE",
  });
  sleep(0.5);
}

export default marketplaceListing;
