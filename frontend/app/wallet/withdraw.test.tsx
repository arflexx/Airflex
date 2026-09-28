import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import WithdrawModal from "./WithdrawModal";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

global.fetch = jest.fn(() =>
  Promise.resolve({
    json: () => Promise.resolve({ banks: [] }),
  })
) as jest.Mock;

describe("WithdrawModal Available Balance and Max button", () => {
  const noop = () => {};

  it("displays the available balance with formatted naira amount", () => {
    render(
      <WithdrawModal
        isOpen={true}
        onClose={noop}
        currentBalance="10000"
        onWithdrawSuccess={noop}
      />
    );

    // Acceptance criteria: displays "Available: ₦10,000.00"
    expect(screen.getAllByText(/Available: ₦10,000\.00/).length).toBeGreaterThan(0);
  });

  it("populates the amount input with the full available balance when Max button is clicked", () => {
    render(
      <WithdrawModal
        isOpen={true}
        onClose={noop}
        currentBalance="10000"
        onWithdrawSuccess={noop}
      />
    );

    const maxButton = screen.getByRole("button", { name: /max/i });
    expect(maxButton).toBeInTheDocument();

    fireEvent.click(maxButton);

    const amountInput = screen.getByLabelText(/amount/i) as HTMLInputElement;
    expect(amountInput.value).toBe("10,000");
  });
});
