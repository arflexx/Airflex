/**
 * trades.notifications.test.ts — issue #678
 *
 * Trade state-change routes must hand notifications to the BullMQ-style
 * `send-notification` queue and respond without waiting on SMS delivery.
 * Exercised through POST /api/v1/trades/:id/buy — the buyer accepting a
 * listing, which locks the trade and notifies the seller.
 *
 * NotificationService is deliberately NOT mocked: the real service runs, and
 * the queue (QueueService.enqueue) and Termii (global fetch) are observed.
 */

process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] =
  "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] =
  "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env["PLATFORM_TREASURY_USER_ID"] = "00000000-0000-0000-0000-000000000001";
process.env["TERMII_API_KEY"] = "test-termii-key";

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
  VerificationError: class VerificationError extends Error {},
}));

jest.mock("../jobs/queue", () => ({
  QueueService: { enqueue: jest.fn(), getStats: jest.fn(() => []) },
}));

import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../index";
import pool from "../db";
import { QueueService } from "../jobs/queue";
import { submitSignedTransaction } from "../services/stellar";

const mockQuery = pool.query as jest.Mock;
const mockEnqueue = QueueService.enqueue as jest.Mock;
const mockSubmit = submitSignedTransaction as jest.Mock;

const BUYER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SELLER_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TRADE_ID = "cccccccc-0000-0000-0000-000000000003";
const SELLER_PHONE = "+2348010000009";
const SIGNED_XDR = "A".repeat(120);

const buyerToken = jwt.sign(
  { sub: BUYER_ID, stellarPublicKey: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" },
  process.env["JWT_SECRET"]!,
  { expiresIn: "1h" }
);

const activeTrade = {
  id: TRADE_ID,
  seller_id: SELLER_ID,
  buyer_id: null,
  status: "Active",
  asset_type: "MTN_AIRTIME",
  amount: 500,
  contract_listing_id: "listing-1",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/**
 * Routes each SQL statement to a canned response. `notificationTarget` is the
 * response for the NotificationService recipient lookup, so a test can make it
 * hang to prove the route does not wait on it.
 */
function wireQueries(notificationTarget: () => Promise<unknown>) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT token_version")) return { rows: [{ token_version: 1 }] };
    if (sql.includes("SELECT * FROM trade_offers")) return { rows: [activeTrade] };
    if (sql.includes("UPDATE trade_offers")) {
      return { rows: [{ ...activeTrade, status: "Locked", buyer_id: BUYER_ID }] };
    }
    if (sql.includes("opt_out_notifications")) return notificationTarget();
    return { rows: [] };
  });
}

/** Lets fire-and-forget promises chained off the request settle. */
async function flushBackgroundWork(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function buy() {
  return request(app)
    .post(`/api/v1/trades/${TRADE_ID}/buy`)
    .set("Authorization", `Bearer ${buyerToken}`)
    .send({ signedXdr: SIGNED_XDR });
}

describe("POST /api/v1/trades/:id/buy — notification offloading (issue #678)", () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSubmit.mockResolvedValue("tx-hash-1");
    mockEnqueue.mockResolvedValue("job-1");
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("enqueues a send-notification job for the seller and never calls Termii synchronously", async () => {
    wireQueries(async () => ({
      rows: [{ id: SELLER_ID, phone: SELLER_PHONE, opt_out_notifications: false }],
    }));

    const res = await buy();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("Locked");

    await flushBackgroundWork();

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      "send-notification",
      expect.objectContaining({
        phone: SELLER_PHONE,
        type: "custom",
        userId: SELLER_ID,
        event: "TRADE_LOCKED",
        message: expect.stringContaining(TRADE_ID),
      })
    );
    // Termii is only called by the queue worker, never from the request path.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("responds without waiting for the notification to be resolved or queued", async () => {
    // The recipient lookup never settles — if the route awaited the
    // notification, this request would hang and the test would time out.
    wireQueries(() => new Promise(() => undefined));

    const res = await buy();

    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still succeeds when the queue is unavailable", async () => {
    wireQueries(async () => ({
      rows: [{ id: SELLER_ID, phone: SELLER_PHONE, opt_out_notifications: false }],
    }));
    mockEnqueue.mockRejectedValue(new Error("redis down"));

    const res = await buy();
    await flushBackgroundWork();

    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
