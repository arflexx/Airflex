import pool from "../db";
import logger from "../utils/logger";
import { listDedicatedAccountTransactions } from "../services/virtualAccount";
import {
  compareDepositReferences,
  getVirtualAccountReconciliationIntervalMs,
  reconcileVirtualAccountDeposits,
} from "./virtualAccountReconciliation";

jest.mock("../db", () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/virtualAccount", () => ({
  listDedicatedAccountTransactions: jest.fn(),
  maskAccountNumber: jest.fn(() => "******1234"),
}));

const mockPool = pool as unknown as { query: jest.Mock };
const mockListTransactions = listDedicatedAccountTransactions as jest.Mock;

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
});
