import pool from "../db";
import logger from "../utils/logger";
import {
  getVirtualAccountBalance,
  listDedicatedAccountTransactions,
} from "../services/virtualAccount";
import {
  compareDepositReferences,
  getVirtualAccountReconciliationIntervalMs,
  getVirtualAccountReconciliationToleranceKobo,
  reconcileVirtualAccountBalances,
  reconcileVirtualAccountDeposits,
} from "./virtualAccountReconciliation";

jest.mock("../db", () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/virtualAccount", () => ({
  getVirtualAccountBalance: jest.fn(),
  listDedicatedAccountTransactions: jest.fn(),
  maskAccountNumber: jest.fn(() => "******1234"),
}));

const mockPool = pool as unknown as { query: jest.Mock };
const mockListTransactions = listDedicatedAccountTransactions as jest.Mock;
const mockGetBalance = getVirtualAccountBalance as jest.Mock;
=======

describe("virtual account reconciliation", () => {
  const originalInterval = process.env["VIRTUAL_ACCOUNT_RECONCILIATION_INTERVAL_MS"];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env["VIRTUAL_ACCOUNT_RECONCILIATION_TOLERANCE_NAIRA"];
    process.env["VIRTUAL_ACCOUNT_RECONCILIATION_INTERVAL_MS"] = "1800000";
  });

  afterAll(() => {
    if (originalInterval === undefined) {
      delete process.env["VIRTUAL_ACCOUNT_RECONCILIATION_INTERVAL_MS"];
    } else {
      process.env["VIRTUAL_ACCOUNT_RECONCILIATION_INTERVAL_MS"] = originalInterval;
    }
  });

  it("compares references and tolerates configured minor-unit differences", () => {
    const mismatches = compareDepositReferences(
      [
        { reference: "same", amount: 10000, currency: "NGN", channel: "dedicated_nuban", status: "success" },
        { reference: "provider-only", amount: 5000, currency: "NGN", channel: "dedicated_nuban", status: "success" },
      ],
      [
        { external_reference: "same", amount_kobo: "10050" },
        { external_reference: "local-only", amount_kobo: "2500" },
      ],
      100n
    );

    expect(mismatches).toEqual([
      { reference: "provider-only", kind: "provider_only", providerAmountKobo: "5000" },
      { reference: "local-only", kind: "local_only", localAmountKobo: "2500" },
    ]);
  });

  it("logs mismatches without changing ledger data and reports run totals", async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          user_id: "user-1",
          paystack_customer_code: "CUS_1",
          virtual_account_number: "0123451234",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ external_reference: "deposit-local", amount_kobo: "20000" }],
      });
    mockListTransactions.mockResolvedValue([
      { reference: "deposit-local", amount: 21000, currency: "NGN", channel: "dedicated_nuban", status: "success" },
      { reference: "deposit-provider", amount: 5000, currency: "NGN", channel: "dedicated_nuban", status: "success" },
    ]);

    await expect(reconcileVirtualAccountDeposits()).resolves.toEqual({
      accountsScanned: 1,
      accountsReconciled: 1,
      mismatches: 2,
      errors: 0,
    });
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(mockPool.query.mock.calls.every(([query]) => String(query).trimStart().startsWith("SELECT"))).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountsScanned: 1, accountsReconciled: 1, mismatches: 2, errors: 0 }),
      "[virtual-account-reconciliation] Finished"
    );
  });

  it("uses a configurable reconciliation interval", () => {
    expect(getVirtualAccountReconciliationIntervalMs()).toBe(1_800_000);
    process.env["VIRTUAL_ACCOUNT_RECONCILIATION_INTERVAL_MS"] = "1";
    expect(getVirtualAccountReconciliationIntervalMs()).toBe(60_000);
  });

  it("uses a configurable balance tolerance in minor units", () => {
    expect(getVirtualAccountReconciliationToleranceKobo()).toBe(0n);
    process.env["VIRTUAL_ACCOUNT_RECONCILIATION_TOLERANCE_NAIRA"] = "5";
    expect(getVirtualAccountReconciliationToleranceKobo()).toBe(500n);
    process.env["VIRTUAL_ACCOUNT_RECONCILIATION_TOLERANCE_NAIRA"] = "not-a-number";
    expect(getVirtualAccountReconciliationToleranceKobo()).toBe(0n);
  });

  describe("reconcileVirtualAccountBalances", () => {
    const activeAccounts = [
      {
        user_id: "user-1",
        paystack_customer_code: "CUS_1",
        virtual_account_number: "0123451234",
        expected_balance_kobo: "10000",
      },
      {
        user_id: "user-2",
        paystack_customer_code: "CUS_2",
        virtual_account_number: "0123455678",
        expected_balance_kobo: "5000",
      },
    ];

    beforeEach(() => {
      process.env["VIRTUAL_ACCOUNT_RECONCILIATION_TOLERANCE_NAIRA"] = "1";
    });

    it("compares provider balances against expected balances within tolerance", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: activeAccounts });
      mockGetBalance
        .mockResolvedValueOnce({ balanceKobo: 10050n, currency: "NGN" })
        .mockResolvedValueOnce({ balanceKobo: 5000n, currency: "NGN" });

      const result = await reconcileVirtualAccountBalances();

      expect(result).toEqual({
        accountsScanned: 2,
        accountsReconciled: 2,
        mismatches: 0,
        errors: 0,
      });
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
      expect(mockGetBalance).toHaveBeenCalledWith("0123451234");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("flags and logs mismatches beyond the configured tolerance", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: activeAccounts });
      mockGetBalance
        .mockResolvedValueOnce({ balanceKobo: 20000n, currency: "NGN" })
        .mockResolvedValueOnce({ balanceKobo: 5000n, currency: "NGN" });

      const result = await reconcileVirtualAccountBalances();

      expect(result).toEqual({
        accountsScanned: 2,
        accountsReconciled: 2,
        mismatches: 1,
        errors: 0,
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          expectedBalanceKobo: "10000",
          providerBalanceKobo: "20000",
          differenceKobo: "10000",
        }),
        "[virtual-account-reconciliation] Balance mismatch"
      );
    });

    it("logs structured start and finish messages with run totals", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: activeAccounts });
      mockGetBalance
        .mockResolvedValueOnce({ balanceKobo: 10000n, currency: "NGN" })
        .mockResolvedValueOnce({ balanceKobo: 5000n, currency: "NGN" });

      await reconcileVirtualAccountBalances();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ intervalMs: expect.any(Number) }),
        "[virtual-account-reconciliation] Started"
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          accountsScanned: 2,
          accountsReconciled: 2,
          mismatches: 0,
          errors: 0,
        }),
        "[virtual-account-reconciliation] Finished"
      );
    });

    it("counts provider errors without aborting the run", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: activeAccounts });
      mockGetBalance
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValueOnce({ balanceKobo: 5000n, currency: "NGN" });

      const result = await reconcileVirtualAccountBalances();

      expect(result).toEqual({
        accountsScanned: 2,
        accountsReconciled: 1,
        mismatches: 0,
        errors: 1,
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("is idempotent for an already-reconciled interval", async () => {
      mockPool.query.mockResolvedValue({ rows: activeAccounts });
      mockGetBalance.mockResolvedValue({ balanceKobo: 10000n, currency: "NGN" });

      const first = await reconcileVirtualAccountBalances({ intervalKey: "2024-01-01T00:00" });
      const second = await reconcileVirtualAccountBalances({ intervalKey: "2024-01-01T00:00" });

      expect(first.accountsReconciled).toBe(2);
      expect(second).toEqual({
        accountsScanned: 0,
        accountsReconciled: 0,
        mismatches: 0,
        errors: 0,
        skipped: true,
      });
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ intervalKey: "2024-01-01T00:00" }),
        "[virtual-account-reconciliation] Skipped already-reconciled interval"
      );
    });
  });
});
