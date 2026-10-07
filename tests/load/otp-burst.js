import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.LOAD_TEST_BASE_URL;
if (!baseUrl) {
  throw new Error("LOAD_TEST_BASE_URL is required");
}

export const options = {
  vus: 50,
  duration: "1m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function otpBurst() {
  const phone = `+23480${__VU}${String(__ITER).padStart(4, "0").slice(-4)}`;
  const res = http.post(
    `${baseUrl}/api/v1/auth/request-otp`,
    JSON.stringify({ phone }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, {
    "otp accepted or rate limited": (r) => r.status === 200 || r.status === 429,
  });
  sleep(0.5);
}
