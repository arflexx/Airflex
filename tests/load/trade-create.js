import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.LOAD_TEST_BASE_URL;
const authToken = __ENV.LOAD_TEST_AUTH_TOKEN;

if (!baseUrl) {
  throw new Error("LOAD_TEST_BASE_URL is required");
}
if (!authToken) {
  throw new Error("LOAD_TEST_AUTH_TOKEN is required for trade creation load tests");
}

export const options = {
  vus: 20,
  duration: "3m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function createTrade() {
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

  check(res, {
    "trade create ok or expected client error": (r) =>
      r.status === 201 || r.status === 400 || r.status === 401,
  });
  sleep(2);
}
