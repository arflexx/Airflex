import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { TradeOffer } from "../../../../server/src/types/trade";
import TradeDetailClient from "./TradeDetailClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeResponse {
  data: TradeOffer;
}

// ---------------------------------------------------------------------------
// Data fetching (SSR)
// ---------------------------------------------------------------------------

async function getTrade(id: string): Promise<TradeOffer | null> {
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/v1/trades/${encodeURIComponent(id)}`, {
      // Always serve fresh data so expiry countdowns and status changes
      // are reflected immediately. Adjust to `revalidate: 30` if traffic
      // warrants ISR caching at the cost of slight staleness.
      cache: "no-store",
    });
  } catch {
    // Network error — treat as not found rather than crashing
    return null;
  }

  if (res.status === 404) return null;
  if (!res.ok) return null;

  const body = (await res.json()) as TradeResponse;
  return body.data ?? null;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Metadata (Issue #28)
// ---------------------------------------------------------------------------

/**
 * Build the page title from the trade itself, so a shared link previews as
 * "5,000 NGN of MTN airtime" rather than an opaque id.
 *
 * Reuses `getTrade`, which Next.js dedupes against the page's own call within a
 * single render — so this costs no extra request.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const trade = await getTrade(id);

  if (!trade) {
    // A missing trade renders not-found; give crawlers a title rather than a
    // template placeholder, and keep the 404 out of the index.
    return {
      title: "Trade not found",
      robots: { index: false, follow: false },
    };
  }

  const amount = trade.amount.toLocaleString("en-NG");
  const title = `₦${amount} ${trade.asset_type} trade`;
  const description = `A peer-to-peer ${trade.asset_type} trade for ₦${amount} on AirFlex, secured by a Soroban escrow contract.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `/trades/${id}`,
    },
    twitter: { card: "summary_large_image", title, description },
    // An active listing is worth indexing; a locked, settled or cancelled one
    // is a dead link to anyone arriving from search.
    robots:
      trade.status === "Active"
        ? { index: true, follow: true }
        : { index: false, follow: true },
  };
}

// ---------------------------------------------------------------------------
// Page (Server Component)
// ---------------------------------------------------------------------------

export default async function TradeDetailPage({ params }: PageProps) {
  const { id } = await params;
  const trade = await getTrade(id);

  // Delegate to Next.js global not-found.tsx if trade is absent
  if (!trade) notFound();

  // trade is guaranteed non-null here — pass down to the interactive shell
  return <TradeDetailClient trade={trade} />;
}
