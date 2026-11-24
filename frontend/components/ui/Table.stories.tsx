import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import React from "react";
import { Table, THead, TBody, TR, TH, TD, TableEmptyState } from "./Table";
import { Badge } from "./Badge";
import { Button } from "./Button";

const meta: Meta<typeof Table> = {
  title: "UI/Table",
  component: Table,
  tags: ["autodocs"],
  argTypes: {
    caption: {
      control: "text",
      description: "Accessible caption for the table (aria-label)",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Table>;

const sampleTrades = [
  {
    id: "TRD-001",
    asset: "MTN Airtime",
    amount: "₦5,000",
    counterparty: "Alice M.",
    status: "Completed" as const,
  },
  {
    id: "TRD-002",
    asset: "Airtel Data 10GB",
    amount: "₦3,500",
    counterparty: "Bob K.",
    status: "Active" as const,
  },
  {
    id: "TRD-003",
    asset: "Glo Airtime",
    amount: "₦2,000",
    counterparty: "Charlie D.",
    status: "Open" as const,
  },
  {
    id: "TRD-004",
    asset: "9mobile Airtime",
    amount: "₦1,500",
    counterparty: "Diana P.",
    status: "Disputed" as const,
  },
];

export const Default: Story = {
  args: {
    onRowAction: fn(),
  },
  argTypes: {
    onRowAction: {
      action: "row action clicked",
      description: "Fired when a row action button is clicked",
    },
  },
  render: (args) => (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <Table {...args} caption={args.caption || "Recent trades"}>
        <THead>
          <TR>
            <TH>Trade ID</TH>
            <TH>Asset</TH>
            <TH>Amount</TH>
            <TH>Counterparty</TH>
            <TH>Status</TH>
            <TH className="text-right">Action</TH>
          </TR>
        </THead>
        <TBody>
          {sampleTrades.map((t) => (
            <TR key={t.id}>
              <TD className="font-mono text-xs font-semibold">{t.id}</TD>
              <TD className="font-medium text-gray-900 dark:text-gray-100">{t.asset}</TD>
              <TD>{t.amount}</TD>
              <TD>{t.counterparty}</TD>
              <TD>
                <Badge variant={t.status} />
              </TD>
              <TD className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`View trade ${t.id}`}
                  onClick={() => args.onRowAction?.(t.id)}
                >
                  View
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const viewButton = canvas.getByRole("button", { name: /view trade TRD-001/i });
    await userEvent.click(viewButton);
    await expect(args.onRowAction).toHaveBeenCalledTimes(1);
    await expect(args.onRowAction).toHaveBeenCalledWith("TRD-001");
  },
};

export const WithSelectedRow: Story = {
  render: () => (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <Table caption="Trades with selected row">
        <THead>
          <TR>
            <TH>Trade ID</TH>
            <TH>Asset</TH>
            <TH>Amount</TH>
            <TH>Status</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD className="font-mono text-xs">TRD-001</TD>
            <TD>MTN Airtime</TD>
            <TD>₦5,000</TD>
            <TD>
              <Badge variant="Completed" />
            </TD>
          </TR>
          <TR selected>
            <TD className="font-mono text-xs font-bold text-violet-700 dark:text-violet-300">
              TRD-002 (Selected)
            </TD>
            <TD className="font-semibold text-violet-900 dark:text-violet-200">Airtel Data 10GB</TD>
            <TD className="font-semibold text-violet-900 dark:text-violet-200">₦3,500</TD>
            <TD>
              <Badge variant="Active" />
            </TD>
          </TR>
          <TR>
            <TD className="font-mono text-xs">TRD-003</TD>
            <TD>Glo Airtime</TD>
            <TD>₦2,000</TD>
            <TD>
              <Badge variant="Open" />
            </TD>
          </TR>
        </TBody>
      </Table>
    </div>
  ),
};

export const EmptyState: Story = {
  render: () => (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <Table caption="Empty trades table">
        <THead>
          <TR>
            <TH>Trade ID</TH>
            <TH>Asset</TH>
            <TH>Amount</TH>
            <TH>Status</TH>
            <TH className="text-right">Action</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TableEmptyState colSpan={5}>
              <div className="flex flex-col items-center justify-center gap-2 py-4">
                <span className="text-2xl" role="img" aria-label="Inbox">
                  📭
                </span>
                <p className="font-medium text-gray-700 dark:text-gray-300">No transactions found</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  When you initiate or complete trades, they will appear here.
                </p>
              </div>
            </TableEmptyState>
          </TR>
        </TBody>
      </Table>
    </div>
  ),
};
