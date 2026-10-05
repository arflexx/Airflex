/**
 * admin.test.ts
 *
 * Tests for the admin-only KYC status endpoint
 * (PATCH /api/v1/admin/users/:id/kyc).
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-key-1234567890";
process.env["JWT_SECRET"] = JWT_SECRET;

// Mock database pool
const mockQuery = jest.fn();
jest.mock("../db", () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

import adminRouter from "./admin";

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRouter);

describe("PATCH /api/v1/admin/users/:id/kyc", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const token = jwt.sign(
    { sub: userId, stellarPublicKey: "GTEST" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).patch(`/api/v1/admin/users/${userId}/kyc`);
    expect(res.status).toBe(401);
  });

  it("requires admin role", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    // 1st query: authorize's role lookup.
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "user" }] });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${userId}/kyc`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "verified" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admin access required");
  });

  it("validates KYC status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "admin" }] });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${userId}/kyc`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Invalid KYC status");
  });

  it("updates a user's KYC status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "admin" }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: userId, kyc_status: "verified" }],
    });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${userId}/kyc`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "verified" });

    expect(res.status).toBe(200);
    expect(res.body.data.kyc_status).toBe("verified");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE users SET kyc_status"),
      ["verified", userId]
    );
  });
});
