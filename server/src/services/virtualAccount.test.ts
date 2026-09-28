/**
 * virtualAccount.test.ts
 *
 * Verifies that Paystack HTTP calls are bounded by an AbortController timeout
 * and surface a descriptive PaystackTimeoutError instead of hanging forever.
 */

import {
  createDedicatedVirtualAccount,
  ensurePaystackCustomer,
  PaystackTimeoutError,
  PAYSTACK_TIMEOUT_MS,
} from "./virtualAccount";

jest.mock("../db", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../jobs", () => ({
  __esModule: true,
  QueueService: { enqueue: jest.fn().mockResolvedValue("job-1") },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pool = require("../db").default as { query: jest.Mock };

/**
 * Installs a fetch mock that never resolves on its own and only rejects when
 * the request's AbortSignal fires — mimicking an unresponsive Paystack.
 */
function installHangingFetch(): jest.Mock {
  const fetchMock = jest.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortErr = new Error("The operation was aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      })
  );
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  return fetchMock;
}

describe("virtualAccount Paystack timeout", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env["PAYSTACK_SECRET_KEY"];

  beforeEach(() => {
    jest.useFakeTimers();
    process.env["PAYSTACK_SECRET_KEY"] = "sk_test_dummy";
    delete process.env["PAYSTACK_TIMEOUT_MS"];
    pool.query.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    (global as unknown as { fetch: typeof originalFetch }).fetch = originalFetch;
    if (originalKey === undefined) delete process.env["PAYSTACK_SECRET_KEY"];
    else process.env["PAYSTACK_SECRET_KEY"] = originalKey;
  });

  it("aborts createDedicatedVirtualAccount after 10s and throws PaystackTimeoutError", async () => {
    const fetchMock = installHangingFetch();

    const promise = createDedicatedVirtualAccount("user-1", "cus_123");
    const assertion = expect(promise).rejects.toBeInstanceOf(PaystackTimeoutError);

    // Not yet aborted — the request is still in flight.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(PAYSTACK_TIMEOUT_MS);

    await assertion;
    expect(init.signal?.aborted).toBe(true);
  });

  it("surfaces the operation name and timeout on the thrown error", async () => {
    installHangingFetch();

    const promise = createDedicatedVirtualAccount("user-1", "cus_123");
    const assertion = promise.catch((err: unknown) => err as PaystackTimeoutError);

    jest.advanceTimersByTime(PAYSTACK_TIMEOUT_MS);

    const err = await assertion;
    expect(err).toBeInstanceOf(PaystackTimeoutError);
    expect(err.name).toBe("PaystackTimeoutError");
    expect(err.operation).toBe("create dedicated account");
    expect(err.timeoutMs).toBe(PAYSTACK_TIMEOUT_MS);
    expect(err.message).toContain("timed out");
  });

  it("also bounds the Paystack customer-creation request", async () => {
    installHangingFetch();
    pool.query
      .mockResolvedValueOnce({ rows: [{ paystack_customer_code: null }] })
      .mockResolvedValueOnce({ rows: [{ phone: "+2348000000000" }] });

    const promise = ensurePaystackCustomer("user-1", "Ada Lovelace");
    const assertion = expect(promise).rejects.toBeInstanceOf(PaystackTimeoutError);

    jest.advanceTimersByTime(PAYSTACK_TIMEOUT_MS);

    await assertion;
  });

  it("honours a PAYSTACK_TIMEOUT_MS override", async () => {
    process.env["PAYSTACK_TIMEOUT_MS"] = "1000";
    installHangingFetch();

    const promise = createDedicatedVirtualAccount("user-1", "cus_123");
    const assertion = promise.catch((err: unknown) => err as PaystackTimeoutError);

    jest.advanceTimersByTime(1000);

    const err = await assertion;
    expect(err).toBeInstanceOf(PaystackTimeoutError);
    expect(err.timeoutMs).toBe(1000);
  });

  it("propagates non-timeout network errors unchanged", async () => {
    const networkErr = new TypeError("fetch failed");
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockRejectedValue(networkErr);

    const promise = createDedicatedVirtualAccount("user-1", "cus_123");
    const assertion = promise.catch((err: unknown) => err);

    jest.advanceTimersByTime(PAYSTACK_TIMEOUT_MS);

    await expect(assertion).resolves.toBe(networkErr);
  });
});
