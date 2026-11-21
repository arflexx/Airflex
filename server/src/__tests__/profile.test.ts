/**
 * Integration tests for the `profile` route group (issue #74, #79).
 *
 * Exercises GET /api/v1/profile, PATCH /api/v1/profile, and
 * GET /api/v1/profile/trades against a real test database.
 *
 * Covers: successful request (2xx), validation failure (400 on PATCH —
 * profile.ts validates with `validate(profileUpdateSchema, 400)`), and auth
 * failure (401 — no bearer token). A dedicated not-found case doesn't apply
 * here: every route operates on the authenticated caller's own row, and
 * `authenticate` itself already 401s before a handler could return 404 for a
 * deleted/non-existent user (see middleware/authenticate.ts
 * isTokenVersionCurrent).
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

describe("Profile routes", () => {
  let dbAvailable = false;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    try {
      await pool.query("SELECT 1");
      await pool.query("TRUNCATE users, wallets, trade_offers CASCADE");
      dbAvailable = true;
    } catch {
      console.warn("PostgreSQL database unavailable or uninitialized for profile test, skipping.");
      return;
    }

    userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, phone, referral_code, stellar_public_key, kyc_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, "+10000000020", "PROFUSER20", "G_PROFILE_PUB", "unverified"]
    );

    token = jwt.sign(
      { sub: userId, stellarPublicKey: "G_PROFILE_PUB" },
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

  it("GET /profile requires authentication (401)", async () => {
    if (!dbAvailable) return;

    const res = await request(app).get("/api/v1/profile");
    expect(res.status).toBe(401);
  });

  it("GET /profile returns the authenticated user's profile (200)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .get("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.kycStatus).toBe("unverified");
    expect(res.body.data.role).toBe("user");
    expect(res.body.data.stellarPublicKey).toBe("G_PROFILE_PUB");
    expect(typeof res.body.data.maskedPhone).toBe("string");
  });

  it("PATCH /profile rejects an invalid alias (400)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ alias: "invalid alias with spaces!" });

    expect(res.status).toBe(400);
  });

  it("PATCH /profile updates alias and notificationsEnabled (200)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ alias: "new_handle", notificationsEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.alias).toBe("new_handle");
    expect(res.body.data.notificationsEnabled).toBe(false);
  });

  it("GET /profile/trades returns a paginated, empty trade history (200)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .get("/api/v1/profile/trades?page=1&limit=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });
});
