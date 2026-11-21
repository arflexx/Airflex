import {
  FraudDetectionService,
  VelocityError,
  REPEATED_FAILED_TRADES,
  evaluateFraudSignals,
} from "./fraudDetection";
import pool from "../db";
import { cache } from "./cache";
import logger from "../utils/logger";

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
  const mockPoolQuery = pool.query as jest.Mock;
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

describe("FraudDetectionService — repeated failed trades (issue #491)", () => {
  const mockPoolQuery = pool.query as jest.Mock;
  const mockCacheGet = cache.get as jest.Mock;
  const mockCacheSet = cache.set as jest.Mock;

  /** Backs the mocked cache with a Map so state carries across calls. */
  let store: Map<string, string>;
  let now: number;
  const originalEnv = process.env;

  const HOUR = 60 * 60 * 1000;

  async function fail(times: number, userId = "user-1", stepMs = 60_000) {
    let outcome = { failureCount: 0, flagged: false };
    for (let i = 0; i < times; i++) {
      outcome = await FraudDetectionService.recordFailedTrade(userId, `trade-${i}`, "VERIFICATION_FAILED");
      now += stepMs;
    }
    return outcome;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env["FAILED_TRADE_THRESHOLD"];
    delete process.env["FAILED_TRADE_WINDOW_SECONDS"];

    store = new Map();
    mockCacheGet.mockImplementation(async (key: string) => store.get(key) ?? null);
    mockCacheSet.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    // A new open flag is inserted unless a test says otherwise.
    mockPoolQuery.mockResolvedValue({ rows: [{ id: "flag-1" }], rowCount: 1 });

    now = Date.parse("2026-10-20T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  describe("getFailedTradeRule", () => {
    it("defaults to 5 failures within 1 hour", () => {
      expect(FraudDetectionService.getFailedTradeRule()).toEqual({ threshold: 5, windowSeconds: 3600 });
    });

    it("reads overrides from the environment and ignores invalid values", () => {
      process.env["FAILED_TRADE_THRESHOLD"] = "3";
      process.env["FAILED_TRADE_WINDOW_SECONDS"] = "600";
      expect(FraudDetectionService.getFailedTradeRule()).toEqual({ threshold: 3, windowSeconds: 600 });

      process.env["FAILED_TRADE_THRESHOLD"] = "-1";
      process.env["FAILED_TRADE_WINDOW_SECONDS"] = "abc";
      expect(FraudDetectionService.getFailedTradeRule()).toEqual({ threshold: 5, windowSeconds: 3600 });
    });
  });

  describe("threshold triggering", () => {
    it("does not flag below the threshold", async () => {
      const outcome = await fail(4);

      expect(outcome).toEqual({ failureCount: 4, flagged: false });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("flags the account on the 5th failure within the hour with reason code and audit details", async () => {
      const outcome = await fail(5);

      expect(outcome).toEqual({ failureCount: 5, flagged: true });
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);

      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO fraud_flags");
      expect(sql).toContain("ON CONFLICT (user_id, reason_code) WHERE status = 'open' DO NOTHING");
      expect(params[0]).toBe("user-1");
      expect(params[1]).toBe(REPEATED_FAILED_TRADES);

      const details = JSON.parse(params[2] as string);
      expect(details).toMatchObject({ threshold: 5, windowSeconds: 3600, failureCount: 5 });
      expect(details.failures).toHaveLength(5);
      expect(details.failures[0]).toEqual({
        tradeId: "trade-0",
        reason: "VERIFICATION_FAILED",
        at: "2026-10-20T12:00:00.000Z",
      });
    });

    it("honours a configured threshold", async () => {
      process.env["FAILED_TRADE_THRESHOLD"] = "2";

      expect((await fail(1)).flagged).toBe(false);
      expect((await fail(1)).flagged).toBe(true);
    });

    it("reports flagged=false when an open flag already exists (no duplicate flags)", async () => {
      await fail(5);
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const outcome = await fail(1);

      expect(outcome).toEqual({ failureCount: 6, flagged: false });
    });

    it("tracks users independently", async () => {
      await fail(4, "user-a");
      const outcome = await fail(1, "user-b");

      expect(outcome).toEqual({ failureCount: 1, flagged: false });
    });

    it("stores the history with a TTL equal to the window", async () => {
      await fail(1);

      expect(mockCacheSet).toHaveBeenCalledWith("failed-trades:user-1", expect.any(String), 3600);
    });
  });

  describe("rolling window expiry", () => {
    it("drops failures older than the window before counting", async () => {
      await fail(4); // 12:00, 12:01, 12:02, 12:03
      now += HOUR; // 13:04 — all four are now outside the window

      const outcome = await fail(1);

      expect(outcome).toEqual({ failureCount: 1, flagged: false });
      expect(JSON.parse(store.get("failed-trades:user-1")!)).toHaveLength(1);
    });

    it("keeps failures that are still inside the window", async () => {
      await fail(4, "user-1", 10 * 60_000); // 12:00, 12:10, 12:20, 12:30
      now = Date.parse("2026-10-20T12:55:00Z");

      expect(await fail(1)).toEqual({ failureCount: 5, flagged: true });
    });

    it("expires a failure exactly one window old", async () => {
      await fail(1);
      now = Date.parse("2026-10-20T13:00:00Z");

      expect((await fail(1)).failureCount).toBe(1);
    });

    it("slides: only the most recent failures count", async () => {
      process.env["FAILED_TRADE_WINDOW_SECONDS"] = "600"; // 10 minutes
      await fail(4, "user-1", 4 * 60_000); // 12:00, 12:04, 12:08, 12:12
      now = Date.parse("2026-10-20T12:13:00Z");

      // 12:00 has expired; 12:04, 12:08, 12:12, 12:13 remain.
      expect((await fail(1)).failureCount).toBe(4);
    });

    it("recovers from a corrupt cache entry", async () => {
      store.set("failed-trades:user-1", "not json");

      expect((await fail(1)).failureCount).toBe(1);
    });
  });

  describe("reset on success", () => {
    it("clears the history so failures must be consecutive", async () => {
      await fail(4);
      await FraudDetectionService.resetFailedTrades("user-1");

      expect(mockCacheSet).toHaveBeenLastCalledWith("failed-trades:user-1", "[]", 1);
      const outcome = await fail(4);
      expect(outcome).toEqual({ failureCount: 4, flagged: false });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("only resets the given user", async () => {
      await fail(4, "user-a");
      await FraudDetectionService.resetFailedTrades("user-b");

      expect((await fail(1, "user-a")).flagged).toBe(true);
    });
  });

  describe("admin review queries", () => {
    it("lists flags filtered by status with pagination", async () => {
      const flag = { id: "flag-1", user_id: "user-1", status: "open" };
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [flag] })
        .mockResolvedValueOnce({ rows: [{ total: 1 }] });

      const result = await FraudDetectionService.listFraudFlags({ status: "open", limit: 20, offset: 40 });

      expect(result).toEqual({ flags: [flag], total: 1 });
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringMatching(/WHERE status = \$1[\s\S]*LIMIT \$2 OFFSET \$3/),
        ["open", 20, 40]
      );
      expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining("COUNT(*)"), ["open"]);
    });

    it("lists all flags when no status is given", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });

      await FraudDetectionService.listFraudFlags({ limit: 10, offset: 0 });

      expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringMatching(/LIMIT \$1 OFFSET \$2/), [10, 0]);
      expect(mockPoolQuery.mock.calls[0]![0]).not.toContain("WHERE");
    });

    it("closes an open flag, recording reviewer, time and note", async () => {
      const reviewed = { id: "flag-1", status: "dismissed", reviewed_by: "admin-1" };
      mockPoolQuery.mockResolvedValueOnce({ rows: [reviewed] });

      const result = await FraudDetectionService.reviewFraudFlag("flag-1", "admin-1", "dismissed", "False positive");

      expect(result).toEqual(reviewed);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringMatching(/reviewed_at = NOW\(\)[\s\S]*WHERE id = \$1 AND status = 'open'/),
        ["flag-1", "dismissed", "admin-1", "False positive"]
      );
    });

    it("returns null when the flag is missing or already closed", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      expect(await FraudDetectionService.reviewFraudFlag("flag-x", "admin-1", "reviewed", null)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Velocity rules (issue #657)
// ---------------------------------------------------------------------------

describe("FraudDetectionService — velocity rules (issue #657)", () => {
  const mockPoolQuery = pool.query as jest.Mock;
  const mockCacheGet = cache.get as jest.Mock;
  const mockCacheSet = cache.set as jest.Mock;

  const HOUR_MS = 60 * 60 * 1000;
  const VELOCITY_ENV = [
    "MAX_TRADES_PER_HOUR",
    "MAX_DEPOSITS_PER_DAY",
    "MAX_WITHDRAWALS_PER_DAY",
    "FAILED_TRADE_THRESHOLD",
    "FAILED_TRADE_WINDOW_SECONDS",
  ];

  /** TTL-aware stand-in for Redis, driven by the mocked clock. */
  let store: Map<string, { value: string; expiresAt: number }>;
  let now: number;
  const originalEnv = process.env;

  function seed(key: string, value: unknown, ttlMs = HOUR_MS) {
    store.set(key, {
      value: typeof value === "string" ? value : JSON.stringify(value),
      expiresAt: now + ttlMs,
    });
  }

  function storedCount(key: string): number | undefined {
    const entry = store.get(key);
    return entry ? (JSON.parse(entry.value) as { count: number }).count : undefined;
  }

  /** Runs `checkVelocity` and reports the outcome instead of throwing. */
  async function attempt(userId: string, action: string): Promise<"allowed" | VelocityError> {
    try {
      await FraudDetectionService.checkVelocity(userId, action);
      return "allowed";
    } catch (err) {
      if (err instanceof VelocityError) return err;
      throw err;
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const name of VELOCITY_ENV) delete process.env[name];

    store = new Map();
    mockCacheGet.mockImplementation(async (key: string) => {
      // Yield first so concurrent callers genuinely interleave.
      await Promise.resolve();
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now) {
        store.delete(key);
        return null;
      }
      return entry.value;
    });
    mockCacheSet.mockImplementation(async (key: string, value: string, ttlSeconds: number) => {
      store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
    });
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    now = Date.parse("2026-11-20T10:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  describe("limit boundaries", () => {
    beforeEach(() => {
      process.env["MAX_TRADES_PER_HOUR"] = "5";
    });

    it("allows trades under the limit without flagging", async () => {
      for (let i = 0; i < 3; i++) {
        await expect(FraudDetectionService.checkVelocity("user-1", "trade_creation")).resolves.toEqual({
          allowed: true,
        });
      }

      expect(storedCount("velocity:trade_creation:user-1")).toBe(3);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("allows the trade that lands exactly on the limit without flagging", async () => {
      for (let i = 0; i < 5; i++) {
        expect(await attempt("user-1", "trade_creation")).toBe("allowed");
      }

      expect(storedCount("velocity:trade_creation:user-1")).toBe(5);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("flags the first trade over the limit: 429, suspicious_activity row, counter unchanged", async () => {
      for (let i = 0; i < 5; i++) await attempt("user-1", "trade_creation");
      now += 10 * 60_000; // 10 minutes into the 1h window

      const outcome = await attempt("user-1", "trade_creation");

      expect(outcome).toBeInstanceOf(VelocityError);
      const err = outcome as VelocityError;
      expect(err.status).toBe(429);
      expect(err.retryAfterSeconds).toBe(50 * 60);

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO suspicious_activity");
      expect(params.slice(0, 2)).toEqual(["user-1", "trade_creation"]);
      expect(JSON.parse(params[2] as string)).toEqual({
        rule: "MAX_TRADES_PER_HOUR",
        limit: 5,
        attemptedCount: 6,
        retryAfterSeconds: 3000,
      });
      // A rejected attempt is not counted.
      expect(storedCount("velocity:trade_creation:user-1")).toBe(5);
    });

    it("keeps rejecting while the window is open", async () => {
      seed("velocity:trade_creation:user-1", { count: 5, resetAt: now + HOUR_MS });

      expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);
      expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });

    it("never reports a Retry-After below 1 second", async () => {
      seed("velocity:trade_creation:user-1", { count: 5, resetAt: now + 200 });

      const err = (await attempt("user-1", "trade_creation")) as VelocityError;

      expect(err.retryAfterSeconds).toBe(1);
    });

    it("still rejects (and logs) when the suspicious_activity insert fails", async () => {
      seed("velocity:trade_creation:user-1", { count: 5, resetAt: now + HOUR_MS });
      mockPoolQuery.mockRejectedValueOnce(new Error("db down"));

      expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ dbErr: expect.any(Error) }),
        "[FraudDetection] Failed to log suspicious activity to DB"
      );
    });

    it("tracks users and actions independently", async () => {
      seed("velocity:trade_creation:user-1", { count: 5, resetAt: now + HOUR_MS });

      expect(await attempt("user-2", "trade_creation")).toBe("allowed");
      expect(await attempt("user-1", "deposit")).toBe("allowed");
      expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);
    });
  });

  describe("rule resolution", () => {
    it.each<[string, string, number, number]>([
      ["trade_creation", "MAX_TRADES_PER_HOUR", 10, 3600],
      ["deposit_initiate", "MAX_DEPOSITS_PER_DAY", 5, 86400],
      ["withdrawal_request", "MAX_WITHDRAWALS_PER_DAY", 3, 86400],
      ["profile_update", "DEFAULT_VELOCITY_RULE", 10, 3600],
    ])("%s uses %s (default limit %i, %is window)", async (action, ruleName, limit, windowSeconds) => {
      const key = `velocity:${action}:user-1`;

      seed(key, { count: limit - 1, resetAt: now + windowSeconds * 1000 });
      expect(await attempt("user-1", action)).toBe("allowed");

      const err = (await attempt("user-1", action)) as VelocityError;
      expect(err).toBeInstanceOf(VelocityError);
      expect(err.retryAfterSeconds).toBe(windowSeconds);
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(JSON.parse(params[2] as string)).toMatchObject({ rule: ruleName, limit });
    });

    it("stores a new counter with a TTL equal to the rule window", async () => {
      await attempt("user-1", "withdrawal_request");

      expect(mockCacheSet).toHaveBeenCalledWith(
        "velocity:withdrawal_request:user-1",
        JSON.stringify({ count: 1, resetAt: now + 86_400_000 }),
        86_400
      );
    });

    it("honours configured limits", async () => {
      process.env["MAX_WITHDRAWALS_PER_DAY"] = "1";

      expect(await attempt("user-1", "withdraw")).toBe("allowed");
      expect(await attempt("user-1", "withdraw")).toBeInstanceOf(VelocityError);
    });

    it.each(["abc", "0", "-2"])(
      "falls back to the default when the configured limit is invalid (%s)",
      async (value) => {
        process.env["MAX_TRADES_PER_HOUR"] = value;
        seed("velocity:trade_creation:user-1", { count: 10, resetAt: now + HOUR_MS });

        // The default of 10 still applies: an invalid value must not disable the rule.
        expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);
      }
    );

    it("normalises the action name in the counter key", async () => {
      await attempt("user-1", "TRADE_Creation");

      expect(mockCacheSet).toHaveBeenCalledWith("velocity:trade_creation:user-1", expect.any(String), 3600);
    });
  });

  describe("stored counter formats", () => {
    beforeEach(() => {
      process.env["MAX_TRADES_PER_HOUR"] = "5";
    });

    it("reads a legacy plain-integer counter", async () => {
      seed("velocity:trade_creation:user-1", "5");

      expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);
    });

    it("treats an unparseable counter as zero", async () => {
      seed("velocity:trade_creation:user-1", "garbage");

      expect(await attempt("user-1", "trade_creation")).toBe("allowed");
      expect(storedCount("velocity:trade_creation:user-1")).toBe(1);
    });

    it("treats an object without a numeric count as zero", async () => {
      seed("velocity:trade_creation:user-1", { count: "lots", resetAt: now + HOUR_MS });

      expect(await attempt("user-1", "trade_creation")).toBe("allowed");
      expect(storedCount("velocity:trade_creation:user-1")).toBe(1);
    });

    it("starts a fresh window when the stored resetAt has already passed", async () => {
      // TTLs are rounded up, so an entry can briefly outlive its window.
      seed("velocity:trade_creation:user-1", { count: 5, resetAt: now - 1 });

      expect(await attempt("user-1", "trade_creation")).toBe("allowed");
      expect(JSON.parse(store.get("velocity:trade_creation:user-1")!.value)).toEqual({
        count: 1,
        resetAt: now + HOUR_MS,
      });
    });
  });

  describe("midnight boundary", () => {
    it("does not reset the daily deposit limit at midnight: the 24h window is rolling", async () => {
      now = Date.parse("2026-11-20T23:59:00Z");
      for (let i = 0; i < 5; i++) {
        expect(await attempt("user-1", "deposit")).toBe("allowed");
      }

      now = Date.parse("2026-11-21T00:00:30Z"); // calendar day rolled over
      const err = (await attempt("user-1", "deposit")) as VelocityError;

      expect(err).toBeInstanceOf(VelocityError);
      expect(err.retryAfterSeconds).toBe(86_400 - 90);
    });

    it("allows deposits again once 24h have passed since the window opened", async () => {
      now = Date.parse("2026-11-20T23:59:00Z");
      for (let i = 0; i < 5; i++) await attempt("user-1", "deposit");

      now = Date.parse("2026-11-21T23:59:01Z");

      expect(await attempt("user-1", "deposit")).toBe("allowed");
      expect(storedCount("velocity:deposit:user-1")).toBe(1);
    });

    it("an hourly window spanning midnight keeps counting across the date change", async () => {
      process.env["MAX_TRADES_PER_HOUR"] = "2";
      now = Date.parse("2026-11-20T23:45:00Z");
      await attempt("user-1", "trade_creation");
      now = Date.parse("2026-11-20T23:59:59Z");
      await attempt("user-1", "trade_creation");

      now = Date.parse("2026-11-21T00:00:01Z");
      expect(await attempt("user-1", "trade_creation")).toBeInstanceOf(VelocityError);

      now = Date.parse("2026-11-21T00:45:00Z"); // window opened 23:45, now closed
      expect(await attempt("user-1", "trade_creation")).toBe("allowed");
    });

    it("counts failed trades either side of midnight within one window", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: "flag-1" }], rowCount: 1 });
      now = Date.parse("2026-11-20T23:50:00Z");
      for (let i = 0; i < 4; i++) {
        await FraudDetectionService.recordFailedTrade("user-1", `trade-${i}`, "CONFIRMATION_REJECTED");
        now += 60_000;
      }

      now = Date.parse("2026-11-21T00:05:00Z");
      const outcome = await FraudDetectionService.recordFailedTrade("user-1", "trade-4", "VERIFICATION_FAILED");

      expect(outcome).toEqual({ failureCount: 5, flagged: true });
    });
  });

  describe("concurrent requests at the limit", () => {
    beforeEach(() => {
      process.env["MAX_TRADES_PER_HOUR"] = "5";
    });

    it("lets exactly one of several simultaneous requests take the last slot", async () => {
      seed("velocity:trade_creation:user-1", { count: 4, resetAt: now + HOUR_MS });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => attempt("user-1", "trade_creation"))
      );

      expect(outcomes.filter((o) => o === "allowed")).toHaveLength(1);
      expect(outcomes.filter((o) => o instanceof VelocityError)).toHaveLength(4);
      expect(storedCount("velocity:trade_creation:user-1")).toBe(5);
    });

    it("allows exactly `limit` simultaneous requests from an empty window", async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => attempt("user-1", "trade_creation"))
      );

      expect(outcomes.every((o) => o === "allowed")).toBe(true);
      expect(storedCount("velocity:trade_creation:user-1")).toBe(5);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("rejects exactly one of `limit + 1` simultaneous requests", async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => attempt("user-1", "trade_creation"))
      );

      expect(outcomes.filter((o) => o instanceof VelocityError)).toHaveLength(1);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it("does not hold one user's request behind another user's limit", async () => {
      seed("velocity:trade_creation:user-1", { count: 5, resetAt: now + HOUR_MS });

      const [blocked, allowed] = await Promise.all([
        attempt("user-1", "trade_creation"),
        attempt("user-2", "trade_creation"),
      ]);

      expect(blocked).toBeInstanceOf(VelocityError);
      expect(allowed).toBe("allowed");
    });
  });

  describe("combined rules", () => {
    it("blocks with every triggered reason when several signals fire", () => {
      expect(
        evaluateFraudSignals({ velocityExceeded: true, deviceKnownFraud: true, relatedAccounts: 3 })
      ).toEqual({ blocked: true, reasons: ["velocity", "device", "cross_account"] });
    });

    it("treats one related account as normal and two or more as cross-account", () => {
      expect(evaluateFraudSignals({ relatedAccounts: 1 })).toEqual({ blocked: false, reasons: [] });
      expect(evaluateFraudSignals({ relatedAccounts: 2 })).toEqual({
        blocked: true,
        reasons: ["cross_account"],
      });
    });

    it("does not block when every signal is explicitly negative", () => {
      expect(
        evaluateFraudSignals({ velocityExceeded: false, deviceKnownFraud: false, relatedAccounts: 0 })
      ).toEqual({ blocked: false, reasons: [] });
    });

    it("feeds a velocity violation into the combined decision", async () => {
      process.env["MAX_DEPOSITS_PER_DAY"] = "1";
      await attempt("user-1", "deposit");
      const velocityExceeded = (await attempt("user-1", "deposit")) instanceof VelocityError;

      expect(evaluateFraudSignals({ velocityExceeded, deviceKnownFraud: true })).toEqual({
        blocked: true,
        reasons: ["velocity", "device"],
      });
    });

    it("raises both the velocity violation and the failed-trade flag for the same user", async () => {
      process.env["MAX_TRADES_PER_HOUR"] = "1";
      process.env["FAILED_TRADE_THRESHOLD"] = "2";
      mockPoolQuery.mockResolvedValue({ rows: [{ id: "flag-1" }], rowCount: 1 });

      await attempt("user-1", "trade_creation");
      await FraudDetectionService.recordFailedTrade("user-1", "t-1", "VERIFICATION_FAILED");
      const velocity = await attempt("user-1", "trade_creation");
      const failed = await FraudDetectionService.recordFailedTrade("user-1", "t-2", "VERIFICATION_FAILED");

      expect(velocity).toBeInstanceOf(VelocityError);
      expect(failed.flagged).toBe(true);
      const statements = mockPoolQuery.mock.calls.map(([sql]) => sql as string);
      expect(statements.some((sql) => sql.includes("INSERT INTO suspicious_activity"))).toBe(true);
      expect(statements.some((sql) => sql.includes("INSERT INTO fraud_flags"))).toBe(true);
    });
  });

  describe("remaining branches", () => {
    it("ignores a failed-trade history that is valid JSON but not a list", async () => {
      seed("failed-trades:user-1", { unexpected: true });

      const outcome = await FraudDetectionService.recordFailedTrade("user-1", "t-1", "VERIFICATION_FAILED");

      expect(outcome.failureCount).toBe(1);
    });

    it("flagAccount reports false when the driver returns a null rowCount", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: null });

      await expect(FraudDetectionService.flagAccount("user-1", "X", {})).resolves.toBe(false);
    });

    it("listFraudFlags reports a total of 0 when the count query returns no row", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

      await expect(FraudDetectionService.listFraudFlags({ limit: 10, offset: 0 })).resolves.toEqual({
        flags: [],
        total: 0,
      });
    });
  });
});
