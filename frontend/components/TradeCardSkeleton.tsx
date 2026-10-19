/**
 * TradeCardSkeleton — animated placeholder that mirrors the layout of a
 * marketplace trade card (issue #446).
 *
 * The skeleton matches the real TradeCard structure — seller label, asset
 * badge area, amount, expiry line, and the action button — so there is no
 * layout shift when the actual listing data resolves. Uses Tailwind theme
 * tokens (with `dark:` variants) so it renders correctly in both modes.
 */

interface TradeCardSkeletonProps {
  /** Optional count of skeletons to render. Defaults to 1. */
  count?: number;
  /** Hide the card from assistive tech with aria-hidden. */
  ariaHidden?: boolean;
}

export default function TradeCardSkeleton({
  count = 1,
  ariaHidden = true,
}: TradeCardSkeletonProps) {
  const items = Array.from({ length: count });
  return (
    <>
      {items.map((_, i) => (
        <article
          key={i}
          aria-hidden={ariaHidden}
          className="flex animate-pulse flex-col gap-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          {/* Seller + asset badge row */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <span className="h-3 w-12 rounded bg-gray-200 dark:bg-gray-700" />
              <span className="h-4 w-24 rounded bg-gray-200 dark:bg-gray-700" />
            </div>
            <span className="h-5 w-20 rounded-full bg-gray-200 dark:bg-gray-700" />
          </div>

          {/* Amount */}
          <div className="flex flex-col gap-0.5">
            <span className="h-3 w-16 rounded bg-gray-200 dark:bg-gray-700" />
            <span className="h-8 w-32 rounded bg-gray-200 dark:bg-gray-700" />
          </div>

          {/* Expiry line */}
          <span className="h-3 w-40 rounded bg-gray-200 dark:bg-gray-700" />

          {/* Action button */}
          <span className="mt-auto h-10 w-full rounded-xl bg-gray-200 dark:bg-gray-700" />
        </article>
      ))}
    </>
  );
}
