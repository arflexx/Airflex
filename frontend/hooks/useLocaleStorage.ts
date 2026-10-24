/**
 * Hook for managing locale persistence with LocalStorage.
 *
 * Provides utilities for saving, loading, and clearing the user's locale
 * preference from client-side storage.
 */

"use client";

import { loadLocale, saveLocale, clearLocale } from "../lib/storage";
import { routing, type AppLocale } from "../i18n/routing";

/**
 * Validates that a locale is supported by the application.
 */
function isValidLocale(locale: unknown): locale is AppLocale {
  return (
    typeof locale === "string" &&
    (routing.locales as readonly string[]).includes(locale)
  );
}

/**
 * Gets the saved locale from LocalStorage, if available and valid.
 * Falls back to the default locale if not found or invalid.
 *
 * @returns The saved locale if valid, otherwise the default locale.
 */
export function getSavedLocale(): AppLocale {
  const saved = loadLocale();
  if (!saved || !isValidLocale(saved)) {
    return routing.defaultLocale as AppLocale;
  }
  return saved;
}

/**
 * Saves a locale to LocalStorage after validating it.
 * Silently ignores invalid locales.
 *
 * @param locale - The locale to save
 */
export function persistLocale(locale: string): void {
  if (isValidLocale(locale)) {
    saveLocale(locale);
  }
}

/**
 * Clears the saved locale preference, reverting to default on next load.
 */
export function resetLocalePreference(): boolean {
  return clearLocale();
}
