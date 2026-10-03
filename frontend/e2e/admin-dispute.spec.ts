import { expect, test, type Page } from "@playwright/test";

import { API_URL, signIn } from "./support/mocks";

/**
 * Admin dispute resolution journey (Issue #23).
 *
 * The admin page is a client-side component ("use client") so all API calls
 * are intercepted via `page.route` — no real server or blockchain needed.
 *
 * Covered paths:
 *   • Non-admin sees the 403 gate instead of the dashboard.
 *   • Admin sees the disputed trades table populated from the API.
 *   • RELEASE path: admin selects "release_to_seller", confirms, POST is sent
 *     with the correct body, modal closes, dashboard reloads (row disappears).
 *   • REFUND path: admin switches to "refund_to_buyer", confirms, POST is sent
 *     with the correct body, modal closes, dashboard reloads.
 *   • Cancel: modal closes without POSTing.
 *   • 409 idempotency: already-resolved trade shows the inline error.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const DISPUTED_TRADE = {
  id: "trade_dispute_001",
  status: "Disputed",
  amount: "5000",
  created_at: new Date("2026-09-01T10:00:00Z").toISOString(),
  buyer_phone: "+2348011111111",
  seller_phone: "+2348022222222",
};

const DISPUTED_TRADE_2 = {
  id: "trade_dispute_002",
  status: "Disputed",
  amount: "2500",
  created_at: new Date("2026-09-02T12:00:00Z").toISOString(),
  buyer_phone: "+2348033333333",
  seller_phone: "+2348044444444",
};

const METRICS = {
  totalUsers: 42,
  openTrades: 5,
  lockedTrades: 3,
  completedTrades: 100,
  disputedTrades: 2,
  totalVolume: 500000,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mount all three admin dashboard endpoints. `disputedTrades` is a ref so
 * individual tests can swap it out after the initial mount to simulate the
 * dashboard reload that follows a successful resolution.
 */
async function mockAdminDashboard(
  page: Page,
  options: { disputedTrades?: typeof DISPUTED_TRADE[] } = {},
) {
  const disputed = options.disputedTrades ?? [DISPUTED_TRADE];

  // The component calls these three in parallel on load and after each
  // successful resolution.
  await page.route(`${API_URL}/api/v1/admin/metrics`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(METRICS),
    }),
  );

  await page.route(`${API_URL}/api/v1/admin/trades**`, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("status") === "disputed") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ trades: disputed }),
      });
    }
    return route.fallback();
  });

  await page.route(`${API_URL}/api/v1/admin/flagged-accounts`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flaggedAccounts: [] }),
    }),
  );
}

/**
 * Stub the resolve endpoint for a given trade.
 *
 * Returns the list of resolution values that were POSTed, so tests can assert
 * on the exact body without intercepting at a higher level.
 */
