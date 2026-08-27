"use client";

import { useState, useEffect, useCallback } from "react";
import { getToken, getUser, isAuthenticated } from "../lib/auth";
import type { TradeOffer, TradeStatus } from "../../../server/src/types/trade";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileData {
  id: string;
  maskedPhone: string;
  createdAt: string;
  totalTradesCompleted: number;
  stellarPublicKey: string;
}

interface ProfileResponse {
  data?: ProfileData;
  error?: string;
}

interface TradesResponse {
  data: TradeOffer[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  error?: string;
}

type FilterStatus = "All" | "Completed" | "Cancelled" | "Locked" | "Active";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITEMS_PER_PAGE = 10;

const FILTER_OPTIONS: { value: FilterStatus; label: string }[] = [
  { value: "All",       label: "All" },
  { value: "Completed", label: "Completed" },
  { value: "Cancelled", label: "Cancelled" },
  { value: "Locked",    label: "Disputed" },
  { value: "Active",    label: "Active" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAssetType(raw: string): string {
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <svg
      className="h-5 w-5 animate-spin text-violet-600 dark:text-violet-400"
      viewBox="0 0 24 24"
      fill="none"
      aria-label={label}
      role="img"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
    </svg>
  );
}

/** Status badge — matches design system used in TradeDetailClient */
function StatusBadge({ status }: { status: TradeStatus }) {
  const styles: Record<TradeStatus, string> = {
    Active:    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    Locked:    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    Completed: "bg-blue-100  text-blue-700  dark:bg-blue-900/40  dark:text-blue-300",
    Cancelled: "bg-gray-100  text-gray-500  dark:bg-gray-700     dark:text-gray-400",
    Disputed:  "bg-red-100   text-red-700   dark:bg-red-900/40   dark:text-red-300",
  };

  // Display "Disputed" in the UI for Locked trades to match filter label
  const label = status === "Locked" ? "Disputed" : status;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        styles[status] ?? "bg-gray-100 text-gray-500"
      }`}
    >
      {label}
    </span>
  );
}

/** A single stat card in the profile summary */
function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <span aria-hidden="true" className="text-2xl">{icon}</span>
      <p className="mt-1 text-2xl font-extrabold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
    </div>
  );
}

/** Pagination controls */
function Pagination({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-4 pt-4 border-t border-gray-100 dark:border-gray-700">
      <button
        type="button"
        onClick={onPrev}
        disabled={page <= 1}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:disabled:opacity-30"
        aria-label="Previous page"
      >
        ← Previous
      </button>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Page <span className="font-semibold text-gray-900 dark:text-gray-100">{page}</span>{" "}
        of <span className="font-semibold text-gray-900 dark:text-gray-100">{totalPages}</span>
      </p>

      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:disabled:opacity-30"
        aria-label="Next page"
      >
        Next →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

function EmptyTrades({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span aria-hidden="true" className="text-4xl">📭</span>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {filtered ? "No trades match this filter." : "You haven't made any trades yet."}
      </p>
      {!filtered && (
        <a
          href="/"
          className="mt-1 text-sm font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
        >
          Browse the marketplace →
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transaction table row
// ---------------------------------------------------------------------------

function TradeRow({
  trade,
  currentUserId,
}: {
  trade: TradeOffer;
  currentUserId: string;
}) {
  const isSeller       = trade.seller_id === currentUserId;
  const counterpartyId = isSeller ? trade.buyer_id : trade.seller_id;
  const counterparty   = counterpartyId
    ? `@${isSeller ? "buyer" : "seller"}_${counterpartyId.slice(-8)}`
    : "—";
  const role = isSeller ? "Seller" : "Buyer";

  return (
    <tr className="group border-b border-gray-50 transition-colors hover:bg-gray-50/60 dark:border-gray-700/60 dark:hover:bg-gray-700/30">
      {/* Date */}
      <td className="py-3.5 pl-5 pr-4 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
        {formatDate(trade.created_at)}
      </td>

      {/* Asset */}
      <td className="px-4 py-3.5">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {formatAssetType(trade.asset_type)}
        </span>
      </td>

      {/* Amount */}
      <td className="px-4 py-3.5 text-sm font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap">
        ₦{trade.amount.toLocaleString()}
      </td>

      {/* Role */}
      <td className="px-4 py-3.5">
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
          isSeller
            ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
            : "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
        }`}>
          {role}
        </span>
      </td>

