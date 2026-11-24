/**
 * Load test: 50 concurrent trade verifications against a rate-limited Soroban RPC.
 *
 * Drives the real QueueService (in-process mode) with 50 verify-trade-delivery
 * jobs. Each job makes the same three sequential RPC calls as releasePayment
 * (prepareTransaction → sendTransaction → getTransaction) through
 * callSorobanRpc. The simulated RPC answers HTTP 429 whenever more requests are
 * in flight than it allows, so any 429 here means the worker let too many
 * verifications hit Soroban at once.
 */

import { QueueService, getQueueConcurrency, DEFAULT_VERIFY_TRADE_CONCURRENCY } from "../jobs/queue";
import type { Job } from "../jobs/queue";
import { callSorobanRpc } from "../services/stellar";

const TRADES = 50;
/** In-flight requests the simulated provider tolerates before returning 429. */
const RPC_IN_FLIGHT_LIMIT = DEFAULT_VERIFY_TRADE_CONCURRENCY;

class RateLimitedRpc {
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;
  rateLimited = 0;

  constructor(private readonly limit: number) {}

  async call(method: string): Promise<string> {
    this.calls++;
    if (this.inFlight >= this.limit) {
      this.rateLimited++;
      throw Object.assign(new Error(`429 Too Many Requests (${method})`), {
        response: { status: 429, headers: {} },
      });
    }
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(5 + Math.floor(Math.random() * 10));
      return method;
    } finally {
      this.inFlight--;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyOnChain(rpc: RateLimitedRpc): Promise<void> {
  // Each RPC call has its own timeout/retry, exactly as in stellar.ts.
  for (const method of ["prepareTransaction", "sendTransaction", "getTransaction"]) {
    await callSorobanRpc(method, () => rpc.call(method), { baseDelayMs: 1 });
  }
}

describe("verify-trade-delivery under load", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  afterAll(() => {
    QueueService.stop();
  });

  it("defaults VERIFY_TRADE_CONCURRENCY to 5 and honours an override", () => {
    delete process.env["VERIFY_TRADE_CONCURRENCY"];
    expect(getQueueConcurrency("verify-trade-delivery")).toBe(5);

    process.env["VERIFY_TRADE_CONCURRENCY"] = "12";
    expect(getQueueConcurrency("verify-trade-delivery")).toBe(12);

    process.env["VERIFY_TRADE_CONCURRENCY"] = "not-a-number";
    expect(getQueueConcurrency("verify-trade-delivery")).toBe(5);

    // Other queues stay unbounded.
    expect(getQueueConcurrency("send-notification")).toBeNull();
  });

  it("sanity check: 50 unthrottled verifications do trip the RPC rate limit", async () => {
    const rpc = new RateLimitedRpc(RPC_IN_FLIGHT_LIMIT);
    await Promise.allSettled(
      Array.from({ length: TRADES }, () => rpc.call("prepareTransaction"))
    );
    expect(rpc.rateLimited).toBeGreaterThan(0);
  });

  it(`processes ${TRADES} concurrent verifications with zero Soroban RPC rate-limit errors`, async () => {
    delete process.env["VERIFY_TRADE_CONCURRENCY"];
    delete process.env["REDIS_URL"];

    const rpc = new RateLimitedRpc(RPC_IN_FLIGHT_LIMIT);
    let running = 0;
    let maxRunning = 0;
    const done = new Set<string>();

    QueueService.register("verify-trade-delivery", async (job: Job<{ tradeId: string }>) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        await verifyOnChain(rpc);
        done.add(job.data.tradeId);
      } finally {
        running--;
      }
    });

    for (let i = 0; i < TRADES; i++) {
      await QueueService.enqueue("verify-trade-delivery", { tradeId: `trade-${i}` });
    }
    QueueService.init();

    const deadline = Date.now() + 20_000;
    while (done.size < TRADES && Date.now() < deadline) {
      await sleep(20);
    }

    const stats = QueueService.getStats().find((s) => s.name === "verify-trade-delivery")!;

    expect(done.size).toBe(TRADES);
    expect(rpc.rateLimited).toBe(0);
    expect(rpc.calls).toBe(TRADES * 3);
    expect(maxRunning).toBeLessThanOrEqual(DEFAULT_VERIFY_TRADE_CONCURRENCY);
    expect(rpc.maxInFlight).toBeLessThanOrEqual(RPC_IN_FLIGHT_LIMIT);
    expect(stats.failed).toBe(0);
    expect(stats.concurrency).toBe(DEFAULT_VERIFY_TRADE_CONCURRENCY);
  }, 30_000);
});
