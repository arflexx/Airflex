"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TradeOffer } from "../../server/src/types/trade";
import { Card } from "./ui/Card";

interface TradesResponse {
  data: TradeOffer[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface MarketplaceListingsProps {
  initialTrades?: TradeOffer[];
  initialPagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function formatAssetType(raw: string): string {
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function AssetBadge({ assetType }: { assetType: string }) {
  const isData = assetType.toUpperCase().includes("DATA");
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide ${
        isData
          ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          : "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
      }`}
    >
      {formatAssetType(assetType)}
    </span>
  );
}

function TradeCard({ trade, t }: { trade: TradeOffer; t: (key: string, values?: Record<string, string | number>) => string }) {
  const sellerAlias = trade.seller_handle ?? "@airflex";
  return (
    <Card className="flex flex-col gap-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("seller")}</p>
          <p className="font-semibold text-gray-900 truncate max-w-[160px] dark:text-gray-100">
            {sellerAlias}
          </p>
        </div>
        <AssetBadge assetType={trade.asset_type} />
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="text-xs uppercase tracking-widest text-gray-400 font-medium dark:text-gray-500">
          {t("amount")}
        </p>
        <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          ₦{trade.amount.toLocaleString()}
        </p>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        {t("expires")}{" "}
        {new Date(trade.expires_at).toLocaleDateString("en-NG", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>

      <a
        href={`/trades/${trade.id}`}
        className="mt-auto inline-flex items-center justify-center rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
        aria-label={t("viewBuyAria", {
          asset: formatAssetType(trade.asset_type),
          amount: trade.amount.toLocaleString(),
          seller: sellerAlias,
        })}
      >
        {t("viewAndBuy")}
      </a>
    </Card>
  );
}

function EmptyState({
  t,
  hasActiveFilters,
  onClear,
}: {
  t: (key: string) => string;
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-8 py-20 text-center dark:border-gray-700 dark:bg-gray-800/50">
      <span aria-hidden="true" className="text-5xl">📭</span>
      <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-200">
        {hasActiveFilters ? "No listings found matching your filters" : t("noListings")}
      </h2>
      <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
        {hasActiveFilters
          ? "Try adjusting or clearing your filters to see more available listings."
          : t("noListingsBody")}
      </p>
      {hasActiveFilters ? (
        <button
          type="button"
          onClick={onClear}
          className="mt-2 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          Clear filters
        </button>
      ) : (
        <a
          href="/sell"
          className="mt-2 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          {t("sellAsset")}
        </a>
      )}
    </div>
  );
}

export default function MarketplaceListings({
  initialTrades = [],
  initialPagination = { page: 1, limit: 20, total: initialTrades.length, totalPages: 1 },
}: MarketplaceListingsProps) {
  const t = useTranslations("Home");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || "/";

  // Filter state initialised from URL parameters
  const [assetType, setAssetType] = useState<string>(searchParams?.get("assetType") ?? "");
  const [carrier, setCarrier] = useState<string>(searchParams?.get("carrier") ?? "");
  const [minAmount, setMinAmount] = useState<string>(searchParams?.get("minAmount") ?? "");
  const [maxAmount, setMaxAmount] = useState<string>(searchParams?.get("maxAmount") ?? "");

  const [trades, setTrades] = useState<TradeOffer[]>(initialTrades);
  const [pagination, setPagination] = useState(initialPagination);
  const [loading, setLoading] = useState(false);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  // Synchronise URL query parameters without full page reload
  const updateUrlParams = useCallback(
    (newParams: { assetType?: string; carrier?: string; minAmount?: string; maxAmount?: string }) => {
      const params = new URLSearchParams();
      if (newParams.assetType) params.set("assetType", newParams.assetType);
      if (newParams.carrier) params.set("carrier", newParams.carrier);
      if (newParams.minAmount) params.set("minAmount", newParams.minAmount);
      if (newParams.maxAmount) params.set("maxAmount", newParams.maxAmount);

      const queryString = params.toString();
      const newUrl = queryString ? `${pathname}?${queryString}` : pathname;
      if (typeof window !== "undefined") {
        window.history.pushState(null, "", newUrl);
      }
    },
    [pathname]
  );

  // Fetch listings with current filters
  const fetchListings = useCallback(
    async (filters: { assetType?: string; carrier?: string; minAmount?: string; maxAmount?: string }) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", "1");
        params.set("limit", "20");
        if (filters.assetType) params.set("assetType", filters.assetType);
        if (filters.carrier) params.set("carrier", filters.carrier);
        if (filters.minAmount) params.set("minAmount", filters.minAmount);
        if (filters.maxAmount) params.set("maxAmount", filters.maxAmount);

        const res = await fetch(`${apiUrl}/api/v1/trades?${params.toString()}`);
        if (res.ok) {
          const data = (await res.json()) as TradesResponse;
          setTrades(data.data ?? []);
          setPagination(data.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 0 });
        }
      } catch (err) {
        console.error("Failed to fetch filtered trades:", err);
      } finally {
        setLoading(false);
      }
    },
    [apiUrl]
  );

  const handleAssetTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setAssetType(val);
    const updated = { assetType: val, carrier, minAmount, maxAmount };
    updateUrlParams(updated);
    fetchListings(updated);
  };

  const handleCarrierChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setCarrier(val);
    const updated = { assetType, carrier: val, minAmount, maxAmount };
    updateUrlParams(updated);
    fetchListings(updated);
  };

  const handleMinAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMinAmount(val);
    const updated = { assetType, carrier, minAmount: val, maxAmount };
    updateUrlParams(updated);
    fetchListings(updated);
  };

  const handleMaxAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMaxAmount(val);
    const updated = { assetType, carrier, minAmount, maxAmount: val };
    updateUrlParams(updated);
    fetchListings(updated);
  };

  const handleClearFilters = () => {
    setAssetType("");
    setCarrier("");
    setMinAmount("");
    setMaxAmount("");
    const updated = { assetType: "", carrier: "", minAmount: "", maxAmount: "" };
    updateUrlParams(updated);
    fetchListings(updated);
  };

  const hasActiveFilters = Boolean(assetType || carrier || minAmount || maxAmount);

  return (
    <div>
      {/* Filter Panel */}
      <div
        aria-label="Filter listings"
        className="mb-8 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
              Filter Listings
            </h3>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="text-xs font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Asset Type */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-asset-type" className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Asset Type
              </label>
              <select
                id="filter-asset-type"
                aria-label="Asset Type"
                value={assetType}
                onChange={handleAssetTypeChange}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              >
                <option value="">All Asset Types</option>
                <option value="AIRTIME">Airtime</option>
                <option value="DATA">Data</option>
              </select>
            </div>

            {/* Carrier Network */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-carrier" className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Carrier
              </label>
              <select
                id="filter-carrier"
                aria-label="Carrier"
                value={carrier}
                onChange={handleCarrierChange}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              >
                <option value="">All Carriers</option>
                <option value="MTN">MTN</option>
                <option value="GLO">Glo</option>
                <option value="AIRTEL">Airtel</option>
                <option value="9MOBILE">9mobile</option>
              </select>
            </div>

            {/* Min Amount */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-min-amount" className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Min Amount (₦)
              </label>
              <input
                id="filter-min-amount"
                aria-label="Min Amount"
                type="number"
                min="0"
                placeholder="0"
                value={minAmount}
                onChange={handleMinAmountChange}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>

            {/* Max Amount */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-max-amount" className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Max Amount (₦)
              </label>
              <input
                id="filter-max-amount"
                aria-label="Max Amount"
                type="number"
                min="0"
                placeholder="100,000"
                value={maxAmount}
                onChange={handleMaxAmountChange}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Offers count */}
      <div className="mb-6 flex items-baseline justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("offersAvailable", { count: pagination.total })}
        </p>
      </div>

      {/* Grid */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loading ? (
          <div className="col-span-full py-16 text-center text-gray-500">
            Updating listings…
          </div>
        ) : trades.length === 0 ? (
          <EmptyState t={t} hasActiveFilters={hasActiveFilters} onClear={handleClearFilters} />
        ) : (
          trades.map((trade) => <TradeCard key={trade.id} trade={trade} t={t} />)
        )}
      </div>

      {pagination.totalPages > 1 && (
        <p className="mt-10 text-center text-sm text-gray-400 dark:text-gray-500">
          {t("showingPage", { total: pagination.totalPages })}
        </p>
      )}
    </div>
  );
}
