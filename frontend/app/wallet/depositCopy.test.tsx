/**
 * Copy-to-clipboard on the virtual account number (Issue #335).
 *
 * The value copied is asserted exactly: a transfer sent to a number that lost
 * a digit on the way to the clipboard is not recoverable.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import DepositModal, {
  COPIED_FEEDBACK_MS,
  CopyAccountNumberButton,
} from "./DepositModal";

const ACCOUNT_NUMBER = "9912345678";

function mockClipboard(writeText: jest.Mock): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

function copyButton(): HTMLElement {
  return screen.getByRole("button", { name: /copy account number/i });
}

describe("CopyAccountNumberButton", () => {
  let writeText: jest.Mock;

  beforeEach(() => {
    writeText = jest.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("copies the account number to the clipboard", async () => {
    render(<CopyAccountNumberButton accountNumber={ACCOUNT_NUMBER} />);

    fireEvent.click(copyButton());

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(ACCOUNT_NUMBER);
  });

  it("confirms the copy for two seconds, then reverts", async () => {
    // Fake timers must be installed *before* the click: the reset timeout is
    // scheduled when the copy resolves, and a timeout created under real timers
    // cannot be advanced by the fake clock afterwards.
    jest.useFakeTimers();

    render(<CopyAccountNumberButton accountNumber={ACCOUNT_NUMBER} />);
    expect(copyButton()).toHaveTextContent("Copy");

    await act(async () => {
      fireEvent.click(copyButton());
      // Flush the mocked clipboard promise so the reset timer is scheduled.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copyButton()).toHaveTextContent("Copied!");

    act(() => {
      jest.advanceTimersByTime(COPIED_FEEDBACK_MS - 1);
    });
    expect(copyButton()).toHaveTextContent("Copied!");

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(copyButton()).toHaveTextContent("Copy");
  });

  it("explains itself when the clipboard is unavailable", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<CopyAccountNumberButton accountNumber={ACCOUNT_NUMBER} />);

    fireEvent.click(copyButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not copy/i);
    expect(copyButton()).toHaveTextContent("Copy");
  });
});

describe("DepositModal virtual account section", () => {
  const noop = () => undefined;

  beforeEach(() => {
    mockClipboard(jest.fn().mockResolvedValue(undefined));
  });

  it("shows the account number with a copy button", () => {
    render(
      <DepositModal
        isOpen
        onClose={noop}
        onDepositSuccess={noop}
        virtualAccount={{ accountNumber: ACCOUNT_NUMBER, bankName: "Wema Bank" }}
      />
    );

    expect(screen.getByTestId("virtual-account-number")).toHaveTextContent(ACCOUNT_NUMBER);
    expect(screen.getByText("Wema Bank")).toBeInTheDocument();
    expect(copyButton()).toBeInTheDocument();
  });

  it("omits the section while the account is still provisioning", () => {
    render(
      <DepositModal isOpen onClose={noop} onDepositSuccess={noop} virtualAccount={null} />
    );

    expect(screen.queryByTestId("virtual-account")).not.toBeInTheDocument();
  });
});
