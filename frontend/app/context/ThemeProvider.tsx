"use client";

import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { loadTheme, saveTheme } from "../../lib/storage";

/**
 * Theme persistence provider (Issue #469, extended in #605).
 *
 * Wraps `next-themes` so the chosen theme is written to `localStorage` under
 * `airflex-theme` and restored before first paint. next-themes injects a tiny
 * blocking inline script into <head> that reads the stored value (falling back
 * to the OS `prefers-color-scheme`) and sets the `class` attribute on <html>
 * *before* React hydrates — this is what prevents a flash of the wrong theme
 * (FOUC) on reload or a fresh visit.
 *
 * Issue #605 asked that persistence go through the project's own
 * `frontend/lib/storage.ts` abstraction rather than relying solely on
 * next-themes' internal localStorage handling, and that the preference be
 * cleared on logout. `STORAGE_KEY` is shared with `storage.ts`'s theme
 * helpers so both read/write the same entry, `ThemeSync` (below) persists
 * every change via `saveTheme`, `defaultTheme` seeds from `loadTheme()`, and
 * `clearToken()` in `frontend/app/lib/auth.ts` calls `clearTheme()` on sign-out.
 *
 * Requirements satisfied:
 *  - Persisted preference survives a full page reload (localStorage key,
 *    written via `storage.ts`'s `saveTheme`).
 *  - Theme applied pre-paint via next-themes' injected script (no FOUC); the
 *    stored preference (read via `storage.ts`'s `loadTheme`) is preferred
 *    over the system default.
 *  - Default falls back to system preference when no stored value exists.
 *  - Preference is applied client-side only — `loadTheme()` returns `null`
 *    during server rendering (no `window`), so SSR always falls back to
 *    "system" and never throws a hydration mismatch.
 *  - Preference is cleared on logout via `clearToken()` → `clearTheme()`.
 *  - ThemeToggle reads `resolvedTheme` and calls `setTheme`, both backed by
 *    this provider, so the button reflects the persisted/active theme.
 *
 * `<html suppressHydrationWarning>` (set in the root layout) is required
 * because the pre-paint script mutates the class attribute before React
 * commits, which would otherwise warn about a hydration mismatch.
 */
export const STORAGE_KEY = "airflex-theme";

/**
 * Persists every theme change through `frontend/lib/storage.ts` (issue #605).
 *
 * next-themes already writes to the same localStorage key internally; this
 * keeps the project's own storage abstraction as the source of truth so
 * other code (e.g. `clearTheme()` on logout) only has to know about
 * `storage.ts`, not next-themes' internals.
 */
function ThemeSync() {
  const { theme } = useTheme();

  useEffect(() => {
    if (theme) saveTheme(theme);
  }, [theme]);

  return null;
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  // `loadTheme()` guards on `typeof window` and returns `null` during SSR, so
  // this is always "system" on the server and the real stored value (if any)
  // on the client — no hydration mismatch, since next-themes' own injected
  // script (not this prop) is what applies the class before paint.
  const storedTheme = loadTheme();

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme={storedTheme ?? "system"}
      enableSystem
      disableTransitionOnChange
      storageKey={STORAGE_KEY}
    >
      <ThemeSync />
      {children}
    </NextThemesProvider>
  );
}
