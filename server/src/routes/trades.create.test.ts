/**
 * trades.create.test.ts
 *
 * Focused tests for POST /api/v1/trades and the explicit unit handling added in
 * issue #292: the client sends `amount` already in stroops, the schema accepts
 * it as a positive integer, and the route forwards that exact integer to the
 * escrow contract without `* 1_000_000`. The naira the seller quoted is what
 * lands in the naira-denominated platform ledger.
 *
 * The database and the Stellar service are mocked, so no Postgres node or
 * Soroban RPC endpoint is required.
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

jest.mock("../db", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock("../services/stellar", () => ({
  createListing: jest.fn(),
  buildEscrowDepositXdr: jest.fn(),
  submitSignedTransaction: jest.fn(),
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
import { createListing } from "../services/stellar";

const mockQuery = pool.query as jest.Mock;
const mockCreateListing = createListing as jest.Mock;

const SELLER_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TRADE_ID = "cccccccc-0000-0000-0000-000000000003";

function makeJwt(userId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
  return jwt.sign(
    {
      sub: userId,
      stellarPublicKey: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    },
    process.env["JWT_SECRET"]!,
    { expiresIn: "1h" }
  );
}

const sellerToken = makeJwt(SELLER_ID);

/**
 * Wire up the four reads/writes the happy path performs, in order:
 *   0. SELECT token_version FROM users …  → authenticate() revocation check
 *   1. SELECT kyc_status  FROM users …    → KYC gate
 *   2. SELECT stellar_secret_key FROM wallets …
 *   3. INSERT INTO trade_offers … RETURNING *
 */
function wireCreate() {
  mockCreateListing.mockResolvedValueOnce("listing-1");
  mockQuery
    .mockResolvedValueOnce({ rows: [{ token_version: 1 }] })
    .mockResolvedValueOnce({ rows: [{ kyc_status: "verified" }] })
    .mockResolvedValueOnce({ rows: [{ stellar_secret_key: "S" + "A".repeat(55) }] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: TRADE_ID,
          seller_id: SELLER_ID,
          buyer_id: null,
          asset_type: "MTN_AIRTIME",
          amount: "500.00",
          fee_amount: null,
          seller_net_amount: null,
          status: "Active",
          contract_listing_id: "listing-1",
          escrow_tx_hash: null,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
}

function insertCallParams(): unknown[] {
  const call = mockQuery.mock.calls.find(
    (args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO trade_offers")
  );
  expect(call).toBeDefined();
  return call![1] as unknown[];
}

describe("POST /api/v1/trades — explicit stroop handling (issue #292)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("forwards a stroop amount to the contract unchanged (no double conversion)", async () => {
    wireCreate();

    const res = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ assetType: "MTN_AIRTIME", amount: 500_000_000, expiresInHours: 24 });

    expect(res.status).toBe(201);

    // The contract receives exactly what the client sent. The old code passed
    // `amount` through `* 1_000_000`, which turned ₦500 into 5e14 stroops when
    // the client had already converted — the double conversion this fixes.
    expect(mockCreateListing).toHaveBeenCalledTimes(1);
    expect(mockCreateListing.mock.calls[0]![0]).toMatchObject({
      sellerPublicKey: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      assetType: "MTN_AIRTIME",
      amountStroops: 500_000_000n,
    });
  });

  it("does not scale a small stroop amount into naira on the way to the contract", async () => {
    wireCreate();

    // A literal 500 here means 500 stroops — not ₦500. If the route still
    // multiplied, the contract would receive 500_000_000n.
    const res = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ assetType: "MTN_AIRTIME", amount: 500, expiresInHours: 24 });

    expect(res.status).toBe(201);
    expect(mockCreateListing.mock.calls[0]![0].amountStroops).toBe(500n);
  });

  it("stores the naira equivalent in the platform ledger", async () => {
    wireCreate();

    await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ assetType: "MTN_AIRTIME", amount: 500_000_000, expiresInHours: 24 });

    // INSERT params: [id, sellerId, assetType, amount, listingId, expiresAt]
    expect(insertCallParams()[3]).toBe(500);
  });

  it("responds with the created trade in naira", async () => {
    wireCreate();

    const res = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ assetType: "MTN_AIRTIME", amount: 500_000_000, expiresInHours: 24 });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe("500.00");
    expect(mockCreateListing).toHaveBeenCalledTimes(1);
  });

  it("rejects a fractional stroop amount", async () => {
    // authenticate() runs before validate(), so the revocation check still
    // needs a row — validation is what should reject the request.
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ assetType: "MTN_AIRTIME", amount: 500.5, expiresInHours: 24 });

    expect(res.status).toBe(422);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects a zero stroop amount", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const res = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ assetType: "MTN_AIRTIME", amount: 0, expiresInHours: 24 });

    expect(res.status).toBe(422);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });
});
