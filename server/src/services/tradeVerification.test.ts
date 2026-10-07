process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgresql://test:test@localhost:5432/test";

import {
  calculatePlatformFee,
  getReleaseRetryMax,
  getReleaseRetryBaseDelayMs,
  calculateBackoffDelay,
  isPermanentError,
  runVerificationWithRetry,
  triggerVerification,
  VerificationError,
} from "./tradeVerification";
import pool from "../db";
import { releasePayment } from "./stellar";
import { SseEmitter } from "./sseEmitter";
import {
  WrongStatusError,
  TradeNotFoundError,
  UnauthorizedContractError,
  AlreadyDisputedError,
} from "./contractErrors";
import type { TradeOffer } from "../types/trade";

jest.mock("../db", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("./stellar", () => ({
  releasePayment: jest.fn(),
}));

jest.mock("./sseEmitter", () => ({
  SseEmitter: {
    emit: jest.fn(),
    emitAll: jest.fn(),
  },
}));

jest.mock("./notifications", () => ({
  NotificationService: {
    sendToMany: jest.fn(),
    sendToAdmins: jest.fn(),
  },
}));

describe("tradeVerification service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("calculatePlatformFee", () => {
    it("uses the default fee for the minimum trade amount", () => {
      expect(calculatePlatformFee(0.01)).toBe(0);
    });

    it("supports a zero-fee configuration", () => {
      process.env["PLATFORM_FEE_PERCENT"] = "0";
      expect(calculatePlatformFee(100)).toBe(0);
    });

    it("rounds the fee to two decimal places", () => {
      process.env["PLATFORM_FEE_PERCENT"] = "1.5";
      expect(calculatePlatformFee(10.37)).toBe(0.16);
    });
  });

  describe("Configuration helpers", () => {
    it("reads RELEASE_RETRY_MAX from environment with default fallback to 3", () => {
      delete process.env["RELEASE_RETRY_MAX"];
      expect(getReleaseRetryMax()).toBe(3);

      process.env["RELEASE_RETRY_MAX"] = "5";
      expect(getReleaseRetryMax()).toBe(5);

      process.env["RELEASE_RETRY_MAX"] = "invalid";
      expect(getReleaseRetryMax()).toBe(3);

      process.env["RELEASE_RETRY_MAX"] = "0";
      expect(getReleaseRetryMax()).toBe(3);
    });

    it("reads RELEASE_RETRY_BASE_DELAY_MS from environment with default fallback to 2000", () => {
      delete process.env["RELEASE_RETRY_BASE_DELAY_MS"];
      expect(getReleaseRetryBaseDelayMs()).toBe(2000);

      process.env["RELEASE_RETRY_BASE_DELAY_MS"] = "500";
      expect(getReleaseRetryBaseDelayMs()).toBe(500);

      process.env["RELEASE_RETRY_BASE_DELAY_MS"] = "-10";
      expect(getReleaseRetryBaseDelayMs()).toBe(2000);

      process.env["RELEASE_RETRY_BASE_DELAY_MS"] = "xyz";
      expect(getReleaseRetryBaseDelayMs()).toBe(2000);
    });
  });

  describe("calculateBackoffDelay", () => {
    it("applies exponential scaling with jitter", () => {
      // With randomFn returning 0.5 (jitter factor = 0)
      const zeroJitter = () => 0.5;

      expect(calculateBackoffDelay(1, 1000, zeroJitter)).toBe(1000);
      expect(calculateBackoffDelay(2, 1000, zeroJitter)).toBe(2000);
      expect(calculateBackoffDelay(3, 1000, zeroJitter)).toBe(4000);
      expect(calculateBackoffDelay(4, 1000, zeroJitter)).toBe(8000);

      // Jitter range is [-20%, +20%]
      const minJitter = () => 0.0; // factor = -1.0 (-20%)
      const maxJitter = () => 1.0; // factor = +1.0 (+20%)

      expect(calculateBackoffDelay(1, 1000, minJitter)).toBe(800);
      expect(calculateBackoffDelay(1, 1000, maxJitter)).toBe(1200);

      // Capped at 30,000 ms before jitter
      expect(calculateBackoffDelay(10, 1000, zeroJitter)).toBe(30000);
    });
  });

  describe("isPermanentError", () => {
    it("identifies ContractError instances as permanent errors", () => {
      expect(isPermanentError(new WrongStatusError())).toBe(true);
      expect(isPermanentError(new TradeNotFoundError())).toBe(true);
      expect(isPermanentError(new UnauthorizedContractError())).toBe(true);
      expect(isPermanentError(new AlreadyDisputedError())).toBe(true);
    });

    it("identifies VerificationError instances as permanent errors", () => {
      expect(isPermanentError(new VerificationError("Not found", 404))).toBe(true);
      expect(isPermanentError(new VerificationError("Only locked trades can be confirmed", 400))).toBe(true);
    });

    it("identifies parsed contract error messages and error strings", () => {
      expect(isPermanentError(new Error("Error(Contract, #4)"))).toBe(true);
      expect(isPermanentError(new Error("ContractError(4)"))).toBe(true);
      expect(isPermanentError(new Error("Trade cannot be confirmed in its current state (Completed)"))).toBe(true);
    });

    it("treats network errors, timeouts, and transient issues as non-permanent", () => {
      expect(isPermanentError(new Error("ECONNRESET"))).toBe(false);
      expect(isPermanentError(new Error("fetch failed"))).toBe(false);
      expect(isPermanentError(new Error("504 Gateway Timeout"))).toBe(false);
      expect(isPermanentError(new Error("Transaction did not confirm within timeout"))).toBe(false);
      expect(isPermanentError(null)).toBe(false);
      expect(isPermanentError(undefined)).toBe(false);
    });
  });

  describe("runVerificationWithRetry", () => {
    const mockTrade: TradeOffer = {
      id: "trade-uuid-1",
      seller_id: "seller-123",
      buyer_id: "buyer-456",
      amount: 500,
      fee_amount: null,
      seller_net_amount: null,
      asset_type: "MTN_AIRTIME",
      status: "Locked",
      contract_listing_id: "1001",
      escrow_tx_hash: "0xescrow123",
      expires_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    beforeEach(() => {
      // Use very short delay for testing retries quickly
      process.env["RELEASE_RETRY_BASE_DELAY_MS"] = "1";
    });

    it("aborts immediately on permanent errors (e.g. WrongStatusError) without retrying", async () => {
      process.env["RELEASE_RETRY_MAX"] = "5";
      (releasePayment as jest.Mock).mockRejectedValueOnce(new WrongStatusError());
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      await runVerificationWithRetry(mockTrade, 1);

      // Should only attempt once
      expect(releasePayment).toHaveBeenCalledTimes(1);
      expect(releasePayment).toHaveBeenCalledWith("1001");

      // Should escalate to Disputed immediately
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE trade_offers"),
        ["trade-uuid-1"]
      );
      expect(SseEmitter.emitAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "admin_alert",
          tradeId: "trade-uuid-1",
          reason: expect.stringContaining("Permanent error"),
        })
      );
    });

    it("retries transient failures up to RELEASE_RETRY_MAX and escalates after exhaustion", async () => {
      process.env["RELEASE_RETRY_MAX"] = "3";
      (releasePayment as jest.Mock).mockRejectedValue(new Error("Network timeout"));
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      await runVerificationWithRetry(mockTrade, 1);

      // Should attempt exactly 3 times
      expect(releasePayment).toHaveBeenCalledTimes(3);

      // Should escalate to Disputed on final failure
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE trade_offers"),
        ["trade-uuid-1"]
      );
      expect(SseEmitter.emitAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "admin_alert",
          tradeId: "trade-uuid-1",
          reason: "Network timeout",
        })
      );
    });

    it("supports custom RELEASE_RETRY_MAX count", async () => {
      process.env["RELEASE_RETRY_MAX"] = "2";
      (releasePayment as jest.Mock).mockRejectedValue(new Error("Soroban RPC 503"));
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      await runVerificationWithRetry(mockTrade, 1);

      expect(releasePayment).toHaveBeenCalledTimes(2);
    });

    it("succeeds after transient retries without escalating", async () => {
      process.env["RELEASE_RETRY_MAX"] = "3";
      (releasePayment as jest.Mock)
        .mockRejectedValueOnce(new Error("Transient RPC glitch"))
        .mockResolvedValueOnce("0xtxhash123");

      process.env["PLATFORM_TREASURY_USER_ID"] = "treasury-admin";

      const mockClient = {
        query: jest.fn().mockImplementation((query: string) => {
          if (query.includes("FOR UPDATE")) {
            return Promise.resolve({ rows: [mockTrade] });
          }
          if (query.includes("UPDATE trade_offers")) {
            return Promise.resolve({ rows: [{ ...mockTrade, status: "Completed" }] });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };
      (pool.connect as jest.Mock).mockResolvedValue(mockClient);

      await runVerificationWithRetry(mockTrade, 1);

      expect(releasePayment).toHaveBeenCalledTimes(2);
      expect(SseEmitter.emit).toHaveBeenCalledWith(
        ["seller-123", "buyer-456"],
        expect.objectContaining({
          type: "trade_completed",
          status: "Completed",
          txHash: "0xtxhash123",
        })
      );
      expect(SseEmitter.emitAll).not.toHaveBeenCalled();
    });
  });

  describe("triggerVerification", () => {
    it("validates that the caller is the seller and trade is Locked", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await expect(triggerVerification("trade-1", "seller-1")).rejects.toThrow(
        new VerificationError("Trade not found", 404)
      );

      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: "trade-1", seller_id: "other-seller", status: "Locked", contract_listing_id: "123" }],
      });
      await expect(triggerVerification("trade-1", "seller-1")).rejects.toThrow(
        new VerificationError("Only the seller can confirm delivery", 403)
      );

      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: "trade-1", seller_id: "seller-1", status: "Completed", contract_listing_id: "123" }],
      });
      await expect(triggerVerification("trade-1", "seller-1")).rejects.toThrow(
        expect.objectContaining({ statusCode: 400 })
      );

      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: "trade-1", seller_id: "seller-1", status: "Locked", contract_listing_id: null }],
      });
      await expect(triggerVerification("trade-1", "seller-1")).rejects.toThrow(
        new VerificationError("Trade has no associated on-chain listing ID", 400)
      );
    });
  });
});