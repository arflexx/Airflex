import { getTranslations } from "next-intl/server";
import ErrorBoundary from "../../components/ErrorBoundary";
import MarketplaceListings from "../../components/MarketplaceListings";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Home");
  return { title: t("activeListings") };
}

/**
 * /trades — marketplace listings index (issue #446).
 *
 * A thin Server-Component shell that renders the interactive
 * `MarketplaceListings` client component with `fetchOnMount` so the page
 * shows animated skeleton placeholders while the first listings request is
 * in-flight, then resolves to the real cards.
 */
export default async function TradesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <ErrorBoundary context={{ section: "MarketplaceListings.page" }}>
        <MarketplaceListings fetchOnMount />
      </ErrorBoundary>
    </div>
  );
}
