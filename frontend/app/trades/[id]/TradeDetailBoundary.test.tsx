import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { TradeOffer } from "../../../../server/src/types/trade";

// TradeDetailClient has a large dependency surface (auth, signing, apiFetch,
// next-intl, several UI primitives). This test is only concerned with the
// boundary behavior around it, so the module is replaced with a component
// that throws on demand — simulating a runtime error "inside
// TradeDetailClient" without needing to stand up its whole dependency tree.
let shouldThrow = true;
jest.mock("./TradeDetailClient", () => ({
  __esModule: true,
  default: function MockTradeDetailClient() {
    if (shouldThrow) {
      throw new Error("Malformed Stellar transaction data");
    }
    return <div>Trade detail loaded</div>;
  },
}));

jest.mock("../../lib/monitoring", () => ({ reportError: jest.fn() }));

import TradeDetailBoundary from "./TradeDetailBoundary";

const trade = {
  id: "trade-123",
  seller_id: "seller-1",
  buyer_id: null,
  asset_type: "MTN_AIRTIME",
  amount: 5000,
  fee_amount: null,
  seller_net_amount: null,
  status: "Active",
  contract_listing_id: null,
  escrow_tx_hash: null,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as unknown as TradeOffer;

describe("TradeDetailBoundary (#611 / #608)", () => {
  beforeEach(() => {
    shouldThrow = true;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the ErrorBoundary fallback instead of crashing when TradeDetailClient throws", () => {
    render(<TradeDetailBoundary trade={trade} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Trade detail loaded")).not.toBeInTheDocument();
  });

  it("re-mounts TradeDetailClient via a key reset when Retry is clicked", () => {
    render(<TradeDetailBoundary trade={trade} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The next mount of TradeDetailClient should succeed.
    shouldThrow = false;

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("Trade detail loaded")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
