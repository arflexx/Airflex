/**
 * rates.test.ts — Redis-cached exchange rates with stale fallback (issue #676).
 */

jest.mock("../services/cache", () => ({
  cache: { get: jest.fn(), set: jest.fn() },
}));

import express from "express";
import request from "supertest";
import ratesRouter from "./rates";
import { cache } from "../services/cache";
import logger from "../utils/logger";
import {
  prewarmExchangeRates,
  rateCacheKey,
  refreshExchangeRate,
} from "../services/exchangeRates";

const mockGet = cache.get as jest.Mock;
const mockSet = cache.set as jest.Mock;

const app = express();
app.use("/api/v1/rates", ratesRouter);

describe("GET /api/v1/rates (issue #676)", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  let store: Map<string, { value: string; ttl: number }>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const name of [
      "RATES_PROVIDER_URL",
      "RATES_CACHE_TTL_SECONDS",
      "RATES_STALE_TTL_SECONDS",
      "NGN_PER_USDC_RATE",
    ]) {
      delete process.env[name];
    }
    store = new Map();
    mockGet.mockImplementation(async (key: string) => store.get(key)?.value ?? null);
    mockSet.mockImplementation(async (key: string, value: string, ttl: number) => {
      store.set(key, { value, ttl });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("uses the namespaced key rates:NGN:USDC", () => {
    expect(rateCacheKey({ base: "ngn", quote: "usdc" })).toBe("rates:NGN:USDC");
  });

  it("fetches on a cold cache, stores with the default 60s TTL and reports MISS", async () => {
    process.env["NGN_PER_USDC_RATE"] = "1550";

    const res = await request(app).get("/api/v1/rates");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rate: 1550,
      base: "NGN",
      target: "USDC",
      data: { rate: 1550, base: "NGN", target: "USDC" },
    });
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=60");
    expect(store.get("rates:NGN:USDC")?.ttl).toBe(60);
    expect(store.get("rates:NGN:USDC:last-known")?.ttl).toBe(86_400);
  });

  it("serves a warm cache entry without touching the provider (HIT)", async () => {
    process.env["RATES_PROVIDER_URL"] = "https://rates.example.com/v1";
    store.set("rates:NGN:USDC", {
      value: JSON.stringify({ base: "NGN", quote: "USDC", rate: 1600, fetchedAt: new Date().toISOString() }),
      ttl: 60,
    });

    const res = await request(app).get("/api/v1/rates");

    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("HIT");
    expect(res.body.rate).toBe(1600);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours RATES_CACHE_TTL_SECONDS", async () => {
    process.env["RATES_CACHE_TTL_SECONDS"] = "120";

    await request(app).get("/api/v1/rates");

    expect(store.get("rates:NGN:USDC")?.ttl).toBe(120);
  });

  it("reads the rate from the configured upstream provider", async () => {
    process.env["RATES_PROVIDER_URL"] = "https://rates.example.com/v1";
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { rate: "1612.5" } }) });

    const res = await request(app).get("/api/v1/rates");

    expect(res.body.rate).toBe(1612.5);
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.searchParams.get("base")).toBe("NGN");
    expect(url.searchParams.get("quote")).toBe("USDC");
  });

  it("serves the last-known rate with stale headers when the provider is unreachable", async () => {
    process.env["RATES_PROVIDER_URL"] = "https://rates.example.com/v1";
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    store.set("rates:NGN:USDC:last-known", {
      value: JSON.stringify({ base: "NGN", quote: "USDC", rate: 1590, fetchedAt: "2026-11-21T09:00:00.000Z" }),
      ttl: 86_400,
    });

    const res = await request(app).get("/api/v1/rates");

    expect(res.status).toBe(200);
    expect(res.body.rate).toBe(1590);
    expect(res.headers["x-cache"]).toBe("STALE");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=0, stale-while-revalidate=60, stale-if-error=86400"
    );
    expect(res.headers["warning"]).toBe('110 - "Response is Stale"');
  });

  it("treats a malformed provider response as an outage", async () => {
    process.env["RATES_PROVIDER_URL"] = "https://rates.example.com/v1";
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ rate: -1 }) });

    const res = await request(app).get("/api/v1/rates");

    expect(res.status).toBe(503);
  });

  it("returns 503 when the provider is down and no rate was ever cached", async () => {
    process.env["RATES_PROVIDER_URL"] = "https://rates.example.com/v1";
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });

    const res = await request(app).get("/api/v1/rates");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Exchange rate temporarily unavailable", code: "RATE_UNAVAILABLE" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("collapses concurrent refreshes into a single provider call", async () => {
    process.env["RATES_PROVIDER_URL"] = "https://rates.example.com/v1";
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ rate: 1600 }) });

    await Promise.all([
      refreshExchangeRate({ base: "NGN", quote: "USDC" }),
      refreshExchangeRate({ base: "NGN", quote: "USDC" }),
      refreshExchangeRate({ base: "NGN", quote: "USDC" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("prewarmExchangeRates (issue #676)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
    delete process.env["RATES_PROVIDER_URL"];
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("refreshes every supported pair", async () => {
    await expect(prewarmExchangeRates()).resolves.toEqual({ refreshed: 1, failed: 0 });
    expect(mockSet).toHaveBeenCalledWith("rates:NGN:USDC", expect.any(String), 60);
  });

  it("reports partial failures and rejects only when every pair fails", async () => {
    mockSet.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      prewarmExchangeRates([
        { base: "NGN", quote: "USDC" },
        { base: "GHS", quote: "USDC" },
      ])
    ).resolves.toEqual({ refreshed: 1, failed: 1 });

    mockSet.mockRejectedValue(new Error("redis down"));
    await expect(prewarmExchangeRates()).rejects.toThrow("pre-warm failed for every pair");
  });
});
