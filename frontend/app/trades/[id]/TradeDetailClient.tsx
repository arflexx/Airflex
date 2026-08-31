"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { TradeOffer } from "../../../../server/src/types/trade";
import { getToken, getUser, isAuthenticated } from "../../lib/auth";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Spinner } from "../../../components/ui/Spinner";
import { Card } from "../../../components/ui/Card";
import { Toast } from "../../../components/ui/Toast";
import { StellarExplorerLink } from "../../../components/StellarExplorerLink";
import { DisputeModal } from "./dispute/DisputeModal";

// ---------------------------------------------------------------------------
// Helpers
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
      className={`inline-block rounded-full px-3 py-1 text-xs font-semibold tracking-wide ${
        isData
          ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          : "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
      }`}
    >
      {formatAssetType(assetType)}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3.5">
      <dt className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-right text-sm font-semibold text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expiry countdown hook
// ---------------------------------------------------------------------------

interface CountdownResult {
  display: string;
  expired: boolean;
  urgent: boolean;
}

function useCountdown(expiresAt: string): CountdownResult {
  const calc = useCallback((): CountdownResult => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return { display: "Expired", expired: true, urgent: false };

    const totalSeconds = Math.floor(diff / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    parts.push(`${String(s).padStart(2, "0")}s`);

    return {
      display: parts.join(" "),
      expired: false,
      urgent: diff < 5 * 60 * 1000,
    };
  }, [expiresAt]);

  const [state, setState] = useState<CountdownResult>(calc);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setState(calc());
    intervalRef.current = setInterval(() => {
      const next = calc();
      setState(next);
      if (next.expired && intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [calc]);

  return state;
}

// ---------------------------------------------------------------------------
// Buy confirmation step
// ---------------------------------------------------------------------------

function ConfirmationPanel({ trade, txHash }: { trade: TradeOffer; txHash: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-6 rounded-2xl border border-green-200 bg-green-50 px-8 py-10 dark:border-green-800 dark:bg-green-900/20"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span aria-hidden="true" className="text-5xl">✅</span>
        <h2 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">Purchase confirmed!</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your funds have been locked in escrow. The seller will deliver your{" "}
          {formatAssetType(trade.asset_type)} shortly.
        </p>
      </div>

      <dl className="divide-y divide-green-100 rounded-xl border border-green-200 bg-white dark:divide-green-800 dark:border-green-800 dark:bg-gray-800">
        <DetailRow label="Trade ID">
          <span className="break-all font-mono text-xs">{trade.id}</span>
        </DetailRow>
        <DetailRow label="Asset">{formatAssetType(trade.asset_type)}</DetailRow>
        <DetailRow label="Amount">₦{trade.amount.toLocaleString()}</DetailRow>
        <DetailRow label="Status">
          <Badge variant="Locked" />
        </DetailRow>
        {txHash && (
          <DetailRow label="Escrow Tx">
            <StellarExplorerLink type="transaction" value={txHash} />
          </DetailRow>
        )}
      </dl>

      <a
        href="/"
        className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
      >
        Back to marketplace
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface BuyResponse {
  data?: TradeOffer & { escrow_tx_hash?: string };
  error?: string;
}

interface Props {
  trade: TradeOffer;
}

export default function TradeDetailClient({ trade }: Props) {
  const countdown = useCountdown(trade.expires_at);

  const [status, setStatus]               = useState<TradeOffer["status"]>(trade.status);
  const [authed, setAuthed]               = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [buying, setBuying]               = useState(false);
  const [buyError, setBuyError]           = useState<string | null>(null);
  const [txHash, setTxHash]               = useState<string | null>(null);
  const [confirmed, setConfirmed]         = useState(false);

  // Dispute state
  const [isDisputeOpen, setIsDisputeOpen] = useState(false);
  const [disputeFiled, setDisputeFiled]   = useState(trade.status === "Disputed");
  const [toast, setToast]                 = useState<{ message: string; type: "success" | "error" } | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const escrowContractAddress =
    process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS ||
    "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";

  useEffect(() => {
    setAuthed(isAuthenticated());
    setCurrentUserId(getUser()?.id ?? null);
  }, []);

  const isSeller = !!currentUserId && currentUserId === trade.seller_id;
  const isBuyer  = !!currentUserId && currentUserId === trade.buyer_id;
  const isParticipant = isSeller || isBuyer;
  const isActive = status === "Active";
  const isLocked = status === "Locked";
  const canBuy   = authed && isActive && !countdown.expired && !isSeller;

  const sellerAlias = `@seller_${trade.seller_id.slice(-8)}`;

  async function handleBuy() {
    if (!canBuy) return;

    setBuyError(null);
    setBuying(true);

    const token = getToken();
    if (!token) {
      const returnTo = encodeURIComponent(`/trades/${trade.id}`);
      window.location.href = `/auth/signup?returnTo=${returnTo}`;
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/api/v1/trades/${trade.id}/buy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      const data = (await res.json()) as BuyResponse;

      if (res.status === 401) {
        const returnTo = encodeURIComponent(`/trades/${trade.id}`);
        window.location.href = `/auth/signup?returnTo=${returnTo}`;
        return;
      }

      if (!res.ok) {
        setBuyError(data.error ?? "Purchase failed. Please try again.");
        return;
      }

      setStatus("Locked");
      setTxHash(data.data?.escrow_tx_hash ?? "");
      setConfirmed(true);
    } catch {
      setBuyError("Network error. Check your connection and try again.");
    } finally {
      setBuying(false);
    }
  }

  function handleDisputeSuccess() {
    setStatus("Disputed");
    setDisputeFiled(true);
    setToast({
      type: "success",
      message: "Dispute submitted successfully. An administrator will review within 24 hours.",
    });
  }

  function handleDisputeError(msg: string) {
    setToast({
      type: "error",
      message: msg,
    });
  }

  if (confirmed) {
    return <ConfirmationPanel trade={{ ...trade, status }} txHash={txHash ?? ""} />;
  }

  return (
    <article aria-labelledby="trade-heading">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-6 right-6 z-50 max-w-md animate-fade-in">
          <Toast
            type={toast.type}
            message={toast.message}
            onClose={() => setToast(null)}
          />
        </div>
      )}

      {/* Page heading */}
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          Trade offer
        </p>
        <h1
          id="trade-heading"
          className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100"
        >
          {formatAssetType(trade.asset_type)}
        </h1>
        <p className="mt-1 font-mono text-xs text-gray-400 dark:text-gray-500 break-all">
          ID: {trade.id}
        </p>
      </div>

      {/* Summary card */}
      <Card noPadding className="overflow-hidden">
        {/* Coloured header strip */}
        <div className="flex items-center justify-between gap-3 bg-violet-50 px-5 py-4 border-b border-violet-100 dark:bg-violet-900/20 dark:border-violet-800">
          <AssetBadge assetType={trade.asset_type} />
          <Badge variant={status === "Active" ? "Open" : (status as any)} />
        </div>

        {/* Detail rows */}
        <dl className="divide-y divide-gray-50 dark:divide-gray-700">
          <DetailRow label="Seller">{sellerAlias}</DetailRow>

          <DetailRow label="Amount">
            <span className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
              ₦{trade.amount.toLocaleString()}
            </span>
          </DetailRow>

          <DetailRow label="Expires in">
            <span
              className={
                countdown.expired
                  ? "text-red-600 dark:text-red-400"
                  : countdown.urgent
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-gray-900 dark:text-gray-100"
              }
              aria-live="polite"
              aria-label={`Time remaining: ${countdown.display}`}
            >
              {countdown.display}
            </span>
          </DetailRow>

          <DetailRow label="Expires at">
            {new Date(trade.expires_at).toLocaleString("en-NG", {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </DetailRow>

          <DetailRow label="Listed on">
            {new Date(trade.created_at).toLocaleString("en-NG", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </DetailRow>

          {/* Escrow Contract Deep-Link (Issue #66) */}
          <DetailRow label="Escrow Contract">
            <StellarExplorerLink
              type="contract"
              value={escrowContractAddress}
            />
          </DetailRow>

          {/* Escrow Tx Deep-Link if present */}
          {trade.escrow_tx_hash && (
            <DetailRow label="Escrow Transaction">
              <StellarExplorerLink
                type="transaction"
                value={trade.escrow_tx_hash}
              />
            </DetailRow>
          )}
        </dl>
      </Card>

      {/* How it works */}
      <div className="mt-6 rounded-xl border border-violet-100 bg-violet-50 px-5 py-4 dark:border-violet-800 dark:bg-violet-900/20">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">
          How this works
        </p>
        <ol className="mt-2 flex flex-col gap-1 text-sm text-violet-800 list-decimal list-inside dark:text-violet-300">
          <li>Click "Buy Now" to lock your funds in a Soroban escrow contract.</li>
          <li>The seller delivers your {formatAssetType(trade.asset_type)}.</li>
          <li>Platform confirms delivery and releases the payment to the seller.</li>
        </ol>
      </div>

      {/* Buy error */}
      {buyError && (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
        >
          {buyError}
        </div>
      )}

      {/* CTA area */}
      <div className="mt-8 flex flex-col gap-3">
        {/* Buy button */}
        {authed && isActive && !isSeller && (
          <Button
            size="lg"
            variant="primary"
            onClick={handleBuy}
            disabled={buying || countdown.expired}
            isLoading={buying}
            loadingText="Processing purchase…"
            aria-label={
              countdown.expired
                ? "This offer has expired"
                : `Buy ${formatAssetType(trade.asset_type)} worth ₦${trade.amount.toLocaleString()} from ${sellerAlias}`
            }
          >
            {countdown.expired ? "Offer expired" : "Buy Now"}
          </Button>
        )}

        {!authed && isActive && !countdown.expired && (
          <a
            href={`/auth/signup?returnTo=${encodeURIComponent(`/trades/${trade.id}`)}`}
            className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-6 py-3.5 text-base font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
            aria-label="Sign in to buy this offer"
          >
            Sign in to Buy
          </a>
        )}

        {/* Dispute Section for Buyer and Seller (Issue #61) */}
        {isLocked && isParticipant && (
          <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-800/40 dark:bg-amber-950/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Trade in progress (Escrow locked)
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  If the transaction cannot be completed, you may raise a dispute.
                </p>
              </div>

              {disputeFiled ? (
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="Disputed">Dispute Filed</Badge>
                </div>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setIsDisputeOpen(true)}
                  aria-label="Raise dispute for this locked trade"
                >
                  Raise Dispute
                </Button>
              )}
            </div>

            {disputeFiled && (
              <p className="text-xs text-rose-700 dark:text-rose-400 mt-1">
                An AirFlex administrator will review this dispute within 24 hours.
              </p>
            )}
          </div>
        )}

        {/* Status messages for other states */}
        {status === "Disputed" && !isLocked && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-800/60 dark:bg-rose-950/30">
            <div className="flex items-center gap-2">
              <Badge variant="Disputed">Dispute Filed</Badge>
            </div>
            <p className="text-xs text-rose-700 dark:text-rose-400 mt-1.5">
              This trade is under active review. An administrator will resolve it within 24 hours.
            </p>
          </div>
        )}

        {isSeller && isActive && (
          <p
            role="note"
            className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-3 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
          >
            This is your listing.
          </p>
        )}

        {!isActive && !isLocked && status !== "Disputed" && (
          <p
            role="note"
            className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-3 text-center text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400"
          >
            This offer is no longer available ({status.toLowerCase()}).
          </p>
        )}

        {isActive && countdown.expired && (
          <p
            role="note"
            className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            This offer has expired.
          </p>
        )}

        <Button
          variant="secondary"
          onClick={() => (window.location.href = "/")}
          className="mt-2"
        >
          ← Back to marketplace
        </Button>
      </div>

      {/* Accessible Dispute Modal Dialog */}
      <DisputeModal
        isOpen={isDisputeOpen}
        onClose={() => setIsDisputeOpen(false)}
        tradeId={trade.id}
        onDisputeSuccess={handleDisputeSuccess}
        onError={handleDisputeError}
      />
    </article>
  );
}
