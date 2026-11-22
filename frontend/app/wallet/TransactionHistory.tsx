"use client";

import { memo } from "react";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { StellarExplorerLink } from "../../components/StellarExplorerLink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status values returned by the wallet transactions endpoint. */
export type WalletTransactionStatus = "Active" | "Locked" | "Completed" | "Cancelled" | "Disputed";

export interface WalletTransaction {
  id: string;
  asset_type: string;
  amount: number;
  status: WalletTransactionStatus;
  escrow_tx_hash: string | null;
  created_at: string;
}

export interface TransactionHistoryProps {
  transactions: WalletTransaction[];
  loading: boolean;
  page: number;
  pageSize: number;
  totalTrades: number;
  totalPages: number;
  onPageChange: (page: number) => void;
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

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/**
 * One table row, memoized on the transaction object. The wallet page keeps
 * unchanged transaction objects across refetches (see lib/stableList), so only
 * rows whose data actually changed re-render.
 */
const TransactionRow = memo(function TransactionRow({ tx }: { tx: WalletTransaction }) {
  return (
    <tr className="hover:bg-gray-50/50 dark:hover:bg-gray-750/30 transition-colors">
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
  );
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Paginated trade history table with Stellar Explorer deep-links (Issues #66,
 * #336). Split out of the wallet page so it can be loaded as its own chunk
 * (Issue #544) — the balance card renders first, the history streams in after.
 *
 * Wrapped in React.memo: the wallet page re-renders on every SSE notification
 * (e.g. optimistic balance updates), and none of those touch these props.
 * Rows are keyed by the transaction's stable database id.
 */
function TransactionHistory({
  transactions,
  loading,
  page,
  pageSize,
  totalTrades,
  totalPages,
  onPageChange,
}: TransactionHistoryProps) {
  // Range shown on this page. Derived from the server's total rather than the
  // rows in hand, so the last page reads "41–47 of 47" and not "41–50".
  const rangeStart = totalTrades === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalTrades);
  const canGoPrevious = page > 1 && !loading;
  const canGoNext = page < totalPages && !loading;

  return (
    <Card noPadding>
      <CardHeader className="p-6">
        <CardTitle>Recent Transactions</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading && transactions.length === 0 ? (
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
                  <TransactionRow key={tx.id} tx={tx} />
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
                onClick={() => onPageChange(Math.max(1, page - 1))}
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
                onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                disabled={!canGoNext}
              >
                Next
              </Button>
            </nav>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default memo(TransactionHistory);
