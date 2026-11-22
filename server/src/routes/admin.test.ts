import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-key-12345678901234567890123456789012";
process.env["JWT_SECRET"] = JWT_SECRET;

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

jest.mock("../services/stellar", () => ({
  resolveDispute: jest.fn(),
}));

jest.mock("../services/fraudDetection", () => ({
  FraudDetectionService: {
    getFlaggedAccounts: jest.fn(),
    listFraudFlags: jest.fn(),
    reviewFraudFlag: jest.fn(),
  },
}));

import adminRouter from "./admin";
import { FraudDetectionService } from "../services/fraudDetection";

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRouter);

describe("GET /api/v1/admin/users/:phone", () => {
  const adminId = "99999999-9999-9999-9999-999999999999";
  const adminToken = jwt.sign(
    { sub: adminId, role: "admin", tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("normalises phone parameter and returns maskedPhone and phoneHash instead of raw phone", async () => {
    // 1st query: authenticate token_version check
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    // 2nd query: authorize role check
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "admin" }] });
    // 3rd query: SELECT user WHERE phone = $1
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "user-123",
          phone: "+2348012345678",
          role: "user",
          created_at: "2026-01-01T00:00:00.000Z",
          stellar_public_key: null,
          balance: 5000,
        },
      ],
    });
    // 4th query: SELECT trade_offers
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Request with unnormalized local phone number
    const res = await request(app)
      .get("/api/v1/admin/users/08012345678")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // User query was called with normalized E.164 phone number (+2348012345678)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE u.phone = $1"),
      ["+2348012345678"]
    );

    // Response contains maskedPhone and phoneHash, not raw phone
    expect(res.body.data.maskedPhone).toBe("+234 *** *** 5678");
    expect(res.body.data.phoneHash).toBeDefined();
    expect(res.body.data.phoneHash.length).toBe(8);
    expect(res.body.data.phone).toBeUndefined();
  });
});

