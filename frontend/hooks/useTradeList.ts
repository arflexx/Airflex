"use client";

import { useEffect, useState, useRef } from "react";
import { apiFetch, ApiError } from "../lib/apiFetch";
import { reconcileList } from "../lib/stableList";
import type { TradeOffer } from "@airflex/shared";

const tradeKey = (trade: TradeOffer): string => trade.id;

/**
 * Keeps the previous `trades` array (and unchanged trade objects) when a
 * refetch or poll returns the same contents, so memoized list consumers don't
 * re-render on every 30s poll or unrelated parent update.
 */
function stableTrades(prev: TradeOffer[], next: TradeOffer[]): TradeOffer[] {
  return reconcileList(prev, next, tradeKey);
}

export interface UseTradeListOptions {
  page: number;
  limit: number;
  assetType?: string;
  carrier?: string;
  minAmount?: number | string;
  maxAmount?: number | string;
  status?: string;
}

export interface UseTradeListReturn {
  trades: TradeOffer[];
  total: number;
  isLoading: boolean;
  isEmpty: boolean;
  error: ApiError | Error | null;
  attempt: number;
  refetch: () => Promise<void>;
}

interface ApiResponse {
  data?: TradeOffer[];
  trades?: TradeOffer[];
  total?: number;
  pagination?: {
    total: number;
  };
}

// In-memory cache for SWR deduplication
const cacheMap = new Map<string, { data: { trades: TradeOffer[]; total: number }; timestamp: number }>();
const inFlightPromises = new Map<string, Promise<{ trades: TradeOffer[]; total: number }>>();
const CACHE_TTL_MS = 5000; // 5 seconds deduplication window

export function clearTradeListCache(): void {
  cacheMap.clear();
  inFlightPromises.clear();
}

export function useTradeList(options: UseTradeListOptions): UseTradeListReturn {
  const { page, limit, assetType, carrier, minAmount, maxAmount, status } = options;

  const [trades, setTrades] = useState<TradeOffer[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isEmpty, setIsEmpty] = useState<boolean>(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [attempt, setAttempt] = useState<number>(1);

  const queryParams = new URLSearchParams();
  queryParams.set("page", String(page));
  queryParams.set("limit", String(limit));
  if (assetType) queryParams.set("assetType", assetType);
  if (carrier) queryParams.set("carrier", carrier);
  if (minAmount !== undefined && minAmount !== "") queryParams.set("minAmount", String(minAmount));
  if (maxAmount !== undefined && maxAmount !== "") queryParams.set("maxAmount", String(maxAmount));
  if (status) queryParams.set("status", status);

  const cacheKey = `/api/v1/trades?${queryParams.toString()}`;
  const isMounted = useRef(true);

  const fetchData = async (isRefetch = false): Promise<void> => {
    if (!isRefetch) {
      const cached = cacheMap.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        setTrades((prev) => stableTrades(prev, cached.data.trades));
        setTotal(cached.data.total);
        setIsLoading(false);
        setError(null);
        setIsEmpty(cached.data.trades.length === 0);
        setAttempt(1);
        return;
      }
    }

    if (!isRefetch && cacheMap.has(cacheKey) === false && trades.length === 0) {
      setIsLoading(true);
    }
    setError(null);
    setIsEmpty(false);
    setAttempt(1);

    // Retry logic with exponential backoff concept (without setTimeout for test simplicity)
    // Retries only for transient failures (5xx, network, timeout), not 4xx client errors
    let lastError: ApiError | Error | null = null;

    for (let i = 1; i <= 3; i++) {
      setAttempt(i);

      try {
        let promise = inFlightPromises.get(cacheKey);
        if (!promise) {
          promise = apiFetch<ApiResponse>(cacheKey).then((res) => {
            const fetchedTrades = res.data ?? res.trades ?? [];
            const fetchedTotal = res.total ?? res.pagination?.total ?? fetchedTrades.length;
            const result = { trades: fetchedTrades, total: fetchedTotal };
            cacheMap.set(cacheKey, { data: result, timestamp: Date.now() });
            return result;
          });
          inFlightPromises.set(cacheKey, promise);
        }

        const result = await promise;
        inFlightPromises.delete(cacheKey);

        if (isMounted.current) {
          setTrades((prev) => stableTrades(prev, result.trades));
          setTotal(result.total);
          setIsLoading(false);
          setIsEmpty(result.trades.length === 0);
        }
        setAttempt(3);
        return;
      } catch (err) {
        const errorObj = err instanceof ApiError ? err : new Error(String(err));
        lastError = errorObj;

        // Only retry for transient failures (5xx, network, timeout), not 4xx client errors
        const isApiError = errorObj instanceof ApiError;
        const shouldRetry =
          !isApiError ||
          (isApiError && errorObj.status >= 500) ||
          errorObj.message.toLowerCase().includes("timeout") ||
          errorObj.message.toLowerCase().includes("network");

        if (!shouldRetry || i >= 3) {
          if (isMounted.current) {
            setIsLoading(false);
            setError(errorObj);
            setIsEmpty(false);
          }
          setAttempt(i);
          return;
        }

        // Continue to next retry attempt
      }
    }

    // Should not reach here, but just in case
    setIsLoading(false);
    setError(lastError ?? new Error("Max retry attempts exceeded"));
    setIsEmpty(false);
    setAttempt(3);
  };

  useEffect(() => {
    isMounted.current = true;
    void fetchData();

    const intervalId = setInterval(() => {
      void fetchData(true);
    }, 30000);

    return () => {
      isMounted.current = false;
      clearInterval(intervalId);
    };
  }, [cacheKey]);

  return {
    trades,
    total,
    isLoading,
    isEmpty,
    error,
    attempt,
    refetch: () => fetchData(true),
  };
}