"use client";

/**
 * Admin dashboard (Issue #23).
 *
 * # On the client-side role check
 *
 * The `role !== "admin"` guard below renders a 403 instead of the dashboard.
 * That is a **UX affordance, not a security control** — the JWT lives in the
 * browser and its payload is readable and editable by whoever holds it, so a
 * determined user can always make this component render.
 *
 * What actually protects the data is that every endpoint behind it runs
 * `authenticate` + `requireAdmin` server-side. A forged client-side role gets
 * a dashboard full of 403s and no data. The check here exists so a normal
 * non-admin sees a clear message rather than a broken page.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { StellarExplorerLink } from "../../components/StellarExplorerLink";

interface Metrics {
  totalUsers: number;
  openTrades: number;
  lockedTrades: number;
  completedTrades: number;
  disputedTrades: number;
  totalVolume: number;
}

interface DisputedTrade {
  id: string;
  status: string;
  amount: string;
  created_at: string;
  buyer_phone: string | null;
  seller_phone: string | null;
}

interface UserLookup {
  user: {
    id: string;
    phone: string;
    role: string;
    created_at: string;
    fiat_balance: string | null;
    stellar_public_key: string | null;
  };
  trades: Array<{ id: string; status: string; amount: string; created_at: string }>;
}

interface FlaggedAccount {
  user_id: string;
  violation_count: number;
  last_violation_at: string;
}

type Resolution = "release_to_seller" | "refund_to_buyer";

export default function AdminDashboardPage(): JSX.Element {
  const { user, token, isLoading } = useAuth();

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [disputed, setDisputed] = useState<DisputedTrade[]>([]);
  const [flaggedAccounts, setFlaggedAccounts] = useState<FlaggedAccount[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [resolving, setResolving] = useState<DisputedTrade | null>(null);
  const [resolution, setResolution] = useState<Resolution>("release_to_seller");
  const [submitting, setSubmitting] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [phoneQuery, setPhoneQuery] = useState("");
  const [lookup, setLookup] = useState<UserLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const authHeaders = useCallback(
    (): HeadersInit => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token ?? ""}`,
    }),
    [token]
  );

  const loadDashboard = useCallback(async () => {
    if (!token) return;
    setLoadError(null);

    try {
      const [metricsRes, tradesRes, flaggedRes] = await Promise.all([
        fetch("/api/v1/admin/metrics", { headers: authHeaders() }),
        fetch("/api/v1/admin/trades?status=disputed", { headers: authHeaders() }),
        fetch("/api/v1/admin/flagged-accounts", { headers: authHeaders() }),
      ]);

      if (metricsRes.status === 403 || tradesRes.status === 403) {
        setLoadError("Your account does not have admin access.");
        return;
      }

      if (metricsRes.ok) {
        setMetrics((await metricsRes.json()) as Metrics);
      }
      if (tradesRes.ok) {
        const body = (await tradesRes.json()) as { trades?: DisputedTrade[] };
        setDisputed(body.trades || []);
      }
      if (flaggedRes.ok) {
        const body = (await flaggedRes.json()) as { flaggedAccounts?: FlaggedAccount[] };
        setFlaggedAccounts(body.flaggedAccounts || []);
      }
    } catch {
      setLoadError("Could not reach the server.");
    }
  }, [token, authHeaders]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  async function submitResolution(): Promise<void> {
    if (!resolving) return;
    setSubmitting(true);
    setResolveError(null);

    try {
      const res = await fetch(`/api/v1/admin/trades/${resolving.id}/resolve`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ resolution }),
      });

      if (res.status === 409) {
        // Another admin got there first. Reload rather than leaving a stale
        // row on screen that would invite a second attempt.
        setResolveError("This trade is no longer disputed — someone else resolved it.");
        await loadDashboard();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResolveError(body.error ?? "Failed to resolve the trade.");
        return;
      }

      setResolving(null);
      await loadDashboard();
    } catch {
      setResolveError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function searchUser(): Promise<void> {
    if (!phoneQuery.trim()) return;
    setLookupError(null);
    setLookup(null);

    try {
      const res = await fetch(
        `/api/v1/admin/users?phone=${encodeURIComponent(phoneQuery.trim())}`,
        { headers: authHeaders() }
      );

      if (res.status === 404) {
        setLookupError("No user with that phone number.");
        return;
      }
      if (!res.ok) {
        setLookupError("Lookup failed.");
        return;
      }

      setLookup((await res.json()) as UserLookup);
    } catch {
      setLookupError("Could not reach the server.");
    }
  }

  if (isLoading) {
    return (
      <main className="flex justify-center p-16">
        <Spinner size="lg" label="Loading admin dashboard…" />
      </main>
    );
  }

  if (!user || user.role !== "admin") {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-10 text-center">
        <h1 className="text-2xl font-bold text-white">403 — Forbidden</h1>
        <p className="max-w-sm text-sm text-zinc-400">
          This area is restricted to administrator accounts.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-white">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Platform metrics, dispute resolution, and account lookup.
        </p>
      </header>

      {loadError && (
        <p className="mb-6 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
          {loadError}
        </p>
      )}

      {/* ── Metrics ────────────────────────────────────────────────────── */}
      {metrics && (
        <section className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "Total users", value: metrics.totalUsers },
            { label: "Open trades", value: metrics.openTrades },
            { label: "Locked trades", value: metrics.lockedTrades },
            { label: "Completed", value: metrics.completedTrades },
            {
              label: "Platform volume",
              value: metrics.totalVolume.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              }),
            },
          ].map((stat) => (
            <Card
              key={stat.label}
              className="border-white/10 bg-white/5 p-4"
            >
              <p className="text-xs uppercase tracking-wide text-zinc-400">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold text-white">{stat.value}</p>
            </Card>
          ))}
        </section>
      )}

      {/* ── Disputed trades ────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold text-white">
          Disputed trades{disputed.length > 0 ? ` (${disputed.length})` : ""}
        </h2>

        {disputed.length === 0 ? (
          <p className="text-sm text-zinc-500">No trades are currently disputed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Trade</th>
                  <th className="pb-2 font-medium">Buyer</th>
                  <th className="pb-2 font-medium">Seller</th>
                  <th className="pb-2 font-medium">Amount</th>
                  <th className="pb-2 font-medium">Opened</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {disputed.map((trade) => (
                  <tr key={trade.id} className="border-t border-white/5">
                    <td className="py-2 font-mono text-xs">{trade.id.slice(0, 8)}…</td>
                    <td className="py-2">{trade.buyer_phone ?? "—"}</td>
                    <td className="py-2">{trade.seller_phone ?? "—"}</td>
                    <td className="py-2">{trade.amount}</td>
                    <td className="py-2 text-xs text-zinc-500">
                      {new Date(trade.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setResolving(trade);
                          setResolution("release_to_seller");
                          setResolveError(null);
                        }}
                      >
                        Resolve
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Flagged Accounts ────────────────────────────────────────────── */}
      <section className="mb-10 rounded-xl border border-red-500/20 bg-red-950/10 p-5">
        <h2 className="mb-4 text-lg font-semibold text-red-200">
          Flagged Accounts{flaggedAccounts.length > 0 ? ` (${flaggedAccounts.length})` : ""}
        </h2>

        {flaggedAccounts.length === 0 ? (
          <p className="text-sm text-zinc-500">No flagged accounts with high velocity violations in the last 24 hours.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-red-400/70">
                <tr>
                  <th className="pb-2 font-medium">User ID</th>
                  <th className="pb-2 font-medium">Violations (24h)</th>
                  <th className="pb-2 font-medium">Last Violation</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {flaggedAccounts.map((account) => (
                  <tr key={account.user_id} className="border-t border-white/5">
                    <td className="py-2 font-mono text-xs text-red-300">{account.user_id}</td>
                    <td className="py-2 text-sm font-bold text-red-400">{account.violation_count}</td>
                    <td className="py-2 text-xs text-zinc-400">
                      {new Date(account.last_violation_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── User lookup ────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold text-white">User lookup</h2>

        <div className="flex flex-wrap gap-2">
          <input
            value={phoneQuery}
            onChange={(e) => setPhoneQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void searchUser();
            }}
            placeholder="Phone number (exact match)"
            className="flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          <button
            type="button"
            onClick={() => void searchUser()}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm text-zinc-100 hover:bg-white/20"
          >
            Search
          </button>
        </div>

        {lookupError && <p className="mt-3 text-sm text-red-300">{lookupError}</p>}

        {lookup && (
          <div className="mt-5 space-y-4">
            <dl className="grid grid-cols-[130px_1fr] gap-y-1 text-sm">
              <dt className="text-zinc-500">Phone</dt>
              <dd className="text-zinc-200">{lookup.user.phone}</dd>
              <dt className="text-zinc-500">Role</dt>
              <dd className="text-zinc-200">{lookup.user.role}</dd>
              <dt className="text-zinc-500">Fiat balance</dt>
              <dd className="text-zinc-200">{lookup.user.fiat_balance ?? "0.00"}</dd>
              <dt className="text-zinc-500">Stellar key</dt>
              <dd className="truncate font-mono text-xs text-zinc-400">
                {lookup.user.stellar_public_key ? (
                  <StellarExplorerLink
                    type="account"
                    value={lookup.user.stellar_public_key}
                    truncate={false}
                  />
                ) : (
                  "—"
                )}
              </dd>
            </dl>

            <div>
              <h3 className="mb-2 text-sm font-medium text-zinc-300">
                Trade history ({lookup.trades.length})
              </h3>
              {lookup.trades.length === 0 ? (
                <p className="text-xs text-zinc-500">No trades.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {lookup.trades.map((t) => (
                    <li
                      key={t.id}
                      className="flex justify-between rounded border border-white/5 px-3 py-1.5 text-zinc-400"
                    >
                      <span className="font-mono">{t.id.slice(0, 8)}…</span>
                      <span>{t.status}</span>
                      <span>{t.amount}</span>
                      <span>{new Date(t.created_at).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Resolve modal ──────────────────────────────────────────────── */}
      {resolving && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resolve-title"
        >
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-950 p-5">
            <h3 id="resolve-title" className="text-lg font-semibold text-white">
              Resolve trade {resolving.id.slice(0, 8)}…
            </h3>
            <p className="mt-1 text-xs text-zinc-400">
              This moves funds and cannot be undone from here. Both parties are
              notified immediately.
            </p>

            <fieldset className="mt-4 space-y-2">
              <legend className="sr-only">Resolution</legend>
              {(
                [
                  ["release_to_seller", "Release to seller", `Seller receives ${resolving.amount}.`],
                  ["refund_to_buyer", "Refund to buyer", `Buyer is refunded ${resolving.amount}.`],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                    resolution === value
                      ? "border-emerald-400/50 bg-emerald-500/10"
                      : "border-white/10 hover:bg-white/5"
                  }`}
                >
                  <input
                    type="radio"
                    name="resolution"
                    value={value}
                    checked={resolution === value}
                    onChange={() => setResolution(value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm text-zinc-100">{label}</span>
                    <span className="block text-xs text-zinc-500">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {resolveError && (
              <p className="mt-3 rounded border border-red-400/30 bg-red-500/10 p-2 text-xs text-red-200">
                {resolveError}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResolving(null)}
                disabled={submitting}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitResolution()}
                disabled={submitting}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
              >
                {submitting ? "Resolving…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
