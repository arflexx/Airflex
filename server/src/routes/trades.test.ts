/**
 * trades.test.ts
 *
 * Tests for the trades routes, focused on issue #362:
 * ratings must persist correctly after a seller account is anonymised.
 *
 * All database calls are intercepted by mocking the `pool` module so no live
 * Postgres instance is required.
 */

// ---------------------------------------------------------------------------
// Env shims — must come before any module import that reads process.env
// ---------------------------------------------------------------------------
process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] =
  "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] =
  "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Mock the DB pool before the app (and therefore the route) is imported
// ---------------------------------------------------------------------------
jest.mock("../db", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

// Mock Stellar service calls so the route under test doesn't attempt real
// network I/O when other endpoints are exercised indirectly.
jest.mock("../services/stellar", () => ({
  createListing: jest.fn(),
  depositToEscrow: jest.fn(),
}));

jest.mock("../services/tradeVerification", () => ({
  triggerVerification: jest.fn(),
  VerificationError: class VerificationError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

jest.mock("../services/notifications", () => ({
  NotificationService: {
    send: jest.fn(),
    sendToMany: jest.fn(),
    sendToAdmins: jest.fn(),
  },
}));

import request from "supertest";
import app from "../index";
import pool from "../db";

// Convenience alias — TypeScript-safe cast to the jest mock
const mockQuery = pool.query as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JWT for a buyer whose id is BUYER_ID */
const BUYER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SELLER_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TRADE_ID = "cccccccc-0000-0000-0000-000000000003";
const RATING_ID = "dddddddd-0000-0000-0000-000000000004";

/** Sign a minimal JWT with the test secret. */
function makeJwt(userId: string): string {
  // jsonwebtoken is a real dep — use it directly rather than crafting a raw token.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
  return jwt.sign(
    { sub: userId, stellarPublicKey: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" },
    process.env["JWT_SECRET"]!,
    { expiresIn: "1h" }
  );
}

const buyerToken = makeJwt(BUYER_ID);

// ---------------------------------------------------------------------------
// Test suite — issue #362
// ---------------------------------------------------------------------------

describe("POST /api/v1/trades/:id/rate — issue #362: ratings survive account anonymisation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Helper: wire up mockQuery for a successful rating flow
  // The mock receives calls in this order from the route handler:
  //   1. SELECT trade_offers WHERE id = $1       → completed trade row
  //   2. SELECT phone FROM users WHERE id = $1   → seller's phone / anon hash
  //   3. INSERT INTO ratings ...                 → new rating row
  // -------------------------------------------------------------------------
  function wireSuccessfulRating(sellerPhone: string) {
    mockQuery
      // call 1 — load the trade
      .mockResolvedValueOnce({
        rows: [
          {
            id: TRADE_ID,
            seller_id: SELLER_ID,
            buyer_id: BUYER_ID,
            status: "Completed",
            asset_type: "airtime",
            amount: 500,
            fee_amount: 7.5,
            seller_net_amount: 492.5,
            contract_listing_id: "listing-abc",
            escrow_tx_hash: "0xdeadbeef",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      })
      // call 2 — look up seller phone / display id
      .mockResolvedValueOnce({ rows: [{ phone: sellerPhone }] })
      // call 3 — insert rating
      .mockResolvedValueOnce({
        rows: [
          {
            id: RATING_ID,
            trade_id: TRADE_ID,
            reviewer_id: BUYER_ID,
            reviewee_id: SELLER_ID,
            reviewee_display_id: sellerPhone || SELLER_ID,
            stars: 5,
            comment: "Great seller",
            created_at: new Date().toISOString(),
          },
        ],
      });
  }

  it("stores the seller phone as reviewee_display_id when account is active", async () => {
    const sellerPhone = "+2348012345678";
    wireSuccessfulRating(sellerPhone);

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 5, comment: "Great seller" });

    expect(res.status).toBe(201);

    // Verify the INSERT was called with reviewee_display_id = seller phone
    const insertCall = mockQuery.mock.calls.find((args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO ratings")
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as unknown[];
    // params order: tradeId, reviewerId, reviewee_id, reviewee_display_id, stars, comment
    expect(insertParams[3]).toBe(sellerPhone);
  });

  it("stores the anonymised hash as reviewee_display_id when the seller has been anonymised", async () => {
    // After hard anonymisation the phone column is replaced with
    // "deleted:<sha256>" by the scheduled job (see profile.ts → hashPhone).
    const anonHash = "deleted:a3f1bc2d4e5f6789abcdef0123456789abcdef0123456789abcdef0123456789";
    wireSuccessfulRating(anonHash);

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 4, comment: null });

    expect(res.status).toBe(201);

    const insertCall = mockQuery.mock.calls.find((args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO ratings")
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams[3]).toBe(anonHash);
  });

  it("falls back to the seller UUID text when the users row returns an empty phone", async () => {
    // Edge case: phone is an empty string (shouldn't happen in production but
    // guards the fallback branch in the route handler).
    wireSuccessfulRating("");

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 3 });

    expect(res.status).toBe(201);

    const insertCall = mockQuery.mock.calls.find((args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO ratings")
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as unknown[];
    // Empty phone → falls back to seller UUID
    expect(insertParams[3]).toBe(SELLER_ID);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/trades — LATERAL join uses reviewee_display_id
// ---------------------------------------------------------------------------

describe("GET /api/v1/trades — LATERAL join on reviewee_display_id (issue #362)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns seller_average_rating from ratings joined on reviewee_display_id", async () => {
    // The SELECT query returns a row whose seller_average_rating comes from
    // the LATERAL subquery joining on reviewee_display_id = seller_id::text.
    // We verify the route correctly passes through the value the DB returns.
    mockQuery
      // call 1 — paginated trades SELECT (includes LATERAL)
      .mockResolvedValueOnce({
        rows: [
          {
            id: TRADE_ID,
            seller_id: SELLER_ID,
            buyer_id: null,
            status: "Active",
            asset_type: "data",
            amount: 1000,
            fee_amount: 15,
            seller_net_amount: 985,
            contract_listing_id: "listing-xyz",
            escrow_tx_hash: null,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            seller_average_rating: 4.5,
            seller_review_count: 3,
          },
        ],
      })
      // call 2 — COUNT(*) for pagination
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const res = await request(app).get("/api/v1/trades?page=1&limit=10");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].seller_average_rating).toBe(4.5);
    expect(res.body.data[0].seller_review_count).toBe(3);

    // Confirm the SQL sent to the DB references reviewee_display_id, not reviewee_id
    const selectCall = mockQuery.mock.calls.find((args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("LATERAL")
    );
    expect(selectCall).toBeDefined();
    expect(selectCall![0]).toContain("reviewee_display_id");
    expect(selectCall![0]).not.toContain("reviewee_id = t.seller_id");
  });

  it("returns seller_average_rating = 0 and seller_review_count = 0 when LATERAL returns no rows", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: TRADE_ID,
            seller_id: SELLER_ID,
            buyer_id: null,
            status: "Active",
            asset_type: "airtime",
            amount: 200,
            fee_amount: 3,
            seller_net_amount: 197,
            contract_listing_id: "listing-abc",
            escrow_tx_hash: null,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            // COALESCE(null, 0) → the DB returns 0 for a new seller
            seller_average_rating: 0,
            seller_review_count: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const res = await request(app).get("/api/v1/trades");

    expect(res.status).toBe(200);
    expect(res.body.data[0].seller_average_rating).toBe(0);
    expect(res.body.data[0].seller_review_count).toBe(0);
  });
});