async function mockResolve(
  page: Page,
  tradeId: string,
  outcome: { status: number; body?: object } = { status: 200, body: {} },
): Promise<string[]> {
  const posted: string[] = [];

  await page.route(`${API_URL}/api/v1/admin/trades/${tradeId}/resolve`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();

    const body = JSON.parse(route.request().postData() ?? "{}") as { resolution?: string };
    if (body.resolution) posted.push(body.resolution);

    return route.fulfill({
      status: outcome.status,
      contentType: "application/json",
      body: JSON.stringify(outcome.body ?? {}),
    });
  });

  return posted;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("Admin dispute resolution", () => {
  // ── Role gate ──────────────────────────────────────────────────────────────
  test.describe("Role gate", () => {
    test("non-admin user sees 403 page, not the dashboard", async ({ page }) => {
      // Sign in without a role override — default role is "user".
      await signIn(page);
      await page.goto("/admin");

      await expect(page.getByRole("heading", { name: /403/i })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(/restricted to administrator/i)).toBeVisible();
    });

    test("unauthenticated visit is redirected away from /admin", async ({ page }) => {
      // No signIn — the middleware should redirect to /auth/signup.
      await page.goto("/admin");

      await expect(page).not.toHaveURL(/\/admin$/, { timeout: 10_000 });
    });
  });

  // ── Dashboard load ─────────────────────────────────────────────────────────
  test.describe("Dashboard load", () => {
    test.beforeEach(async ({ page }) => {
      await signIn(page, { role: "admin" });
      await mockAdminDashboard(page, { disputedTrades: [DISPUTED_TRADE, DISPUTED_TRADE_2] });
    });

    test("renders the admin dashboard heading", async ({ page }) => {
      await page.goto("/admin");

      await expect(
        page.getByRole("heading", { name: /admin dashboard/i }),
      ).toBeVisible({ timeout: 10_000 });
    });

    test("shows platform metrics from the API", async ({ page }) => {
      await page.goto("/admin");

      // Platform volume card — value comes from the metrics fixture.
      await expect(page.getByText("42")).toBeVisible({ timeout: 10_000 });
    });

    test("lists all disputed trades in the table", async ({ page }) => {
      await page.goto("/admin");

      // Section heading includes the count from the fixture (2 trades).
      await expect(page.getByRole("heading", { name: /disputed trades \(2\)/i })).toBeVisible({
        timeout: 10_000,
      });

      // Both buyer phones appear in the table.
      await expect(page.getByText(DISPUTED_TRADE.buyer_phone!)).toBeVisible();
      await expect(page.getByText(DISPUTED_TRADE_2.buyer_phone!)).toBeVisible();
    });

    test("shows the Resolve button for each disputed trade", async ({ page }) => {
      await page.goto("/admin");

      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      const resolveButtons = page.getByRole("button", { name: /resolve/i });
      await expect(resolveButtons).toHaveCount(2);
    });
  });

  // ── RELEASE path ───────────────────────────────────────────────────────────
  test.describe("RELEASE resolution (release_to_seller)", () => {
    test("opens the modal and defaults to release_to_seller", async ({ page }) => {
      await signIn(page, { role: "admin" });
      await mockAdminDashboard(page);
      await mockResolve(page, DISPUTED_TRADE.id);

      await page.goto("/admin");

      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();

      // Default selection is release_to_seller.
      const releaseRadio = modal.locator('input[type="radio"][value="release_to_seller"]');
      await expect(releaseRadio).toBeChecked();
    });

    test("POSTs resolution=release_to_seller and closes the modal on success", async ({
      page,
    }) => {
      await signIn(page, { role: "admin" });

      // After the first load, the dispute list is empty to simulate the
      // dashboard reload that follows a successful resolution.
      let callCount = 0;
      await page.route(`${API_URL}/api/v1/admin/metrics`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(METRICS),
        }),
      );
      await page.route(`${API_URL}/api/v1/admin/trades**`, (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === "GET" &&
          url.searchParams.get("status") === "disputed"
        ) {
          const trades = callCount === 0 ? [DISPUTED_TRADE] : [];
          callCount++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ trades }),
          });
        }
        return route.fallback();
      });
      await page.route(`${API_URL}/api/v1/admin/flagged-accounts`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ flaggedAccounts: [] }),
        }),
      );

      const posted = await mockResolve(page, DISPUTED_TRADE.id, { status: 200, body: {} });

      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();

      // "release_to_seller" is already selected; click Confirm directly.
      await modal.getByRole("button", { name: "Confirm" }).click();

      // Modal must close.
      await expect(modal).not.toBeVisible({ timeout: 10_000 });

      // Dashboard reloads: row disappears, section shows empty state.
      await expect(
        page.getByText(/no trades are currently disputed/i),
      ).toBeVisible({ timeout: 10_000 });

      // Exactly one POST was sent with the correct body.
      expect(posted).toHaveLength(1);
      expect(posted[0]).toBe("release_to_seller");
    });

    test("trade row disappears from the table after RELEASE", async ({ page }) => {
      await signIn(page, { role: "admin" });

      let callCount = 0;
      await page.route(`${API_URL}/api/v1/admin/metrics`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(METRICS),
        }),
      );
      await page.route(`${API_URL}/api/v1/admin/trades**`, (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === "GET" &&
          url.searchParams.get("status") === "disputed"
        ) {
          const trades = callCount === 0 ? [DISPUTED_TRADE] : [];
          callCount++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ trades }),
          });
        }
        return route.fallback();
      });
      await page.route(`${API_URL}/api/v1/admin/flagged-accounts`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ flaggedAccounts: [] }),
        }),
      );
      await mockResolve(page, DISPUTED_TRADE.id, { status: 200 });

      await page.goto("/admin");
      await expect(page.getByText(DISPUTED_TRADE.buyer_phone!)).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();

      // The buyer phone must be gone after the reload.
      await expect(page.getByText(DISPUTED_TRADE.buyer_phone!)).not.toBeVisible({
        timeout: 10_000,
      });
    });
  });

  // ── REFUND path ────────────────────────────────────────────────────────────
  test.describe("REFUND resolution (refund_to_buyer)", () => {
    test("POSTs resolution=refund_to_buyer when the refund radio is selected", async ({
      page,
    }) => {
      await signIn(page, { role: "admin" });

      let callCount = 0;
      await page.route(`${API_URL}/api/v1/admin/metrics`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(METRICS),
        }),
      );
      await page.route(`${API_URL}/api/v1/admin/trades**`, (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === "GET" &&
          url.searchParams.get("status") === "disputed"
        ) {
          const trades = callCount === 0 ? [DISPUTED_TRADE] : [];
          callCount++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ trades }),
          });
        }
        return route.fallback();
      });
      await page.route(`${API_URL}/api/v1/admin/flagged-accounts`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ flaggedAccounts: [] }),
        }),
      );

      const posted = await mockResolve(page, DISPUTED_TRADE.id, { status: 200 });

      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();

      // Switch to refund_to_buyer.
      const refundRadio = modal.locator('input[type="radio"][value="refund_to_buyer"]');
      await refundRadio.check();
      await expect(refundRadio).toBeChecked();

      // Confirm.
      await modal.getByRole("button", { name: "Confirm" }).click();

      // Modal must close.
      await expect(modal).not.toBeVisible({ timeout: 10_000 });

      // One POST with refund_to_buyer.
      expect(posted).toHaveLength(1);
      expect(posted[0]).toBe("refund_to_buyer");
    });

    test("trade row disappears from the table after REFUND", async ({ page }) => {
      await signIn(page, { role: "admin" });

      let callCount = 0;
      await page.route(`${API_URL}/api/v1/admin/metrics`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(METRICS),
        }),
      );
      await page.route(`${API_URL}/api/v1/admin/trades**`, (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === "GET" &&
          url.searchParams.get("status") === "disputed"
        ) {
          const trades = callCount === 0 ? [DISPUTED_TRADE] : [];
          callCount++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ trades }),
          });
        }
        return route.fallback();
      });
      await page.route(`${API_URL}/api/v1/admin/flagged-accounts`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ flaggedAccounts: [] }),
        }),
      );
      await mockResolve(page, DISPUTED_TRADE.id, { status: 200 });

      await page.goto("/admin");
      await expect(page.getByText(DISPUTED_TRADE.buyer_phone!)).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await modal.locator('input[type="radio"][value="refund_to_buyer"]').check();
      await modal.getByRole("button", { name: "Confirm" }).click();

      await expect(page.getByText(DISPUTED_TRADE.buyer_phone!)).not.toBeVisible({
        timeout: 10_000,
      });
    });
  });

  // ── Cancel ─────────────────────────────────────────────────────────────────
  test.describe("Cancel", () => {
    test("Cancel button closes the modal without POSTing", async ({ page }) => {
      await signIn(page, { role: "admin" });
      await mockAdminDashboard(page);

      let resolved = false;
      await page.route(`${API_URL}/api/v1/admin/trades/${DISPUTED_TRADE.id}/resolve`, () => {
        resolved = true;
      });

      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();

      await modal.getByRole("button", { name: "Cancel" }).click();

      await expect(modal).not.toBeVisible({ timeout: 5_000 });
      expect(resolved, "Cancel must not trigger a resolve POST").toBe(false);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────
  test.describe("Error handling", () => {
    test("shows inline error on 409 (already resolved by another admin)", async ({ page }) => {
      await signIn(page, { role: "admin" });
      await mockAdminDashboard(page);
      await mockResolve(page, DISPUTED_TRADE.id, {
        status: 409,
        body: { error: "Trade already resolved" },
      });

      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();

      await modal.getByRole("button", { name: "Confirm" }).click();

      // The modal stays open and shows the conflict message.
      await expect(modal).toBeVisible({ timeout: 10_000 });
      await expect(modal.getByText(/no longer disputed|someone else resolved/i)).toBeVisible();
    });

    test("shows an error message when the API returns a generic failure", async ({ page }) => {
      await signIn(page, { role: "admin" });
      await mockAdminDashboard(page);
      await mockResolve(page, DISPUTED_TRADE.id, {
        status: 500,
        body: { error: "Internal server error" },
      });

      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: /disputed trades/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /resolve/i }).first().click();

      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();
      await modal.getByRole("button", { name: "Confirm" }).click();

      // Modal stays open; an inline error is shown.
      await expect(modal).toBeVisible({ timeout: 10_000 });
      await expect(modal.getByText(/failed to resolve|internal server error/i)).toBeVisible();
    });

    test("shows empty-state message when no trades are disputed", async ({ page }) => {
      await signIn(page, { role: "admin" });
      await mockAdminDashboard(page, { disputedTrades: [] });

      await page.goto("/admin");

      await expect(
        page.getByText(/no trades are currently disputed/i),
      ).toBeVisible({ timeout: 10_000 });
    });
  });
});
