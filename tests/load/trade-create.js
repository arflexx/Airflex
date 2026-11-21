import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const baseUrl = __ENV.LOAD_TEST_BASE_URL;
const authToken = __ENV.LOAD_TEST_AUTH_TOKEN;

if (!baseUrl) {
  throw new Error("LOAD_TEST_BASE_URL is required");
}
if (!authToken) {
  throw new Error("LOAD_TEST_AUTH_TOKEN is required for trade creation load tests");
}

const VUS = parseInt(__ENV.LOAD_TEST_VUS ?? "50", 10);
const DURATION = __ENV.LOAD_TEST_DURATION ?? "2m";

/**
 * Requests that failed because the PostgreSQL pool had no free connection
 * (issue #680). The server answers those with HTTP 503 (code
 * DB_POOL_EXHAUSTED outside production); any 503 from trade creation is
 * counted here.
 */
const poolExhaustionErrors = new Counter("db_pool_exhaustion_errors");
/** Callers queued for a connection, sampled from GET /health. */
const poolWaiting = new Trend("db_pool_waiting");
/** Checked-out connections as a share of DB_POOL_MAX, sampled from /health. */
const poolUtilisation = new Trend("db_pool_utilisation");

export const options = {
  scenarios: {
    // 50 concurrent users creating trades (issue #680).
    trade_create: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      exec: "createTrade",
      tags: { endpoint: "trade_create" },
    },
    // Samples pool metrics from /health while the load runs.
    pool_monitor: {
      executor: "constant-vus",
      vus: 1,
      duration: DURATION,
      exec: "samplePoolHealth",
      tags: { endpoint: "health" },
    },
  },
  thresholds: {
    "http_req_failed{endpoint:trade_create}": ["rate<0.01"],
    "http_req_duration{endpoint:trade_create}": ["p(95)<500"],
    // Zero pool exhaustion errors at 50 concurrent users.
    db_pool_exhaustion_errors: ["count==0"],
  },
};

export function createTrade() {
  const payload = JSON.stringify({
    assetType: "MTN_AIRTIME",
    amount: 500,
    expiresInHours: 24,
  });

  const res = http.post(`${baseUrl}/api/v1/trades`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (res.status === 503) {
    poolExhaustionErrors.add(1);
  }

  check(res, {
    "trade create ok or expected client error": (r) =>
      r.status === 201 || r.status === 400 || r.status === 401,
    "no pool exhaustion (503)": (r) => r.status !== 503,
  });
  sleep(2);
}

export function samplePoolHealth() {
  const res = http.get(`${baseUrl}/health`);
  const pool = res.status === 200 || res.status === 503 ? res.json("pool") : null;

  if (pool && typeof pool === "object") {
    poolWaiting.add(Number(pool.waiting ?? 0));
    if (pool.max) {
      poolUtilisation.add(Number(pool.active ?? 0) / Number(pool.max));
    }
  }

  check(res, { "health exposes pool metrics": () => Boolean(pool) });
  sleep(5);
}

export default createTrade;
