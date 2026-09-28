import React from "react";
import { render, screen } from "@testing-library/react";

import {
  ESCROW_LINK_LABEL,
  EscrowTransactionLink,
  shouldShowEscrowLink,
} from "./EscrowTransactionLink";
import type { TradeStatus } from "../../server/src/types/trade";

const SAMPLE_HASH =
  "3389e9f0f1a54f7b1d5b2a0c9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";

describe("shouldShowEscrowLink", () => {
  it.each<TradeStatus>(["Locked", "Completed", "Disputed"])(
    "shows the link for %s trades",
    (status) => {
      expect(shouldShowEscrowLink(status, SAMPLE_HASH)).toBe(true);
    }
  );

  it.each<TradeStatus>(["Active", "Cancelled"])(
    "hides the link for %s trades",
    (status) => {
      expect(shouldShowEscrowLink(status, SAMPLE_HASH)).toBe(false);
    }
  );

  it("hides the link when no escrow hash has been recorded", () => {
    expect(shouldShowEscrowLink("Locked", null)).toBe(false);
    expect(shouldShowEscrowLink("Locked", undefined)).toBe(false);
  });
});

describe("EscrowTransactionLink", () => {
  it("renders a labelled explorer link for a locked trade", () => {
    render(<EscrowTransactionLink status="Locked" escrowTxHash={SAMPLE_HASH} />);

    const link = screen.getByRole("link", { name: new RegExp(ESCROW_LINK_LABEL) });
    expect(link).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/tx/${SAMPLE_HASH}`
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("matches the snapshot for a sample hash", () => {
    const { container } = render(
      <EscrowTransactionLink status="Completed" escrowTxHash={SAMPLE_HASH} />
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders nothing for an active trade", () => {
    const { container } = render(
      <EscrowTransactionLink status="Active" escrowTxHash={SAMPLE_HASH} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
