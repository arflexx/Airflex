import React from "react";
import { render, screen } from "@testing-library/react";
import {
  StellarExplorerLink,
  getStellarExpertUrl,
  formatExplorerValue,
} from "./StellarExplorerLink";

describe("formatExplorerValue", () => {
  it("leaves short values intact", () => {
    expect(formatExplorerValue("1234567890")).toBe("1234567890");
  });

  it("truncates values longer than 12 characters", () => {
    expect(formatExplorerValue("CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP")).toBe(
      "CCBJ23…P2SLNP"
    );
  });
});

describe("getStellarExpertUrl", () => {
  const prevNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

  afterEach(() => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = prevNetwork;
  });

  it("builds testnet transaction URL by default", () => {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    expect(getStellarExpertUrl("transaction", "abc123tx")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123tx"
    );
  });

  it("builds testnet account URL", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
    expect(getStellarExpertUrl("account", "GABCDEF")).toBe(
      "https://stellar.expert/explorer/testnet/account/GABCDEF"
    );
  });

  it("builds testnet contract URL", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
    expect(getStellarExpertUrl("contract", "CCBJ123")).toBe(
      "https://stellar.expert/explorer/testnet/contract/CCBJ123"
    );
  });

  it("builds mainnet URL when NEXT_PUBLIC_STELLAR_NETWORK is mainnet", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "mainnet";
    expect(getStellarExpertUrl("transaction", "tx999")).toBe(
      "https://stellar.expert/explorer/public/tx/tx999"
    );
    expect(getStellarExpertUrl("contract", "contract777")).toBe(
      "https://stellar.expert/explorer/public/contract/contract777"
    );
    expect(getStellarExpertUrl("account", "acc111")).toBe(
      "https://stellar.expert/explorer/public/account/acc111"
    );
  });

  it("builds public URL when NEXT_PUBLIC_STELLAR_NETWORK is public", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "public";
    expect(getStellarExpertUrl("contract", "CCBJ123")).toBe(
      "https://stellar.expert/explorer/public/contract/CCBJ123"
    );
  });
});

describe("StellarExplorerLink", () => {
  const prevNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = prevNetwork;
  });

  it("renders null gracefully when value is empty string", () => {
    const { container } = render(<StellarExplorerLink type="contract" value="" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders null gracefully when value is undefined", () => {
    const { container } = render(<StellarExplorerLink type="contract" value={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders null gracefully when value is whitespace only", () => {
    const { container } = render(<StellarExplorerLink type="contract" value="   " />);
    expect(container.firstChild).toBeNull();
  });

  it("renders anchor tag with correct URL, target, rel, and external icon", () => {
    const contract = "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
    render(<StellarExplorerLink type="contract" value={contract} />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/contract/${contract}`
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.getByTestId("external-link-icon")).toBeInTheDocument();
    expect(link).toHaveTextContent("CCBJ23…P2SLNP");
  });

  it("renders custom children when provided", () => {
    render(
      <StellarExplorerLink type="transaction" value="hash123">
        View Contract Transaction
      </StellarExplorerLink>
    );

    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("View Contract Transaction");
    expect(link).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/hash123"
    );
  });
});
