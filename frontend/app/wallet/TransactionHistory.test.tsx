import React, { Profiler } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import TransactionHistory, { type WalletTransaction } from "./TransactionHistory";
import { ModalSkeleton, TransactionHistorySkeleton } from "./WalletSkeletons";

/**
 * TransactionHistory was split out of the wallet page so it can load as its
 * own chunk (Issue #544). These tests pin the behaviour it carried over.
 */

const tx = (overrides: Partial<WalletTransaction> = {}): WalletTransaction => ({
  id: "t1",
  asset_type: "MTN_AIRTIME",
  amount: 1500,
  status: "Completed",
  escrow_tx_hash: "a".repeat(64),
  created_at: "2026-10-01T10:00:00.000Z",
  ...overrides,
});

function renderHistory(props: Partial<React.ComponentProps<typeof TransactionHistory>> = {}) {
  const onPageChange = jest.fn();
  render(
    <TransactionHistory
      transactions={[tx()]}
      loading={false}
      page={1}
      pageSize={10}
      totalTrades={1}
      totalPages={1}
      onPageChange={onPageChange}
      {...props}
    />
  );
  return { onPageChange };
}

describe("TransactionHistory", () => {
  it("renders a row per transaction with amount and status", () => {
    renderHistory({ transactions: [tx(), tx({ id: "t2", amount: 250, status: "Active" })], totalTrades: 2 });

    const table = screen.getByRole("table", { name: "Wallet transactions" });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("₦1,500")).toBeInTheDocument();
    expect(screen.getByText("₦250")).toBeInTheDocument();
  });

  it("shows a dash when a transaction has no escrow hash", () => {
    renderHistory({ transactions: [tx({ escrow_tx_hash: null })] });

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the loading state only before any rows have arrived", () => {
    renderHistory({ transactions: [], loading: true, totalTrades: 0 });

    expect(screen.getByRole("status", { name: "Loading transactions…" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no transactions", () => {
    renderHistory({ transactions: [], totalTrades: 0 });

    expect(screen.getByText("No transactions found on this account yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("trades-range")).not.toBeInTheDocument();
  });

  it("derives the range from the server total on the last page", () => {
    renderHistory({ page: 5, totalTrades: 47, totalPages: 5 });

    expect(screen.getByTestId("trades-range")).toHaveTextContent("Showing 41–47 of 47 trades");
  });

  it("requests the neighbouring pages", () => {
    const { onPageChange } = renderHistory({ page: 2, totalTrades: 30, totalPages: 3 });

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });

  it("disables paging at the ends and while loading", () => {
    renderHistory({ page: 1, totalTrades: 30, totalPages: 3, loading: true });

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

/**
 * Issue #683: the wallet page re-renders on every SSE notification (e.g. an
 * optimistic balance update). React's <Profiler> reports each commit of its
 * subtree, so it shows directly whether TransactionHistory re-rendered.
 */
describe("TransactionHistory memoization", () => {
  const transactions = [tx(), tx({ id: "t2", amount: 250 })];
  const noop = () => {};

  function WalletPageStandIn({ onRender }: { onRender: React.ProfilerOnRenderCallback }) {
    const [balance, setBalance] = React.useState(0);
    const [rows, setRows] = React.useState(transactions);
    return (
      <>
        <p>₦{balance} balance</p>
        <button onClick={() => setBalance((b) => b + 100)}>sse balance update</button>
        <button onClick={() => setRows((r) => [...r, tx({ id: "t3", amount: 999 })])}>new trade</button>
        <Profiler id="history" onRender={onRender}>
          <TransactionHistory
            transactions={rows}
            loading={false}
            page={1}
            pageSize={10}
            totalTrades={rows.length}
            totalPages={1}
            onPageChange={noop}
          />
        </Profiler>
      </>
    );
  }

  it("does not re-render on unrelated parent updates", () => {
    const onRender = jest.fn();
    render(<WalletPageStandIn onRender={onRender} />);
    expect(onRender).toHaveBeenCalledTimes(1); // mount

    fireEvent.click(screen.getByText("sse balance update"));
    fireEvent.click(screen.getByText("sse balance update"));

    expect(screen.getByText("₦200 balance")).toBeInTheDocument();
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it("re-renders when its transactions change", () => {
    const onRender = jest.fn();
    render(<WalletPageStandIn onRender={onRender} />);

    fireEvent.click(screen.getByText("new trade"));

    expect(onRender).toHaveBeenCalledTimes(2);
    expect(onRender.mock.calls[1]![1]).toBe("update");
    expect(screen.getByText("₦999")).toBeInTheDocument();
  });
});

describe("wallet loading skeletons", () => {
  it("renders an accessible placeholder for the transaction history", () => {
    render(<TransactionHistorySkeleton />);

    expect(screen.getByTestId("transaction-history-skeleton")).toHaveAttribute("role", "status");
    expect(screen.getByRole("status", { name: "Loading transactions…" })).toBeInTheDocument();
  });

  it("renders an accessible overlay placeholder for the modals", () => {
    render(<ModalSkeleton />);

    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
  });
});
