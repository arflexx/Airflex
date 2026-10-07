import React from "react";

import { StellarExplorerLink } from "./StellarExplorerLink";
import type { TradeStatus } from "../../server/src/types/trade";

/**
 * Deep-link to the on-chain escrow transaction for a trade (Issue #332).
 *
 * Extracted from the trade detail page so the rule for *when* a buyer is shown
 * proof that their funds are secured lives in one testable place rather than
 * inline in a large client component.
 */

/**
 * Statuses in which an escrow transaction is meaningful to show.
 *
 * An `Active` trade has no escrow yet, and a `Cancelled` one's hash — if the
 * column was ever written — describes money that has since been returned, so
 * surfacing it as "your funds are secured" would be misleading.
 */
export const ESCROW_VISIBLE_STATUSES: readonly TradeStatus[] = [
  "Locked",
  "Completed",
  "Disputed",
];

export const ESCROW_LINK_LABEL = "View escrow on Stellar Explorer";

export interface EscrowTransactionLinkProps {
  status: TradeStatus;
  escrowTxHash: string | null | undefined;
  className?: string;
}

export function shouldShowEscrowLink(
  status: TradeStatus,
  escrowTxHash: string | null | undefined
): boolean {
  return Boolean(escrowTxHash) && ESCROW_VISIBLE_STATUSES.includes(status);
}

export function EscrowTransactionLink({
  status,
  escrowTxHash,
  className = "",
}: EscrowTransactionLinkProps) {
  if (!shouldShowEscrowLink(status, escrowTxHash)) return null;

  return (
    <StellarExplorerLink
      type="transaction"
      value={escrowTxHash}
      className={className}
    >
      {ESCROW_LINK_LABEL}
    </StellarExplorerLink>
  );
}

export default EscrowTransactionLink;
