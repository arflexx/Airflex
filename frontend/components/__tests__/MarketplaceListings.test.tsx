/**
 * Tests for marketplace skeleton loading + error states (issue #446).
 *
 * Uses react-dom/server static rendering so we don't depend on
 * @testing-library/react (not currently a project dependency). useEffect does
 * not run during static rendering, so <MarketplaceListings /> renders its
 * initial loading state — which is exactly what we want to assert.
 */

import { renderToStaticMarkup } from "react-dom/server";
import TradeCardSkeleton from "../TradeCardSkeleton";
import {
  MarketplaceListings,
  MarketplaceLoading,
  MarketplaceError,
  EmptyState,
} from "../MarketplaceListings";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

describe("TradeCardSkeleton (#446)", () => {
  it("renders the requested number of skeleton cards", () => {
    const html = render(<TradeCardSkeleton count={4} />);
    // Each skeleton is an <article> with animate-pulse.
    const articleCount = (html.match(/<article/g) || []).length;
    expect(articleCount).toBe(4);
  });

  it("uses theme tokens for both light and dark mode", () => {
    const html = render(<TradeCardSkeleton count={1} />);
    expect(html).toContain("animate-pulse");
    expect(html).toContain("dark:bg-gray-700");
    expect(html).toContain("dark:border-gray-700");
  });

  it("is hidden from assistive tech by default", () => {
    const html = render(<TradeCardSkeleton count={1} />);
    expect(html).toContain("aria-hidden=\"true\"");
  });

  it("defaults to a single skeleton", () => {
    const html = render(<TradeCardSkeleton />);
    expect((html.match(/<article/g) || []).length).toBe(1);
  });
});

describe("MarketplaceLoading (#446)", () => {
  it("renders a busy status region with skeletons", () => {
    const html = render(<MarketplaceLoading count={6} />);
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain('role="status"');
    expect((html.match(/<article/g) || []).length).toBe(6);
  });
});

describe("MarketplaceError (#446)", () => {
  it("renders an alert with a retry control", () => {
    const html = render(<MarketplaceError onRetry={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
    // Dark mode contrast tokens present
    expect(html).toContain("dark:border-red-800");
  });
});

describe("EmptyState (#446)", () => {
  it("renders a friendly empty message and a sell CTA", () => {
    const html = render(<EmptyState />);
    expect(html).toContain("No active listings right now");
    expect(html).toContain("Sell Airtime / Data");
  });
});

describe("MarketplaceListings initial render (#446)", () => {
  it("shows the skeleton loading state on first render (before effects)", () => {
    // useEffect does not run during static rendering, so the component
    // renders its initial "loading" status — i.e. skeletons.
    const html = render(<MarketplaceListings apiUrl="http://localhost:3001" />);
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("animate-pulse");
    // No real trade content while loading
    expect(html).not.toContain("View &amp; Buy");
  });
});
