/** Possible states a trade offer moves through */
export type TradeStatus = "Active" | "Locked" | "Completed" | "Cancelled" | "Disputed";

/**
 * Machine-readable error codes returned alongside the `error` message on
 * every 4xx/5xx response from `server/src/routes/trades.ts` (and the
 * synchronous validation errors thrown by `tradeVerification.ts` on behalf
 * of the confirm-delivery route) — issue #618.
 *
 * API consumers (including the frontend) should branch on `code`, not on
 * the human-readable `error` string, which may change wording without
 * notice.
 */
export const TradeErrorCode = {
  /** Query parameters on GET /api/v1/trades failed validation. */
  INVALID_QUERY: "INVALID_QUERY",
  /** The authenticated user row could not be found when creating a trade. */
  USER_NOT_FOUND: "USER_NOT_FOUND",
  /** Seller has not completed KYC verification. */
  KYC_REQUIRED: "KYC_REQUIRED",
  /** Seller has no wallet record (and therefore no signing key) on file. */
  WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
  /** No trade offer exists with the given id. */
  TRADE_NOT_FOUND: "TRADE_NOT_FOUND",
  /** Trade exists but is not in the `Active` status required to buy it. */
  TRADE_NOT_AVAILABLE: "TRADE_NOT_AVAILABLE",
  /** Trade has no on-chain `contract_listing_id` to deposit escrow against. */
  TRADE_NO_LISTING: "TRADE_NO_LISTING",
  /** The authenticated buyer is also the trade's seller. */
  TRADE_SELF_BUY_FORBIDDEN: "TRADE_SELF_BUY_FORBIDDEN",
  /** Caller is not the trade's seller (confirm-delivery). */
  TRADE_NOT_SELLER: "TRADE_NOT_SELLER",
  /** Trade is not in the state required for the requested transition. */
  TRADE_INVALID_STATE: "TRADE_INVALID_STATE",
  /** Caller is neither the buyer nor the seller of the trade (dispute). */
  TRADE_FORBIDDEN_DISPUTE: "TRADE_FORBIDDEN_DISPUTE",
  /** Trade has already been disputed. */
  TRADE_ALREADY_DISPUTED: "TRADE_ALREADY_DISPUTED",
  /** Only `Locked` trades may be disputed. */
  TRADE_NOT_LOCKED: "TRADE_NOT_LOCKED",
  /** Trade's status changed between the read and the write (lost a race). */
  TRADE_STATE_CONFLICT: "TRADE_STATE_CONFLICT",
  /** Only `Completed` trades may be rated. */
  TRADE_NOT_COMPLETED: "TRADE_NOT_COMPLETED",
  /** Only the buyer may rate the seller. */
  TRADE_FORBIDDEN_RATE: "TRADE_FORBIDDEN_RATE",
  /** This trade already has a rating on file. */
  TRADE_ALREADY_RATED: "TRADE_ALREADY_RATED",
  /** Escrow release failed permanently on the Soroban contract. */
  ESCROW_RELEASE_FAILED: "ESCROW_RELEASE_FAILED",
  /** Caller is creating trades faster than `MAX_TRADES_PER_HOUR` allows. */
  TRADE_RATE_LIMITED: "TRADE_RATE_LIMITED",
  /** Unexpected, unclassified server error. */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type TradeErrorCode = (typeof TradeErrorCode)[keyof typeof TradeErrorCode];

/** Shape of a row returned from the trade_offers table */
export interface TradeOffer {
  id: string;
  seller_id: string;
  buyer_id: string | null;
  asset_type: string;
  amount: number;
  fee_amount: number | null;
  seller_net_amount: number | null;
  status: TradeStatus;
  contract_listing_id: string | null;
  escrow_tx_hash: string | null;
  expires_at: string; // ISO timestamp
  created_at: string;
  updated_at: string;
  /**
   * Opaque, human-readable seller label derived from `seller_id` (issue #330).
   * Present whenever the seller row is joined — always on the public listing
   * feed, which never exposes `seller_id` itself.
   */
  seller_handle?: string | null;
}
