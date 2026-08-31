"use client";

import { useEffect, useState, useRef } from "react";
import { apiFetch, ApiError } from "../lib/apiFetch";
import type { TradeOffer } from "@airflex/shared";

export interface UseTradeReturn {
  trade: TradeOffer | null;
  isLoading: boolean;
  error: ApiError | Error | null;
  refetch: () => Promise<void>;
}

interface ApiResponse {
  data?: TradeOffer;
  trade?: TradeOffer;
}

// In-memory cache for SWR deduplication
const cacheMap = new Map<string, { data: TradeOffer | null; timestamp: number }>();
const inFlightPromises = new Map<string, Promise<TradeOffer | null>>();
const CACHE_TTL_MS = 5000; // 5 seconds deduplication window

export function clearTradeCache(): void {
  cacheMap.clear();
  inFlightPromises.clear();
}

export function useTrade(id: string): UseTradeReturn {
  const [trade, setTrade] = useState<TradeOffer | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const cacheKey = `/api/v1/trades/${id}`;
  const isMounted = useRef(true);

  const fetchData = async (isRefetch = false): Promise<void> => {
    if (!id) {
      setTrade(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    if (!isRefetch) {
      const cached = cacheMap.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        setTrade(cached.data);
        setIsLoading(false);
        setError(null);
        return;
      }
    }

    setIsLoading(true);
    setError(null);

    try {
      let promise = inFlightPromises.get(cacheKey);
      if (!promise) {
        promise = apiFetch<ApiResponse>(cacheKey).then((res) => {
          const fetchedTrade = res.data ?? res.trade ?? (res as unknown as TradeOffer);
          cacheMap.set(cacheKey, { data: fetchedTrade, timestamp: Date.now() });
          return fetchedTrade;
        });
        inFlightPromises.set(cacheKey, promise);
      }

      const result = await promise;
      inFlightPromises.delete(cacheKey);

      if (isMounted.current) {
        setTrade(result);
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

    return () => {
      isMounted.current = false;
    };
  }, [id, cacheKey]);

  return {
    trade,
    isLoading,
    error,
    refetch: () => fetchData(true),
  };
}
