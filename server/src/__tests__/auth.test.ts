/**
 * Integration tests for the `auth` route group (issue #79).
 *
 * Exercises POST /api/v1/auth/request-otp and POST /api/v1/auth/verify-otp
 * end-to-end against a real test database (migrated via `npm run db:migrate`
 * before the suite runs), with the Termii SMS API mocked at the `fetch`
 * boundary and wallet provisioning mocked at the service boundary — the same
 * approach already used by trade-lifecycle.test.ts.
 *
 * Covers: successful request (2xx), validation failure (422), and the
 * auth-flow's own failure case (401 — invalid/expired OTP), since
 * request-otp/verify-otp are public endpoints with no bearer-token
 * authorization to probe for 401/403.
 */

// Shim env vars — must be set before `../index` is imported.
process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-4000-8000-000000000000";
process.env["PAYSTACK_SECRET_KEY"] = "sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
process.env["TERMII_API_KEY"] = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

import request from "supertest";
import app from "../index";
import { pool } from "../db/pool";

// Mock wallet provisioning so verify-otp doesn't try to fund a real Stellar
// account (same pattern as trade-lifecycle.test.ts).
jest.mock("../services/stellar", () => ({
  generateAndFundWallet: jest.fn().mockResolvedValue({
    publicKey: "G_NEW_WALLET_PUB",
    encryptedSecretKey: "mock_encrypted_secret",
  }),
}));

// verify-otp also fires-and-forgets a Paystack dedicated-virtual-account
// provisioning call on first signup. Mock it at the service boundary so the
// test never depends on real (or even mocked-but-unconsumed) network access.
jest.mock("../services/virtualAccount", () => ({
  provisionVirtualAccountForUser: jest.fn().mockResolvedValue(undefined),
}));

describe("Auth routes", () => {
  let dbAvailable = false;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    try {
      await pool.query("SELECT 1");
      await pool.query("TRUNCATE users, wallets CASCADE");
      dbAvailable = true;
    } catch {
      console.warn("PostgreSQL database unavailable or uninitialized for auth test, skipping.");
    }
  });

  afterAll(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
    // Safety net: any fetch call not explicitly mocked in a test (there
    // should be none) gets a generic successful response instead of hitting
    // the real network.
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("POST /request-otp validates the phone number (422)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .post("/api/v1/auth/request-otp")
      .send({ phone: "not-a-phone" });

    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it("POST /request-otp creates/upserts the user and sends an OTP (200)", async () => {
    if (!dbAvailable) return;

    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ pinId: "mock_pin_id", status: "ok" }),
      text: async () => "",
    } as unknown as Response);

    const res = await request(app)
      .post("/api/v1/auth/request-otp")
      .send({ phone: "+2348012345678" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("OTP sent successfully");

    const { rows } = await pool.query(
      `SELECT otp_pin_id FROM users WHERE phone = $1`,
      ["+2348012345678"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].otp_pin_id).toBe("mock_pin_id");
  });

  it("POST /verify-otp validates the OTP shape (422)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: "+2348012345678", otp: "12" }); // too short

    expect(res.status).toBe(422);
  });

  it("POST /verify-otp rejects a phone with no pending OTP (401)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: "+2348099999999", otp: "123456" });

    expect(res.status).toBe(401);
  });

  it("POST /verify-otp completes signup and returns a JWT (200)", async () => {
    if (!dbAvailable) return;

    fetchSpy
      // request-otp: Termii send
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pinId: "mock_pin_id_2", status: "ok" }),
        text: async () => "",
      } as unknown as Response)
      // verify-otp: Termii verify
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ verified: true }),
        text: async () => "",
      } as unknown as Response);

    const phone = "+2348011112222";

    const requestRes = await request(app)
      .post("/api/v1/auth/request-otp")
      .send({ phone });
    expect(requestRes.status).toBe(200);

    const verifyRes = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp: "123456" });

    expect(verifyRes.status).toBe(200);
    expect(typeof verifyRes.body.token).toBe("string");
  });
});
