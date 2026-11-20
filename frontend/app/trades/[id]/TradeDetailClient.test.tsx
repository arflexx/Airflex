import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { TradeOffer } from "../../../../server/src/types/trade";

// Real translation catalogs, so assertions can match on the text a user
// actually sees rather than translation keys.
jest.mock("next-intl", () => jest.requireActual("../../../i18n/testing").nextIntlMock);

jest.mock("../../lib/auth", () => ({
  isAuthenticated: () => true,
  getUser: () => ({ id: "buyer-1" }),
  getToken: () => "token-abc",
}));

// Signing/session are never reached in the failure-at-prepare-step scenario
// this suite exercises, but TradeDetailClient imports them unconditionally —
// stub them out rather than pull in the real @stellar/stellar-sdk dependency.
jest.mock("../../lib/signing", () => ({
  ensureSessionKey: jest.fn(),
  signTransactionXdr: jest.fn(),
  SessionKeyMissingError: class SessionKeyMissingError extends Error {},
  UnlockFailedError: class UnlockFailedError extends Error {
    status?: number;
  },
  AccountMismatchError: class AccountMismatchError extends Error {},
}));

jest.mock("../../lib/stellarSession", () => ({
  clearSessionKey: jest.fn(),
}));

jest.mock("../../../lib/apiFetch", () => {
  const actual = jest.requireActual("../../../lib/apiFetch");
  return {
    ...actual,
    apiFetch: jest.fn(),
  };
});

// ToastProvider renders through a portal and auto-dismisses on a timer this
// suite doesn't need to manage — assert directly against the ToastContext
// consumer instead via a minimal stand-in provider.
const toastError = jest.fn();
jest.mock("../../../components/ToastProvider", () => {
  const React = require("react");
  const ToastContext = React.createContext({
    success: jest.fn(),
    error: toastError,
    info: jest.fn(),
    warning: jest.fn(),
  });
  return { ToastContext };
});

import { apiFetch, ApiError } from "../../../lib/apiFetch";
import TradeDetailClient from "./TradeDetailClient";

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function makeTrade(overrides: Partial<TradeOffer> = {}): TradeOffer {
  return {
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
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    seller_handle: "@seller",
    ...overrides,
  };
}

describe("TradeDetailClient optimistic buy (#612)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rolls back the optimistic 'Locked' status and shows a toast when the buy request fails", async () => {
    // TradeDetailClient reads the user-facing message from `error.data.error`
    // (the server's JSON error body), not `error.message`.
    mockApiFetch.mockRejectedValueOnce(
      new ApiError("Conflict", 409, { error: "Trade already locked" })
    );

    render(<TradeDetailClient trade={makeTrade()} />);

    // The button's accessible name comes from its `aria-label` ("Buy {asset}
    // worth ₦{amount} from {seller}"), not its visible "Buy Now" text.
    const buyButton = await screen.findByRole("button", { name: /^buy /i });

    // Confirmed status starts "Active" → badge reads "Open".
    expect(screen.getByText("Open")).toBeInTheDocument();

    // A synchronous (non-async) `act` only flushes the click's synchronous
    // state update (`setBuying(true)`, set before the first `await` in
    // `handleBuy`) — it does not yield to the microtask queue, so the
    // rejected `apiFetch` mock cannot have settled yet. That makes this
    // assertion a reliable check of the *optimistic* state, not a race.
    act(() => {
      fireEvent.click(buyButton);
    });

    // Optimistic transition: badge flips to "Locked" the instant the request
    // is in flight, before the (failing) response has come back.
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(buyButton).toBeDisabled();

    // The request now resolves (rejects) — status rolls back and a toast
    // fires.
    await waitFor(() => expect(screen.getByText("Open")).toBeInTheDocument());

    expect(screen.queryByText("Locked")).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith("Trade already locked");
    expect(screen.getByRole("alert")).toHaveTextContent("Trade already locked");
  });

  it("keeps the optimistic 'Locked' status once the buy request succeeds", async () => {
    mockApiFetch.mockResolvedValueOnce({
      data: { xdr: "XDR", networkPassphrase: "Test SDF Network ; September 2015", publicKey: "GPUBLIC" },
    });
    mockApiFetch.mockResolvedValueOnce({
      data: { ...makeTrade({ status: "Locked" }), escrow_tx_hash: "tx-abc" },
    });

    const { signTransactionXdr } = jest.requireMock("../../lib/signing") as {
      signTransactionXdr: jest.Mock;
    };
    signTransactionXdr.mockReturnValue("signed-xdr");

    render(<TradeDetailClient trade={makeTrade()} />);

    const buyButton = await screen.findByRole("button", { name: /^buy /i });

    await act(async () => {
      fireEvent.click(buyButton);
    });

    // On success the component swaps to the confirmation panel, whose own
    // "Locked" badge reflects the now-confirmed (not merely optimistic) status.
    await waitFor(() =>
      expect(screen.getByText(/purchase confirmed/i)).toBeInTheDocument()
    );
    expect(screen.getByText("Locked")).toBeInTheDocument();
  });
});
