/**
 * Integration tests for Paystack webhook handling (issue #536).
 *
 * Exercises the full path a real webhook takes:
 *   signed HTTP POST → routes/webhooks.ts (HMAC-SHA512 check, persist, enqueue)
 *   → jobs/processors/process-paystack-webhook.ts
 *   → services/paystackWebhookHandlers.ts
 * against an in-memory database that implements the SQL those modules issue,
 * including transactions and the payment_events (provider, reference) unique
 * constraint that makes deliveries idempotent.
 */
import crypto from "crypto";
import express from "express";
import request from "supertest";

import webhooksRouter, { signatureMatches } from "../routes/webhooks";
import { QueueService } from "../jobs";
import { processPaystackWebhookProcessor } from "../jobs/processors/process-paystack-webhook";
import {
  applyChargeSuccess,
  applyDVAAssigned,
  applyTransferEvent,
  type PaystackWebhookEvent,
} from "../services/paystackWebhookHandlers";
import { NotificationService } from "../services/notifications";
import type { Job } from "../jobs/queue";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// The pool delegates lazily so the factory can run before mockDb is initialised.
jest.mock("../db/pool", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => mockDb.query(sql, params),
    connect: () => mockDb.connect(),
  },
}));

jest.mock("../jobs", () => ({
  QueueService: { enqueue: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../services/notifications", () => ({
  NotificationService: {
    send: jest.fn().mockResolvedValue(undefined),
    sendToMany: jest.fn().mockResolvedValue(undefined),
    sendToAdmins: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/sseEmitter", () => ({
  SseEmitter: { emit: jest.fn(), emitAll: jest.fn() },
}));

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

interface Tables {
  users: Array<{ id: string; phone: string | null; virtual_account_number: string | null; balance?: number }>;
  wallets: Array<{ user_id: string; fiat_balance: number }>;
  transactions: Array<{
    user_id: string;
    trade_id: string | null;
    amount: number;
    direction: string;
    type: string;
    external_reference: string | null;
  }>;
  payment_events: Array<{
    id: string;
    provider: string;
    event_type: string;
    reference: string;
    payload: unknown;
    status: string;
    user_id: string | null;
  }>;
  webhook_events: Array<{ id: string; event_type: string; payload: unknown; status: string }>;
  withdrawals: Array<{
    id: string;
    user_id: string;
    reference: string;
    amount: string;
    status: string;
    failure_reason: string | null;
  }>;
}

function emptyTables(): Tables {
  return {
    users: [],
    wallets: [],
    transactions: [],
    payment_events: [],
    webhook_events: [],
    withdrawals: [],
  };
}

/**
 * Pattern-matches the exact statements issued by the webhook route, processor,
 * handlers, WalletService and withdrawal processor. Unknown SQL throws so the
 * suite fails loudly if a handler starts issuing a query this fake can't model.
 */
class InMemoryDb {
  tables: Tables = emptyTables();
  /** Next statement matching this pattern throws (once), to simulate DB failure. */
  failNext: RegExp | null = null;
  private seq = 0;

  reset(): void {
    this.tables = emptyTables();
    this.failNext = null;
    this.seq = 0;
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
    release: () => void;
  }> {
    let snapshot: Tables | null = null;
    return {
      query: async (sql: string, params?: unknown[]) => {
        const stmt = normalize(sql);
        if (stmt === "BEGIN") {
          snapshot = structuredClone(this.tables);
          return { rows: [], rowCount: 0 };
        }
        if (stmt === "COMMIT") {
          snapshot = null;
          return { rows: [], rowCount: 0 };
        }
        if (stmt === "ROLLBACK") {
          if (snapshot) this.tables = snapshot;
          snapshot = null;
          return { rows: [], rowCount: 0 };
        }
        return this.query(sql, params);
      },
      release: () => undefined,
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const stmt = normalize(sql);
    const t = this.tables;
    const p = params;

    if (this.failNext?.test(stmt)) {
      this.failNext = null;
      throw new Error("simulated database failure");
    }

    if (stmt.startsWith("INSERT INTO webhook_events")) {
      const row = {
        id: this.nextId("whe"),
        event_type: p[0] as string,
        payload: JSON.parse(p[1] as string) as unknown,
        status: "pending",
      };
      t.webhook_events.push(row);
      return result([{ id: row.id }]);
    }

    if (stmt.startsWith("SELECT id, status, payload FROM webhook_events")) {
      return result(t.webhook_events.filter((r) => r.id === p[0]).slice(0, 1));
    }

    if (stmt.startsWith("UPDATE webhook_events SET status = $2")) {
      const rows = t.webhook_events.filter((r) => r.id === p[0]);
      rows.forEach((r) => (r.status = p[1] as string));
      return result([], rows.length);
    }

    if (stmt.startsWith("INSERT INTO payment_events")) {
      // ON CONFLICT (provider, reference) DO NOTHING
      if (t.payment_events.some((r) => r.provider === "paystack" && r.reference === p[1])) {
        return result([]);
      }
      const row = {
        id: this.nextId("pe"),
        provider: "paystack",
        event_type: p[0] as string,
        reference: p[1] as string,
        payload: JSON.parse(p[2] as string) as unknown,
        status: "processing",
        user_id: null,
      };
      t.payment_events.push(row);
      return result([{ id: row.id }]);
    }

    if (stmt.startsWith("UPDATE payment_events SET status = 'unmatched'")) {
      const rows = t.payment_events.filter((r) => r.reference === p[0]);
      rows.forEach((r) => (r.status = "unmatched"));
      return result([], rows.length);
    }

    if (stmt.startsWith("UPDATE payment_events SET status = 'processed'")) {
      const rows = t.payment_events.filter((r) => r.reference === p[0]);
      rows.forEach((r) => {
        r.status = "processed";
        r.user_id = p[1] as string;
      });
      return result([], rows.length);
    }

    if (stmt.startsWith("SELECT id FROM users WHERE ($1::uuid IS NOT NULL")) {
      const [userId, phone] = p as [string | null, string | null];
      const user = t.users.find(
        (u) => (userId !== null && u.id === userId) || (phone !== null && u.phone === phone)
      );
      return result(user ? [{ id: user.id }] : []);
    }

    if (stmt.startsWith("SELECT id FROM users WHERE virtual_account_number = $1")) {
      const user = t.users.find((u) => u.virtual_account_number === p[0]);
      return result(user ? [{ id: user.id }] : []);
    }

    if (stmt.startsWith("INSERT INTO transactions (user_id, trade_id, amount, direction, type, external_reference)")) {
      t.transactions.push({
        user_id: p[0] as string,
        trade_id: p[1] as string | null,
        amount: p[2] as number,
        direction: p[3] as string,
        type: p[4] as string,
        external_reference: p[5] as string | null,
      });
      return result([], 1);
    }

    if (stmt.startsWith("UPDATE users SET balance = balance + $1 WHERE id = $2")) {
      const rows = t.users.filter((u) => u.id === p[1]);
      rows.forEach((u) => (u.balance = (u.balance ?? 0) + Number(p[0])));
      return result([], rows.length);
    }

    if (stmt.startsWith("UPDATE wallets SET fiat_balance = fiat_balance + $1")) {
      const rows = t.wallets.filter((w) => w.user_id === p[1]);
      rows.forEach((w) => (w.fiat_balance += Number(p[0])));
      return result([], rows.length);
    }

    if (stmt.startsWith("UPDATE withdrawals SET status = 'completed'")) {
      const rows = t.withdrawals.filter((w) => w.reference === p[0] && w.status === "processing");
      rows.forEach((w) => (w.status = "completed"));
      return result(rows.map(({ id, user_id, amount }) => ({ id, user_id, amount })));
    }

    if (stmt.startsWith("UPDATE withdrawals SET status = 'failed'")) {
      const rows = t.withdrawals.filter(
        (w) => w.reference === p[0] && (w.status === "pending" || w.status === "processing")
      );
      rows.forEach((w) => {
        w.status = "failed";
        w.failure_reason = p[1] as string;
      });
      return result(rows.map(({ id, user_id, amount }) => ({ id, user_id, amount })));
    }

    throw new Error(`InMemoryDb: unsupported SQL: ${stmt}`);
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function result<T extends Record<string, unknown>>(rows: T[], rowCount = rows.length): QueryResult {
  return { rows, rowCount };
}

const mockDb = new InMemoryDb();

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const SECRET = "sk_test_webhook_secret_0123456789abcdef";
const USER_ID = "8f14e45f-ceea-467a-9575-6b2f3c9d1a01";
const USER_PHONE = "+2348012345678";
const DVA_ACCOUNT = "9930000123";

const enqueue = QueueService.enqueue as jest.Mock;

function buildApp(): express.Express {
  const app = express();
  // Same verify hook as src/index.ts: keep the raw bytes for the HMAC check.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use("/api/v1/webhooks", webhooksRouter);
  return app;
}

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

function chargeSuccess(
  reference: string,
  amountKobo = 500_000,
  overrides: Partial<PaystackWebhookEvent["data"]> = {}
): PaystackWebhookEvent {
  return {
    event: "charge.success",
    data: {
      reference,
      amount: amountKobo,
      currency: "NGN",
      status: "success",
      customer: { email: "buyer@example.com", phone: USER_PHONE },
      metadata: { user_id: USER_ID },
      ...overrides,
    },
  };
}

function job(webhookEventId: string, attempts = 1, maxAttempts = 3): Job<{ webhookEventId: string }> {
  return {
    id: `job-${webhookEventId}`,
    queue: "process-paystack-webhook",
    data: { webhookEventId },
    attempts,
    maxAttempts,
    createdAt: new Date().toISOString(),
    nextRunAt: 0,
  };
}

/** The route persists and enqueues after responding; wait for that to happen. */
async function waitForEnqueueCount(count: number): Promise<void> {
  for (let i = 0; i < 50 && enqueue.mock.calls.length < count; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(enqueue).toHaveBeenCalledTimes(count);
}

/**
 * POSTs a correctly signed webhook, waits for it to be enqueued, then runs the
 * queued job through the real processor — i.e. one complete delivery.
 */
async function deliver(app: express.Express, event: PaystackWebhookEvent): Promise<void> {
  const body = JSON.stringify(event);
  const before = enqueue.mock.calls.length;

  const res = await request(app)
    .post("/api/v1/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set("X-Paystack-Signature", sign(body))
    .send(body);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });

  await waitForEnqueueCount(before + 1);
  const [queue, data] = enqueue.mock.calls[before] as [string, { webhookEventId: string }];
  expect(queue).toBe("process-paystack-webhook");
  await processPaystackWebhookProcessor(job(data.webhookEventId));
}

function balanceOf(userId: string): number {
  return mockDb.tables.wallets.find((w) => w.user_id === userId)!.fiat_balance;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let app: express.Express;
const originalSecret = process.env["PAYSTACK_SECRET_KEY"];

beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  process.env["PAYSTACK_SECRET_KEY"] = SECRET;
  mockDb.reset();
  mockDb.tables.users.push({ id: USER_ID, phone: USER_PHONE, virtual_account_number: DVA_ACCOUNT });
  mockDb.tables.wallets.push({ user_id: USER_ID, fiat_balance: 1_000 });
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env["PAYSTACK_SECRET_KEY"];
  else process.env["PAYSTACK_SECRET_KEY"] = originalSecret;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Paystack webhooks (integration)", () => {
  describe("HMAC-SHA512 signature verification", () => {
    it("accepts a payload signed with the secret key, persists it and enqueues processing", async () => {
      const body = JSON.stringify(chargeSuccess("ref_valid"));

      const res = await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", sign(body))
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      await waitForEnqueueCount(1);
      expect(mockDb.tables.webhook_events).toHaveLength(1);
      expect(mockDb.tables.webhook_events[0]).toMatchObject({
        event_type: "charge.success",
        status: "pending",
        payload: JSON.parse(body),
      });
      expect(enqueue).toHaveBeenCalledWith("process-paystack-webhook", {
        webhookEventId: mockDb.tables.webhook_events[0]!.id,
      });
    });

    it("verifies against the raw bytes, not a re-serialised body", async () => {
      // Unusual key order and whitespace: re-serialising would change the HMAC.
      const body = `{ "data": {"amount":500000,  "reference":"ref_raw"}, "event":"charge.success" }`;

      const res = await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", sign(body))
        .send(body);

      expect(res.status).toBe(200);
      await waitForEnqueueCount(1);
    });

    const forgedSignatures: Array<[string, (body: string) => string]> = [
      ["signed with the wrong secret", (body) => sign(body, "sk_test_attacker")],
      ["computed over a different body", () => sign(JSON.stringify(chargeSuccess("ref_other")))],
      ["using SHA-256 instead of SHA-512", (body) =>
        crypto.createHmac("sha256", SECRET).update(body).digest("hex")],
      ["truncated", (body) => sign(body).slice(0, 64)],
      ["garbage", () => "not-a-signature"],
      ["upper-cased hex", (body) => sign(body).toUpperCase()],
    ];

    it.each(forgedSignatures)("rejects a signature %s with 401 and processes nothing", async (_label, makeSignature) => {
      const body = JSON.stringify(chargeSuccess("ref_forged", 99_900_000));

      const res = await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", makeSignature(body))
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid signature" });

      await new Promise((resolve) => setImmediate(resolve));
      expect(mockDb.tables.webhook_events).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
      expect(balanceOf(USER_ID)).toBe(1_000);
    });

    it("rejects a body tampered with after signing with 401", async () => {
      const original = JSON.stringify(chargeSuccess("ref_tamper", 100));
      const tampered = original.replace('"amount":100', '"amount":100000000');

      const res = await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", sign(original))
        .send(tampered);

      expect(res.status).toBe(401);
      expect(mockDb.tables.webhook_events).toHaveLength(0);
    });

    it("returns 400 when the signature header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .send(JSON.stringify(chargeSuccess("ref_nosig")));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Missing x-paystack-signature header" });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("returns 500 without processing when PAYSTACK_SECRET_KEY is not configured", async () => {
      delete process.env["PAYSTACK_SECRET_KEY"];
      const body = JSON.stringify(chargeSuccess("ref_nosecret"));

      const res = await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", sign(body))
        .send(body);

      expect(res.status).toBe(500);
      expect(enqueue).not.toHaveBeenCalled();
    });

    describe("signatureMatches", () => {
      it("is true only for identical strings", () => {
        const sig = sign("payload");
        expect(signatureMatches(sig, sig)).toBe(true);
        expect(signatureMatches(sig, sign("other"))).toBe(false);
      });

      it("returns false (instead of throwing) on a length mismatch", () => {
        expect(() => signatureMatches(sign("payload"), "short")).not.toThrow();
        expect(signatureMatches(sign("payload"), "short")).toBe(false);
      });
    });
  });

  describe("charge.success", () => {
    it("credits the matched user's wallet and records the deposit", async () => {
      await deliver(app, chargeSuccess("ref_charge_1", 250_000));

      expect(balanceOf(USER_ID)).toBe(1_000 + 2_500);
      expect(mockDb.tables.transactions).toEqual([
        {
          user_id: USER_ID,
          trade_id: null,
          amount: 2_500,
          direction: "credit",
          type: "deposit",
          external_reference: "ref_charge_1",
        },
      ]);
      expect(mockDb.tables.payment_events).toEqual([
        expect.objectContaining({
          reference: "ref_charge_1",
          event_type: "charge.success",
          status: "processed",
          user_id: USER_ID,
        }),
      ]);
      expect(mockDb.tables.webhook_events[0]!.status).toBe("processed");
    });

    it("matches the user by phone when metadata has no user_id", async () => {
      await deliver(app, chargeSuccess("ref_phone", 100_000, { metadata: {} }));

      expect(balanceOf(USER_ID)).toBe(2_000);
    });

    it("marks the payment unmatched and credits nobody when no user matches", async () => {
      const event = chargeSuccess("ref_unmatched", 100_000, {
        metadata: { user_id: "00000000-0000-4000-8000-000000000999" },
        customer: { phone: "+2340000000000" },
      });

      await expect(applyChargeSuccess(event)).resolves.toBe("unmatched");
      expect(balanceOf(USER_ID)).toBe(1_000);
      expect(mockDb.tables.transactions).toHaveLength(0);
      expect(mockDb.tables.payment_events[0]!.status).toBe("unmatched");
    });

    it("rolls back on failure so a retry credits exactly once", async () => {
      const event = chargeSuccess("ref_retry", 100_000);
      mockDb.failNext = /^UPDATE wallets/;

      await expect(applyChargeSuccess(event)).rejects.toThrow("simulated database failure");
      expect(balanceOf(USER_ID)).toBe(1_000);
      expect(mockDb.tables.transactions).toHaveLength(0);
      expect(mockDb.tables.payment_events).toHaveLength(0);

      await expect(applyChargeSuccess(event)).resolves.toBe("credited");
      expect(balanceOf(USER_ID)).toBe(2_000);
    });

    it("leaves the webhook pending and rethrows so the queue retries a failed attempt", async () => {
      await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", sign(JSON.stringify(chargeSuccess("ref_job_retry"))))
        .send(JSON.stringify(chargeSuccess("ref_job_retry")));
      await waitForEnqueueCount(1);
      const { webhookEventId } = enqueue.mock.calls[0]![1] as { webhookEventId: string };

      mockDb.failNext = /^UPDATE wallets/;
      await expect(processPaystackWebhookProcessor(job(webhookEventId, 1))).rejects.toThrow();
      expect(mockDb.tables.webhook_events[0]!.status).toBe("pending");
      expect(NotificationService.sendToAdmins).not.toHaveBeenCalled();

      await processPaystackWebhookProcessor(job(webhookEventId, 2));
      expect(mockDb.tables.webhook_events[0]!.status).toBe("processed");
      expect(balanceOf(USER_ID)).toBe(1_000 + 5_000);
    });

    it("marks the webhook failed and alerts admins once retries are exhausted", async () => {
      await request(app)
        .post("/api/v1/webhooks/paystack")
        .set("Content-Type", "application/json")
        .set("X-Paystack-Signature", sign(JSON.stringify(chargeSuccess("ref_exhaust"))))
        .send(JSON.stringify(chargeSuccess("ref_exhaust")));
      await waitForEnqueueCount(1);
      const { webhookEventId } = enqueue.mock.calls[0]![1] as { webhookEventId: string };

      mockDb.failNext = /^UPDATE wallets/;
      await expect(processPaystackWebhookProcessor(job(webhookEventId, 3, 3))).rejects.toThrow();

      expect(mockDb.tables.webhook_events[0]!.status).toBe("failed");
      expect(NotificationService.sendToAdmins).toHaveBeenCalledWith("WEBHOOK_FAILED", {
        eventId: webhookEventId,
        eventType: "charge.success",
      });
    });
  });

  describe("unknown event types", () => {
    it.each(["subscription.create", "invoice.update", "customeridentification.success", ""])(
      "acknowledges %p with 200 and completes processing without side effects",
      async (eventType) => {
        const event = { event: eventType, data: { reference: "ref_unknown", amount: 1 } };

        await expect(deliver(app, event)).resolves.toBeUndefined();

        expect(mockDb.tables.webhook_events[0]!.status).toBe("processed");
        expect(mockDb.tables.payment_events).toHaveLength(0);
        expect(mockDb.tables.transactions).toHaveLength(0);
        expect(balanceOf(USER_ID)).toBe(1_000);
      }
    );

    it("applyTransferEvent ignores non-transfer events without throwing", async () => {
      await expect(applyTransferEvent(chargeSuccess("ref_not_transfer"))).resolves.toBeUndefined();
    });
  });

  describe("idempotent duplicate delivery", () => {
    it("credits once when Paystack redelivers the same charge.success", async () => {
      const event = chargeSuccess("ref_dup", 300_000);

      await deliver(app, event);
      await deliver(app, event);
      await deliver(app, event);

      // Every delivery is acknowledged and recorded...
      expect(mockDb.tables.webhook_events).toHaveLength(3);
      expect(mockDb.tables.webhook_events.every((r) => r.status === "processed")).toBe(true);
      // ...but the money moves only once.
      expect(balanceOf(USER_ID)).toBe(1_000 + 3_000);
      expect(mockDb.tables.transactions).toHaveLength(1);
      expect(mockDb.tables.payment_events).toHaveLength(1);
    });

    it("reports the redelivery as a duplicate", async () => {
      const event = chargeSuccess("ref_dup_direct", 100_000);

      await expect(applyChargeSuccess(event)).resolves.toBe("credited");
      await expect(applyChargeSuccess(event)).resolves.toBe("duplicate");
      expect(balanceOf(USER_ID)).toBe(2_000);
    });

    it("credits once under concurrent duplicate deliveries", async () => {
      const event = chargeSuccess("ref_dup_concurrent", 100_000);

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => applyChargeSuccess(event))
      );

      expect(outcomes.filter((o) => o === "credited")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(4);
      expect(balanceOf(USER_ID)).toBe(2_000);
    });

    it("skips a webhook_events row that was already processed (job replay)", async () => {
      await deliver(app, chargeSuccess("ref_job_replay", 100_000));
      const { webhookEventId } = enqueue.mock.calls[0]![1] as { webhookEventId: string };

      await processPaystackWebhookProcessor(job(webhookEventId, 2));

      expect(balanceOf(USER_ID)).toBe(2_000);
    });

    it("treats different references as distinct payments", async () => {
      await deliver(app, chargeSuccess("ref_a", 100_000));
      await deliver(app, chargeSuccess("ref_b", 100_000));

      expect(balanceOf(USER_ID)).toBe(3_000);
      expect(mockDb.tables.transactions).toHaveLength(2);
    });

    it("throws when the queued webhook event no longer exists", async () => {
      await expect(processPaystackWebhookProcessor(job("whe-missing"))).rejects.toThrow(
        "Webhook event whe-missing not found"
      );
    });
  });

  describe("dedicatedaccount.assign.success", () => {
    function dvaEvent(reference: string, accountNumber?: string): PaystackWebhookEvent {
      return {
        event: "dedicatedaccount.assign.success",
        data: {
          reference,
          amount: 750_000,
          ...(accountNumber ? { dedicated_account: { account_number: accountNumber } } : {}),
        },
      };
    }

    it("credits the user owning the virtual account, once per reference", async () => {
      await deliver(app, dvaEvent("ref_dva", DVA_ACCOUNT));
      await deliver(app, dvaEvent("ref_dva", DVA_ACCOUNT));

      expect(balanceOf(USER_ID)).toBe(1_000 + 7_500);
      expect(mockDb.tables.transactions).toEqual([
        expect.objectContaining({ type: "deposit", amount: 7_500, external_reference: "ref_dva" }),
      ]);
      await expect(applyDVAAssigned(dvaEvent("ref_dva", DVA_ACCOUNT))).resolves.toBe("duplicate");
    });

    it("falls back to data.account_number", async () => {
      const event = dvaEvent("ref_dva_fallback");
      event.data.account_number = DVA_ACCOUNT;

      await expect(applyDVAAssigned(event)).resolves.toBe("credited");
    });

    it.each([
      ["no account number", undefined],
      ["an unknown account number", "0000000000"],
    ])("marks the payment unmatched for %s", async (_label, account) => {
      await expect(applyDVAAssigned(dvaEvent("ref_dva_unmatched", account))).resolves.toBe(
        "unmatched"
      );
      expect(balanceOf(USER_ID)).toBe(1_000);
      expect(mockDb.tables.payment_events[0]!.status).toBe("unmatched");
    });
  });

  describe("transfer events", () => {
    beforeEach(() => {
      mockDb.tables.withdrawals.push({
        id: "wd-1",
        user_id: USER_ID,
        reference: "wd_ref_1",
        amount: "2500.00",
        status: "processing",
        failure_reason: null,
      });
    });

    function transferEvent(event: string, reason?: string): PaystackWebhookEvent {
      return {
        event,
        data: { reference: "wd_ref_1", amount: 250_000, ...(reason ? { reason } : {}) },
      } as PaystackWebhookEvent;
    }

    it("transfer.success completes the withdrawal and notifies once across redeliveries", async () => {
      await deliver(app, transferEvent("transfer.success"));
      await deliver(app, transferEvent("transfer.success"));

      expect(mockDb.tables.withdrawals[0]!.status).toBe("completed");
      expect(NotificationService.send).toHaveBeenCalledTimes(1);
      expect(NotificationService.send).toHaveBeenCalledWith(USER_ID, "WITHDRAWAL_PROCESSED", {
        amount: 2500,
      });
    });

    it("transfer.failed restores the balance exactly once across redeliveries", async () => {
      await deliver(app, transferEvent("transfer.failed", "Account resolution failed"));
      await deliver(app, transferEvent("transfer.failed", "Account resolution failed"));

      expect(mockDb.tables.withdrawals[0]).toMatchObject({
        status: "failed",
        failure_reason: "Account resolution failed",
      });
      expect(balanceOf(USER_ID)).toBe(1_000 + 2_500);
      expect(NotificationService.send).toHaveBeenCalledTimes(1);
    });

    it("transfer.reversed falls back to the event type as the failure reason", async () => {
      await deliver(app, transferEvent("transfer.reversed"));

      expect(mockDb.tables.withdrawals[0]!.failure_reason).toBe("transfer.reversed");
      expect(balanceOf(USER_ID)).toBe(3_500);
    });
  });
});
