process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] =
  "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] =
  "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-0000-0000-000000000001";
process.env["PAYSTACK_SECRET_KEY"] = "sk_test_mock";
process.env["TERMII_API_KEY"] = "mock_termii_key";

jest.mock("../db", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import request from "supertest";
import app from "../index";
import pool from "../db";

const mockQuery = pool.query as jest.Mock;

describe("GET /api/v1/trades filter parameters (Issue #328)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("filters by carrier network", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const res = await request(app).get("/api/v1/trades?carrier=MTN");
    expect(res.status).toBe(200);

    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toContain("t.asset_type ILIKE $1");
    expect(selectCall[1]).toContain("MTN%");
  });

  it("filters by asset type (Airtime / Data)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const res = await request(app).get("/api/v1/trades?assetType=AIRTIME");
    expect(res.status).toBe(200);

    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toContain("t.asset_type ILIKE $1");
    expect(selectCall[1]).toContain("%AIRTIME%");
  });

  it("filters by amount range (minAmount and maxAmount)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const res = await request(app).get("/api/v1/trades?minAmount=500&maxAmount=10000");
    expect(res.status).toBe(200);

    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toContain("t.amount >= $1");
    expect(selectCall[0]).toContain("t.amount <= $2");
    expect(selectCall[1]).toContain(500);
    expect(selectCall[1]).toContain(10000);
  });

  it("combines carrier, assetType, and amount range filters", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const res = await request(app).get(
      "/api/v1/trades?carrier=GLO&assetType=DATA&minAmount=200&maxAmount=2000"
    );
    expect(res.status).toBe(200);

    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toContain("t.asset_type ILIKE $1");
    expect(selectCall[0]).toContain("t.asset_type ILIKE $2");
    expect(selectCall[0]).toContain("t.amount >= $3");
    expect(selectCall[0]).toContain("t.amount <= $4");
    expect(selectCall[1]).toEqual(["GLO%", "%DATA%", 200, 2000, 20, 0]);
  });
});
