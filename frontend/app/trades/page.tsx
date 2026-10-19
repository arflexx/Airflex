import MarketplaceListings from "../../components/MarketplaceListings";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Marketplace — AirFlex",
  description: "Browse active airtime and data trade offers on AirFlex.",
};

/**
 * /trades — marketplace listings index.
 *
 * A thin Server-Component shell that renders the interactive
 * `MarketplaceListings` client component, which handles fetching, skeleton
 * loading, error, and empty states (issue #446).
 */
export default function TradesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="mb-8">
        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          Marketplace
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
          Active Listings
        </h1>
      </div>

      <MarketplaceListings />
    </div>
  );
}
