import { FraudDetectionService, VelocityError } from "./fraudDetection";
import pool from "../db";
import { cache } from "./cache";

jest.mock("../db", () => ({
  query: jest.fn(),
}));

jest.mock("./cache", () => ({
  cache: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

describe("FraudDetectionService", () => {
  const mockPoolQuery = pool.query as jest.MockedFunction<typeof pool.query>;
  const mockCacheGet = cache.get as jest.MockedFunction<typeof cache.get>;
  const mockCacheSet = cache.set as jest.MockedFunction<typeof cache.set>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows trade creation when below velocity limit", async () => {
    mockCacheGet.mockResolvedValueOnce(JSON.stringify({ count: 2, resetAt: Date.now() + 3600000 }));
    mockCacheSet.mockResolvedValueOnce();

    const result = await FraudDetectionService.checkVelocity("user-123", "trade_creation");
    expect(result.allowed).toBe(true);
    expect(mockCacheSet).toHaveBeenCalledWith(
      "velocity:trade_creation:user-123",
      expect.stringContaining('"count":3'),
      expect.any(Number)
    );
  });

  it("throws VelocityError (429) and logs to DB when limit is exceeded", async () => {
    process.env["MAX_TRADES_PER_HOUR"] = "5";
    mockCacheGet.mockResolvedValueOnce(JSON.stringify({ count: 5, resetAt: Date.now() + 1800000 }));
    mockPoolQuery.mockResolvedValueOnce({ rows: [], command: "", rowCount: 1, oid: 0, fields: [] });

    await expect(FraudDetectionService.checkVelocity("user-456", "trade_creation")).rejects.toThrow(
      VelocityError
    );

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO suspicious_activity"),
      expect.arrayContaining(["user-456", "trade_creation"])
    );
  });

  it("retrieves flagged accounts with > 3 violations in past 24h", async () => {
    const mockFlagged = [
      {
        user_id: "user-flagged",
        violation_count: 4,
        last_violation_at: "2026-08-28T22:00:00Z",
        violations: [],
      },
    ];
    mockPoolQuery.mockResolvedValueOnce({
      rows: mockFlagged,
      command: "",
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const accounts = await FraudDetectionService.getFlaggedAccounts();
    expect(accounts).toEqual(mockFlagged);
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining("HAVING COUNT(*) > 3"));
  });
});
