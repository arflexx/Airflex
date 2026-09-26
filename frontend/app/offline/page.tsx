"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "../../components/ui/Spinner";
import { SITE_NAME } from "../lib/seo";

export default function OfflinePage() {
  const router = useRouter();
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <div className="flex max-w-md flex-col items-center gap-6 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
        {reconnecting ? (
          <>
            <Spinner size="lg" label="Reconnecting…" />
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">
                Reconnecting…
              </h1>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                Network connection restored. Taking you back…
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
                You&apos;re offline
              </h1>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                {SITE_NAME} needs a connection to load this page. Check your
                network and try again — your saved trades and wallet are safe.
              </p>
            </div>
            <a
              href="/"
              className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
            >
              Retry
            </a>
          </>
        )}
      </div>
    </div>
  );
}
