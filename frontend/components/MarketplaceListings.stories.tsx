import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { NextIntlClientProvider } from "next-intl";
import MarketplaceListings from "./MarketplaceListings";
import type { TradeOffer } from "../../server/src/types/trade";

const homeMessages = {
  Home: {
    seller: "Seller",
    amount: "Amount",
    expires: "Expires",
    viewAndBuy: "View & Buy",
    viewBuyAria: "View and buy {asset} for ₦{amount} from {seller}",
    noListings: "No active listings right now",
    noListingsBody: "Be the first to list your airtime or data.",
    sellAsset: "Sell Airtime / Data",
    offersAvailable: "{count} offers available",
    showingPage: "Showing page 1 of {total}",
  },
};

/**
 * MarketplaceListings stories (issue #600).
 *
 * `Loading` documents the skeleton-placeholder state the grid renders while
 * the initial `fetchOnMount` request is in flight — `global.fetch` is
 * stubbed with a promise that never resolves so the story is a stable
 * snapshot of that loading variant, matching `TradeCardSkeleton` with no
 * duplicate markup.
 */
const meta: Meta<typeof MarketplaceListings> = {
  title: "Components/MarketplaceListings",
  component: MarketplaceListings,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
    },
  },
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="en" messages={homeMessages}>
        <div className="min-h-[600px] bg-gray-50 p-6 dark:bg-gray-950">
          <Story />
        </div>
      </NextIntlClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof MarketplaceListings>;

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
  } as TradeOffer,
];

/**
 * Loading state: `fetchOnMount` is true and `global.fetch` is stubbed with a
 * promise that never resolves, so the grid stays in its loading phase and
 * renders `TradeCardSkeleton` placeholders instead of an empty grid.
 */
export const Loading: Story = {
  render: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = () => new Promise(() => undefined);
    return <MarketplaceListings fetchOnMount initialTrades={[]} />;
  },
};

/**
 * Loaded state, for contrast with `Loading` — real listings replace the
 * skeleton placeholders once data resolves.
 */
export const Loaded: Story = {
  render: () => <MarketplaceListings initialTrades={sampleTrades} />,
};
