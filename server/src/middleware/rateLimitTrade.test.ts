import type { Request, Response, NextFunction } from "express";
import { cache } from "../services/cache";
import { TRADE_MAX_PER_HOUR, checkTradeRateLimit, rateLimitTrade } from "./rateLimitTrade";

jest.mock("../services/cache", () => ({
  cache: { get: jest.fn(), set: jest.fn() },
}));

function mockRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { setHeader: jest.fn(), status, json } as unknown as Response;
}

describe("rateLimitTrade", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (cache.set as jest.Mock).mockResolvedValue(undefined);
  });

  describe("checkTradeRateLimit", () => {
    it("allows a request under the limit", async () => {
      (cache.get as jest.Mock).mockResolvedValue(null);

      const state = await checkTradeRateLimit("user-under");

      expect(state.allowed).toBe(true);
      expect(state.remaining).toBe(TRADE_MAX_PER_HOUR - 1);
    });

    it("allows the request that lands exactly on the limit", async () => {
      const resetAt = Date.now() + 10_000;
      (cache.get as jest.Mock).mockResolvedValue(
        JSON.stringify({ count: TRADE_MAX_PER_HOUR - 1, resetAt })
      );

      const state = await checkTradeRateLimit("user-at-limit");

      expect(state.allowed).toBe(true);
      expect(state.remaining).toBe(0);
    });

    it("rejects a request over the limit", async () => {
      const resetAt = Date.now() + 15_000;
      (cache.get as jest.Mock).mockResolvedValue(
        JSON.stringify({ count: TRADE_MAX_PER_HOUR, resetAt })
      );

      const state = await checkTradeRateLimit("user-over-limit");

      expect(state.allowed).toBe(false);
      expect(state.remaining).toBe(0);
      expect(state.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("charges the attempt even when it will be rejected (no free retries)", async () => {
      const resetAt = Date.now() + 15_000;
      (cache.get as jest.Mock).mockResolvedValue(
        JSON.stringify({ count: TRADE_MAX_PER_HOUR, resetAt })
      );

      await checkTradeRateLimit("user-charged");

      expect(cache.set).toHaveBeenCalledWith(
        "rate-limit:trade-create:user-charged",
        JSON.stringify({ count: TRADE_MAX_PER_HOUR + 1, resetAt }),
        expect.any(Number)
      );
    });

    it("throws when neither a user ID nor an IP address is available", async () => {
      await expect(checkTradeRateLimit(null, null)).rejects.toThrow(
        /user ID or IP address is required/
      );
    });
  });

  describe("rateLimitTrade middleware", () => {
    it("calls next() and sets rate-limit headers when under the limit", async () => {
      (cache.get as jest.Mock).mockResolvedValue(null);

      const req = { user: { sub: "user-1" }, ip: "203.0.113.5" } as unknown as Request;
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await rateLimitTrade(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", String(TRADE_MAX_PER_HOUR));
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", String(TRADE_MAX_PER_HOUR - 1));
      expect(res.status).not.toHaveBeenCalled();
    });

    it("responds 429 with Retry-After and a code when over the limit", async () => {
      const resetAt = Date.now() + 20_000;
      (cache.get as jest.Mock).mockResolvedValue(
        JSON.stringify({ count: TRADE_MAX_PER_HOUR, resetAt })
      );

      const req = { user: { sub: "user-2" }, ip: "203.0.113.6" } as unknown as Request;
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await rateLimitTrade(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
      expect(next).not.toHaveBeenCalled();
    });

    it("keys the limit by IP when the caller is unauthenticated", async () => {
      (cache.get as jest.Mock).mockResolvedValue(null);

      const req = {
        ip: "203.0.113.7",
        socket: { remoteAddress: "203.0.113.7" },
      } as unknown as Request;
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await rateLimitTrade(req, res, next);

      expect(cache.get).toHaveBeenCalledWith("rate-limit:trade-create:203.0.113.7");
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("fails open (calls next) when the cache throws", async () => {
      (cache.get as jest.Mock).mockRejectedValue(new Error("redis down"));

      const req = { user: { sub: "user-3" }, ip: "203.0.113.8" } as unknown as Request;
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await rateLimitTrade(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
