// Shim env vars
process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-4000-8000-000000000000";
process.env["PAYSTACK_SECRET_KEY"] = "sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
process.env["TERMII_API_KEY"] = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

import request from "supertest";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import app from "../index";
import pool from "../db/pool";

// Mock the entire stellar service
jest.mock("../services/stellar", () => {
  return {
    createListing: jest.fn().mockResolvedValue("12345"),
    buildEscrowDepositXdr: jest.fn().mockResolvedValue({
      xdr: "mock_unsigned_xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    }),
    submitSignedTransaction: jest.fn().mockResolvedValue("mock_tx_hash_buy"),
    releasePayment: jest.fn().mockResolvedValue("mock_tx_hash_release"),
    getWalletBalance: jest.fn().mockResolvedValue("100"),
    generateAndFundWallet: jest.fn().mockResolvedValue({
      publicKey: "GA...",
      encryptedSecretKey: "mock_encrypted_secret",
    }),
  };
});

// We might also need to mock Notifications and SSE to avoid open handles
jest.mock("../services/notifications", () => ({
  NotificationService: {
    send: jest.fn(),
    sendToMany: jest.fn(),
    sendToAdmins: jest.fn(),
  },
}));

jest.mock("../services/sseEmitter", () => ({
  SseEmitter: {
    emit: jest.fn(),
    emitAll: jest.fn(),
  },
}));

describe("Trade Lifecycle E2E", () => {
  let sellerId: string;
  let buyerId: string;
  let sellerToken: string;
  let buyerToken: string;
  let tradeId: string;

  beforeAll(async () => {
    // Clear out tables to avoid conflicts
    await pool.query("TRUNCATE trade_offers, wallets, users, ratings, recovery_codes, referrals, referral_rewards CASCADE");

    sellerId = uuidv4();
    buyerId = uuidv4();

    const treasuryId = process.env.PLATFORM_TREASURY_USER_ID!;

    // Create Treasury user
    await pool.query(
      `INSERT INTO users (id, phone, referral_code) VALUES ($1, $2, $3)`,
      [treasuryId, "+12345678900", "TREASURY"]
    );
    await pool.query(
      `INSERT INTO wallets (id, user_id, stellar_public_key, stellar_secret_key) VALUES ($1, $2, $3, $4)`,
      [uuidv4(), treasuryId, "G_TREASURY", "encrypted"]
    );

    // Create Seller
    await pool.query(
      `INSERT INTO users (id, phone, referral_code) VALUES ($1, $2, $3)`,
      [sellerId, "+10000000001", "SELLER123"]
    );
    await pool.query(
      `INSERT INTO wallets (id, user_id, stellar_public_key, stellar_secret_key) VALUES ($1, $2, $3, $4)`,
      [uuidv4(), sellerId, "G_SELLER_PUB", "encrypted"]
    );

    // Create Buyer
    await pool.query(
      `INSERT INTO users (id, phone, referral_code) VALUES ($1, $2, $3)`,
      [buyerId, "+10000000002", "BUYER123"]
    );
    await pool.query(
      `INSERT INTO wallets (id, user_id, stellar_public_key, stellar_secret_key) VALUES ($1, $2, $3, $4)`,
      [uuidv4(), buyerId, "G_BUYER_PUB", "encrypted"]
    );

    // Fund the buyer so the wallet can be debited upon release
    await pool.query(
      `UPDATE wallets SET balance = balance + 1000 WHERE user_id = $1`,
      [buyerId]
    );

    sellerToken = jwt.sign(
      { sub: sellerId, stellarPublicKey: "G_SELLER_PUB" },
      process.env.JWT_SECRET!,
      { expiresIn: "1h" }
    );

    buyerToken = jwt.sign(
      { sub: buyerId, stellarPublicKey: "G_BUYER_PUB" },
      process.env.JWT_SECRET!,
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    // End pool
    await pool.end();
  });

  it("should complete a full trade lifecycle", async () => {
    // 1. Create a trade (Seller)
    const createRes = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({
        assetType: "AIRTIME",
        amount: 50,
        expiresInHours: 24,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data).toHaveProperty("id");
    expect(createRes.body.data.status).toBe("Active");
    tradeId = createRes.body.data.id;

    // 2. Buy Prepare (Buyer)
    const prepareRes = await request(app)
      .post(`/api/v1/trades/${tradeId}/buy/prepare`)
      .set("Authorization", `Bearer ${buyerToken}`);

    expect(prepareRes.status).toBe(200);
    expect(prepareRes.body.data).toHaveProperty("xdr");

    // 3. Buy (Buyer)
    const buyRes = await request(app)
      .post(`/api/v1/trades/${tradeId}/buy`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ signedXdr: "mock_signed_xdr" });

    expect(buyRes.status).toBe(200);
    expect(buyRes.body.data.status).toBe("Locked");
    expect(buyRes.body.data.buyer_id).toBe(buyerId);

    // 4. Confirm Delivery (Seller)
    const confirmRes = await request(app)
      .post(`/api/v1/trades/${tradeId}/confirm-delivery`)
      .set("Authorization", `Bearer ${sellerToken}`);

    expect(confirmRes.status).toBe(202);

    // Since verification runs asynchronously in the background, we poll the DB for Completion
    let finalStatus = "Locked";
    let attempts = 0;
    while (finalStatus !== "Completed" && attempts < 20) {
      const dbRes = await pool.query("SELECT status FROM trade_offers WHERE id = $1", [tradeId]);
      finalStatus = dbRes.rows[0].status;
      if (finalStatus === "Completed") break;
      await new Promise(r => setTimeout(r, 100)); // sleep 100ms
      attempts++;
    }

    expect(finalStatus).toBe("Completed");

    // Fetch the trade again to assert final details
    const finalTradeRes = await request(app).get(`/api/v1/trades/${tradeId}`);
    expect(finalTradeRes.status).toBe(200);
    const tradeData = finalTradeRes.body.data;
    expect(tradeData.status).toBe("Completed");
    expect(tradeData.feeAmount).toBeGreaterThan(0);
    expect(tradeData.sellerNetAmount).toBeGreaterThan(0);
  }, 10000); // increase timeout to 10s just in case
});
