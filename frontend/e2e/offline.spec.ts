import { expect, test } from "@playwright/test";

/**
 * Offline page auto-reconnect (issue #278).
 *
 * Verifies that the offline fallback page detects the `online` event and
 * automatically redirects to `/` — the user must never have to reload
 * manually after their network is restored.
 *
 * Network interception strategy
 * ─────────────────────────────
 * In dev / test mode, Next-PWA is disabled so there is no service worker cache
 * to deliver offline assets. We navigate to `/offline` while online, stubbing
 * `navigator.onLine` to false on mount to simulate arriving in an offline state.
 * Once the React component finishes hydration (`data-hydrated="true"`), we restore
 * connectivity and dispatch the `online` event to assert the automatic redirect.
 */

test.describe("Offline page", () => {
  test.beforeEach(async ({ page }) => {
    // Stub navigator.onLine during initial load so the mount check in OfflinePage
    // does not immediately redirect before the test begins.
    await page.addInitScript(() => {
      let isOnline = false;
      Object.defineProperty(window.navigator, "onLine", {
        get: () => isOnline,
        configurable: true,
      });
      window.addEventListener("online", () => {
        isOnline = true;
      });
      window.addEventListener("offline", () => {
        isOnline = false;
      });
    });
  });

  test("redirects to / automatically when network is restored", async ({
    page,
  }) => {
    await page.goto("/offline");
    await page.locator('[data-hydrated="true"]').waitFor();

    // 1. The offline state indicator should be visible.
    await expect(
      page.getByRole("heading", { name: /you're offline/i })
    ).toBeVisible();

    // 2. Restore network connectivity — this fires `window.online`.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
    });

    // 3. The page should first show the "Reconnecting…" state …
    await expect(
      page.getByRole("heading", { name: /reconnecting/i })
    ).toBeVisible({ timeout: 5_000 });

    // 4. … then redirect to `/` automatically (no manual reload required).
    await page.waitForURL("/", { timeout: 10_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  test("shows Reconnecting spinner with accessible label", async ({
    page,
  }) => {
    await page.goto("/offline");
    await page.locator('[data-hydrated="true"]').waitFor();

    // Confirm the spinner is NOT present while still offline.
    await expect(page.getByRole("status")).not.toBeVisible();

    // Restore network — spinner should appear.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
    });

    const spinner = page.getByRole("status");
    await expect(spinner).toBeVisible({ timeout: 5_000 });
    await expect(spinner).toHaveAttribute("aria-label", "Reconnecting…");
  });

  test("Retry button is present while offline and targets the previous route", async ({
    page,
  }) => {
    // Visit a real route first so document.referrer is populated, then land
    // on /offline the way the service worker's navigation fallback would.
    // `page.goto` does not set a Referer header by default, so it is passed
    // explicitly to simulate the browser-driven navigation that would
    // normally populate `document.referrer`.
    await page.goto("/sell");
    const previousUrl = page.url();
    await page.goto("/offline", { referer: previousUrl });
    await page.locator('[data-hydrated="true"]').waitFor();

    // The manual Retry button should always be available as a fallback
    // (issue #610) — a button, not a link, since clicking it re-attempts the
    // previous route rather than just navigating somewhere fixed.
    const retry = page.getByRole("button", { name: /retry/i });
    await expect(retry).toBeVisible();

    await retry.click();
    await page.waitForURL("/sell", { timeout: 10_000 });
    expect(page.url()).toMatch(/\/sell$/);
  });

  test("Retry button falls back to / when there is no same-origin referrer", async ({
    page,
  }) => {
    await page.goto("/offline");
    await page.locator('[data-hydrated="true"]').waitFor();

    const retry = page.getByRole("button", { name: /retry/i });
    await retry.click();
    await page.waitForURL("/", { timeout: 10_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  // Issue #610 — the offline page must show a locale-aware message, not a
  // hardcoded English string, since it is reachable without a network round
  // trip in any locale the user had selected.
  test("shows a localized message when reached in a non-English locale", async ({
    page,
  }) => {
    await page.goto("/yo/offline");
    await page.locator('[data-hydrated="true"]').waitFor();

    await expect(
      page.getByRole("heading", { name: "O kò sí lórí ayélujára" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tún gbìyànjú" })
    ).toBeVisible();
  });
});
