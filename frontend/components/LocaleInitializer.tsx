/**
 * LocaleInitializer — client component that restores the user's saved locale
 * preference from LocalStorage on app load.
 *
 * Runs once on mount to check for a saved locale and redirect to it if:
 * 1. A locale is saved in LocalStorage
 * 2. It differs from the current locale
 * 3. It's a valid, supported locale
 *
 * This ensures minimal FOUC (Flash of Unstyled Content) or locale mismatch
 * after a page reload or new session.
 */

"use client";

import { useEffect } from "react";
import { useLocale } from "next-intl";
import { useRouter, usePathname } from "../i18n/navigation";
import { getSavedLocale } from "../hooks/useLocaleStorage";

export default function LocaleInitializer() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const saved = getSavedLocale();

    // Redirect to saved locale if it differs from current
    if (saved !== locale) {
      router.replace(pathname, { locale: saved });
    }
  }, [locale, router, pathname]);

  // Invisible component — renders nothing
  return null;
}
