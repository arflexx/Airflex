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
 * Playwright's `context.setOffline(true/false)` toggles the browser context
 * network state and fires the real `window.online` / `window.offline` events,
 * which is exactly the mechanism the page listens to. This is preferred over
 * `page.route` stubs for this particular test because we are exercising the
 * browser-native event, not mocking an API response.
 *
 * The test goes offline first, navigates to /offline (simulating the service
 * worker delivering the cached fallback), then brings the network back online
 * and asserts the redirect to `/` fires.
 */

test.describe("Offline page", () => {
  test("redirects to / automatically when network is restored", async ({
    page,
    context,
  }) => {
    // 1. Go offline before loading the page so the `online` check on mount
    //    does not immediately redirect (we want to test the event listener path).
    await context.setOffline(true);

    // 2. Navigate to /offline. In production the service worker delivers this
    //    page; in the test environment we hit it directly.
    await page.goto("/offline", { waitUntil: "domcontentloaded" });

    // 3. The offline state indicator should be visible.
    await expect(
      page.getByRole("heading", { name: /you're offline/i })
    ).toBeVisible();

    // 4. Restore network connectivity — this fires `window.online`.
    await context.setOffline(false);

    // 5. The page should first show the "Reconnecting…" state …
    await expect(
      page.getByRole("heading", { name: /reconnecting/i })
    ).toBeVisible({ timeout: 5_000 });

    // 6. … then redirect to `/` automatically (no manual reload required).
    await page.waitForURL("/", { timeout: 10_000 });
    expect(page.url()).toMatch(/\/$/);
  });

  test("shows Reconnecting spinner with accessible label", async ({
    page,
    context,
  }) => {
    await context.setOffline(true);
    await page.goto("/offline", { waitUntil: "domcontentloaded" });

    // Confirm the spinner is NOT present while still offline.
    await expect(page.getByRole("status")).not.toBeVisible();

    // Restore network — spinner should appear.
    await context.setOffline(false);

    const spinner = page.getByRole("status");
    await expect(spinner).toBeVisible({ timeout: 5_000 });
    await expect(spinner).toHaveAttribute("aria-label", "Reconnecting…");
  });

  test("Retry link is present while offline", async ({ page, context }) => {
    await context.setOffline(true);
    await page.goto("/offline", { waitUntil: "domcontentloaded" });

    // The manual Retry link should always be available as a fallback.
    const retry = page.getByRole("link", { name: /retry/i });
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute("href", "/");
  });
});
