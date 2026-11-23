import express from "express";
import request from "supertest";

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock("../db/pool", () => ({
  pool: {
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: () => mockRelease(),
    }),
  },
}));

const mockGetOtpLock = jest.fn();
const mockRecordOtpFailure = jest.fn();
const mockResetOtpFailures = jest.fn();

jest.mock("../services/cache", () => ({
  getOtpLock: (...args: unknown[]) => mockGetOtpLock(...args),
  recordOtpFailure: (...args: unknown[]) => mockRecordOtpFailure(...args),
  resetOtpFailures: (...args: unknown[]) => mockResetOtpFailures(...args),
}));

import { rateLimitOtp, otpLockout } from "./rateLimitOtp";

describe("rateLimitOtp", () => {
  const originalMaxRequests = process.env["OTP_RATE_LIMIT_MAX_REQUESTS"];
  const originalWindowMinutes = process.env["OTP_RATE_LIMIT_WINDOW_MINUTES"];
  let identifierCounts: Map<string, number>;
  let ipCounts: Map<string, number>;
  let app: express.Express;

  beforeEach(() => {
    process.env["OTP_RATE_LIMIT_MAX_REQUESTS"] = "2";
    process.env["OTP_RATE_LIMIT_WINDOW_MINUTES"] = "60";
    identifierCounts = new Map();
    ipCounts = new Map();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockGetOtpLock.mockReset();
    mockRecordOtpFailure.mockReset();
    mockResetOtpFailures.mockReset();
    mockGetOtpLock.mockResolvedValue(null);
    mockRecordOtpFailure.mockResolvedValue({ failures: 1, locked: false });
    mockResetOtpFailures.mockResolvedValue(undefined);
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO otp_requests")) {
        const [identifier, ip] = params as [string, string];
        identifierCounts.set(identifier, (identifierCounts.get(identifier) ?? 0) + 1);
        ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
      }

      if (sql.includes("COUNT(*) FILTER")) {
        const [identifier, ip] = params as [string, string, string];
        const oldest = new Date(Date.now() - 1000).toISOString();
        return {
          rows: [{
            identifier_attempts: String(identifierCounts.get(identifier) ?? 0),
            identifier_oldest: oldest,
            ip_attempts: String(ipCounts.get(ip) ?? 0),
            ip_oldest: oldest,
          }],
        };
      }

      return { rows: [] };
    });

    app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.post("/request-otp", rateLimitOtp, (_req, res) => res.sendStatus(200));
  });

  afterAll(() => {
    if (originalMaxRequests === undefined) {
      delete process.env["OTP_RATE_LIMIT_MAX_REQUESTS"];
    } else {
      process.env["OTP_RATE_LIMIT_MAX_REQUESTS"] = originalMaxRequests;
    }
    if (originalWindowMinutes === undefined) {
      delete process.env["OTP_RATE_LIMIT_WINDOW_MINUTES"];
    } else {
      process.env["OTP_RATE_LIMIT_WINDOW_MINUTES"] = originalWindowMinutes;
    }
  });

  it("rejects requests over the identifier limit with Retry-After", async () => {
    const sendRequest = () =>
      request(app)
        .post("/request-otp")
        .set("x-forwarded-for", "203.0.113.10")
        .send({ phone: "+2348123456789" });

    expect((await sendRequest()).status).toBe(200);
    expect((await sendRequest()).status).toBe(200);

    const blocked = await sendRequest();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rejects requests over the IP limit even when identifiers differ", async () => {
    const sendRequest = (phone: string) =>
      request(app)
        .post("/request-otp")
        .set("x-forwarded-for", "203.0.113.11")
        .send({ phone });

    expect((await sendRequest("+2348123456781")).status).toBe(200);
    expect((await sendRequest("+2348123456782")).status).toBe(200);

    const blocked = await sendRequest("+2348123456783");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  describe("otpLockout", () => {
    const identifier = "+2348123456789";
    let lockoutApp: express.Express;

    beforeEach(() => {
      lockoutApp = express();
      lockoutApp.use(express.json());
      lockoutApp.post("/verify-otp", otpLockout, (_req, res) => res.sendStatus(200));
    });

    const sendVerify = (phone: string = identifier) =>
      request(lockoutApp).post("/verify-otp").send({ phone });

    it("does not lock after 4 consecutive failures", async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        mockRecordOtpFailure.mockResolvedValueOnce({ failures: attempt, locked: false });
        const response = await sendVerify();
        expect(response.status).toBe(200);
      }

      expect(mockRecordOtpFailure).toHaveBeenCalledTimes(4);
      expect(mockRecordOtpFailure).toHaveBeenLastCalledWith(identifier);
    });

    it("locks the account on the 5th consecutive failure with a 30-minute TTL", async () => {
      const lockedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      mockRecordOtpFailure.mockResolvedValueOnce({
        failures: 5,
        locked: true,
        lockedUntil,
      });

      const response = await sendVerify();

      expect(response.status).toBe(423);
      expect(response.body.message).toMatch(/locked/i);
      expect(response.body.lockedUntil).toBe(lockedUntil);
      expect(mockRecordOtpFailure).toHaveBeenCalledWith(identifier);
    });

    it("returns 423 with expiry information when the account is already locked", async () => {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      mockGetOtpLock.mockResolvedValueOnce({ lockedUntil });

      const response = await sendVerify();

      expect(response.status).toBe(423);
      expect(response.body.message).toMatch(/locked/i);
      expect(response.body.lockedUntil).toBe(lockedUntil);
      expect(mockRecordOtpFailure).not.toHaveBeenCalled();
    });

    it("resets the failure counter after a successful verification", async () => {
      const response = await sendVerify();

      expect(response.status).toBe(200);
      expect(mockResetOtpFailures).toHaveBeenCalledWith(identifier);
    });
  });
});