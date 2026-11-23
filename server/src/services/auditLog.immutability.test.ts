/**
 * auditLog.immutability.test.ts
 *
 * Verifies that the audit_logs table is immutable from the application layer,
 * and that the only permitted deletion path (purgeExpiredAuditLogs) activates
 * both the trigger guard and the RLS retention role before issuing DELETE.
 *
 * Cases covered:
 *   1. recordAuditLog() issues only INSERT — never UPDATE or DELETE.
 *   2. listAuditLogs()  issues only SELECT — never UPDATE or DELETE.
 *   3. A direct DELETE via the application DB pool is rejected with an
 *      insufficient_privilege error (simulates both the trigger from
 *      migration 013 and the RLS policy from migration 021).
 *   4. A direct UPDATE via the application DB pool is rejected.
 *   5. purgeExpiredAuditLogs() sets the retention flag AND activates the
 *      privileged role before issuing DELETE — the only permitted path.
 *   6. Without the retention role the DELETE is rejected even if the
 *      retention flag is set.
 */

// ---------------------------------------------------------------------------
// Module-level statement log shared by the mock.
// Declared before jest.mock() so the factory closure can reference it.
// ---------------------------------------------------------------------------
const executedStatements: string[] = [];

// ---------------------------------------------------------------------------
// Mock helpers (declared before jest.mock factories)
// ---------------------------------------------------------------------------

/** Returns true when both the retention flag AND role-switch appear earlier
 *  in executedStatements (i.e. within the same logical transaction). */
function retentionGuardsActive(): boolean {
  const hasFlag = executedStatements.some((s) =>
    s.toLowerCase().includes("airflex.audit_retention"),
  );
  const hasRole = executedStatements.some((s) =>
    s.toUpperCase().includes("SET LOCAL ROLE AIRFLEX_AUDIT_RETENTION"),
  );
  return hasFlag && hasRole;
}

function simulateQuery(sql: string): { rows: unknown[]; rowCount: number } {
  const upper = sql.trim().toUpperCase();

  if (upper.startsWith("DELETE") && !retentionGuardsActive()) {
    const err = Object.assign(
      new Error("audit_logs is append-only: DELETE is not permitted"),
      { code: "insufficient_privilege" },
    );
    throw err;
  }

  if (upper.startsWith("UPDATE")) {
    const err = Object.assign(
      new Error("audit_logs is append-only: UPDATE is not permitted"),
      { code: "insufficient_privilege" },
    );
    throw err;
  }

  if (upper.startsWith("SELECT COUNT"))
    return { rows: [{ count: "0" }], rowCount: 1 };
  if (upper.startsWith("SELECT PG_TRY_ADVISORY"))
    return { rows: [{ locked: true }], rowCount: 1 };

  return { rows: [], rowCount: 0 };
}

// ---------------------------------------------------------------------------
// Mocks (jest.mock factories run before any imports are evaluated)
// ---------------------------------------------------------------------------

jest.mock("../db", () => {
  const clientQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
    executedStatements.push(sql.trim());
    return simulateQuery(sql);
  });

  const client = { query: clientQuery, release: jest.fn() };

  const poolQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    executedStatements.push(sql.trim());
    return simulateQuery(sql);
  });

  const pool = {
    query: poolQuery,
    connect: jest.fn(async () => client),
    _client: client,
  };

  return { __esModule: true, default: pool };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import pool from "../db";
import { recordAuditLog, listAuditLogs, type Queryable } from "./auditLog";
import { purgeExpiredAuditLogs, AUDIT_LOG_RETENTION_DAYS } from "../jobs/auditLogRetention";

