import { act, renderHook, waitFor } from "@testing-library/react";
import { useTradeList, clearTradeListCache } from "../useTradeList";
import * as apiModule from "../../lib/apiFetch";
import { TradeStatus } from "@airflex/shared";
import type { TradeOffer } from "@airflex/shared";

jest.mock("../../lib/apiFetch", () => {
  const actual = jest.requireActual("../../lib/apiFetch");
  return {
    ...actual,
    apiFetch: jest.fn(),
  };
});

/** Builds fresh (structurally identical) trade objects on every call, as JSON parsing would. */
function makeTrades(overrides: Partial<TradeOffer> = {}): TradeOffer[] {
  return [
    {
      id: "trade-1",
      sellerId: "user-1",
      assetCode: "MTN_AIRTIME",
      amount: 5000,
      price: 5000,
      currency: "NGN",
      status: TradeStatus.ACTIVE,
      createdAt: new Date("2026-11-01T10:00:00Z"),
      updatedAt: new Date("2026-11-01T10:00:00Z"),
      ...overrides,
    } as TradeOffer,
    {
      id: "trade-2",
      sellerId: "user-2",
      assetCode: "AIRTEL_DATA",
      amount: 1000,
      price: 1000,
      currency: "NGN",
      status: TradeStatus.ACTIVE,
      createdAt: new Date("2026-11-02T10:00:00Z"),
      updatedAt: new Date("2026-11-02T10:00:00Z"),
    } as TradeOffer,
  ];
}

describe("useTradeList reference stability", () => {
  const mockedApiFetch = apiModule.apiFetch as jest.MockedFunction<typeof apiModule.apiFetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearTradeListCache();
  });

  it("returns the exact same trades array across re-renders with identical data", async () => {
    mockedApiFetch.mockImplementation(async () => ({ data: makeTrades(), total: 2 }));

    const { result, rerender } = renderHook(
      (props: { page: number; limit: number }) => useTradeList(props),
      { initialProps: { page: 1, limit: 10 } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = result.current.trades;
    expect(first).toHaveLength(2);

    // Plain re-render with the same options.
    rerender({ page: 1, limit: 10 });
    expect(result.current.trades).toBe(first);

    // A refetch that returns new-but-equal objects keeps the same reference.
    await act(async () => {
      await result.current.refetch();
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.trades).toBe(first);

    // Functional behaviour is unchanged.
    expect(result.current.total).toBe(2);
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("returns a new array when contents change, reusing unchanged items", async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ data: makeTrades(), total: 2 })
      .mockResolvedValueOnce({ data: makeTrades({ amount: 7500 }), total: 2 });

    const { result } = renderHook(() => useTradeList({ page: 1, limit: 10 }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = result.current.trades;

    await act(async () => {
      await result.current.refetch();
    });

    const second = result.current.trades;
    expect(second).not.toBe(first);
    expect(second[0]!.amount).toBe(7500);
    expect(second[0]).not.toBe(first[0]);
    // The untouched trade keeps its identity so a memoized row would skip rendering.
    expect(second[1]).toBe(first[1]);
  });
});
