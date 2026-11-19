import { expect, test, type Route } from "@playwright/test";

import { API_URL, signIn } from "./support/mocks";

/**
 * ListingsGrid pagination (Issue #606).
 *
 * Stubs a paginated `/api/v1/trades` endpoint with 45 listings split across
 * pages of 20 (the component's default `pageSize`), and drives the
 * "Load next page" control — the same action the scroll-to-bottom
 * IntersectionObserver triggers — to walk through all three pages.
 */

const PAGE_SIZE = 20;
const TOTAL_TRADES = 45;

function buildTrade(index: number) {
  return {
    id: `trade_page_${index}`,
    seller_id: `seller_${index}`,
    seller_handle: `@seller_${index}`,
    buyer_id: null,
    asset_type: index % 2 === 0 ? "MTN_AIRTIME" : "GLO_DATA",
    amount: 1000 + index * 10,
    fee_amount: 15,
    seller_net_amount: 985 + index * 10,
    status: "Active",
    contract_listing_id: `listing_${index}`,
    escrow_tx_hash: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const ALL_TRADES = Array.from({ length: TOTAL_TRADES }, (_, i) => buildTrade(i));

async function mockPaginatedTradeList(page: import("@playwright/test").Page) {
  await page.route(`${API_URL}/api/v1/trades**`, (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();

    const url = new URL(route.request().url());
    const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.max(1, Number(url.searchParams.get("limit")) || PAGE_SIZE);

    const start = (requestedPage - 1) * limit;
    const slice = ALL_TRADES.slice(start, start + limit);

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: slice, total: TOTAL_TRADES }),
    });
  });
}

test.describe("Listings pagination", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await mockPaginatedTradeList(page);
  });

  test("loads the first page, then more pages via the next-page control, with no duplicates", async ({
    page,
  }) => {
    await page.goto("/");

    const cards = page.getByRole("link", { name: /view and buy/i });

    // First page: 20 listings, and a "Load next page" control (not the
    // end-of-results message) since more remain.
    await expect(cards).toHaveCount(PAGE_SIZE, { timeout: 15_000 });
    const loadMore = page.getByRole("button", { name: /load next page/i });
    await expect(loadMore).toBeVisible();

    // Second page: appended, not replaced — 40 unique cards, no duplicates.
    await loadMore.click();
    await expect(cards).toHaveCount(PAGE_SIZE * 2, { timeout: 15_000 });

    const hrefs = await cards.evaluateAll((els) =>
      els.map((el) => el.getAttribute("href")),
    );
    expect(new Set(hrefs).size).toBe(hrefs.length);

    // The URL reflects the current page, so Back returns to the right spot.
    await expect(page).toHaveURL(/page=2/);

    // Third (final) page: 45 total, so 5 more listings, then the
    // end-of-results message replaces the "Load next page" control.
    await page.getByRole("button", { name: /load next page/i }).click();
    await expect(cards).toHaveCount(TOTAL_TRADES, { timeout: 15_000 });
    await expect(page.getByText(/reached the end of the listings/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /load next page/i })).toHaveCount(0);
  });

  test("the browser Back button returns the URL to the previous page", async ({ page }) => {
    await page.goto("/");

    const cards = page.getByRole("link", { name: /view and buy/i });
    await expect(cards).toHaveCount(PAGE_SIZE, { timeout: 15_000 });

    await page.getByRole("button", { name: /load next page/i }).click();
    await expect(page).toHaveURL(/page=2/);

    await page.goBack();
    await expect(page).not.toHaveURL(/page=2/);
  });
});