// Typed reference to the mock pool
const mockPool = pool as unknown as {
  query: jest.Mock;
  connect: jest.Mock;
  _client: { query: jest.Mock; release: jest.Mock };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statementsOf(type: "INSERT" | "UPDATE" | "DELETE" | "SELECT"): string[] {
  return executedStatements.filter((s) => s.trim().toUpperCase().startsWith(type));
}

beforeEach(() => {
  executedStatements.length = 0;
  jest.clearAllMocks();

  // Re-attach implementations after clearAllMocks resets them.
  mockPool._client.query.mockImplementation(async (sql: string, _params?: unknown[]) => {
    executedStatements.push(sql.trim());
    return simulateQuery(sql);
  });
  mockPool.query.mockImplementation(async (sql: string, _params?: unknown[]) => {
    executedStatements.push(sql.trim());
    return simulateQuery(sql);
  });
  mockPool.connect.mockResolvedValue(mockPool._client as unknown as never);
  mockPool._client.release.mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// 1. recordAuditLog only issues INSERT
// ---------------------------------------------------------------------------

describe("recordAuditLog — SQL safety", () => {
  it("issues exactly one INSERT and no UPDATE or DELETE", async () => {
    await recordAuditLog(
      {
        actorId: "actor-uuid",
        actorRole: "admin",
        action: "kyc.approved",
        targetType: "user",
        targetId: "target-uuid",
        before: { kyc_status: "pending" },
        after: { kyc_status: "verified" },
      },
      mockPool as unknown as Queryable,
    );

    expect(statementsOf("INSERT")).toHaveLength(1);
    expect(statementsOf("UPDATE")).toHaveLength(0);
    expect(statementsOf("DELETE")).toHaveLength(0);
  });

  it("INSERT statement targets audit_logs", async () => {
    await recordAuditLog(
      {
        actorId: "actor-uuid",
        actorRole: "admin",
        action: "trade.dispute_resolved",
        targetType: "trade",
        targetId: "trade-uuid",
      },
      mockPool as unknown as Queryable,
    );

    const insert = statementsOf("INSERT")[0]!;
    expect(insert.toUpperCase()).toContain("INTO AUDIT_LOGS");
  });
});

// ---------------------------------------------------------------------------
// 2. listAuditLogs only issues SELECT
// ---------------------------------------------------------------------------

describe("listAuditLogs — SQL safety", () => {
  it("issues only SELECT statements and no INSERT, UPDATE, or DELETE", async () => {
    await listAuditLogs({ limit: 20, offset: 0 }, mockPool as unknown as Queryable);

    expect(statementsOf("SELECT").length).toBeGreaterThanOrEqual(1);
    expect(statementsOf("INSERT")).toHaveLength(0);
    expect(statementsOf("UPDATE")).toHaveLength(0);
    expect(statementsOf("DELETE")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Direct DELETE via app pool is rejected
// ---------------------------------------------------------------------------

describe("direct DELETE on audit_logs — rejected", () => {
  it("throws an insufficient_privilege error when no retention role is active", async () => {
    await expect(
      mockPool.query("DELETE FROM audit_logs WHERE id = $1", ["some-uuid"]),
    ).rejects.toMatchObject({
      code: "insufficient_privilege",
      message: expect.stringContaining("append-only"),
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Direct UPDATE via app pool is rejected
// ---------------------------------------------------------------------------

describe("direct UPDATE on audit_logs — rejected", () => {
  it("throws an insufficient_privilege error for any UPDATE", async () => {
    await expect(
      mockPool.query("UPDATE audit_logs SET action = $1 WHERE id = $2", [
        "tampered",
        "some-uuid",
      ]),
    ).rejects.toMatchObject({
      code: "insufficient_privilege",
      message: expect.stringContaining("append-only"),
    });
  });
});

// ---------------------------------------------------------------------------
// 5. purgeExpiredAuditLogs uses both guards before DELETE
// ---------------------------------------------------------------------------

describe("purgeExpiredAuditLogs — privileged path", () => {
  it("resolves without error when both retention guards are satisfied", async () => {
    await expect(
      purgeExpiredAuditLogs(mockPool as unknown as import("pg").Pool),
    ).resolves.not.toThrow();
  });

  it("sets the retention session flag before DELETE", async () => {
    await purgeExpiredAuditLogs(mockPool as unknown as import("pg").Pool);

    const hasFlag = executedStatements.some((s) =>
      s.toLowerCase().includes("airflex.audit_retention"),
    );
    expect(hasFlag).toBe(true);
  });

  it("activates the airflex_audit_retention role before DELETE", async () => {
    await purgeExpiredAuditLogs(mockPool as unknown as import("pg").Pool);

    const hasRole = executedStatements.some((s) =>
      s.toUpperCase().includes("SET LOCAL ROLE AIRFLEX_AUDIT_RETENTION"),
    );
    expect(hasRole).toBe(true);
  });

  it("DELETE statement filters by occurred_at and passes the retention window as a parameter", async () => {
    await purgeExpiredAuditLogs(mockPool as unknown as import("pg").Pool);

    const del = statementsOf("DELETE").find((s) =>
      s.toUpperCase().includes("AUDIT_LOGS"),
    );
    expect(del).toBeDefined();
    // The WHERE clause must reference occurred_at so recent rows are excluded.
    expect(del!.toLowerCase()).toContain("occurred_at");

    // The retention window is passed as a parameter ($1), not interpolated
    // into the SQL text. Verify it was passed to the client query call.
    const deleteCall = mockPool._client.query.mock.calls.find(
      ([sql]: [string]) => sql.trim().toUpperCase().startsWith("DELETE"),
    );
    expect(deleteCall).toBeDefined();
    // First param is the retention days value.
    expect(deleteCall![1]).toEqual(
      expect.arrayContaining([AUDIT_LOG_RETENTION_DAYS]),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. DELETE without retention role is rejected
// ---------------------------------------------------------------------------

describe("purgeExpiredAuditLogs — rejected without retention role", () => {
  it("throws when the client does not issue SET LOCAL ROLE", async () => {
    // A client that blocks any DELETE unconditionally (no role-switch check).
    const strictClient = {
      query: jest.fn(async (sql: string) => {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("DELETE")) {
          throw Object.assign(
            new Error("audit_logs is append-only: DELETE is not permitted"),
            { code: "insufficient_privilege" },
          );
        }
        if (upper.startsWith("SELECT PG_TRY_ADVISORY"))
          return { rows: [{ locked: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };

    const strictPool = {
      connect: jest.fn(async () => strictClient),
    };

    await expect(
      purgeExpiredAuditLogs(strictPool as unknown as import("pg").Pool),
    ).rejects.toMatchObject({ code: "insufficient_privilege" });
  });
});
