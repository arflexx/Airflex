"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { ASSET_OPTIONS, formatAssetType } from "../lib/assetTypes";
import type { AssetTypeValue } from "../lib/assetTypes";
import { useTradeList } from "../../hooks/useTradeList";

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

interface GridTrade {
  id: string;
  seller_handle?: string;
  sellerId?: string;
  asset_type?: string;
  assetCode?: string;
  amount: number;
  expires_at?: string | number | Date;
  expiresAt?: string | number | Date;
}

function TradeCard({ trade }: { trade: GridTrade }) {
  const sellerAlias = trade.seller_handle ?? trade.sellerId ?? "@airflex";
  const assetType = trade.asset_type ?? trade.assetCode ?? "AIRTIME";
  const expires = trade.expires_at ?? trade.expiresAt ?? new Date();
  return (
    <Card className="flex flex-col gap-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Seller</p>
          <p className="font-semibold text-gray-900 truncate max-w-[160px] dark:text-gray-100">
            {sellerAlias}
          </p>
        </div>
        <AssetBadge assetType={assetType} />
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
        {new Date(expires).toLocaleDateString("en-NG", {
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
        aria-label={`View and buy ${formatAssetType(assetType)} — ₦${trade.amount.toLocaleString()} from ${sellerAlias}`}
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

export interface ListingsGridProps {
  /**
   * Number of listings fetched per page (issue #606). Defaults to 20.
   */
  pageSize?: number;
  /**
   * Pre-fetched first page of trades from the server component (issue #677).
   * When supplied the grid renders them immediately on hydration, skipping the
   * initial client fetch and the skeleton state for page 1.
   */
  initialTrades?: GridTrade[];
  /**
   * Total offer count matching the pre-fetched query (issue #677).
   */
  initialTotal?: number;
}

const PAGE_PARAM = "page";

export default function ListingsGrid({ pageSize = 20, initialTrades, initialTotal }: ListingsGridProps = {}) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const searchParams = useSearchParams();

  const [activeFilter, setActiveFilter] = useState<FilterValue>("ALL");

  const initialPage = Math.max(1, Number(searchParams?.get(PAGE_PARAM)) || 1);
  const [page, setPage] = useState(initialPage);

  // Accumulated, de-duplicated listings across every page fetched so far —
  // pagination here is infinite-scroll style, so each successful fetch is
  // appended rather than replacing the grid.
  // Seed with server-pre-fetched data when available (issue #677).
  const [accumulated, setAccumulated] = useState<GridTrade[]>(
    () => (initialPage === 1 && initialTrades && initialTrades.length > 0)
      ? (initialTrades as GridTrade[])
      : [],
  );

  // When initialTrades are present we already have page 1; don't re-fetch it.
  const [ssrHydrated] = useState(
    () => initialPage === 1 && !!initialTrades && initialTrades.length > 0,
  );

  const assetTypeParam = activeFilter === "ALL" ? undefined : activeFilter;

  const { trades, total, isLoading, error } = useTradeList({
    page,
    limit: pageSize,
    assetType: assetTypeParam,
  });

  // Merge the current page's results into the accumulated list, de-duplicated
  // by id so an offer inserted between fetches never appears twice.
  // Skip the merge for page 1 when it was already seeded from SSR data
  // (issue #677) — the client fetch would just re-fetch the same records.
  useEffect(() => {
    if (isLoading || error) return;
    if (ssrHydrated && page === 1 && activeFilter === "ALL") return;
    setAccumulated((prev) => {
      const seen = new Set(prev.map((t) => t.id));
      const newItems = (trades as unknown as GridTrade[]).filter((t) => !seen.has(t.id));
      if (newItems.length === 0) return prev;
      return [...prev, ...newItems];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, isLoading, error]);

  // Sync local state when the URL's `page` param changes externally (browser
  // Back/Forward). Truncate the accumulated list back down to what that page
  // depth would have shown, so Back returns to roughly the right position.
  useEffect(() => {
    const urlPage = Math.max(1, Number(searchParams?.get(PAGE_PARAM)) || 1);
    if (urlPage !== page) {
      setPage(urlPage);
      setAccumulated((prev) =>
        prev.length > urlPage * pageSize ? prev.slice(0, urlPage * pageSize) : prev,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const isInitialLoad = isLoading && page === 1 && accumulated.length === 0;
  const isLoadingMore = isLoading && !isInitialLoad;

  // Use the server-pre-fetched total for the first render; switch to the live
  // value once a client fetch has completed (issue #677).
  const displayedTotal = total > 0 ? total : (initialTotal ?? 0);

  const reachedEnd =
    !isLoading &&
    !error &&
    accumulated.length > 0 &&
    ((trades as unknown as GridTrade[]).length < pageSize ||
      (displayedTotal > 0 && accumulated.length >= displayedTotal));

  const updatePageInUrl = useCallback(
    (nextPage: number) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (nextPage > 1) params.set(PAGE_PARAM, String(nextPage));
      else params.delete(PAGE_PARAM);
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const loadNextPage = useCallback(() => {
    if (isLoading || reachedEnd) return;
    const nextPage = page + 1;
    setPage(nextPage);
    updatePageInUrl(nextPage);
  }, [isLoading, reachedEnd, page, updatePageInUrl]);

  const handleFilterChange = (value: FilterValue) => {
    setActiveFilter(value);
    setPage(1);
    setAccumulated([]);
    updatePageInUrl(1);
  };

  // Infinite scroll: observe a sentinel below the grid and load the next
  // page once it scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || reachedEnd || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadNextPage, reachedEnd, accumulated.length]);

  const displayedTrades = useMemo(() => accumulated, [accumulated]);

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
          {!isInitialLoad && displayedTotal > 0 && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {displayedTotal} {displayedTotal === 1 ? "offer" : "offers"} available
            </p>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-6">
        <FilterBar active={activeFilter} onChange={handleFilterChange} />
      </div>

      {/* Grid */}
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
        >
          {accumulated.length > 0
            ? "Could not load newer listings — showing cached results. Please refresh to try again."
            : "Failed to load listings. Please refresh the page."}
        </div>
      ) : isInitialLoad ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {displayedTrades.length === 0 ? (
            <EmptyState filtered={activeFilter !== "ALL"} />
          ) : (
            displayedTrades.map((trade) => <TradeCard key={trade.id} trade={trade} />)
          )}
        </div>
      )}

      {/* Pagination footer: spinner while loading more, a manual "next page"
          control as a fallback to scroll-triggered loading, or an
          end-of-results message once every page has been fetched. */}
      {!error && !isInitialLoad && displayedTrades.length > 0 && (
        <div className="mt-8 flex justify-center" data-testid="listings-pagination-footer">
          {isLoadingMore ? (
            <Spinner size="md" label="Loading more listings…" />
          ) : reachedEnd ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">
              You&apos;ve reached the end of the listings.
            </p>
          ) : (
            <button
              type="button"
              onClick={loadNextPage}
              className="rounded-xl border border-gray-200 bg-white px-5 py-2 text-sm font-semibold text-gray-700 transition-colors hover:border-violet-300 hover:text-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:border-violet-500 dark:hover:text-violet-300"
            >
              Load next page
            </button>
          )}
        </div>
      )}

      {/* Scroll-to-bottom trigger for infinite scroll. */}
      <div ref={sentinelRef} aria-hidden="true" data-testid="listings-sentinel" />
    </section>
  );
}