describe("fraud flag review endpoints (issue #491)", () => {
  const adminId = "99999999-9999-9999-9999-999999999999";
  const flagId = "11111111-2222-4333-8444-555555555555";
  const adminToken = jwt.sign(
    { sub: adminId, role: "admin", tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  const listFraudFlags = FraudDetectionService.listFraudFlags as jest.Mock;
  const reviewFraudFlag = FraudDetectionService.reviewFraudFlag as jest.Mock;

  /** authenticate (token_version) + authorize (role) lookups. */
  function mockAdminAuth(): void {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "admin" }] });
  }

  beforeEach(() => {
    mockQuery.mockReset();
    listFraudFlags.mockReset();
    reviewFraudFlag.mockReset();
  });

  describe("GET /api/v1/admin/fraud-flags", () => {
    it("returns the flags with pagination for the requested status", async () => {
      mockAdminAuth();
      const flag = {
        id: flagId,
        user_id: "user-1",
        reason_code: "REPEATED_FAILED_TRADES",
        details: { failureCount: 5 },
        status: "open",
        flagged_at: "2026-10-20T12:00:00.000Z",
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
      };
      listFraudFlags.mockResolvedValueOnce({ flags: [flag], total: 21 });

      const res = await request(app)
        .get("/api/v1/admin/fraud-flags?status=open&page=2&limit=10")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(listFraudFlags).toHaveBeenCalledWith({ status: "open", limit: 10, offset: 10 });
      expect(res.body).toEqual({
        data: [flag],
        pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
      });
    });

    it("lists every flag when status is omitted", async () => {
      mockAdminAuth();
      listFraudFlags.mockResolvedValueOnce({ flags: [], total: 0 });

      const res = await request(app)
        .get("/api/v1/admin/fraud-flags")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(listFraudFlags).toHaveBeenCalledWith({ status: undefined, limit: expect.any(Number), offset: 0 });
    });

    it("rejects an unknown status with 400", async () => {
      mockAdminAuth();

      const res = await request(app)
        .get("/api/v1/admin/fraud-flags?status=pending")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(listFraudFlags).not.toHaveBeenCalled();
    });

    it("requires authentication", async () => {
      const res = await request(app).get("/api/v1/admin/fraud-flags");

      expect(res.status).toBe(401);
      expect(listFraudFlags).not.toHaveBeenCalled();
    });

    it("forbids non-admin users", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ role: "user" }] });
      const userToken = jwt.sign({ sub: "user-1", role: "user", tokenVersion: 1 }, JWT_SECRET, {
        expiresIn: "1h",
      });

      const res = await request(app)
        .get("/api/v1/admin/fraud-flags")
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.status).toBe(403);
      expect(listFraudFlags).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/v1/admin/fraud-flags/:id", () => {
    it("closes the flag and records the reviewing admin", async () => {
      mockAdminAuth();
      const reviewed = { id: flagId, status: "dismissed", reviewed_by: adminId, review_note: "False positive" };
      reviewFraudFlag.mockResolvedValueOnce(reviewed);

      const res = await request(app)
        .patch(`/api/v1/admin/fraud-flags/${flagId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "dismissed", note: "  False positive  " });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: reviewed });
      expect(reviewFraudFlag).toHaveBeenCalledWith(flagId, adminId, "dismissed", "False positive");
    });

    it("passes a null note when none is given", async () => {
      mockAdminAuth();
      reviewFraudFlag.mockResolvedValueOnce({ id: flagId, status: "reviewed" });

      await request(app)
        .patch(`/api/v1/admin/fraud-flags/${flagId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "reviewed" });

      expect(reviewFraudFlag).toHaveBeenCalledWith(flagId, adminId, "reviewed", null);
    });

    it("rejects reopening a flag (status must be reviewed or dismissed) with 422", async () => {
      mockAdminAuth();

      const res = await request(app)
        .patch(`/api/v1/admin/fraud-flags/${flagId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "open" });

      expect(res.status).toBe(422);
      expect(reviewFraudFlag).not.toHaveBeenCalled();
    });

    it("rejects a malformed id with 400", async () => {
      mockAdminAuth();

      const res = await request(app)
        .patch("/api/v1/admin/fraud-flags/not-a-uuid")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "reviewed" });

      expect(res.status).toBe(400);
      expect(reviewFraudFlag).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown flag", async () => {
      mockAdminAuth();
      reviewFraudFlag.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch(`/api/v1/admin/fraud-flags/${flagId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "reviewed" });

      expect(res.status).toBe(404);
    });

    it("returns 409 for a flag that is already closed", async () => {
      mockAdminAuth();
      reviewFraudFlag.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: [{ status: "reviewed" }] });

      const res = await request(app)
        .patch(`/api/v1/admin/fraud-flags/${flagId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "dismissed" });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Fraud flag is already reviewed" });
    });
  });
});

describe("Admin audit logs (issue #539)", () => {
  const actorId = "99999999-9999-9999-9999-999999999999";
  const token = jwt.sign({ sub: actorId, role: "super_admin", tokenVersion: 1 }, JWT_SECRET, {
    expiresIn: "1h",
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("lets a super_admin query audit entries with filters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "super_admin" }] });
    const entry = {
      id: "e1",
      action: "trade.dispute_resolved",
      target_type: "trade",
      target_id: "t1",
    };
    mockQuery.mockResolvedValueOnce({ rows: [entry] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const res = await request(app)
      .get("/api/v1/admin/audit-logs?action=trade.dispute_resolved&targetType=trade&page=1&limit=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [entry],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE action = $1 AND target_type = $2"),
      ["trade.dispute_resolved", "trade", 10, 0]
    );
  });

  it("forbids a regular admin", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "admin" }] });

    const res = await request(app)
      .get("/api/v1/admin/audit-logs")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("rejects an unknown action filter with 400", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "super_admin" }] });

    const res = await request(app)
      .get("/api/v1/admin/audit-logs?action=user.deleted_everything")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it.each(["post", "put", "patch", "delete"] as const)(
    "refuses %s on audit entries with 405",
    async (method) => {
      const res = await request(app)[method]("/api/v1/admin/audit-logs/e1")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("GET");
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  it("still lets a super_admin use admin-only routes", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: "super_admin" }] });

    const res = await request(app)
      .get("/api/v1/admin/queues")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/admin/users cursor-based pagination (issue #616)", () => {
  const adminId = "99999999-9999-9999-9999-999999999999";
  const adminToken = jwt.sign(
    { sub: adminId, role: "admin", tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  function makeUsers(startIndex: number, count: number) {
    return Array.from({ length: count }, (_, i) => {
      const idx = startIndex + i;
      return {
        id: `00000000-0000-0000-0000-${String(idx).padStart(12, "0")}`,
        phone: `+23480000${String(idx).padStart(5, "0")}`,
        registrationDate: "2026-01-01T00:00:00.000Z",
        balance: 10 * idx,
        tradeCount: idx,
      };
    });
  }

  function wireDb(pageRows: ReturnType<typeof makeUsers>) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/token_version/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/SELECT role FROM users/i.test(sql)) return { rows: [{ role: "admin" }] };
      if (/FROM page_users pu/i.test(sql)) return { rows: pageRows };
      throw new Error(`unexpected query: ${sql.replace(/\s+/g, " ").slice(0, 80)}`);
    });
  }

  it("covers first page with nextCursor returned", async () => {
    mockQuery.mockReset();
    // Simulate fetching limit + 1 items (e.g. limit=2, 3 items available)
    wireDb(makeUsers(1, 3));

    const res = await request(app)
      .get("/api/v1/admin/users?limit=2")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).toBe(res.body.data[1].id);
    expect(res.body.nextCursor).not.toBeNull();

    const pageCall = mockQuery.mock.calls.find(([sql]) => /FROM page_users pu/i.test(sql));
    expect(pageCall).toBeDefined();
    const [sql, params] = pageCall as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY id ASC/i);
    expect(params).toEqual([3]);
  });

  it("covers middle page with cursor and nextCursor returned", async () => {
    mockQuery.mockReset();
    const cursor = "00000000-0000-0000-0000-000000000002";
    // 3 items returned (limit 2 + 1), indicating more items follow
    wireDb(makeUsers(3, 3));

    const res = await request(app)
      .get(`/api/v1/admin/users?cursor=${cursor}&limit=2`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).toBe(res.body.data[1].id);
    expect(res.body.nextCursor).not.toBeNull();

    const pageCall = mockQuery.mock.calls.find(([sql]) => /FROM page_users pu/i.test(sql));
    expect(pageCall).toBeDefined();
    const [sql, params] = pageCall as [string, unknown[]];
    expect(sql).toMatch(/WHERE id > \$1/i);
    expect(params).toEqual([cursor, 3]);
  });

  it("covers last page where nextCursor is null", async () => {
    mockQuery.mockReset();
    const cursor = "00000000-0000-0000-0000-000000000005";
    // Returns 1 item, less than or equal to limit (limit=2), indicating end of pages
    wireDb(makeUsers(6, 1));

    const res = await request(app)
      .get(`/api/v1/admin/users?cursor=${cursor}&limit=2`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
  });
});

describe("GET /api/v1/admin/users cursor pagination input validation (issue #625)", () => {
  const adminToken = jwt.sign(
    { sub: "99999999-9999-9999-9999-999999999999", role: "admin", tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  it.each(["0", "101", "not-a-number"])("rejects invalid limit %s before querying", async (limit) => {
    mockQuery.mockReset();
    const res = await request(app)
      .get(`/api/v1/admin/users?limit=${limit}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query parameters");
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringMatching(/FROM page_users pu/i), expect.anything());
  });

  it("rejects a blank cursor before querying", async () => {
    mockQuery.mockReset();
    const res = await request(app)
      .get("/api/v1/admin/users?cursor=%20")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query parameters");
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringMatching(/FROM page_users pu/i), expect.anything());
  });
});

