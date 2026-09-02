import { defineRouting } from "next-intl/routing";

/**
 * Shared i18n routing configuration.
 *
 * Locales:
 *   en — English (default, no URL prefix)
 *   yo — Yoruba
 *   ig — Igbo
 *   ha — Hausa
 *
 * `localePrefix: "as-needed"` means the default locale (`en`) has no URL prefix
 * while the others are prefixed (e.g. `/yo/wallet`).
 */
export const routing = defineRouting({
  locales: ["en", "yo", "ig", "ha"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type AppLocale = (typeof routing.locales)[number];
