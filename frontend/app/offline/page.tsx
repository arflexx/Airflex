import Link from "next/link";
import { SITE_NAME } from "../lib/seo";

export const metadata = {
  title: "You're offline",
};

/**
 * Offline fallback page (issue #107).
 *
 * Served by the service worker via next-pwa's `fallbacks.document` config when
 * the user has no network connection and the requested page is not in the
 * cache. It must be a real route so the service worker can precache it.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <div className="flex max-w-md flex-col items-center gap-6 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <span aria-hidden="true" className="text-6xl">
          📡
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">
            You&apos;re offline
          </h1>
          <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            {SITE_NAME} needs a connection to load this page. Check your network
            and try again — your saved trades and wallet are safe.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
        >
          Retry
        </Link>
      </div>
    </div>
  );
}
