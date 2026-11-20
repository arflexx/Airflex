/**
 * Integration tests for the `wallet` route group (issue #79).
 *
 * Exercises GET /api/v1/wallet and POST /api/v1/wallet/withdraw against a
 * real test database, with the Stellar/Horizon balance lookup mocked at the
 * service boundary (same approach as trade-lifecycle.test.ts).
 *
 * Covers: successful request (2xx), validation failure (400 — missing
 * Idempotency-Key header on withdraw), auth failure (401 — no bearer token),
 * and not-found (404 — authenticated user with no provisioned wallet row).
 */

process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-4000-8000-000000000000";
process.env["PAYSTACK_SECRET_KEY"] = "sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
process.env["TERMII_API_KEY"] = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

import request from "supertest";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import app from "../index";
import { pool } from "../db/pool";

jest.mock("../services/stellar", () => ({
  getWalletBalance: jest.fn().mockResolvedValue("1234.5000000"),
  decryptSecret: jest.fn().mockReturnValue("mock_decrypted_secret"),
}));

describe("Wallet routes", () => {
  let dbAvailable = false;
  let userWithWalletId: string;
  let userWithWalletToken: string;
  let userWithoutWalletId: string;
  let userWithoutWalletToken: string;

  beforeAll(async () => {
    try {
      await pool.query("SELECT 1");
      await pool.query("TRUNCATE users, wallets CASCADE");
      dbAvailable = true;
    } catch {
      console.warn("PostgreSQL database unavailable or uninitialized for wallet test, skipping.");
      return;
    }

    userWithWalletId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, phone, referral_code) VALUES ($1, $2, $3)`,
      [userWithWalletId, "+10000000010", "WALUSER10"]
    );
    await pool.query(
      `INSERT INTO wallets (id, user_id, stellar_public_key, stellar_secret_key)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), userWithWalletId, "G_WALLET_PUB", "encrypted"]
    );
    userWithWalletToken = jwt.sign(
      { sub: userWithWalletId, stellarPublicKey: "G_WALLET_PUB" },
      process.env["JWT_SECRET"]!,
      { expiresIn: "1h" }
    );

    userWithoutWalletId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, phone, referral_code) VALUES ($1, $2, $3)`,
      [userWithoutWalletId, "+10000000011", "WALUSER11"]
    );
    userWithoutWalletToken = jwt.sign(
      { sub: userWithoutWalletId, stellarPublicKey: "" },
      process.env["JWT_SECRET"]!,
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });

  it("GET /wallet requires authentication (401)", async () => {
    if (!dbAvailable) return;

    const res = await request(app).get("/api/v1/wallet");
    expect(res.status).toBe(401);
  });

  it("GET /wallet returns the public key and balance (200)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .get("/api/v1/wallet")
      .set("Authorization", `Bearer ${userWithWalletToken}`);

    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe("G_WALLET_PUB");
    expect(res.body.balance).toBe("1234.5000000");
    expect(res.body.asset).toBe("XLM");
  });

  it("GET /wallet returns 404 when the wallet hasn't been provisioned yet", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .get("/api/v1/wallet")
      .set("Authorization", `Bearer ${userWithoutWalletToken}`);

    expect(res.status).toBe(404);
  });

  it("POST /wallet/withdraw rejects a missing Idempotency-Key header (400)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .post("/api/v1/wallet/withdraw")
      .set("Authorization", `Bearer ${userWithWalletToken}`)
      .send({
        amount: 100,
        bank_code: "058",
        account_number: "0123456789",
        account_name: "Test User",
      });

    expect(res.status).toBe(400);
  });
});
