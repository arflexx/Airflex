"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { getToken, isAuthenticated } from "../lib/auth";
import DepositModal, { type VirtualAccount } from "./DepositModal";
import WithdrawModal from "./WithdrawModal";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { StellarExplorerLink } from "../../components/StellarExplorerLink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalletData {
  publicKey: string;
  balance: string;
  asset: string;
  network: string;
}

interface WalletResponse {
  publicKey?: string;
  balance?: string;
  asset?: string;
  network?: string;
  virtualAccount?: VirtualAccount | null;
  error?: string;
}

/** Status values returned by the wallet transactions endpoint. */
type WalletTransactionStatus = "Active" | "Locked" | "Completed" | "Cancelled" | "Disputed";

interface WalletTransaction {
  id: string;
  asset_type: string;
  amount: number;
  status: WalletTransactionStatus;
  escrow_tx_hash: string | null;
  created_at: string;
}

/**
 * Maps a WalletTransactionStatus to a BadgeStatusVariant.
 * "Active" on the backend is displayed as "Open" in the UI because
 * the trade is open/available, not yet locked by a buyer.
 */
function walletStatusToBadgeVariant(
  status: WalletTransactionStatus,
): "Open" | "Locked" | "Completed" | "Cancelled" | "Disputed" {
  if (status === "Active") return "Open";
  return status;
}

interface TradesResponse {
  data?: WalletTransaction[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  error?: string;
}

/**
 * Rows per page (Issue #336).
 *
 * The endpoint already paginates; the page previously asked for a single fixed
 * window of ten and rendered whatever came back, so a user with a long history
 * could neither see nor reach the rest of it.
 */
const TRADES_PER_PAGE = 10;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalletPage() {
  const t = useTranslations("Wallet");
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  const [authChecked, setAuthChecked] = useState(false);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [virtualAccount, setVirtualAccount] = useState<VirtualAccount | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDepositOpen, setIsDepositOpen] = useState(false);

