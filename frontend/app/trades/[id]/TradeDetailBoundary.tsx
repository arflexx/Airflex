"use client";

import { useState } from "react";
import ErrorBoundary from "../../../components/ErrorBoundary";
import TradeDetailClient from "./TradeDetailClient";
import type { TradeOffer } from "../../../../server/src/types/trade";

interface Props {
  trade: TradeOffer;
}

/**
 * Wraps TradeDetailClient with ErrorBoundary (issue #611, duplicated as
 * issue #608 — same title/body, implemented once here).
 *
 * TradeDetailClient renders live Stellar transaction data, countdowns, and
 * the buy/sign/dispute flows — a malformed trade payload or an unexpected
 * null should show an inline, recoverable error instead of crashing the
 * whole route. This file exists as a thin client wrapper (rather than
 * inlining the boundary into the server component `page.tsx`) because
 * "Retry" needs to actually re-mount TradeDetailClient via a React key
 * reset, which requires client-side state that a Server Component can't
 * hold.
 *
 * ErrorBoundary only intercepts runtime exceptions thrown during render —
 * it does not special-case TradeDetailClient's own loading/empty states,
 * which TradeDetailClient already handles itself before it ever throws.
 */
export default function TradeDetailBoundary({ trade }: Props) {
  // Bumped on every retry so <TradeDetailClient key={attempt} /> unmounts the
  // failed instance and mounts a fresh one, rather than trying to resume
  // whatever state it was in when it threw.
  const [attempt, setAttempt] = useState(0);

  return (
    <ErrorBoundary
      context={{ section: "TradeDetailClient", tradeId: trade.id }}
      onReset={() => setAttempt((n) => n + 1)}
    >
      <TradeDetailClient key={attempt} trade={trade} />
    </ErrorBoundary>
  );
}
