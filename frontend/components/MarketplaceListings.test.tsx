import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import MarketplaceListings from "./MarketplaceListings";
import type { TradeOffer } from "../../server/src/types/trade";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/",
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      activeListings: "Active Listings",
      seller: "Seller",
      amount: "Amount",
      expires: "Expires",
      viewAndBuy: "View & Buy",
      noListings: "No active listings right now",
      noListingsBody: "Be the first to list your airtime or data.",
      sellAsset: "Sell Airtime / Data",
      showingPage: "Showing page 1 of 1",
    };
    if (key === "offersAvailable") {
      return `${values?.count ?? 0} offers available`;
    }
    return translations[key] ?? key;
  },
}));

describe("MarketplaceListings Filter Panel (Issue #328)", () => {
  const initialTrades: TradeOffer[] = [
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
      expires_at: new Date(Date.now() + 3600000).toISOString(),
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
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      seller_handle: "@seller2",
    },
  ];

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders filter controls for asset type, carrier, and amount range", () => {
    render(<MarketplaceListings initialTrades={initialTrades} />);

    expect(screen.getByLabelText("Asset Type")).toBeInTheDocument();
    expect(screen.getByLabelText("Carrier")).toBeInTheDocument();
    expect(screen.getByLabelText("Min Amount")).toBeInTheDocument();
    expect(screen.getByLabelText("Max Amount")).toBeInTheDocument();

    expect(screen.getByText("₦1,000")).toBeInTheDocument();
    expect(screen.getByText("₦2,500")).toBeInTheDocument();
  });

  it("updates listings and URL when filter is selected without full page reload", async () => {
    const pushStateSpy = jest.spyOn(window.history, "pushState");

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [initialTrades[0]],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    });

    render(<MarketplaceListings initialTrades={initialTrades} />);

    // Select Carrier -> MTN
    const carrierSelect = screen.getByLabelText("Carrier");
    fireEvent.change(carrierSelect, { target: { value: "MTN" } });

    // Verify URL was updated without page reload
    expect(pushStateSpy).toHaveBeenCalledWith(null, "", expect.stringContaining("carrier=MTN"));

    // Verify fetch was called with filter params
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("carrier=MTN"));
    });
  });

  it("clears filters when 'Clear filters' button is clicked", async () => {
    const pushStateSpy = jest.spyOn(window.history, "pushState");

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: initialTrades,
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      }),
    });

    render(<MarketplaceListings initialTrades={initialTrades} />);

    // Apply assetType filter
    const assetTypeSelect = screen.getByLabelText("Asset Type");
    fireEvent.change(assetTypeSelect, { target: { value: "AIRTIME" } });

    // "Clear filters" button should now be visible
    const clearButton = await screen.findByRole("button", { name: /clear filters/i });
    expect(clearButton).toBeInTheDocument();

    // Click "Clear filters"
    fireEvent.click(clearButton);

    // Verify inputs reset
    expect((screen.getByLabelText("Asset Type") as HTMLSelectElement).value).toBe("");

    // Verify URL was reset to clean pathname
    expect(pushStateSpy).toHaveBeenLastCalledWith(null, "", "/");

    // Verify fetch was called without assetType filter
    await waitFor(() => {
      expect(global.fetch).toHaveBeenLastCalledWith(expect.not.stringContaining("assetType="));
    });
  });
});
