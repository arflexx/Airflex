/**
 * index.test.ts
 *
 * Integration-level tests for the root Express application.
 * Uses supertest to make requests without starting a real network listener.
 *
 * NOTE: The app validates required env vars at module load, so we shim them
 * before importing the app.
 */

// Shim required env vars before loading the app module
process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

import request from "supertest";
import app from "./index";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("includes a version field equal to '1.0.0'", async () => {
    const res = await request(app).get("/health");
    expect(res.body.version).toBe("1.0.0");
  });

  it("includes a timestamp ISO string", async () => {
    const res = await request(app).get("/health");
    expect(typeof res.body.timestamp).toBe("string");
    expect(() => new Date(res.body.timestamp)).not.toThrow();
  });

  it("includes the X-Api-Version: 1 response header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-api-version"]).toBe("1");
  });
});
