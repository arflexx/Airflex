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

import { rateLimitOtp } from "./rateLimitOtp";

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
});