"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { getToken, isAuthenticated } from "../lib/auth";
import DepositModal from "./DepositModal";
import WithdrawModal from "./WithdrawModal";
import { useAnnouncement } from "../components/AnnouncementRegions";
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
  error?: string;
}

interface WalletTransaction {
  id: string;
  asset_type: string;
  amount: number;
  status: "Active" | "Locked" | "Completed" | "Cancelled" | "Disputed";
  escrow_tx_hash: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalletPage() {
  const t = useTranslations("Wallet");
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
  const { announceError, announceStatus } = useAnnouncement();

  const [authChecked, setAuthChecked] = useState(false);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDepositOpen, setIsDepositOpen] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!isAuthenticated()) {
      window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/wallet");
      return;
    }
    setAuthChecked(true);
  }, []);

  // Fetch wallet data & transactions
  useEffect(() => {
    if (!authChecked) return;

    const token = getToken();
    if (!token) return;

    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`${apiUrl}/api/v1/wallet`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json() as Promise<WalletResponse>),
      fetch(`${apiUrl}/api/v1/profile/trades?limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .catch(() => ({ data: [] })),
    ])
      .then(([data, tradesData]) => {
        if (data.error || !data.publicKey) {
          setError(data.error ?? t("loadFailed"));
        } else {
          setWallet({
            publicKey: data.publicKey,
            balance: data.balance ?? "0",
            asset: data.asset ?? "XLM",
            network: data.network ?? "testnet",
          });
          announceStatus(`Wallet loaded. Balance: ${data.balance ?? "0"} ${data.asset ?? "XLM"}`);
          if (tradesData && Array.isArray(tradesData.data)) {
            setTransactions(tradesData.data);
          }
        }
      })
      .catch(() => setError(t("networkError")))
      .finally(() => setLoading(false));
  }, [authChecked, apiUrl, t]);

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
          announceStatus(`Balance refreshed: ${data.balance ?? "0"} ${data.asset ?? "XLM"}`);
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
          {transactions.length === 0 ? (
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
                        <Badge variant={tx.status === "Active" ? "Open" : (tx.status as any)} />
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
        </CardContent>
      </Card>

      {/* Deposit Modal (Issue #25) */}
      <DepositModal
        isOpen={isDepositOpen}
        onClose={() => setIsDepositOpen(false)}
        onDepositSuccess={handleWithdrawSuccess}
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
