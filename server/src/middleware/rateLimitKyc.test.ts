import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { KYC_MAX_SUBMISSIONS, rateLimitKyc } from "./rateLimitKyc";

jest.mock("../db/pool", () => ({
  pool: { connect: jest.fn() },
}));

describe("rateLimitKyc", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects an over-limit submission with 429 and Retry-After", async () => {
    const oldest = new Date(Date.now() - 1_000).toISOString();
    const query = jest.fn(async (statement: string) => {
      if (statement.includes("SELECT COUNT(*)")) {
        return { rows: [{ attempts: String(KYC_MAX_SUBMISSIONS + 1), oldest }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = jest.fn();
    (pool.connect as jest.Mock).mockResolvedValue({ query, release });

    const req = {
      ip: "203.0.113.10",
      user: { sub: "00000000-0000-4000-8000-000000000123" },
    } as unknown as Request;
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = {
      setHeader: jest.fn(),
      status,
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    await rateLimitKyc(req, res, next);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("Too many KYC submissions") }));
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", String(KYC_MAX_SUBMISSIONS));
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(next).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses the request IP when no authenticated user ID is available", async () => {
    const query = jest.fn(async (statement: string) => {
      if (statement.includes("SELECT COUNT(*)")) {
        return { rows: [{ attempts: "1", oldest: new Date().toISOString() }] };
      }
      return { rows: [], rowCount: 1 };
    });
    (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });

    const req = {
      ip: "203.0.113.20",
      socket: { remoteAddress: "203.0.113.20" },
    } as unknown as Request;
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    await rateLimitKyc(req, res, next);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO kyc_submission_attempts"),
      [null, "203.0.113.20"]
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
