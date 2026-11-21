/**
 * trades.tracing.test.ts
 *
 * OpenTelemetry spans for the trade lifecycle (issue #482). A real tracer
 * provider with an in-memory exporter is registered in place of the OTLP
 * one, so the test sees exactly the spans that would be exported: their
 * names, `trade_id` / `user_id` / `status` attributes, recorded exceptions
 * and parent/child links.
 *
 * The database and the Stellar service are mocked, as in trades.create.test.ts.
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
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import app from "../index";
import pool from "../db";
import { createListing, submitSignedTransaction } from "../services/stellar";

const mockQuery = pool.query as jest.Mock;
const mockCreateListing = createListing as jest.Mock;
const mockSubmitSignedTransaction = submitSignedTransaction as jest.Mock;

const BUYER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
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

function tradeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRADE_ID,
    seller_id: SELLER_ID,
    buyer_id: BUYER_ID,
    asset_type: "MTN_AIRTIME",
    amount: "500.00",
    fee_amount: null,
    seller_net_amount: null,
    status: "Locked",
    contract_listing_id: "listing-1",
    escrow_tx_hash: "tx-1",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  exporter.reset();
});

function finishedSpan(name: string) {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  expect(span).toBeDefined();
  return span!;
}

describe("trade lifecycle spans (issue #482)", () => {
  it("records a dispute span with trade_id, user_id and the resulting status", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ token_version: 1 }] }) // authenticate
      .mockResolvedValueOnce({ rows: [tradeRow()] }) // load trade
      .mockResolvedValueOnce({ rows: [tradeRow({ status: "Disputed" })] }); // UPDATE

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/dispute`)
      .set("Authorization", `Bearer ${makeJwt(BUYER_ID)}`)
      .send({ reason: "Airtime was never delivered to my number" });

    expect(res.status).toBe(200);

    const span = finishedSpan("trade.dispute");
    expect(span.attributes).toMatchObject({
      "trade.stage": "dispute",
      trade_id: TRADE_ID,
      user_id: BUYER_ID,
      status: "Disputed",
      "http.response.status_code": 200,
    });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.events.map((e) => e.name)).not.toContain("trade.rejected");
  });

  it("correlates the stage span with the request id and sets dotted domain attributes", async () => {
    const requestId = "4f3c2b1a-0000-4000-8000-00000000abcd";
    mockQuery
      .mockResolvedValueOnce({ rows: [{ token_version: 1 }] }) // authenticate
      .mockResolvedValueOnce({ rows: [tradeRow()] }) // load trade
      .mockResolvedValueOnce({ rows: [tradeRow({ status: "Disputed" })] }); // UPDATE

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/dispute`)
      .set("Authorization", `Bearer ${makeJwt(BUYER_ID)}`)
      .set("X-Request-Id", requestId)
      .send({ reason: "Airtime was never delivered to my number" });

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe(requestId);

    expect(finishedSpan("trade.dispute").attributes).toMatchObject({
      "request.id": requestId,
      "trade.id": TRADE_ID,
      "user.id": BUYER_ID,
      "trade.status": "Disputed",
    });
  });

  it("marks a dispute the route rejects with a trade.rejected event", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ token_version: 1 }] })
      .mockResolvedValueOnce({ rows: [] }); // trade not found

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/dispute`)
      .set("Authorization", `Bearer ${makeJwt(BUYER_ID)}`)
      .send({ reason: "Airtime was never delivered to my number" });

    expect(res.status).toBe(404);

    const span = finishedSpan("trade.dispute");
    expect(span.attributes["http.response.status_code"]).toBe(404);
    expect(span.events.map((e) => e.name)).toContain("trade.rejected");
  });

  it("records the escrow submission as a child of the fund span", async () => {
    mockSubmitSignedTransaction.mockResolvedValueOnce("tx-hash-1");
    mockQuery
      .mockResolvedValueOnce({ rows: [{ token_version: 1 }] })
      .mockResolvedValueOnce({ rows: [tradeRow({ status: "Active", buyer_id: null })] })
      .mockResolvedValueOnce({ rows: [tradeRow({ status: "Locked" })] });

    const res = await request(app)
      .post(`/api/v1/trades/${TRADE_ID}/buy`)
      .set("Authorization", `Bearer ${makeJwt(BUYER_ID)}`)
      .send({ signedXdr: "A".repeat(120) });

    expect(res.status).toBe(200);

    const fund = finishedSpan("trade.fund");
    const submit = finishedSpan("trade.fund.submit_escrow_deposit");

    expect(fund.attributes).toMatchObject({
      trade_id: TRADE_ID,
      user_id: BUYER_ID,
      status: "Locked",
    });
    expect(submit.spanContext().traceId).toBe(fund.spanContext().traceId);
    expect(submit.parentSpanId).toBe(fund.spanContext().spanId);
  });

  it("records a failed contract call as an exception on the create span and its child", async () => {
    mockCreateListing.mockRejectedValueOnce(new Error("Soroban RPC unavailable"));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ token_version: 1 }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: "verified" }] })
      .mockResolvedValueOnce({ rows: [{ stellar_secret_key: "S" + "A".repeat(55) }] });

    const res = await request(app)
      .post("/api/v1/trades")
      .set("Authorization", `Bearer ${makeJwt(SELLER_ID)}`)
      .send({ assetType: "MTN_AIRTIME", amount: 500_000_000, expiresInHours: 24 });

    expect(res.status).toBeGreaterThanOrEqual(500);

    const create = finishedSpan("trade.create");
    const listing = finishedSpan("trade.create.contract_listing");

    expect(create.attributes).toMatchObject({ "trade.stage": "create", user_id: SELLER_ID });
    expect(listing.parentSpanId).toBe(create.spanContext().spanId);

    for (const span of [create, listing]) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      const exception = span.events.find((e) => e.name === "exception");
      expect(exception?.attributes?.["exception.message"]).toBe("Soroban RPC unavailable");
    }
  });
});
