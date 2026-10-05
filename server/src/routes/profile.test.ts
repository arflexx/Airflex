/**
 * profile.test.ts
 *
 * Tests for GET /api/v1/profile including referralCode verification,
 * plus the PATCH /api/v1/profile update and trade-history query validation
 * added in issue #74.
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

import profileRouter from "./profile";

const app = express();
app.use(express.json());
app.use("/api/v1/profile", profileRouter);

describe("GET /api/v1/profile", () => {
  const userId = "11111111-1111-1111-1111-111111111111";
  const token = jwt.sign({ sub: userId, role: "user" }, JWT_SECRET, { expiresIn: "1h" });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/v1/profile");
    expect(res.status).toBe(401);
  });

  it("returns 200 with profile data and non-empty referralCode", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    // 1st query: users
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: userId,
          phone: "+2348012345678",
          created_at: "2026-01-01T00:00:00.000Z",
          stellar_public_key: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
          role: "user",
          kyc_status: "verified",
          virtual_account_number: "0123456789",
          referral_code: "AIR77REF",
        },
      ],
    });

    // 2nd query: trade counts
    mockQuery.mockResolvedValueOnce({
      rows: [{ count: "12" }],
    });

    const res = await request(app)
      .get("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.referralCode).toBe("AIR77REF");
    expect(typeof res.body.data.referralCode).toBe("string");
    expect(res.body.data.referralCode.length).toBeGreaterThan(0);
    expect(res.body.data.totalTradesCompleted).toBe(12);
    expect(res.body.data.role).toBe("user");
    expect(res.body.data.kycStatus).toBe("verified");
    expect(res.body.data.virtualAccountNumber).toBe("0123456789");
  });

  it("returns 404 when user is not found in database", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    // 1st query: users (not found)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });
});

describe("PATCH /api/v1/profile", () => {
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
    const res = await request(app).patch("/api/v1/profile");
    expect(res.status).toBe(401);
  });

  it("rejects invalid profile updates", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ alias: "not valid!" });

    expect(res.status).toBe(422);
  });

  it("updates only supplied profile fields", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    // 1st query: the profile UPDATE itself.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: userId, alias: "Alice", notifications_enabled: false }],
    });

    const res = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ alias: "Alice", notificationsEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.alias).toBe("Alice");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE users SET"),
      ["Alice", false, userId]
    );
  });

  it("returns 400 when no profile field is supplied", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/profile/trades", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const token = jwt.sign(
    { sub: userId, stellarPublicKey: "GTEST" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("rejects an invalid trade-history status filter", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .get("/api/v1/profile/trades?status=unknown")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query parameters");
  });

  it("returns paginated trade history", async () => {
    // 0th query: authenticate's token-revocation check (token_version lookup).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    // 1st query: trades, 2nd query: total count.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "trade-1", status: "Active" }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const res = await request(app)
      .get("/api/v1/profile/trades?page=1&limit=10&status=Active")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  });
});
