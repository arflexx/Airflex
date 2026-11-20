/**
 * Integration tests for the `admin` route group (issue #74, #79).
 *
 * Exercises GET /api/v1/admin/queues and PATCH /api/v1/admin/users/:id/kyc
 * against a real test database.
 *
 * Covers: successful request (2xx), validation failure (422 — invalid KYC
 * status value), auth failure (401 — no token, 403 — authenticated but not
 * an admin), and not-found (404 — KYC update for a user id that doesn't
 * exist).
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

describe("Admin routes", () => {
  let dbAvailable = false;
  let adminToken: string;
  let regularUserToken: string;
  let targetUserId: string;

  beforeAll(async () => {
    try {
      await pool.query("SELECT 1");
      // Note: audit_logs is append-only (a DB trigger rejects TRUNCATE/UPDATE
      // outside the retention job's opt-in session setting), so it is
      // deliberately left out of this TRUNCATE — the KYC-approval assertion
      // below looks up its row by target_id instead of relying on a clean
      // table.
      await pool.query("TRUNCATE users CASCADE");
      dbAvailable = true;
    } catch {
      console.warn("PostgreSQL database unavailable or uninitialized for admin test, skipping.");
      return;
    }

    const adminId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, phone, referral_code, role) VALUES ($1, $2, $3, $4)`,
      [adminId, "+10000000030", "ADMINUSER30", "admin"]
    );
    adminToken = jwt.sign({ sub: adminId }, process.env["JWT_SECRET"]!, { expiresIn: "1h" });

    const regularId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, phone, referral_code, role) VALUES ($1, $2, $3, $4)`,
      [regularId, "+10000000031", "REGUSER31", "user"]
    );
    regularUserToken = jwt.sign({ sub: regularId }, process.env["JWT_SECRET"]!, { expiresIn: "1h" });

    targetUserId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, phone, referral_code, kyc_status) VALUES ($1, $2, $3, $4)`,
      [targetUserId, "+10000000032", "TARGETUSER32", "pending"]
    );
  });

  afterAll(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });

  it("GET /admin/queues requires authentication (401)", async () => {
    if (!dbAvailable) return;

    const res = await request(app).get("/api/v1/admin/queues");
    expect(res.status).toBe(401);
  });

  it("GET /admin/queues rejects a non-admin user (403)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .get("/api/v1/admin/queues")
      .set("Authorization", `Bearer ${regularUserToken}`);

    expect(res.status).toBe(403);
  });

  it("GET /admin/queues returns queue stats for an admin (200)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .get("/api/v1/admin/queues")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.queues)).toBe(true);
  });

  it("PATCH /admin/users/:id/kyc rejects an invalid status value (422)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .patch(`/api/v1/admin/users/${targetUserId}/kyc`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "not-a-real-status" });

    expect(res.status).toBe(422);
  });

  it("PATCH /admin/users/:id/kyc returns 404 for a non-existent user", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .patch(`/api/v1/admin/users/${uuidv4()}/kyc`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "verified" });

    expect(res.status).toBe(404);
  });

  it("PATCH /admin/users/:id/kyc approves a user's KYC (200)", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .patch(`/api/v1/admin/users/${targetUserId}/kyc`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "verified", note: "Document reviewed manually" });

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe("verified");

    const { rows } = await pool.query(
      `SELECT kyc_status FROM users WHERE id = $1`,
      [targetUserId]
    );
    expect(rows[0].kyc_status).toBe("verified");

    const { rows: auditRows } = await pool.query(
      `SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [targetUserId]
    );
    expect(auditRows[0]?.action).toBe("kyc.approved");
  });
});
