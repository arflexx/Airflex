/**
 * Local storage helpers with SSR/hydration safety.
 *
 * LocalStorage is only available on the browser, so we guard against access
 * during server rendering or before hydration.
 */

const LOCALE_KEY = "airflex_locale";

/**
 * Storage key for the user's theme preference (issue #605).
 *
 * Shared with `next-themes`' `storageKey` prop in `ThemeProvider.tsx` so both
 * the pre-paint blocking script next-themes injects *and* this app's own
 * storage abstraction read/write the same localStorage entry.
 */
const THEME_KEY = "airflex-theme";

/**
 * Checks if LocalStorage is available (browser environment).
 */
function isLocalStorageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const test = "__test__";
    window.localStorage.setItem(test, test);
    window.localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the selected locale to LocalStorage.
 * Silently fails in SSR/non-browser environments.
 */
export function saveLocale(locale: string): void {
  if (!isLocalStorageAvailable()) return;
  try {
    window.localStorage.setItem(LOCALE_KEY, locale);
  } catch (error) {
    // LocalStorage quota exceeded or private browsing mode — fail silently
    console.warn("[storage] Failed to save locale to LocalStorage", error);
  }
}

/**
 * Reads the saved locale from LocalStorage.
 * Returns null if not found or unavailable.
 */
export function loadLocale(): string | null {
  if (!isLocalStorageAvailable()) return null;
  try {
    return window.localStorage.getItem(LOCALE_KEY);
  } catch (error) {
    // Private browsing mode or other storage errors — fail silently
    console.warn("[storage] Failed to read locale from LocalStorage", error);
    return null;
  }
}

/**
 * Clears the saved locale from LocalStorage.
 * Returns true if successful, false otherwise.
 */
export function clearLocale(): boolean {
  if (!isLocalStorageAvailable()) return false;
  try {
    window.localStorage.removeItem(LOCALE_KEY);
    return true;
  } catch (error) {
    console.warn("[storage] Failed to clear locale from LocalStorage", error);
    return false;
  }
}

/**
 * Saves the selected theme preference to LocalStorage (issue #605).
 * Silently fails in SSR/non-browser environments.
 */
export function saveTheme(theme: string): void {
  if (!isLocalStorageAvailable()) return;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    // LocalStorage quota exceeded or private browsing mode — fail silently
    console.warn("[storage] Failed to save theme to LocalStorage", error);
  }
}

/**
 * Reads the saved theme preference from LocalStorage.
 * Returns null if not found or unavailable (callers should fall back to the
 * system `prefers-color-scheme`).
 */
export function loadTheme(): string | null {
  if (!isLocalStorageAvailable()) return null;
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch (error) {
    // Private browsing mode or other storage errors — fail silently
    console.warn("[storage] Failed to read theme from LocalStorage", error);
    return null;
  }
}

/**
 * Clears the saved theme preference from LocalStorage. Called on logout
 * (`frontend/app/lib/auth.ts`) so the next signed-out visitor sees the system
 * default rather than the previous user's choice.
 * Returns true if successful, false otherwise.
 */
export function clearTheme(): boolean {
  if (!isLocalStorageAvailable()) return false;
  try {
    window.localStorage.removeItem(THEME_KEY);
    return true;
  } catch (error) {
    console.warn("[storage] Failed to clear theme from LocalStorage", error);
    return false;
  }
}
