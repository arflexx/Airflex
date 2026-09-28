/**
 * Double-submit protection for the wallet modals.
 *
 * A user who clicks "Submit" twice (or hits Enter while the request is in
 * flight) must fire exactly one API request, see a disabled button with a
 * spinner, and be unable to dismiss the modal via Escape, overlay click, or
 * the close button until the request settles.
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import DepositModal from "./DepositModal";
import WithdrawModal from "./WithdrawModal";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const TOKEN = "test-token";

function setToken() {
  localStorage.setItem("airflex:token", TOKEN);
}

function clearToken() {
  localStorage.removeItem("airflex:token");
}

describe("DepositModal submitting state", () => {
  const onClose = jest.fn();
  const onDepositSuccess = jest.fn();
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    onClose.mockClear();
    onDepositSuccess.mockClear();
    setToken();
    // Never-resolving initialize request simulates a slow API.
    fetchMock = jest.fn(
      () =>
        new Promise(() => {
          // pending forever
        }) as Promise<Response>
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    clearToken();
    jest.restoreAllMocks();
  });

  it("sends only one request on double submit, disables the button with a spinner, and blocks close", async () => {
    render(
      <DepositModal
        isOpen
        onClose={onClose}
        onDepositSuccess={onDepositSuccess}
        virtualAccount={null}
      />
    );

    const amountInput = screen.getByRole("textbox");
    fireEvent.change(amountInput, { target: { value: "5000" } });

    const submit = screen.getByRole("button", {
      name: /continue to payment/i,
    });

    // Two rapid clicks in the same tick — before React can re-render.
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/wallet/deposit/initialize"),
      expect.objectContaining({ method: "POST" })
    );

    // Button is disabled and shows a spinner while submitting.
    const pendingButton = await screen.findByRole("button", {
      name: /starting/i,
    });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();

    // Close button is disabled while submitting.
    expect(
      screen.getByRole("button", { name: /close deposit dialog/i })
    ).toBeDisabled();

    // Escape must not close while submitting.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // Overlay (backdrop) click must not close while submitting.
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("WithdrawModal submitting state", () => {
  const onClose = jest.fn();
  const onWithdrawSuccess = jest.fn();
  let fetchMock: jest.Mock;
  let withdrawCalls = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    onClose.mockClear();
    onWithdrawSuccess.mockClear();
    withdrawCalls = 0;
    setToken();

    fetchMock = jest.fn((url: string) => {
      if (url.includes("/api/v1/wallet/banks")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            banks: [{ code: "001", name: "Test Bank" }],
          }),
        });
      }
      if (url.includes("/resolve-account")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ account_name: "John Doe" }),
        });
      }
      if (url.includes("/api/v1/wallet/withdraw")) {
        withdrawCalls += 1;
        // Slow API: never resolves, so the modal stays in submitting state.
        return new Promise(() => {}) as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    clearToken();
    jest.restoreAllMocks();
  });

  it("sends only one withdrawal on double submit, shows a spinner, and blocks close", async () => {
    render(
      <WithdrawModal
        isOpen
        onClose={onClose}
        currentBalance="10000"
        onWithdrawSuccess={onWithdrawSuccess}
      />
    );

    // Amount (CurrencyInput labelled "amount" via mocked translations).
    const amountInput = screen.getByLabelText("amount");
    fireEvent.change(amountInput, { target: { value: "2000" } });

    // Bank selection.
    const bankInput = screen.getByPlaceholderText("searchBank");
    fireEvent.change(bankInput, { target: { value: "Test" } });
    const bankOption = await screen.findByText("Test Bank");
    fireEvent.click(bankOption);

    // Account number triggers resolve-account.
    const accountInput = screen.getByPlaceholderText(
      "accountNumberPlaceholder"
    );
    fireEvent.change(accountInput, { target: { value: "1234567890" } });

    // Wait for the resolved name, then confirm it.
    await screen.findByText("John Doe");
    fireEvent.click(screen.getByRole("checkbox"));

    const submit = screen.getByRole("button", { name: "withdraw" });
    expect(submit).not.toBeDisabled();

    // Two rapid submits.
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(withdrawCalls).toBe(1);
    });

    // Still exactly one request after a tick.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "processing" })).toBeDisabled();
    });
    expect(withdrawCalls).toBe(1);
    expect(screen.getByRole("status")).toBeInTheDocument();

    // Close button is disabled while submitting.
    expect(screen.getByRole("button", { name: "close" })).toBeDisabled();

    // Escape must not close while submitting.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // Overlay click must not close while submitting.
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
