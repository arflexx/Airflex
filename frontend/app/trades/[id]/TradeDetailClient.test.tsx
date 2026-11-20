import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import TradeDetailClient from "./TradeDetailClient";
import { apiFetch, ApiError } from "../../../lib/apiFetch";
import type { TradeOffer } from "../../../../server/src/types/trade";

// Real catalog text so assertions match what users actually see.
jest.mock("next-intl", () => jest.requireActual("../../../i18n/testing").nextIntlMock);

jest.mock("../../lib/auth", () => ({
  getToken: () => "mock-jwt-token",
  getUser: () => ({ id: "buyer-1" }),
  isAuthenticated: () => true,
}));

jest.mock("../../lib/stellarSession", () => ({
  clearSessionKey: jest.fn(),
  setSessionKey: jest.fn(),
  getSessionKey: jest.fn(),
  hasSessionKey: jest.fn(() => true),
}));

jest.mock("../../lib/signing", () => {
  const actual = jest.requireActual("../../lib/signing");
  return {
    ...actual,
    ensureSessionKey: jest.fn().mockResolvedValue(undefined),
    signTransactionXdr: jest.fn().mockReturnValue("signed-xdr-stub"),
  };
});

jest.mock("../../../lib/apiFetch", () => {
  const actual = jest.requireActual("../../../lib/apiFetch");
  return {
    ...actual,
    apiFetch: jest.fn(),
  };
});

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const baseTrade: TradeOffer = {
  id: "trade-abc",
  seller_id: "seller-1",
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
};

// Issue #609 — optimistic UI for trade acceptance, with rollback on failure.
describe("TradeDetailClient optimistic buy (Issue #609)", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("flips status to Locked immediately, then rolls back and toasts on a failed API response", async () => {
    // Step 1 (prepare) succeeds; step 3 (submit signed envelope) fails.
    mockedApiFetch
      .mockResolvedValueOnce({
        data: {
          xdr: "unsigned-xdr",
          networkPassphrase: "Test SDF Network ; September 2015",
          publicKey: "GABCDEF",
        },
      })
      .mockRejectedValueOnce(
        new ApiError("Insufficient escrow balance", 400, {
          error: "Insufficient escrow balance",
        })
      );

    render(<TradeDetailClient trade={baseTrade} />);

    const buyButton = await screen.findByRole("button", { name: /buy mtn airtime/i });

    // Optimistic update: status flips to "Locked" synchronously on click,
    // before the prepare/sign/submit round-trip resolves.
    fireEvent.click(buyButton);
    expect(screen.getByText("Locked")).toBeInTheDocument();

    // On failure, the status rolls back to its previous value ("Active",
    // rendered as the "Open" badge) and an error toast is shown.
    await waitFor(() => {
      expect(screen.queryByText("Locked")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Open")).toBeInTheDocument();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Insufficient escrow balance");

    const toastStatus = await screen.findByRole("status");
    expect(toastStatus).toHaveTextContent("Insufficient escrow balance");

    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it("confirms the purchase and keeps the Locked status when the full flow succeeds", async () => {
    mockedApiFetch
      .mockResolvedValueOnce({
        data: {
          xdr: "unsigned-xdr",
          networkPassphrase: "Test SDF Network ; September 2015",
          publicKey: "GABCDEF",
        },
      })
      .mockResolvedValueOnce({
        data: { ...baseTrade, status: "Locked", escrow_tx_hash: "tx-hash-123" },
      });

    render(<TradeDetailClient trade={baseTrade} />);

    const buyButton = await screen.findByRole("button", { name: /buy mtn airtime/i });
    fireEvent.click(buyButton);
    expect(screen.getByText("Locked")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/purchase confirmed/i)).toBeInTheDocument();
    });
  });
});
