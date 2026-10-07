/**
 * analytics.test.ts
 *
 * Regression tests for issue #318: platform-level analytics must not be
 * publicly reachable. All three endpoints are gated by
 * `authenticate` + `authorize("admin")`; unauthenticated requests are
 * rejected with 401 before any handler (or DB query) runs.
 */

import request from "supertest";

// Shim required env vars for test (mirrors docs.test.ts)
process.env["JWT_SECRET"] = "test-secret";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] = "SAIXYZSSAQUEJO3Z3LUQ4PM3VVDK3DIO55V76ORFO6HH2VULC43AFHZX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-0000-0000-000000000000";
process.env["NODE_ENV"] = "development";

import app from "../index";

const ANALYTICS_PATHS = [
  "/api/v1/admin/analytics/overview",
  "/api/v1/admin/analytics/trades/timeseries",
  "/api/v1/admin/analytics/assets",
];

describe("analytics routes (#318)", () => {
  it.each(ANALYTICS_PATHS)("GET %s without a token returns 401", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .set("Authorization", "NotBearer abc123");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid JWT with 401", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .set("Authorization", "Bearer this-is-not-a-valid-token");
    expect(res.status).toBe(401);
  });
});
