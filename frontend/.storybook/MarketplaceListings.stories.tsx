import type { Meta, StoryObj } from "@storybook/react";
import MarketplaceListings from "../components/MarketplaceListings";

const meta: Meta<typeof MarketplaceListings> = {
  title: "Components/MarketplaceListings",
  component: MarketplaceListings,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof MarketplaceListings>;

export const LoadingState: Story = {
  args: {
    fetchOnMount: true,
    initialTrades: [],
  },
  parameters: {
    msw: {
      handlers: [],
    },
  },
};

export const LoadedState: Story = {
  args: {
    fetchOnMount: false,
    initialTrades: [
      {
        id: "trade-1",
        seller_id: "user-1",
        buyer_id: null,
        asset_type: "MTN_AIRTIME",
        amount: 2500,
        fee_amount: 37.5,
        seller_net_amount: 2462.5,
        status: "Active",
        contract_listing_id: "listing-1",
        escrow_tx_hash: null,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        seller_handle: "@alice",
      },
      {
        id: "trade-2",
        seller_id: "user-2",
        buyer_id: null,
        asset_type: "GLO_DATA",
        amount: 5000,
        fee_amount: 75,
        seller_net_amount: 4925,
        status: "Active",
        contract_listing_id: "listing-2",
        escrow_tx_hash: null,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        seller_handle: "@bob",
      },
    ],
  },
};
