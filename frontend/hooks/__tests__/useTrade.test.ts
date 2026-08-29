import { renderHook, waitFor } from "@testing-library/react";
import { useTrade, clearTradeCache } from "../useTrade";
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

describe("useTrade Hook", () => {
  const mockedApiFetch = apiModule.apiFetch as jest.MockedFunction<typeof apiModule.apiFetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearTradeCache();
  });

  it("handles loading -> success state transition and returns single trade", async () => {
    const mockTrade = {
      id: "trade-123",
      sellerId: "user-99",
      assetCode: "GLO_DATA",
      amount: 2000,
      price: 2000,
      currency: "NGN",
      status: TradeStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockedApiFetch.mockResolvedValueOnce({
      data: mockTrade,
    });

    const { result } = renderHook(() => useTrade("trade-123"));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.trade).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.trade).toEqual(mockTrade);
    expect(result.current.error).toBeNull();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/trades/trade-123");
  });

  it("handles loading -> error state transition when trade is not found", async () => {
    const apiError = new ApiError("Trade not found", 404);
    mockedApiFetch.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() => useTrade("invalid-id"));

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.trade).toBeNull();
    expect(result.current.error).toBe(apiError);
    expect((result.current.error as ApiError).message).toBe("Trade not found");
  });
});
