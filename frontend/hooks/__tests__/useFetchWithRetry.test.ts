import { renderHook, waitFor } from "@testing-library/react";
import {
  useFetchWithRetry,
  fetchDeduped,
  clearFetchDedupCache,
  DEFAULT_DEDUP_WINDOW_MS,
} from "../useFetchWithRetry";
import { apiFetch } from "../../lib/apiFetch";
import { clearHttpCache } from "../../lib/httpCache";
import { clearToken } from "../../app/lib/auth";

const TOKEN_KEY = "airflex:token";

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe("useFetchWithRetry request deduplication", () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.restoreAllMocks();
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => mockResponse({ trades: [1, 2, 3] }));
    global.fetch = mockFetch as unknown as typeof fetch;
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, "token-a");
    clearFetchDedupCache();
    clearHttpCache();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("does not make a second network call for an identical GET within the dedup window", async () => {
    const first = await fetchDeduped("/api/v1/trades");
    const second = await fetchDeduped("/api/v1/trades");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("shares one in-flight request between concurrent identical GETs (two hooks)", async () => {
    const a = renderHook(() => useFetchWithRetry<{ trades: number[] }>("/api/v1/trades"));
    const b = renderHook(() => useFetchWithRetry<{ trades: number[] }>("/api/v1/trades"));

    await waitFor(() => expect(a.result.current.isLoading).toBe(false));
    await waitFor(() => expect(b.result.current.isLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a.result.current.data).toEqual({ trades: [1, 2, 3] });
    expect(b.result.current.data).toBe(a.result.current.data);
  });

  it("hits the network again once the dedup window has passed", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    await fetchDeduped("/api/v1/trades");

    now.mockReturnValue(1_000_000 + DEFAULT_DEDUP_WINDOW_MS + 1);
    await fetchDeduped("/api/v1/trades");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps different endpoints separate", async () => {
    await Promise.all([fetchDeduped("/api/v1/trades?page=1"), fetchDeduped("/api/v1/trades?page=2")]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidates the deduplicated GET when a mutation on the same resource succeeds", async () => {
    await fetchDeduped("/api/v1/trades");
    await apiFetch("/api/v1/trades", { method: "POST", body: "{}" });
    await fetchDeduped("/api/v1/trades");

    // GET, POST, GET
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not invalidate on a mutation to an unrelated resource", async () => {
    await fetchDeduped("/api/v1/trades");
    await apiFetch("/api/v1/profile", { method: "PATCH", body: "{}" });
    await fetchDeduped("/api/v1/trades");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a failed request", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "bad" }, { status: 400 }));
    await expect(fetchDeduped("/api/v1/trades")).rejects.toThrow("bad");
    await fetchDeduped("/api/v1/trades");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("scopes the cache per session and clears it on logout", async () => {
    await fetchDeduped("/api/v1/profile");

    // Another user signs in on the same device — no shared entry.
    localStorage.setItem(TOKEN_KEY, "token-b");
    await fetchDeduped("/api/v1/profile");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    clearToken();
    localStorage.setItem(TOKEN_KEY, "token-b");
    await fetchDeduped("/api/v1/profile");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("apiFetch Cache-Control / ETag handling", () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, "token-a");
    clearHttpCache();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("serves a max-age response from memory while fresh", async () => {
    mockFetch.mockResolvedValue(mockResponse({ v: 1 }, { headers: { "Cache-Control": "private, max-age=60" } }));

    await apiFetch("/api/v1/marketplace");
    const second = await apiFetch("/api/v1/marketplace");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ v: 1 });
  });

  it("revalidates with If-None-Match and reuses the body on 304", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ v: 1 }, { headers: { ETag: 'W/"abc"' } }))
      .mockResolvedValueOnce(mockResponse(null, { status: 304 }));

    const first = await apiFetch("/api/v1/marketplace");
    const second = await apiFetch("/api/v1/marketplace");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, options] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(options.headers).toEqual(expect.objectContaining({ "If-None-Match": 'W/"abc"' }));
    expect(second).toBe(first);
  });

  it("never caches no-store responses", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ v: 1 }, { headers: { "Cache-Control": "no-store", ETag: '"abc"' } }),
    );

    await apiFetch("/api/v1/wallet");
    await apiFetch("/api/v1/wallet");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, options] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(options.headers).not.toHaveProperty("If-None-Match");
  });

  it("drops cached GETs for a resource after a successful mutation on it", async () => {
    mockFetch.mockResolvedValue(mockResponse({ v: 1 }, { headers: { "Cache-Control": "max-age=60" } }));

    await apiFetch("/api/v1/trades/42");
    await apiFetch("/api/v1/trades/42", { method: "DELETE" });
    await apiFetch("/api/v1/trades/42");

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
