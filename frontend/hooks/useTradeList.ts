"use client";

import { useEffect, useState, useRef } from "react";
import { apiFetch, ApiError } from "../lib/apiFetch";
import type { TradeOffer } from "@airflex/shared";

export interface UseTradeListOptions {
  page: number;
  limit: number;
  assetType?: string;
  status?: string;
}

export interface UseTradeListReturn {
  trades: TradeOffer[];
  total: number;
  isLoading: boolean;
  error: ApiError | Error | null;
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
  const { page, limit, assetType, status } = options;

  const [trades, setTrades] = useState<TradeOffer[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const queryParams = new URLSearchParams();
  queryParams.set("page", String(page));
  queryParams.set("limit", String(limit));
  if (assetType) queryParams.set("assetType", assetType);
  if (status) queryParams.set("status", status);

  const cacheKey = `/api/v1/trades?${queryParams.toString()}`;
  const isMounted = useRef(true);

  const fetchData = async (isRefetch = false): Promise<void> => {
    if (!isRefetch) {
      const cached = cacheMap.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        setTrades(cached.data.trades);
        setTotal(cached.data.total);
        setIsLoading(false);
        setError(null);
        return;
      }
    }

    if (!isRefetch && cacheMap.has(cacheKey) === false && trades.length === 0) {
      setIsLoading(true);
    }
    setError(null);

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
        setTrades(result.trades);
        setTotal(result.total);
        setIsLoading(false);
      }
    } catch (err) {
      inFlightPromises.delete(cacheKey);
      if (isMounted.current) {
        const errorObj = err instanceof ApiError ? err : (err as Error);
        setError(errorObj);
        setIsLoading(false);
      }
    }
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
    error,
    refetch: () => fetchData(true),
  };
}
