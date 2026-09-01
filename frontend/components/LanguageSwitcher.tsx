"use client";

/**
 * LanguageSwitcher — dropdown that changes the active locale.
 *
 * Uses next-intl's locale-aware router so navigation preserves the current
 * page while switching locale (e.g. `/wallet` → `/yo/wallet`). The choice is
 * persisted in the `NEXT_LOCALE` cookie by the i18n middleware.
 */

import { useState, useRef, useEffect, useTransition } from "react";
import { useLocale } from "next-intl";
import { useRouter, usePathname } from "../i18n/navigation";
import { routing } from "../i18n/routing";

const LOCALE_LABELS: Record<(typeof routing.locales)[number], string> = {
  en: "English",
  yo: "Yorùbá",
  ig: "Igbo",
  ha: "Hausa",
};

export default function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function onSelect(next: (typeof routing.locales)[number]) {
    if (next === locale) {
      setOpen(false);
      return;
    }
    setOpen(false);
    startTransition(() => {
      router.replace(pathname, { locale: next });
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={LOCALE_LABELS[locale as (typeof routing.locales)[number]]}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        <span aria-hidden="true">🌐</span>
        {locale}
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-40 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {routing.locales.map((code) => (
            <li key={code}>
              <button
                type="button"
                role="option"
                aria-selected={code === locale}
                onClick={() => onSelect(code)}
                disabled={isPending}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors ${
                  code === locale
                    ? "font-semibold text-violet-700 dark:text-violet-400"
                    : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                }`}
              >
                {LOCALE_LABELS[code]}
                {code === locale && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
