import React from "react";

export type StellarExplorerType = "transaction" | "account" | "contract";

export interface StellarExplorerLinkProps {
  /** The kind of Stellar entity to explore */
  type: StellarExplorerType;
  /** The transaction hash, account public key, or contract address */
  value?: string | null;
  /** Optional custom link text or content. If omitted, value is displayed */
  children?: React.ReactNode;
  /** Additional CSS class names */
  className?: string;
  /** Whether to truncate long addresses/hashes when displaying as default text. Defaults to true */
  truncate?: boolean;
}

/**
 * Truncates a long Stellar address or transaction hash for readable inline display.
 */
export function formatExplorerValue(val: string): string {
  if (val.length <= 12) return val;
  return `${val.slice(0, 6)}…${val.slice(-6)}`;
}

/**
 * Constructs the canonical Stellar Expert explorer URL for a given type, value, and network.
 */
export function getStellarExpertUrl(type: StellarExplorerType, value: string): string {
  const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet").toLowerCase();
  const networkSegment = network === "mainnet" || network === "public" ? "public" : "testnet";
  const typeSegment = type === "transaction" ? "tx" : type;
  return `https://stellar.expert/explorer/${networkSegment}/${typeSegment}/${encodeURIComponent(value.trim())}`;
}

/**
 * Reusable deep-link component that links Stellar contracts, accounts, and transactions
 * to the Stellar Expert block explorer.
 */
export function StellarExplorerLink({
  type,
  value,
  children,
  className = "",
  truncate = true,
}: StellarExplorerLinkProps) {
  // Acceptance criteria: The component renders null gracefully when value is empty or undefined.
  if (!value || typeof value !== "string" || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  const url = getStellarExpertUrl(type, trimmed);
  const displayText = children ?? (truncate ? formatExplorerValue(trimmed) : trimmed);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-violet-600 hover:text-violet-700 hover:underline dark:text-violet-400 dark:hover:text-violet-300 font-mono text-xs ${className}`}
      title={`View ${type} on Stellar Expert`}
    >
      <span>{displayText}</span>
      <svg
        className="h-3.5 w-3.5 shrink-0 opacity-70 transition-opacity hover:opacity-100"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
        role="img"
        data-testid="external-link-icon"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
    </a>
  );
}

export default StellarExplorerLink;