  // Trade history paging (Issue #336)
  const [page, setPage] = useState(1);
  const [totalTrades, setTotalTrades] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [tradesLoading, setTradesLoading] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!isAuthenticated()) {
      window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/wallet");
      return;
    }
    setAuthChecked(true);
  }, []);

  // Fetch wallet data
  useEffect(() => {
    if (!authChecked) return;

    const token = getToken();
    if (!token) return;

    setLoading(true);
    setError(null);

    fetch(`${apiUrl}/api/v1/wallet`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<WalletResponse>)
      .then((data) => {
        if (data.error || !data.publicKey) {
          setError(data.error ?? t("loadFailed"));
        } else {
          setWallet({
            publicKey: data.publicKey,
            balance: data.balance ?? "0",
            asset: data.asset ?? "XLM",
            network: data.network ?? "testnet",
          });
          setVirtualAccount(data.virtualAccount ?? null);
        }
      })
      .catch(() => setError(t("networkError")))
      .finally(() => setLoading(false));
  }, [authChecked, apiUrl, t]);

  // Fetch one page of trade history — re-runs whenever the page changes.
  // A failure here leaves the wallet card usable: the history is secondary.
  const fetchTrades = useCallback(() => {
    const token = getToken();
    if (!token) return;

    setTradesLoading(true);

    const params = new URLSearchParams({
      page: String(page),
      limit: String(TRADES_PER_PAGE),
    });

    fetch(`${apiUrl}/api/v1/profile/trades?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? (r.json() as Promise<TradesResponse>) : { data: [] }))
      .catch(() => ({ data: [] }) as TradesResponse)
      .then((tradesData) => {
        setTransactions(Array.isArray(tradesData.data) ? tradesData.data : []);
        if (tradesData.pagination) {
          setTotalTrades(tradesData.pagination.total);
          setTotalPages(Math.max(tradesData.pagination.totalPages, 1));
        }
      })
      .finally(() => setTradesLoading(false));
  }, [apiUrl, page]);

  useEffect(() => {
    if (authChecked) fetchTrades();
  }, [authChecked, fetchTrades]);

  function handleWithdrawSuccess() {
    // Refresh wallet data after successful withdrawal
    const token = getToken();
    if (!token) return;

    setLoading(true);
    fetch(`${apiUrl}/api/v1/wallet`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<WalletResponse>)
      .then((data) => {
        if (data.publicKey) {
          setWallet({
            publicKey: data.publicKey,
            balance: data.balance ?? "0",
            asset: data.asset ?? "XLM",
            network: data.network ?? "testnet",
          });
          setVirtualAccount(data.virtualAccount ?? null);
        }
      })
      .catch(() => setError(t("refreshFailed")))
      .finally(() => setLoading(false));
  }

  // Range shown on this page. Derived from the server's total rather than the
  // rows in hand, so the last page reads "41–47 of 47" and not "41–50".
  const rangeStart = totalTrades === 0 ? 0 : (page - 1) * TRADES_PER_PAGE + 1;
  const rangeEnd = Math.min(page * TRADES_PER_PAGE, totalTrades);
  const canGoPrevious = page > 1 && !tradesLoading;
  const canGoNext = page < totalPages && !tradesLoading;

  if (!authChecked || loading) {
    return (
      <div className="flex items-center justify-center py-32">
<Spinner size="lg" label="Loading wallet details…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Page heading */}
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          {t("label")}
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
          {t("title")}
        </h1>
      </div>

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {/* Wallet card */}
      {wallet && (
        <Card className="flex flex-col">
          <div className="mb-6 flex flex-col gap-1">
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
              {t("availableBalance")}
            </p>
            <p className="text-4xl font-extrabold text-gray-900 dark:text-gray-100">
              ₦{parseFloat(wallet.balance).toLocaleString()}
            </p>
          </div>

          <div className="mb-6 flex flex-col gap-2 rounded-xl bg-gray-50 p-4 dark:bg-gray-700">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
Stellar Public Key (On-chain Account)
            </p>
            <p className="break-all font-mono text-xs text-gray-700 dark:text-gray-300">
              {wallet.publicKey}
            </p>
            <div className="flex items-center gap-2">
              <StellarExplorerLink
                type="account"
                value={wallet.publicKey}
                className="text-xs font-mono break-all"
                truncate={false}
              />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                {wallet.network}
              </span>
              <span className="inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-600 dark:text-gray-300">
                {wallet.asset}
              </span>
            </div>
          </div>

<div className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant="primary"
              onClick={() => setIsDepositOpen(true)}
              className="w-full"
            >
              Deposit
            </Button>
            <Button
              variant="secondary"
              onClick={() => setIsModalOpen(true)}
              className="w-full"
            >
              {t("withdrawFunds")}
            </Button>
          </div>
        </Card>
      )}

      {/* Transaction Rows with Stellar Explorer Deep-Links (Issue #66) */}
      <Card noPadding>
        <CardHeader className="p-6">
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {tradesLoading && transactions.length === 0 ? (
            <div className="flex justify-center px-6 py-8">
              <Spinner label="Loading transactions…" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No transactions found on this account yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label="Wallet transactions">
                <thead className="border-b border-gray-100 bg-gray-50/50 text-xs font-semibold text-gray-500 uppercase tracking-wider dark:border-gray-700/60 dark:bg-gray-900/30 dark:text-gray-400">
                  <tr>
                    <th className="px-6 py-3">Date</th>
                    <th className="px-6 py-3">Asset</th>
                    <th className="px-6 py-3">Amount</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Stellar Transaction</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/60">
                  {transactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-750/30 transition-colors">
                      <td className="px-6 py-3.5 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                        {new Date(tx.created_at).toLocaleDateString("en-NG", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-6 py-3.5 font-medium text-gray-900 dark:text-gray-100">
                        {tx.asset_type}
                      </td>
                      <td className="px-6 py-3.5 font-semibold text-gray-900 dark:text-gray-100">
                        ₦{tx.amount.toLocaleString()}
                      </td>
                      <td className="px-6 py-3.5">
                        <Badge variant={walletStatusToBadgeVariant(tx.status)} />
                      </td>
                      <td className="px-6 py-3.5">
                        {tx.escrow_tx_hash ? (
                          <StellarExplorerLink
                            type="transaction"
                            value={tx.escrow_tx_hash}
                          />
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination controls (Issue #336) */}
          {totalTrades > 0 && (
            <div className="flex flex-col items-center justify-between gap-3 border-t border-gray-100 px-6 py-4 sm:flex-row dark:border-gray-700/60">
              <p
                data-testid="trades-range"
                aria-live="polite"
                className="text-xs text-gray-500 dark:text-gray-400"
              >
                Showing {rangeStart}–{rangeEnd} of {totalTrades}{" "}
                {totalTrades === 1 ? "trade" : "trades"}
              </p>

              <nav className="flex items-center gap-2" aria-label="Trade history pages">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={!canGoPrevious}
                >
                  Previous
                </Button>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={!canGoNext}
                >
                  Next
                </Button>
              </nav>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deposit Modal (Issue #25) */}
      <DepositModal
        isOpen={isDepositOpen}
        onClose={() => setIsDepositOpen(false)}
        onDepositSuccess={handleWithdrawSuccess}
        virtualAccount={virtualAccount}
      />

      {/* Withdraw Modal */}
      <WithdrawModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        currentBalance={wallet?.balance ?? "0"}
        onWithdrawSuccess={handleWithdrawSuccess}
      />
    </div>
  );
}
