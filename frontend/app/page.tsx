import type { TradeOffer } from "../../server/src/types/trade";
import ThemeToggle from "../components/ThemeToggle";

interface TradesResponse {
  data: TradeOffer[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

async function getActiveListings(): Promise<TradesResponse> {
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
  try {
    const res = await fetch(`${apiUrl}/api/trades?page=1&limit=20`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) {
      return { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    }
    return res.json() as Promise<TradesResponse>;
  } catch {
    // API unreachable (e.g. during static prerender) — render an empty marketplace
    return { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
  }
}

function formatAssetType(raw: string): string {
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function AssetBadge({ assetType }: { assetType: string }) {
  const isData = assetType.toUpperCase().includes("DATA");
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide ${
        isData
          ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          : "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
      }`}
    >
      {formatAssetType(assetType)}
    </span>
  );
}

function TradeCard({ trade }: { trade: TradeOffer }) {
  const sellerAlias = `@seller_${trade.seller_id.slice(-8)}`;
  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Seller</p>
          <p className="font-semibold text-gray-900 truncate max-w-[160px] dark:text-gray-100">
            {sellerAlias}
          </p>
        </div>
        <AssetBadge assetType={trade.asset_type} />
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="text-xs uppercase tracking-widest text-gray-400 font-medium dark:text-gray-500">
          Amount
        </p>
        <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          ₦{trade.amount.toLocaleString()}
        </p>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Expires{" "}
        {new Date(trade.expires_at).toLocaleDateString("en-NG", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>

      <a
        href={`/trades/${trade.id}`}
        className="mt-auto inline-flex items-center justify-center rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
        aria-label={`View and buy ${formatAssetType(trade.asset_type)} worth ₦${trade.amount.toLocaleString()} from ${sellerAlias}`}
      >
        View &amp; Buy
      </a>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="col-span-full flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-8 py-20 text-center dark:border-gray-700 dark:bg-gray-800/50">
      <span aria-hidden="true" className="text-5xl">📭</span>
      <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-200">
        No active listings right now
      </h2>
      <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
        Be the first to list your airtime or data. Sellers get paid instantly once
        delivery is confirmed on-chain.
      </p>
      <a
        href="/sell"
        className="mt-2 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        Sell Airtime / Data
      </a>
    </div>
  );
}

export default async function HomePage() {
  const { data: listings, pagination } = await getActiveListings();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <main>
        {/* Hero */}
        <section className="bg-white border-b border-gray-100 dark:bg-gray-800 dark:border-gray-700">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <div className="max-w-2xl">
              <p className="mb-3 inline-block rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                Powered by Stellar
              </p>
              <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl dark:text-gray-50">
                Buy &amp; Sell Airtime{" "}
                <span className="text-violet-600 dark:text-violet-400">Peer-to-Peer</span>
              </h1>
              <p className="mt-4 text-lg text-gray-600 leading-relaxed dark:text-gray-300">
                AirFlex is an open marketplace for Nigerian airtime and mobile data.
                Every trade is secured by a Soroban escrow contract — funds only move
                when delivery is confirmed.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href="#listings"
                  className="inline-flex items-center rounded-xl bg-violet-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                >
                  Browse Listings
                </a>
                <a
                  href="/sell"
                  className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                >
                  List Airtime / Data
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Listings */}
        <section
          id="listings"
          aria-labelledby="listings-heading"
          className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8"
        >
          <div className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <h2
                id="listings-heading"
                className="text-2xl font-bold text-gray-900 dark:text-gray-100"
              >
                Active Listings
              </h2>
              {pagination.total > 0 && (
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {pagination.total} offer{pagination.total !== 1 ? "s" : ""} available
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {listings.length === 0 ? (
              <EmptyState />
            ) : (
              listings.map((trade) => <TradeCard key={trade.id} trade={trade} />)
            )}
          </div>

          {pagination.totalPages > 1 && (
            <p className="mt-10 text-center text-sm text-gray-400 dark:text-gray-500">
              Showing page 1 of {pagination.totalPages}. Sign in to filter and paginate listings.
            </p>
          )}
        </section>
      </main>

      <footer className="border-t border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            &copy; {new Date().getFullYear()} AirFlex. Open source under the MIT License.
          </p>
          <div className="flex gap-5 text-sm text-gray-400 dark:text-gray-500">
            <a href="/docs" className="hover:text-gray-600 transition-colors dark:hover:text-gray-300">
              Docs
            </a>
            <a
              href="https://github.com/dark-sarge/Airflex"
              target="_blank"
              rel="noreferrer"
              className="hover:text-gray-600 transition-colors dark:hover:text-gray-300"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
