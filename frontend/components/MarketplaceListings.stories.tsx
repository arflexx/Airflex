import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { NextIntlClientProvider } from "next-intl";
import MarketplaceListings from "./MarketplaceListings";
import type { TradeOffer } from "../../server/src/types/trade";

const homeMessages = {
  Home: {
    activeListings: "Active Listings",
    offersAvailable: "{count, plural, =1 {# offer available} other {# offers available}}",
    seller: "Seller",
    amount: "Amount",
    expires: "Expires",
    viewAndBuy: "View & Buy",
    viewBuyAria: "View and buy {asset} worth ₦{amount} from {seller}",
    noListings: "No active listings right now",
    noListingsBody:
      "Be the first to list your airtime or data. Sellers get paid instantly once delivery is confirmed on-chain.",
    sellAsset: "Sell Airtime / Data",
    browseListings: "Browse Listings",
    noFilteredListings: "No listings found matching your filters",
    noFilteredListingsBody:
      "Try adjusting or clearing your filters to see more available listings.",
    clearFilters: "Clear filters",
    showingPage: "Showing page 1 of {total}. Sign in to filter and paginate listings.",
  },
};

const sampleTrades: TradeOffer[] = [
  {
    id: "trade-1",
    seller_id: "user-1",
    buyer_id: null,
    asset_type: "MTN_AIRTIME",
    amount: 1000,
    fee_amount: 15,
    seller_net_amount: 985,
    status: "Active",
    contract_listing_id: "listing-1",
    escrow_tx_hash: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    seller_handle: "@seller1",
  },
  {
    id: "trade-2",
    seller_id: "user-2",
    buyer_id: null,
    asset_type: "GLO_DATA",
    amount: 2500,
    fee_amount: 37.5,
    seller_net_amount: 2462.5,
    status: "Active",
    contract_listing_id: "listing-2",
    escrow_tx_hash: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    seller_handle: "@seller2",
  },
];

/**
 * MarketplaceListings — /trades listing grid.
 *
 * Covers the empty-state variant added in issue #604: when a user has no
 * trades, the grid shows an illustrated message and a primary CTA (built
 * from the shared `Card` and `Button` primitives) instead of a blank area.
 */
const meta: Meta<typeof MarketplaceListings> = {
  title: "Components/MarketplaceListings",
  component: MarketplaceListings,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="en" messages={homeMessages}>
        <div className="min-h-[400px] bg-gray-50 p-6 dark:bg-gray-950">
          <Story />
        </div>
      </NextIntlClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof MarketplaceListings>;

/** Populated grid with active listings. */
export const Populated: Story = {
  name: "Populated",
  args: {
    initialTrades: sampleTrades,
    initialPagination: { page: 1, limit: 20, total: sampleTrades.length, totalPages: 1 },
  },
};

/**
 * Empty state (issue #604) — shown when the marketplace has no active
 * listings. Includes the illustration, translated copy, and the
 * "Browse Listings" CTA linking back to the marketplace landing page.
 */
export const EmptyState: Story = {
  name: "Empty State",
  args: {
    initialTrades: [],
    initialPagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  },
};

/**
 * Empty state shown when the user's filters exclude every listing — copy and
 * CTA swap to "Clear filters" instead of "Browse Listings".
 */
export const EmptyStateFiltered: Story = {
  name: "Empty State (Filtered)",
  args: {
    initialTrades: [],
    initialPagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  },
  parameters: {
    nextjs: {
      navigation: {
        query: { assetType: "DATA" },
      },
    },
  },
};
