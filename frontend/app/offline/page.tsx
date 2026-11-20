"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Spinner } from "../../components/ui/Spinner";
import { getSavedLocale } from "../../hooks/useLocaleStorage";
import type { AppLocale } from "../../i18n/routing";
import en from "../../locales/en/common.json";
import ha from "../../locales/ha/common.json";
import ig from "../../locales/ig/common.json";
import yo from "../../locales/yo/common.json";

/**
 * Offline page copy, keyed by locale (issue #613).
 *
 * This page is served by next-pwa's `fallbacks.document` strategy (see
 * `next.config.js` / `lib/pwa-cache-strategy.js`) straight from the
 * service-worker cache when a navigation fails with no network at all —
 * there is no server round-trip to resolve the active locale from a cookie
 * or an `accept-language` header the way the rest of the app does via
 * `next-intl`'s `NextIntlClientProvider`. The message catalogs are imported
 * directly (rather than lazily) so all four locales ship inside this
 * route's own JS chunk, which next-pwa must already precache for the
 * fallback to work offline in the first place — no extra network request is
 * introduced to localize this page.
 */
const MESSAGES: Record<AppLocale, (typeof en)["Offline"]> = {
  en: en.Offline,
  ha: ha.Offline,
  ig: ig.Offline,
  yo: yo.Offline,
};

/**
 * In production, next-pwa's document fallback serves this page's markup in
 * place of the route the user actually tried to reach — the address bar
 * still shows that original route (e.g. `/trades/abc`), not `/offline`.
 * Retrying should reload that real route, not loop back onto this page.
 *
 * When `/offline` is hit directly (a bookmark, or an e2e test that can't
 * simulate the service-worker fallback — see `e2e/offline.spec.ts`) there is
 * no prior route to recover, so Retry sends the user home instead.
 */
function getRetryHref(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search } = window.location;
  if (pathname === "/offline") return "/";
  return `${pathname}${search}`;
}

/**
 * The route the service worker falls back to (and thus the route a user is
 * most likely to have actually been trying to reach) is whatever the browser
 * was navigating *from*. `document.referrer` carries that — when it's
 * same-origin we send the Retry button there instead of hardcoding "/", so
 * retrying genuinely re-attempts the page the user lost (issue #610).
 */
function resolveRetryTarget(): string {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return "/";
  }
  if (!document.referrer) return "/";
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin !== window.location.origin) return "/";
    // Never bounce back to /offline itself.
    if (referrer.pathname.replace(/\/$/, "") === "/offline") return "/";
    return `${referrer.pathname}${referrer.search}` || "/";
  } catch {
    return "/";
  }
}

export default function OfflinePage() {
  const router = useRouter();
  const t = useTranslations("Offline");
  const [reconnecting, setReconnecting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [retryHref, setRetryHref] = useState("/");
  const [messages, setMessages] = useState<(typeof en)["Offline"]>(MESSAGES.en);

  useEffect(() => {
    setMounted(true);
    setRetryHref(getRetryHref());
    setMessages(MESSAGES[getSavedLocale()]);

    // If already online when the page mounts (e.g. browser cached it), go home.
    if (typeof window !== "undefined" && window.navigator.onLine) {
      router.replace("/");
      return;
    }

    function handleOnline() {
      setReconnecting(true);
      router.replace("/");
    }

    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [router]);

  /** Attempts to reload the route the user was on before landing here. */
  function handleRetry() {
    if (typeof window === "undefined") return;
    window.location.href = retryTarget;
  }

  return (
    <div
      data-hydrated={mounted ? "true" : undefined}
      className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900"
    >
      <div className="flex max-w-md flex-col items-center gap-6 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
        {reconnecting ? (
          <>
            <Spinner size="lg" label={messages.reconnectingHeading} />
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">
                {messages.reconnectingHeading}
              </h1>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                {messages.reconnectingBody}
              </p>
            </div>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="text-6xl">
              📡
            </span>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">
                {messages.heading}
              </h1>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                {messages.body}
              </p>
            </div>
            <a
              href={retryHref}
              className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
            >
              {messages.retry}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
