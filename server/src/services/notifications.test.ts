import pool from "../db";
import logger from "../utils/logger";
import { QueueService } from "../jobs/queue";
import { NotificationService, enqueueNotification } from "./notifications";

jest.mock("../db", () => ({
  query: jest.fn(),
}));

jest.mock("../jobs/queue", () => ({
  QueueService: { enqueue: jest.fn() },
}));

const mockQuery = pool.query as jest.Mock;
const mockEnqueue = QueueService.enqueue as jest.Mock;

/** SMS bodies queued, keyed by recipient phone. */
function queuedMessages(): Record<string, string> {
  return Object.fromEntries(
    mockEnqueue.mock.calls.map(([, data]) => {
      const job = data as { phone: string; message: string };
      return [job.phone, job.message];
    })
  );
}

describe("NotificationService.notifyTradeDisputeOpened (issue #490)", () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  const seller = {
    id: "seller-1",
    phone: "+2348010000001",
    opt_out_notifications: false,
    display_handle: "@airflex_5e11",
  };
  const buyer = {
    id: "buyer-1",
    phone: "+2348010000002",
    opt_out_notifications: false,
    display_handle: "@airflex_b0b0",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, TERMII_API_KEY: "test-key", APP_BASE_URL: "https://airflex.app/" };
    mockEnqueue.mockResolvedValue("job-1");
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(logger, "info").mockImplementation(() => undefined);
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("loads both participants in one query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buyer, seller] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "buyer-1",
      counterpartyId: "seller-1",
      reason: "Not delivered",
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("WHERE id = ANY($1::uuid[])"), [
      ["buyer-1", "seller-1"],
    ]);
  });

  it("queues a job for the initiator and the counterparty, each naming the other party", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buyer, seller] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "buyer-1",
      counterpartyId: "seller-1",
      reason: "Not delivered",
    });

    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).toHaveBeenCalledWith(
      "send-notification",
      expect.objectContaining({ type: "custom", userId: "buyer-1", event: "trade_dispute_opened" })
    );
    const messages = queuedMessages();
    expect(messages[buyer.phone]).toContain("trade trd_1 with @airflex_5e11");
    expect(messages[seller.phone]).toContain("trade trd_1 with @airflex_b0b0");
    for (const text of Object.values(messages)) {
      expect(text).toContain("Reason: Not delivered.");
      expect(text).toContain("View the dispute: https://airflex.app/trades/trd_1");
      expect(text).not.toMatch(/\{\w+\}/);
    }
  });

  it("never calls Termii inline — delivery is left to the queue worker (issue #678)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buyer, seller] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "buyer-1",
      counterpartyId: "seller-1",
      reason: "Not delivered",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the fallback link text when APP_BASE_URL is not configured", async () => {
    delete process.env["APP_BASE_URL"];
    mockQuery.mockResolvedValueOnce({ rows: [buyer, seller] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "buyer-1",
      counterpartyId: "seller-1",
      reason: "Not delivered",
    });

    expect(queuedMessages()[buyer.phone]).toContain("View the dispute: open the AirFlex app");
  });

  it("falls back to a generic counterparty when the other party has no handle", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buyer, { ...seller, display_handle: null }] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "buyer-1",
      counterpartyId: "seller-1",
      reason: "Not delivered",
    });

    expect(queuedMessages()[buyer.phone]).toContain("with your trading partner");
  });

  it("notifies only the initiator when the trade has no counterparty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [seller] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "seller-1",
      counterpartyId: null,
      reason: "Buyer vanished",
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [["seller-1"]]);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(queuedMessages()[seller.phone]).toContain("with your trading partner");
  });

  it("respects opt-out for one participant while still notifying the other", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buyer, { ...seller, opt_out_notifications: true }] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "buyer-1",
      counterpartyId: "seller-1",
      reason: "Not delivered",
    });

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(Object.keys(queuedMessages())).toEqual([buyer.phone]);
  });

  it("keeps notifying the other participant when one enqueue fails", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buyer, seller] });
    mockEnqueue.mockRejectedValueOnce(new Error("redis down")).mockResolvedValueOnce("job-2");

    await expect(
      NotificationService.notifyTradeDisputeOpened({
        tradeId: "trd_1",
        initiatorId: "buyer-1",
        counterpartyId: "seller-1",
        reason: "Not delivered",
      })
    ).resolves.toBeUndefined();

    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "trade_dispute_opened" }),
      "[notifications] Failed to enqueue SMS"
    );
  });

  it("never throws when participants cannot be loaded", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));

    await expect(
      NotificationService.notifyTradeDisputeOpened({
        tradeId: "trd_1",
        initiatorId: "buyer-1",
        counterpartyId: "seller-1",
        reason: "Not delivered",
      })
    ).resolves.toBeUndefined();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("deduplicates when initiator and counterparty are the same user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [seller] });

    await NotificationService.notifyTradeDisputeOpened({
      tradeId: "trd_1",
      initiatorId: "seller-1",
      counterpartyId: "seller-1",
      reason: "Self-trade",
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [["seller-1"]]);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationService.send — queue offloading (issue #678)", () => {
  const user = { id: "user-1", phone: "+2348010000003", opt_out_notifications: false };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue("job-1");
    jest.spyOn(logger, "info").mockImplementation(() => undefined);
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the template and enqueues a validated send-notification job", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [user] });

    await NotificationService.send("user-1", "TRADE_LOCKED", { tradeId: "trd_9" });

    expect(mockEnqueue).toHaveBeenCalledWith("send-notification", {
      phone: user.phone,
      type: "custom",
      message: expect.stringContaining("Your trade trd_9 has been locked"),
      userId: "user-1",
      event: "TRADE_LOCKED",
    });
  });

  it("does not enqueue when a template variable is missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [user] });

    await expect(NotificationService.send("user-1", "TRADE_LOCKED", {})).resolves.toBeUndefined();

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "TRADE_LOCKED" }),
      "[notifications] Failed to render notification template"
    );
  });

  it("does not enqueue when the user is not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await NotificationService.send("ghost", "TRADE_LOCKED", { tradeId: "trd_9" });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number via the Zod schema instead of enqueueing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...user, phone: "not-a-phone" }] });

    await NotificationService.send("user-1", "TRADE_LOCKED", { tradeId: "trd_9" });

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "[notifications] Invalid notification payload — not enqueued"
    );
  });

  it("enqueueNotification returns null for a custom job without a message", async () => {
    await expect(enqueueNotification({ phone: "+2348010000003", type: "custom" })).resolves.toBeNull();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("enqueueNotification returns the job id for a valid payload", async () => {
    await expect(
      enqueueNotification({ phone: "08010000003", type: "trade_locked", vars: { tradeId: "t" } })
    ).resolves.toBe("job-1");
  });
});
