import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { app, API, seedUser, seedTrade, authHeader } from "./helpers/testApp";
import { setupTestDatabase, queryOne } from "./helpers/testDb";
import { setupMsw } from "./helpers/mockHttp";

// The Soroban contract-call functions require live RPC/XDR round-trips that
// cannot run against a unit-test environment. They are replaced at the module
// boundary; every genuine outbound HTTP call (Horizon/Friendbot/Termii/Paystack)
// remains exercised through msw.
jest.mock("../services/stellar", () => ({
  ...jest.requireActual("../services/stellar"),
  createListing: jest.fn(),
  depositToEscrow: jest.fn(),
  releasePayment: jest.fn(),
}));

import {
  createListing,
  depositToEscrow,
  releasePayment,
} from "../services/stellar";

const mockCreateListing = createListing as jest.Mock;
const mockDepositToEscrow = depositToEscrow as jest.Mock;
const mockReleasePayment = releasePayment as jest.Mock;

setupMsw();
setupTestDatabase();

beforeEach(() => {
  mockCreateListing.mockReset();
  mockDepositToEscrow.mockReset();
  mockReleasePayment.mockReset();
});

// =============================================================================
// GET /api/v1/trades
// =============================================================================
describe("GET /api/v1/trades", () => {
  it("200 — lists only Active, unexpired offers, newest first, with pagination", async () => {
    const seller = await seedUser();
    await seedTrade({ sellerId: seller.id, assetType: "airtime-oldest", createdAtOffsetMs: -2_000 });
    await seedTrade({ sellerId: seller.id, assetType: "airtime-middle",  createdAtOffsetMs: -1_000 });
    await seedTrade({ sellerId: seller.id, assetType: "airtime-newest",  createdAtOffsetMs: 0 });
    // Must be excluded:
    await seedTrade({ sellerId: seller.id, status: "Locked" });
    await seedTrade({ sellerId: seller.id, expiresInHours: -1 }); // expired

    const res = await request(app).get(`${API}/trades`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { asset_type: string }) => t.asset_type)).toEqual([
      "airtime-newest",
      "airtime-middle",
      "airtime-oldest",
    ]);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it("200 — paginates correctly", async () => {
    const seller = await seedUser();
    for (let i = 0; i < 5; i++) {
      await seedTrade({ sellerId: seller.id, createdAtOffsetMs: -i * 1_000 });
    }

    const res = await request(app).get(`${API}/trades?page=2&limit=2`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it("200 — empty marketplace returns an empty list", async () => {
    const res = await request(app).get(`${API}/trades`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it("400 — invalid query parameters (page out of range)", async () => {
    const res = await request(app).get(`${API}/trades?page=0`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("400 — invalid query parameters (non-numeric page)", async () => {
    const res = await request(app).get(`${API}/trades?page=abc`);
    expect(res.status).toBe(400);
  });

  it("400 — invalid query parameters (limit above maximum)", async () => {
    const res = await request(app).get(`${API}/trades?limit=101`);
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// POST /api/v1/trades  (authenticated)
// =============================================================================
describe("POST /api/v1/trades", () => {
  const validBody = { assetType: "airtime", amount: 500, expiresInHours: 24 };

  it("201 — creates a listing on-chain and persists the trade offer", async () => {
    const seller = await seedUser({ withWallet: true });
    mockCreateListing.mockResolvedValue("777");

    const res = await request(app)
      .post(`${API}/trades`)
      .set(authHeader(seller.token))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data.seller_id).toBe(seller.id);
    expect(res.body.data.status).toBe("Active");
    expect(res.body.data.contract_listing_id).toBe("777");
    expect(parseFloat(res.body.data.amount)).toBe(500);

    // Contract was invoked with the seller's credentials
    expect(mockCreateListing).toHaveBeenCalledTimes(1);
    expect(mockCreateListing.mock.calls[0][0]).toMatchObject({
      sellerPublicKey: seller.publicKey,
      assetType: "airtime",
      amount: 500,
    });

    const stored = await queryOne<{ status: string; contract_listing_id: string }>(
      `SELECT status, contract_listing_id FROM trade_offers WHERE id = $1`,
      [res.body.data.id]
    );
    expect(stored?.contract_listing_id).toBe("777");
  });

  it("401 — missing Authorization header", async () => {
    const res = await request(app).post(`${API}/trades`).send(validBody);
    expect(res.status).toBe(401);
  });

  it("401 — invalid or expired token", async () => {
    const res = await request(app)
      .post(`${API}/trades`)
      .set({ Authorization: "Bearer not.a.jwt" })
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("422 — validation failure (negative amount)", async () => {
    const seller = await seedUser({ withWallet: true });

    const res = await request(app)
      .post(`${API}/trades`)
      .set(authHeader(seller.token))
      .send({ ...validBody, amount: -10 });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe("amount");
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("422 — validation failure (expiry above 168h)", async () => {
    const seller = await seedUser({ withWallet: true });

    const res = await request(app)
      .post(`${API}/trades`)
      .set(authHeader(seller.token))
      .send({ ...validBody, expiresInHours: 200 });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe("expiresInHours");
  });

  it("400 — seller has no wallet yet", async () => {
    const seller = await seedUser(); // without wallet

    const res = await request(app)
      .post(`${API}/trades`)
      .set(authHeader(seller.token))
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wallet not found/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("500 — contract call failure surfaces through the global error handler", async () => {
    const seller = await seedUser({ withWallet: true });
    mockCreateListing.mockRejectedValue(new Error("soroban rpc unavailable"));

    const res = await request(app)
      .post(`${API}/trades`)
      .set(authHeader(seller.token))
      .send(validBody);

    expect(res.status).toBe(500);
    // Nothing was persisted when the contract call failed
    const count = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM trade_offers`);
    expect(Number(count?.count)).toBe(0);
  });
});

// =============================================================================
// GET /api/v1/trades/:id
// =============================================================================
describe("GET /api/v1/trades/:id", () => {
  it("200 — returns a single trade offer", async () => {
    const seller = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id, assetType: "data" });

    const res = await request(app).get(`${API}/trades/${tradeId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tradeId);
    expect(res.body.data.asset_type).toBe("data");
  });

  it("404 — unknown trade id", async () => {
    const res = await request(app).get(`${API}/trades/${uuidv4()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// =============================================================================
// POST /api/v1/trades/:id/buy  (authenticated)
// =============================================================================
describe("POST /api/v1/trades/:id/buy", () => {
  const buyerSecret = "SB6GFHKPZLTHKVNNRRGLLLAAGG5HGGNAFJDCJTJZPIYRZOSMGDJBXKCL"; // 56 chars, never used on-chain (mocked)

  function buyRequest(token: string, id: string) {
    return request(app)
      .post(`${API}/trades/${id}/buy`)
      .set(authHeader(token))
      .send({ buyerSecretKey: buyerSecret });
  }

  it("200 — locks the trade and records the escrow transaction hash", async () => {
    const seller = await seedUser();
    const buyer = await seedUser({ withWallet: true }); // wallet ⇒ public key embedded in the JWT
    const tradeId = await seedTrade({
      sellerId: seller.id,
      contractListingId: "42",
      amount: 750,
    });
    mockDepositToEscrow.mockResolvedValue("tx-hash-abc");

    const res = await buyRequest(buyer.token, tradeId);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("Locked");
    expect(res.body.data.buyer_id).toBe(buyer.id);
    expect(res.body.data.escrow_tx_hash).toBe("tx-hash-abc");

    expect(mockDepositToEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerPublicKey: buyer.publicKey,
        listingId: "42",
        // NUMERIC columns come back as decimal strings
        amount: "750.0000000",
      })
    );

    const stored = await queryOne<{ status: string; escrow_tx_hash: string | null }>(
      `SELECT status, escrow_tx_hash FROM trade_offers WHERE id = $1`,
      [tradeId]
    );
    expect(stored?.status).toBe("Locked");
    expect(stored?.escrow_tx_hash).toBe("tx-hash-abc");
  });

  it("401 — unauthenticated purchase attempt", async () => {
    const seller = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id });

    const res = await request(app)
      .post(`${API}/trades/${tradeId}/buy`)
      .send({ buyerSecretKey: buyerSecret });

    expect(res.status).toBe(401);
  });

  it("422 — missing buyerSecretKey", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id });

    const res = await request(app)
      .post(`${API}/trades/${tradeId}/buy`)
      .set(authHeader(buyer.token))
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe("buyerSecretKey");
  });

  it("404 — unknown trade id", async () => {
    const buyer = await seedUser();
    const res = await buyRequest(buyer.token, uuidv4());
    expect(res.status).toBe(404);
    expect(mockDepositToEscrow).not.toHaveBeenCalled();
  });

  it("400 — seller cannot buy their own trade", async () => {
    const seller = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id });

    const res = await buyRequest(seller.token, tradeId);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own trade/i);
  });

  it("400 — trade is not Active anymore", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const tradeId = await seedTrade({
      sellerId: seller.id,
      status: "Cancelled",
    });

    const res = await buyRequest(buyer.token, tradeId);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
  });

  it("400 — trade without an on-chain listing cannot be bought", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const tradeId = await seedTrade({
      sellerId: seller.id,
      contractListingId: null,
    });

    const res = await buyRequest(buyer.token, tradeId);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contract listing/i);
  });

  it("500 — escrow deposit failure leaves the trade untouched", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id });
    mockDepositToEscrow.mockRejectedValue(new Error("escrow rejected"));

    const res = await buyRequest(buyer.token, tradeId);

    expect(res.status).toBe(500);
    const stored = await queryOne<{ status: string; buyer_id: string | null }>(
      `SELECT status, buyer_id FROM trade_offers WHERE id = $1`,
      [tradeId]
    );
    expect(stored?.status).toBe("Active");
    expect(stored?.buyer_id).toBeNull();
  });
});

// =============================================================================
// POST /api/v1/trades/:id/confirm-delivery  (authenticated, seller only)
// =============================================================================
describe("POST /api/v1/trades/:id/confirm-delivery", () => {
  function confirm(token: string, id: string) {
    return request(app)
      .post(`${API}/trades/${id}/confirm-delivery`)
      .set(authHeader(token))
      .send();
  }

  it("202 — accepted, then completes asynchronously after payment release", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const tradeId = await seedTrade({
      sellerId: seller.id,
      buyerId: buyer.id,
      status: "Locked",
      contractListingId: "9001",
    });
    mockReleasePayment.mockResolvedValue("release-tx-hash");

    const res = await confirm(seller.token, tradeId);

    expect(res.status).toBe(202);
    expect(res.body.tradeId).toBe(tradeId);
    expect(mockReleasePayment).toHaveBeenCalledWith("9001");

    // Background verification flips the status once the release confirms
    const deadline = Date.now() + 5_000;
    let stored: { status: string } | undefined;
    while (Date.now() < deadline) {
      stored = await queryOne<{ status: string }>(
        `SELECT status FROM trade_offers WHERE id = $1`,
        [tradeId]
      );
      if (stored?.status === "Completed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stored?.status).toBe("Completed");
  }, 15_000);

  it("202 — retries on failure and eventually escalates to Disputed", async () => {
    jest.useFakeTimers();
    try {
      mockReleasePayment.mockRejectedValue(new Error("ledger congested"));

      const seller = await seedUser();
      const buyer = await seedUser();
      const tradeId = await seedTrade({
        sellerId: seller.id,
        buyerId: buyer.id,
        status: "Locked",
        contractListingId: "9002",
      });

      const pending = confirm(seller.token, tradeId);
      const res = await pending;
      expect(res.status).toBe(202);

      // Pump the exponential back-off sleeps (≈2s + ≈4s) until escalation
      let status: string | undefined;
      for (let i = 0; i < 80 && status !== "Disputed"; i++) {
        await jest.advanceTimersByTimeAsync(250);
        const row = await queryOne<{ status: string }>(
          `SELECT status FROM trade_offers WHERE id = $1`,
          [tradeId]
        );
        status = row?.status;
      }

      expect(status).toBe("Disputed");
      expect(mockReleasePayment).toHaveBeenCalledTimes(3); // MAX_RETRIES
    } finally {
      jest.useRealTimers();
    }
  });

  it("401 — unauthenticated confirmation attempt", async () => {
    const seller = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id, status: "Locked" });

    const res = await request(app).post(`${API}/trades/${tradeId}/confirm-delivery`).send();
    expect(res.status).toBe(401);
  });

  it("403 — only the seller may confirm delivery", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const tradeId = await seedTrade({
      sellerId: seller.id,
      buyerId: buyer.id,
      status: "Locked",
    });

    const res = await confirm(buyer.token, tradeId);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the seller/i);
    expect(mockReleasePayment).not.toHaveBeenCalled();
  });

  it("404 — unknown trade id", async () => {
    const seller = await seedUser();
    const res = await confirm(seller.token, uuidv4());
    expect(res.status).toBe(404);
  });

  it("400 — trade must be Locked to confirm delivery", async () => {
    const seller = await seedUser();
    const tradeId = await seedTrade({ sellerId: seller.id, status: "Active" });

    const res = await confirm(seller.token, tradeId);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/locked/i);
    expect(mockReleasePayment).not.toHaveBeenCalled();
  });
});
