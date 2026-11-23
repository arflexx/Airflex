/**
 * auth.test.ts
 *
 * Integration tests for auth routes and JWT middleware (issue #665).
 *
 * Covers:
 *   - OTP signup success (POST /api/v1/auth/request-otp)
 *   - OTP expiry (POST /api/v1/auth/verify-otp)
 *   - JWT issue on successful verify-otp
 *   - Expired JWT rejection by authenticate middleware
 *   - Revoked JWT rejection (token_version mismatch)
 *   - Malformed JWT rejection
 *
 * Database is mocked — no live Postgres required.
 * Run via: npm test (or pnpm --filter server test)
 */

// ---------------------------------------------------------------------------
// Env shims — must precede any module import that reads process.env
// ---------------------------------------------------------------------------
const JWT_SECRET = "test-secret-key-at-least-32-chars-long!!";
process.env["JWT_SECRET"] = JWT_SECRET;
process.env["TERMII_API_KEY"] = "test-termii-key";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";

// ---------------------------------------------------------------------------
// Mock heavy dependencies before importing the app
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock("../services/stellar", () => ({
  generateAndFundWallet: jest.fn().mockResolvedValue({
    publicKey: "GPUBLIC_KEY_MOCK",
    encryptedSecretKey: "enc-secret",
  }),
}));

jest.mock("../services/recoveryCodes", () => ({
  generateRecoveryCodesForUser: jest.fn().mockResolvedValue(["CODE1", "CODE2"]),
  userHasRecoveryCodes: jest.fn().mockResolvedValue(true),
  countRemainingRecoveryCodes: jest.fn().mockResolvedValue(8),
  redeemRecoveryCode: jest.fn(),
}));

jest.mock("../services/virtualAccount", () => ({
  provisionVirtualAccountForUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/referrals", () => ({
  createReferralCode: jest.fn().mockReturnValue("REF123"),
}));

jest.mock("../middleware/rateLimitOtp", () => ({
  rateLimitOtp: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOtpRateLimit: jest.fn().mockResolvedValue(true),
}));

jest.mock("../services/cache", () => ({
  cache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock global fetch for Termii API calls
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Import app and helpers after mocks are in place
// ---------------------------------------------------------------------------
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import authRouter from "./auth";
import { authenticate } from "../middleware/authenticate";

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRouter);

// A protected probe endpoint so we can test the authenticate middleware
// without depending on another real route.
app.get("/probe", authenticate, (req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const PHONE = "+2348012345678";
const STELLAR_KEY = "GPUBLIC_KEY_MOCK";

function makeJwt(overrides: Record<string, unknown> = {}, secret = JWT_SECRET) {
  return jwt.sign(
    {
      sub: USER_ID,
      stellarPublicKey: STELLAR_KEY,
      tokenVersion: 1,
      ...overrides,
    },
    secret,
    { expiresIn: "7d" }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/request-otp — OTP signup success", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFetch.mockReset();
  });

  it("returns 200 and stores the OTP pin when the phone is new", async () => {
    // Termii returns a pinId
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pinId: "pin-abc123", status: "success" }),
    });

    // 1st query: SELECT existing user (none)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 2nd query: INSERT new user
    mockQuery.mockResolvedValueOnce({ rows: [{ id: USER_ID }] });
    // 3rd query: UPDATE users SET otp_pin_id
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/v1/auth/request-otp")
      .send({ phone: PHONE });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: expect.any(String) });
  });
});

describe("POST /api/v1/auth/verify-otp — OTP expiry", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFetch.mockReset();
  });

  it("returns 401 when the OTP is expired", async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: USER_ID,
          otp_pin_id: "pin-expired",
          otp_expires_at: expiredAt,
          stellar_public_key: STELLAR_KEY,
          token_version: 1,
        },
      ],
    });

    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: PHONE, otp: "123456" });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });
});

describe("POST /api/v1/auth/verify-otp — JWT issue on success", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFetch.mockReset();
  });

  it("returns 200 with a signed JWT when OTP is valid", async () => {
    const validExpiry = new Date(Date.now() + 10 * 60_000).toISOString();

    // 1st query: SELECT user with pending OTP
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: USER_ID,
          otp_pin_id: "pin-valid",
          otp_expires_at: validExpiry,
          stellar_public_key: STELLAR_KEY,
          token_version: 1,
        },
      ],
    });

    // Termii verify endpoint
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ msisdn: PHONE, verified: true }),
    });

    // UPDATE: clear otp_pin_id
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: PHONE, otp: "123456" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");

    // Confirm the token is a verifiable JWT
    const decoded = jwt.verify(res.body.token, JWT_SECRET) as Record<string, unknown>;
    expect(decoded["sub"]).toBe(USER_ID);
  });
});

describe("authenticate middleware — expired JWT", () => {
  it("returns 401 for a token that has already expired", async () => {
    const expiredToken = jwt.sign(
      { sub: USER_ID, stellarPublicKey: STELLAR_KEY, tokenVersion: 1 },
      JWT_SECRET,
      { expiresIn: -1 } // expires 1 second in the past
    );

    const res = await request(app)
      .get("/probe")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });
});

describe("authenticate middleware — revoked JWT (token_version mismatch)", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns 401 when the user's token_version has been bumped", async () => {
    const token = makeJwt({ tokenVersion: 1 });

    // DB returns token_version = 2 (bumped after a POST /api/v1/auth/revoke)
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 2 }] });

    const res = await request(app)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it("returns 200 when token_version still matches", async () => {
    const token = makeJwt({ tokenVersion: 1 });

    // DB returns matching token_version
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

describe("authenticate middleware — malformed JWT", () => {
  it("returns 401 for a completely malformed token string", async () => {
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer not.a.jwt");

    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header is missing entirely", async () => {
    const res = await request(app).get("/probe");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing or invalid/i);
  });

  it("returns 401 for a token signed with the wrong secret", async () => {
    const badToken = jwt.sign(
      { sub: USER_ID, tokenVersion: 1 },
      "completely-wrong-secret-that-is-long-enough"
    );

    const res = await request(app)
      .get("/probe")
      .set("Authorization", `Bearer ${badToken}`);

    expect(res.status).toBe(401);
  });
});
