"use client";

import { useState } from "react";
import { Card } from "./ui/Card";
import { ASSET_OPTIONS, ASSET_TYPE_VALUES, formatAssetType } from "../lib/assetTypes";
import type { AssetTypeValue } from "../lib/assetTypes";
import { useTradeList } from "../hooks/useTradeList";
import type { TradeOffer } from "../../../server/src/types/trade";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

function TradeCard({ trade }: { trade: TradeOffer }) {
  const sellerAlias = trade.seller_handle ?? "@airflex";
  return (
    <Card className="flex flex-col gap-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Seller</p>
          <p className="font-semibold text-gray-900 truncate max-w-[160px] dark:text-gray-100">
            {sellerAlias}
          </p>
        </div>
        <AssetBadge assetType={trade.asset_type} />
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="text-xs uppercase tracking-widest text-gray-400 font-medium dark:text-gray-500">
          Amount
        </p>
        <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          ₦{trade.amount.toLocaleString()}
        </p>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Expires{" "}
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
        aria-label={`View and buy ${formatAssetType(trade.asset_type)} — ₦${trade.amount.toLocaleString()} from ${sellerAlias}`}
      >
        View &amp; Buy
      </a>
    </Card>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-8 py-20 text-center dark:border-gray-700 dark:bg-gray-800/50">
      <span aria-hidden="true" className="text-5xl">📭</span>
      <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-200">
        {filtered ? "No listings match this filter" : "No listings yet"}
      </h2>
      <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
        {filtered
          ? "Try a different asset type, or clear the filter to see all active listings."
          : "Be the first to list airtime or data on the marketplace."}
      </p>
      {!filtered && (
        <a
          href="/sell"
          className="mt-2 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          Sell an asset
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

/** All canonical asset type values plus a sentinel "all" for clearing the filter. */
type FilterValue = AssetTypeValue | "ALL";

const FILTER_OPTIONS: Array<{ value: FilterValue; label: string }> = [
  { value: "ALL", label: "All" },
  ...ASSET_OPTIONS,
];

function FilterBar({
  active,
  onChange,
}: {
  active: FilterValue;
  onChange: (v: FilterValue) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter listings by asset type"
      className="flex flex-wrap gap-2"
    >
      {FILTER_OPTIONS.map(({ value, label }) => {
        const isActive = active === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={isActive}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
              isActive
                ? "border-violet-600 bg-violet-600 text-white"
                : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:border-violet-500 dark:hover:text-violet-300"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex justify-between">
        <div className="h-4 w-24 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-5 w-20 rounded-full bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="mb-2 h-8 w-32 rounded bg-gray-200 dark:bg-gray-700" />
      <div className="mb-6 h-3 w-48 rounded bg-gray-100 dark:bg-gray-700" />
      <div className="h-10 w-full rounded-xl bg-gray-200 dark:bg-gray-700" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function ListingsGrid() {
  const [activeFilter, setActiveFilter] = useState<FilterValue>("ALL");
  const [page] = useState(1);

  const assetTypeParam =
    activeFilter === "ALL" ? undefined : activeFilter;

  const { trades, total, isLoading, error } = useTradeList({
    page,
    limit: 20,
    assetType: assetTypeParam,
  });

  return (
    <section
      id="listings"
      aria-labelledby="listings-heading"
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8"
    >
      {/* Section header */}
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h2
            id="listings-heading"
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
          >
            Active Listings
          </h2>
          {!isLoading && total > 0 && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {total} {total === 1 ? "offer" : "offers"} available
            </p>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-6">
        <FilterBar active={activeFilter} onChange={setActiveFilter} />
      </div>

      {/* Grid */}
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
        >
          Failed to load listings. Please refresh the page.
        </div>
      ) : isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {trades.length === 0 ? (
            <EmptyState filtered={activeFilter !== "ALL"} />
          ) : (
            trades.map((trade) => <TradeCard key={trade.id} trade={trade} />)
          )}
        </div>
      )}
    </section>
  );
}
