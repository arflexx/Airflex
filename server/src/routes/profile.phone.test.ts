/**
 * profile.phone.test.ts
 *
 * Integration tests for phone number change with OTP re-verification
 * (issue #620 / #629).
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-key-1234567890";
process.env["JWT_SECRET"] = JWT_SECRET;

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

jest.mock("../services/auditLog", () => ({
  recordAuditLog: jest.fn().mockResolvedValue(undefined),
  auditContext: jest.fn().mockReturnValue({ ip: "127.0.0.1" }),
}));

jest.mock("../middleware/rateLimitOtp", () => ({
  enforceOtpRateLimit: jest.fn().mockResolvedValue(true),
  rateLimitOtp: (_req: any, _res: any, next: any) => next(),
}));

import profileRouter from "./profile";
import { cache } from "../services/cache";
import { recordAuditLog } from "../services/auditLog";

const app = express();
app.use(express.json());
app.use("/api/v1/profile", profileRouter);

describe("POST /api/v1/profile/phone/request & /confirm", () => {
  const userId = "aaaaaaaa-1111-1111-1111-111111111111";
  const otherUserId = "bbbbbbbb-2222-2222-2222-222222222222";
  const token = jwt.sign({ sub: userId, role: "user" }, JWT_SECRET, { expiresIn: "1h" });

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
  });

  it("requests phone change, normalizes number, and stores OTP in Redis", async () => {
    // 1. authenticate token_version check
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    // 2. check phone not already registered to another user
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/v1/profile/phone/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "08012345678" });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe("+2348012345678");

    // Verify stored in Redis / cache
    const cached = await cache.get(`pending_phone_change:${userId}`);
    expect(cached).not.toBeNull();
    const data = JSON.parse(cached!);
    expect(data.phone).toBe("+2348012345678");
    expect(data.otp).toMatch(/^\d{6}$/);
  });

  it("rejects phone if already registered to another account (409)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    // phone found for another user
    mockQuery.mockResolvedValueOnce({ rows: [{ id: otherUserId }] });

    const res = await request(app)
      .post("/api/v1/profile/phone/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "08012345678" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it("confirms phone change, updates DB, and records audit log", async () => {
    const otp = "654321";
    await cache.set(
      `pending_phone_change:${userId}`,
      JSON.stringify({ phone: "+2348012345678", otp }),
      600
    );

    // 1. authenticate
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    // 2. select old phone
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: "+2348099999999" }] });
    // 3. update user phone
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post("/api/v1/profile/phone/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ otp });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.phone).toBe("+2348012345678");

    // Verify DB update
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE users SET phone = \$1/i),
      ["+2348012345678", userId]
    );

    // Verify audit log recorded
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: userId,
        action: "user.phone_changed",
        targetType: "user",
        before: { phone: "+2348099999999" },
        after: { phone: "+2348012345678" },
      })
    );

    // Verify pending change cleared from cache
    const cachedAfter = await cache.get(`pending_phone_change:${userId}`);
    expect(cachedAfter).toBeFalsy();
  });

  it("rejects invalid OTP", async () => {
    await cache.set(
      `pending_phone_change:${userId}`,
      JSON.stringify({ phone: "+2348012345678", otp: "654321" }),
      600
    );

    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .post("/api/v1/profile/phone/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ otp: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid otp/i);
  });
});
