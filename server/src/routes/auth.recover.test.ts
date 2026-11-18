/**
 * auth.recover.test.ts
 *
 * Tests for POST /api/v1/auth/recover/change-phone (issue #252).
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-key-at-least-32-chars-long!";
process.env["JWT_SECRET"] = JWT_SECRET;
process.env["TERMII_API_KEY"] = "test-termii-api-key";

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => mockQuery(...args),
  },
}));

jest.mock("../services/stellar", () => ({
  generateAndFundWallet: jest.fn(),
}));

jest.mock("../services/recoveryCodes", () => ({
  generateRecoveryCodesForUser: jest.fn(),
  userHasRecoveryCodes: jest.fn(),
  countRemainingRecoveryCodes: jest.fn(),
  redeemRecoveryCode: jest.fn(),
}));

jest.mock("../middleware/rateLimitOtp", () => ({
  rateLimitOtp: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOtpRateLimit: jest.fn().mockResolvedValue(true),
}));

// Mock fetch for Termii OTP send
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import authRouter from "./auth";
import { enforceOtpRateLimit } from "../middleware/rateLimitOtp";

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRouter);

describe("POST /api/v1/auth/recover/change-phone", () => {
  const userId = "aaaaaaaa-0000-0000-0000-000000000001";
  const validRecoveryToken = jwt.sign(
    { sub: userId, scope: "recovery", purpose: "change-phone" },
    JWT_SECRET,
    { expiresIn: "15m" }
  );

  beforeEach(() => {
    mockQuery.mockReset();
    mockFetch.mockReset();
  });

  it("returns verification prompt without session token, sends OTP, and invalidates recovery token", async () => {
    // Termii mock returns pinId
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pinId: "pin-123456", status: "success" }),
    });

    // 1st query: check if newPhone is already registered
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 2nd query: check if user exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: userId }] });
    // 3rd query: UPDATE users SET phone = $1, token_version = token_version + 1 WHERE id = $2
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4th query: sendOtp updates users table with otp_pin_id
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const newPhone = "+2348123456789";

    const res = await request(app)
      .post("/api/v1/auth/recover/change-phone")
      .send({ token: validRecoveryToken, newPhone });

    expect(res.status).toBe(200);
    expect(enforceOtpRateLimit).toHaveBeenCalledWith(
      newPhone,
      expect.any(String),
      expect.anything()
    );
    // Does NOT return a session token
    expect(res.body.token).toBeUndefined();
    expect(res.body.requiresVerification).toBe(true);
    expect(res.body.phone).toBe(newPhone);
    expect(res.body.message).toContain("Please verify your new phone number with the OTP");

    // Verified OTP was sent via Termii
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.ng.termii.com/api/sms/otp/send",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(newPhone),
      })
    );

    // Second attempt with the SAME recovery token must fail because it was invalidated immediately
    const resDuplicate = await request(app)
      .post("/api/v1/auth/recover/change-phone")
      .send({ token: validRecoveryToken, newPhone });

    expect(resDuplicate.status).toBe(401);
    expect(resDuplicate.body.error).toContain("Recovery token is invalid or expired");
  });
});
