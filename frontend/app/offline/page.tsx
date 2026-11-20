"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Spinner } from "../../components/ui/Spinner";
import { SITE_NAME } from "../lib/seo";

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
  const [retryTarget, setRetryTarget] = useState("/");

  useEffect(() => {
    setMounted(true);
    setRetryTarget(resolveRetryTarget());

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
            <Spinner size="lg" label={t("reconnectingTitle")} />
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">
                {t("reconnectingTitle")}
              </h1>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                {t("reconnectingMessage")}
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
                {t("title")}
              </h1>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                {t("message", { siteName: SITE_NAME })}
              </p>
            </div>
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
            >
              {t("retry")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