describe("Granular permission-based access control (issue #674)", () => {
  const adminId = "99999999-9999-9999-9999-999999999999";
  const adminWithPermission = jwt.sign(
    { sub: adminId, role: "admin", tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  const adminWithoutPermission = jwt.sign(
    { sub: "88888888-8888-8888-8888-888888888888", role: "admin", tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("requirePermission middleware", () => {
    it("allows access when admin has the required permission", async () => {
      // authenticate (token_version)
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission (admin_permissions check)
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: ["trades.view"] }],
      });

      const res = await request(app)
        .get("/api/v1/admin/trades")
        .set("Authorization", `Bearer ${adminWithPermission}`);

      expect(res.status).toBe(200);
    });

    it("denies access with 403 when admin lacks the required permission", async () => {
      // authenticate (token_version)
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission (admin_permissions check)
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: ["users.view"] }], // Missing trades.view
      });

      const res = await request(app)
        .get("/api/v1/admin/trades")
        .set("Authorization", `Bearer ${adminWithoutPermission}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Permission denied" });
    });

    it("denies access with 403 when admin_permissions is empty", async () => {
      // authenticate (token_version)
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission (admin_permissions check)
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: [] }],
      });

      const res = await request(app)
        .get("/api/v1/admin/trades")
        .set("Authorization", `Bearer ${adminWithoutPermission}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Permission denied" });
    });

    it("denies access with 403 when admin_permissions is null", async () => {
      // authenticate (token_version)
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission (admin_permissions check)
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: null }],
      });

      const res = await request(app)
        .get("/api/v1/admin/trades")
        .set("Authorization", `Bearer ${adminWithoutPermission}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Permission denied" });
    });
  });

  describe("permission checks per endpoint", () => {
    it("trades.resolve permission required for dispute resolution", async () => {
      // authenticate
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission - admin has trades.resolve
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: ["trades.resolve"] }],
      });

      const res = await request(app)
        .post("/api/v1/admin/trades/123e4567-e89b-12d3-a456-426614174000/resolve")
        .set("Authorization", `Bearer ${adminWithPermission}`)
        .send({ resolution: "RELEASE" });

      // Should pass permission check (will fail later on validation/DB, but that's OK)
      expect(res.status).not.toBe(403);
    });

    it("denies dispute resolution without trades.resolve permission", async () => {
      // authenticate
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission - admin lacks trades.resolve
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: ["trades.view"] }],
      });

      const res = await request(app)
        .post("/api/v1/admin/trades/123e4567-e89b-12d3-a456-426614174000/resolve")
        .set("Authorization", `Bearer ${adminWithoutPermission}`)
        .send({ resolution: "RELEASE" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Permission denied" });
    });

    it("users.kyc_approve permission required for KYC status changes", async () => {
      // authenticate
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission - admin has users.kyc_approve
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: ["users.kyc_approve"] }],
      });

      const res = await request(app)
        .patch("/api/v1/admin/users/123e4567-e89b-12d3-a456-426614174000/kyc")
        .set("Authorization", `Bearer ${adminWithPermission}`)
        .send({ status: "verified" });

      expect(res.status).not.toBe(403);
    });

    it("denies KYC approval without users.kyc_approve permission", async () => {
      // authenticate
      mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });
      // requirePermission - admin lacks users.kyc_approve
      mockQuery.mockResolvedValueOnce({
        rows: [{ admin_permissions: ["users.view"] }],
      });

      const res = await request(app)
        .patch("/api/v1/admin/users/123e4567-e89b-12d3-a456-426614174000/kyc")
        .set("Authorization", `Bearer ${adminWithoutPermission}`)
        .send({ status: "verified" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Permission denied" });
    });
  });
});

