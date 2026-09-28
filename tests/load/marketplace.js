import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.LOAD_TEST_BASE_URL;
if (!baseUrl) {
  throw new Error("LOAD_TEST_BASE_URL is required");
}

export const options = {
  vus: 100,
  duration: "5m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function marketplaceListing() {
  const res = http.get(`${baseUrl}/api/v1/trades?page=1&limit=10`);
  check(res, { "marketplace status 200": (r) => r.status === 200 });
  sleep(1);
}