      {/* Counterparty */}
      <td className="px-4 py-3.5 text-sm text-gray-500 dark:text-gray-400 font-mono">
        {counterparty}
      </td>

      {/* Status */}
      <td className="py-3.5 pl-4 pr-5 text-right">
        <StatusBadge status={trade.status} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Mobile trade card (shown on small screens instead of the table)
// ---------------------------------------------------------------------------

function TradeMobileCard({
  trade,
  currentUserId,
}: {
  trade: TradeOffer;
  currentUserId: string;
}) {
  const isSeller       = trade.seller_id === currentUserId;
  const counterpartyId = isSeller ? trade.buyer_id : trade.seller_id;
  const counterparty   = counterpartyId
    ? `@${isSeller ? "buyer" : "seller"}_${counterpartyId.slice(-8)}`
    : "—";

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {formatAssetType(trade.asset_type)}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {formatDateTime(trade.created_at)}
          </p>
        </div>
        <StatusBadge status={trade.status} />
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500 dark:text-gray-400">Amount</span>
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          ₦{trade.amount.toLocaleString()}
        </span>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500 dark:text-gray-400">Counterparty</span>
        <span className="font-mono text-gray-600 dark:text-gray-400 text-xs">{counterparty}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function ProfilePage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");

  // Profile data
  const [profile, setProfile]       = useState<ProfileData | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Trade history
  const [trades, setTrades]         = useState<TradeOffer[]>([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [tradesLoading, setTradesLoading] = useState(true);
  const [tradesError, setTradesError]     = useState<string | null>(null);

  // Filter + pagination state
  const [filter, setFilter]   = useState<FilterStatus>("All");
  const [page, setPage]       = useState(1);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isAuthenticated()) {
      window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/profile");
      return;
    }
    const user = getUser();
    setCurrentUserId(user?.id ?? "");
    setAuthChecked(true);
  }, []);

