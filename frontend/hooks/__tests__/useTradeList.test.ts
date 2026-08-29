import { renderHook, waitFor } from "@testing-library/react";
import { useTradeList, clearTradeListCache } from "../useTradeList";
import * as apiModule from "../../lib/apiFetch";
import { ApiError } from "../../lib/apiFetch";
import { TradeStatus } from "@airflex/shared";

jest.mock("../../lib/apiFetch", () => {
  const actual = jest.requireActual("../../lib/apiFetch");
  return {
    ...actual,
    apiFetch: jest.fn(),
  };
});

describe("useTradeList Hook", () => {
  const mockedApiFetch = apiModule.apiFetch as jest.MockedFunction<typeof apiModule.apiFetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearTradeListCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("handles loading -> success state transition and fetches trades", async () => {
    const mockTrades = [
      {
        id: "trade-1",
        sellerId: "user-1",
        assetCode: "MTN_AIRTIME",
        amount: 5000,
        price: 5000,
        currency: "NGN",
        status: TradeStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockedApiFetch.mockResolvedValueOnce({
      data: mockTrades,
      total: 1,
    });

    const { result } = renderHook(() =>
      useTradeList({ page: 1, limit: 10, assetType: "MTN_AIRTIME", status: "active" })
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.trades).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.trades).toEqual(mockTrades);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toBeNull();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/trades?page=1&limit=10&assetType=MTN_AIRTIME&status=active"
    );
  });

  it("handles loading -> error state transition when apiFetch throws ApiError", async () => {
    const apiError = new ApiError("Failed to fetch marketplace trades", 500);
    mockedApiFetch.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() =>
      useTradeList({ page: 1, limit: 10 })
    );

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.trades).toEqual([]);
    expect(result.current.error).toBe(apiError);
    expect((result.current.error as ApiError).message).toBe("Failed to fetch marketplace trades");
  });

  it("deduplicates network requests within the cache window", async () => {
    const mockTrades = [
      {
        id: "trade-1",
        sellerId: "user-1",
        assetCode: "MTN_AIRTIME",
        amount: 5000,
        price: 5000,
        currency: "NGN",
        status: TradeStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockedApiFetch.mockResolvedValue({
      data: mockTrades,
      total: 1,
    });

    const { result: r1 } = renderHook(() => useTradeList({ page: 1, limit: 10 }));
    const { result: r2 } = renderHook(() => useTradeList({ page: 1, limit: 10 }));

    await waitFor(() => {
      expect(r1.current.isLoading).toBe(false);
      expect(r2.current.isLoading).toBe(false);
    });

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });
});
