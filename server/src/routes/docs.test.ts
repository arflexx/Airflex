/**
 * docs.test.ts
 *
 * Tests for docs routes including the async error test endpoint.
 */

import request from "supertest";

// Shim required env vars for test
process.env["JWT_SECRET"] = "test-secret";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-0000-0000-000000000000";
process.env["NODE_ENV"] = "development";

import app from "../index";

describe("docs routes", () => {
  describe("GET /api/docs.json", () => {
    it("returns 200 with OpenAPI spec JSON", async () => {
      const res = await request(app).get("/api/docs.json");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body.openapi).toBe("3.1.0");
    });
  });

  describe("GET /api/test-async-error (dev mode)", () => {
    it("returns 500 with global error handler (not hanging)", async () => {
      const res = await request(app).get("/api/v1/test-async-error");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("async test");
    });
  });
});
