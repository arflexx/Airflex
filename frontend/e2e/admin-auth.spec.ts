import { expect, test } from "@playwright/test";

import { signIn } from "./support/mocks";

/**
 * Access control for /admin (Issue #284).
 *
 * A non-admin session must never end up on the admin dashboard. Two layers
 * enforce that: the edge middleware rejects a non-admin JWT before the page is
 * rendered, and the client-side `<AuthGuard role="admin">` redirects to `/`
 * after hydration. This spec asserts the user-visible outcome — a redirect to
 * `/` and no admin UI — while the AuthGuard itself is covered by the Jest unit
 * tests.
 */
test.describe("Admin access control (Issue #284)", () => {
  test("a non-admin session is redirected away from /admin to /", async ({
    page,
  }) => {
    await signIn(page, { role: "user" });

    await page.goto("/admin");

    await expect(page).toHaveURL(
      (url) => new URL(url).pathname === "/",
      { timeout: 10_000 },
    );
    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" }),
    ).toHaveCount(0);
  });

  test("an admin session reaches the dashboard", async ({ page }) => {
    await page.route("**/api/v1/admin/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          totalUsers: 0,
          openTrades: 0,
          lockedTrades: 0,
          completedTrades: 0,
          disputedTrades: 0,
          totalVolume: 0,
          trades: [],
          flaggedAccounts: [],
        }),
      }),
    );

    await signIn(page, { role: "admin" });
    // AuthContext hydrates token + user together, so the stored user must be
    // present for the token (and its role) to be picked up.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "airflex:user",
        JSON.stringify({
          id: "user_e2e",
          phone: "+2348000000000",
          stellarPublicKey:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          role: "admin",
        }),
      );
    });

    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