  // -------------------------------------------------------------------------
  // Fetch profile metadata
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!authChecked) return;

    const token = getToken();
    if (!token) return;

    setProfileLoading(true);
    setProfileError(null);

    fetch(`${apiUrl}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<ProfileResponse>)
      .then((data) => {
        if (data.error || !data.data) {
          setProfileError(data.error ?? "Failed to load profile.");
        } else {
          setProfile(data.data);
        }
      })
      .catch(() => setProfileError("Network error. Check your connection."))
      .finally(() => setProfileLoading(false));
  }, [authChecked, apiUrl]);

  // -------------------------------------------------------------------------
  // Fetch trade history (re-runs when page or filter changes)
  // -------------------------------------------------------------------------
  const fetchTrades = useCallback(() => {
    const token = getToken();
    if (!token) return;

    setTradesLoading(true);
    setTradesError(null);

    const params = new URLSearchParams({
      page:   String(page),
      limit:  String(ITEMS_PER_PAGE),
      status: filter,
    });

    fetch(`${apiUrl}/api/v1/profile/trades?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<TradesResponse>)
      .then((data) => {
        if (data.error) {
          setTradesError(data.error);
        } else {
          setTrades(data.data ?? []);
          setPagination({
            page:       data.pagination.page,
            totalPages: data.pagination.totalPages,
            total:      data.pagination.total,
          });
        }
      })
      .catch(() => setTradesError("Network error. Check your connection."))
      .finally(() => setTradesLoading(false));
  }, [page, filter, apiUrl]);

  useEffect(() => {
    if (authChecked) fetchTrades();
  }, [authChecked, fetchTrades]);

  // Reset to page 1 when filter changes
  function handleFilterChange(value: FilterStatus) {
    setFilter(value);
    setPage(1);
  }

  // -------------------------------------------------------------------------
  // Loading / auth gate
  // -------------------------------------------------------------------------
  if (!authChecked) {
    return (
      <div className="flex items-center justify-center py-32">
        <Spinner label="Checking authentication…" />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="flex flex-col gap-10">

      {/* ------------------------------------------------------------------ */}
      {/* Page heading                                                         */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          Account
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
          My Profile
        </h1>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Profile summary                                                      */}
      {/* ------------------------------------------------------------------ */}
      {profileLoading ? (
        <div className="flex items-center gap-3 py-6">
          <Spinner label="Loading profile…" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading profile…</p>
        </div>
      ) : profileError ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
        >
          {profileError}
        </div>
      ) : profile ? (
        <section aria-labelledby="profile-summary-heading">
          <h2
            id="profile-summary-heading"
            className="mb-4 text-lg font-bold text-gray-900 dark:text-gray-100"
          >
            Account Details
          </h2>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <StatCard
              icon="📱"
              label="Phone number"
              value={profile.maskedPhone}
            />
            <StatCard
              icon="📅"
              label="Member since"
              value={formatDate(profile.createdAt)}
            />
            <StatCard
              icon="✅"
              label="Trades completed"
              value={profile.totalTradesCompleted}
            />
          </div>

          {/* Stellar public key */}
          {profile.stellarPublicKey && (
            <div className="mt-4 flex flex-col gap-1 rounded-xl border border-gray-100 bg-white px-5 py-4 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Stellar Public Key
              </p>
              <p className="break-all font-mono text-xs text-gray-700 dark:text-gray-300">
                {profile.stellarPublicKey}
              </p>
            </div>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Transaction history                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="history-heading">
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2
              id="history-heading"
              className="text-lg font-bold text-gray-900 dark:text-gray-100"
            >
              Transaction History
            </h2>
            {!tradesLoading && (
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                {pagination.total} trade{pagination.total !== 1 ? "s" : ""} total
              </p>
            )}
          </div>

          {/* Filter control */}
          <div
            role="group"
            aria-label="Filter trades by status"
            className="flex flex-wrap gap-2"
          >
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleFilterChange(opt.value)}
                aria-pressed={filter === opt.value}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
                  filter === opt.value
                    ? "border-violet-500 bg-violet-600 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-violet-500 dark:hover:text-violet-400"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {tradesLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner label="Loading transactions…" />
          </div>
        )}

        {/* Error */}
        {!tradesLoading && tradesError && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            {tradesError}
            <button
              type="button"
              onClick={fetchTrades}
              className="ml-3 font-semibold underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty */}
        {!tradesLoading && !tradesError && trades.length === 0 && (
          <EmptyTrades filtered={filter !== "All"} />
        )}

        {/* Desktop table */}
        {!tradesLoading && !tradesError && trades.length > 0 && (
          <>
            <div className="hidden sm:block overflow-x-auto rounded-2xl border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
              <table className="w-full text-left" aria-label="Transaction history">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700">
                    <th className="py-3 pl-5 pr-4 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Date
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Asset
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Role
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Counterparty
                    </th>
                    <th className="py-3 pl-4 pr-5 text-right text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <TradeRow
                      key={trade.id}
                      trade={trade}
                      currentUserId={currentUserId}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="flex flex-col gap-3 sm:hidden">
              {trades.map((trade) => (
                <TradeMobileCard
                  key={trade.id}
                  trade={trade}
                  currentUserId={currentUserId}
                />
              ))}
            </div>

            {/* Pagination */}
            <div className="mt-4">
              <Pagination
                page={page}
                totalPages={pagination.totalPages}
                onPrev={() => setPage((p) => Math.max(1, p - 1))}
                onNext={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
