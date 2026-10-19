"use client";

/**
 * MarketplaceListings — client-side marketplace grid with skeleton loading
 * states (issue #446).
 *
 * Fetches active trade listings from the API and renders:
 *   - Animated skeleton placeholders while the request is in-flight
 *   - An error state if the fetch fails
 *   - An empty state when there are no listings
 *   - The real trade cards once data resolves
 *
 * The skeleton mirrors the real TradeCard layout to avoid layout shift, and
 * uses theme tokens so it works in both light and dark mode.
 */

import { useEffect, useState } from "react";
import type { TradeOffer } from "../../server/src/types/trade";
import TradeCardSkeleton from "./TradeCardSkeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradesResponse {
  data: TradeOffer[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

type Status = "loading" | "error" | "ready";

// ---------------------------------------------------------------------------
// Helpers (mirrored from app/page.tsx to keep this component self-contained)
// ---------------------------------------------------------------------------

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

function TradeCard({ trade }: { trade: TradeOffer }) {
  const sellerAlias = `@seller_${trade.seller_id.slice(-8)}`;
  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800">
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
        aria-label={`View and buy ${formatAssetType(trade.asset_type)} worth ₦${trade.amount.toLocaleString()} from ${sellerAlias}`}
      >
        View &amp; Buy
      </a>
    </article>
  );
}

export function EmptyState() {
  return (
    <div className="col-span-full flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-8 py-20 text-center dark:border-gray-700 dark:bg-gray-800/50">
      <span aria-hidden="true" className="text-5xl">📭</span>
      <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-200">
        No active listings right now
      </h2>
      <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
        Be the first to list your airtime or data. Sellers get paid instantly once
        delivery is confirmed on-chain.
      </p>
      <a
        href="/sell"
        className="mt-2 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        Sell Airtime / Data
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State views (exported for unit testing)
// ---------------------------------------------------------------------------

/** Loading view: a responsive grid of skeleton cards. */
export function MarketplaceLoading({ count = 8 }: { count?: number }) {
  return (
    <div
      className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      aria-busy="true"
      aria-live="polite"
      role="status"
    >
      <TradeCardSkeleton count={count} />
    </div>
  );
}

/** Error view: a retryable alert shown when the listings fetch fails. */
export function MarketplaceError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-8 py-16 text-center dark:border-red-800 dark:bg-red-900/20"
    >
      <span aria-hidden="true" className="text-4xl">⚠️</span>
      <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">
        Couldn&apos;t load listings
      </h2>
      <p className="max-w-sm text-sm text-red-600 dark:text-red-400/80">
        Something went wrong while fetching marketplace offers. Please try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 inline-flex items-center rounded-xl border border-red-300 bg-white px-5 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-800 dark:bg-gray-800 dark:text-red-400 dark:hover:bg-gray-700"
      >
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MarketplaceListingsProps {
  /** Override the API base URL (defaults to NEXT_PUBLIC_API_URL). */
  apiUrl?: string;
  /** Number of skeletons to show while loading. */
  skeletonCount?: number;
  /** Page/limit query params. */
  page?: number;
  limit?: number;
}

export default function MarketplaceListings({
  apiUrl,
  skeletonCount = 8,
  page = 1,
  limit = 20,
}: MarketplaceListingsProps) {
  const base = apiUrl ?? process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  const [status, setStatus] = useState<Status>("loading");
  const [listings, setListings] = useState<TradeOffer[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setStatus("loading");
    fetch(`${base}/api/v1/trades?page=${page}&limit=${limit}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed with ${r.status}`);
        return r.json() as Promise<TradesResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setListings(data.data ?? []);
        setTotal(data.pagination?.total ?? 0);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) return;
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [base, page, limit]);

  if (status === "loading") {
    return <MarketplaceLoading count={skeletonCount} />;
  }

  if (status === "error") {
    return <MarketplaceError onRetry={() => setStatus("loading")} />;
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {listings.length === 0 ? (
        <EmptyState />
      ) : (
        listings.map((trade) => <TradeCard key={trade.id} trade={trade} />)
      )}

      {total > listings.length && (
        <p className="col-span-full mt-6 text-center text-sm text-gray-400 dark:text-gray-500">
          Showing {listings.length} of {total} offers.
        </p>
      )}
    </div>
  );
}
