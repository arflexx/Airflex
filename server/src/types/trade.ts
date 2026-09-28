/** Possible states a trade offer moves through */
export type TradeStatus = "Active" | "Locked" | "Completed" | "Cancelled" | "Disputed";

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
