"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { getToken, isAuthenticated } from "../lib/auth";
import type { VirtualAccount } from "./DepositModal";
import type { WalletTransaction } from "./TransactionHistory";
import { ModalSkeleton, TransactionHistorySkeleton } from "./WalletSkeletons";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { StellarExplorerLink } from "../../components/StellarExplorerLink";
import { useOptimisticBalance } from "../hooks/useOptimisticBalance";
import { reconcileList } from "../../lib/stableList";

const transactionKey = (tx: WalletTransaction): string => tx.id;

// ---------------------------------------------------------------------------
// Code-split chunks (Issue #544)
//
// The balance card is what users come here for, so it ships in the initial
// bundle. The trade history table and the two modals (DepositModal also pulls
// in the Paystack checkout flow) load as separate client-only chunks: the
// history right after first paint behind a skeleton, the modals only once the
// user first opens them.
// ---------------------------------------------------------------------------

const TransactionHistory = dynamic(() => import("./TransactionHistory"), {
  ssr: false,
  loading: () => <TransactionHistorySkeleton />,
});

const DepositModal = dynamic(() => import("./DepositModal"), {
  ssr: false,
  loading: () => <ModalSkeleton />,
});

const WithdrawModal = dynamic(() => import("./WithdrawModal"), {
  ssr: false,
  loading: () => <ModalSkeleton />,
});

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
  // Modals stay unmounted (and their chunks unloaded) until first opened, then
  // stay mounted so their close/cleanup effects keep running.
  const [depositMounted, setDepositMounted] = useState(false);
  const [withdrawMounted, setWithdrawMounted] = useState(false);

  // Trade history paging (Issue #336)
  const [page, setPage] = useState(1);
  const [totalTrades, setTotalTrades] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [tradesLoading, setTradesLoading] = useState(false);

  // Optimistic balance (issue #447): the displayed balance updates
  // immediately on submit and reverts if the server rejects the action.
  const {
    displayedBalance,
    displayedNumber,
    pending: optimisticPending,
    apply: applyOptimistic,
    revert: revertOptimistic,
  } = useOptimisticBalance(wallet?.balance ?? "0");

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
        // Keep the previous array when the page's rows are unchanged so the
        // memoized TransactionHistory skips re-rendering.
        const next = Array.isArray(tradesData.data) ? tradesData.data : [];
        setTransactions((prev) => reconcileList(prev, next, transactionKey));
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
            <p
              className="text-4xl font-extrabold text-gray-900 dark:text-gray-100"
              aria-live="polite"
            >
              ₦{displayedBalance}
              {optimisticPending && (
                <span className="ml-2 align-middle text-xs font-medium text-violet-500 dark:text-violet-400">
                  updating…
                </span>
              )}
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
              onClick={() => {
                setDepositMounted(true);
                setIsDepositOpen(true);
              }}
              className="w-full"
            >
              Deposit
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setWithdrawMounted(true);
                setIsModalOpen(true);
              }}
              className="w-full"
            >
              {t("withdrawFunds")}
            </Button>
          </div>
        </Card>
      )}

      {/* Transaction Rows with Stellar Explorer Deep-Links (Issue #66) */}
      <TransactionHistory
        transactions={transactions}
        loading={tradesLoading}
        page={page}
        pageSize={TRADES_PER_PAGE}
        totalTrades={totalTrades}
        totalPages={totalPages}
        onPageChange={setPage}
      />

      {/* Deposit Modal (Issue #25) */}
      {depositMounted && (
        <DepositModal
          isOpen={isDepositOpen}
          onClose={() => setIsDepositOpen(false)}
          onDepositSuccess={handleWithdrawSuccess}
          virtualAccount={virtualAccount}
          onOptimisticApply={(amount) => applyOptimistic(amount)}
          onOptimisticRevert={revertOptimistic}
        />
      )}

      {/* Withdraw Modal */}
      {withdrawMounted && (
        <WithdrawModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          currentBalance={String(displayedNumber)}
          onWithdrawSuccess={handleWithdrawSuccess}
          onOptimisticApply={(amount) => applyOptimistic(-amount)}
          onOptimisticRevert={revertOptimistic}
        />
      )}
    </div>
  );
}
