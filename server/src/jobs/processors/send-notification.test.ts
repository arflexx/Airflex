import logger from "../../utils/logger";
import type { Job } from "../queue";
import {
  isTransientStatus,
  sendNotificationProcessor,
  TERMII_SMS_URL,
  type SendNotificationData,
} from "./send-notification";

function makeJob(data: Partial<SendNotificationData> = {}, attempts = 1): Job<SendNotificationData> {
  return {
    id: "job-1",
    queue: "send-notification",
    data: { phone: "+2348010000001", type: "custom", message: "Hello", ...data } as SendNotificationData,
    attempts,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    nextRunAt: 0,
  };
}

describe("sendNotificationProcessor (issue #678)", () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, TERMII_API_KEY: "test-key" };
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    jest.spyOn(logger, "info").mockImplementation(() => undefined);
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
    jest.spyOn(logger, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("sends the message to Termii", async () => {
    await sendNotificationProcessor(makeJob({ message: "Trade locked" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TERMII_SMS_URL);
    expect(JSON.parse(init.body as string)).toMatchObject({
      api_key: "test-key",
      to: "+2348010000001",
      sms: "Trade locked",
    });
  });

  it("renders a built-in template when no message override is given", async () => {
    await sendNotificationProcessor(
      makeJob({ type: "trade_locked", message: undefined, vars: { tradeId: "trd_1" } })
    );

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.sms).toContain("Your trade (trd_1) has been locked");
  });

  it.each([500, 502, 503, 429, 408])("throws on transient HTTP %i so the queue retries", async (status) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => "busy" });

    await expect(sendNotificationProcessor(makeJob())).rejects.toThrow(`Termii SMS API error ${status}`);
  });

  it("throws on a network error / timeout so the queue retries", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(sendNotificationProcessor(makeJob())).rejects.toThrow("Termii request failed: socket hang up");
  });

  it.each([400, 401, 422])("does not retry a permanent HTTP %i response", async (status) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => "bad request" });

    await expect(sendNotificationProcessor(makeJob())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1" }),
      "[send-notification] Permanent Termii failure — not retrying"
    );
  });

  it("drops an invalid payload without calling Termii or retrying", async () => {
    await expect(sendNotificationProcessor(makeJob({ phone: "abc" }))).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1" }),
      "[send-notification] Invalid job payload — dropping without retry"
    );
  });

  it("throws (and is retried) when TERMII_API_KEY is missing", async () => {
    delete process.env["TERMII_API_KEY"];

    await expect(sendNotificationProcessor(makeJob())).rejects.toThrow("TERMII_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies statuses", () => {
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(404)).toBe(false);
  });
});
