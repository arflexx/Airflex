import {
  callSorobanRpc,
  isRetryableSorobanRpcError,
  getSorobanRpcTimeoutMs,
  getSorobanRpcMaxRetries,
  SorobanRpcTimeoutError,
  SorobanRpcRetryableError,
} from "./stellar";

function httpError(status: number, headers: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });
}

const never = () => new Promise<never>(() => {});

describe("callSorobanRpc", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("defaults to a 10s timeout and 2 retries, overridable via env", () => {
    delete process.env["SOROBAN_RPC_TIMEOUT_MS"];
    delete process.env["SOROBAN_RPC_MAX_RETRIES"];
    expect(getSorobanRpcTimeoutMs()).toBe(10_000);
    expect(getSorobanRpcMaxRetries()).toBe(2);

    process.env["SOROBAN_RPC_TIMEOUT_MS"] = "2500";
    process.env["SOROBAN_RPC_MAX_RETRIES"] = "0";
    expect(getSorobanRpcTimeoutMs()).toBe(2500);
    expect(getSorobanRpcMaxRetries()).toBe(0);
  });

  it("retries after a timeout and returns the later result", async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockImplementationOnce(never)
      .mockResolvedValueOnce("ok");

    await expect(
      callSorobanRpc("getTransaction", fn, { timeoutMs: 20, maxRetries: 1, baseDelayMs: 1 })
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws SorobanRpcTimeoutError once retries are exhausted", async () => {
    const fn = jest.fn(never);
    await expect(
      callSorobanRpc("prepareTransaction", fn, { timeoutMs: 10, maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toBeInstanceOf(SorobanRpcTimeoutError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries HTTP 429 and 5xx responses", async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce("sent");

    await expect(
      callSorobanRpc("sendTransaction", fn, { timeoutMs: 1_000, maxRetries: 2, baseDelayMs: 1 })
    ).resolves.toBe("sent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry contract or simulation errors", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("HostError: contract panicked"));
    await expect(
      callSorobanRpc("prepareTransaction", fn, { timeoutMs: 1_000, maxRetries: 3, baseDelayMs: 1 })
    ).rejects.toThrow("contract panicked");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry 4xx responses other than 429", async () => {
    const fn = jest.fn().mockRejectedValue(httpError(400));
    await expect(
      callSorobanRpc("sendTransaction", fn, { timeoutMs: 1_000, maxRetries: 3, baseDelayMs: 1 })
    ).rejects.toThrow("HTTP 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isRetryableSorobanRpcError", () => {
  it.each([
    [new SorobanRpcTimeoutError("getTransaction", 10), true],
    [new SorobanRpcRetryableError("TRY_AGAIN_LATER"), true],
    [httpError(429), true],
    [httpError(502), true],
    [Object.assign(new Error("reset"), { code: "ECONNRESET" }), true],
    [httpError(404), false],
    [new Error("Transaction simulation failed"), false],
  ])("%s → %s", (err, expected) => {
    expect(isRetryableSorobanRpcError(err)).toBe(expected);
  });
});
