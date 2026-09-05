import { expect, test } from "@playwright/test";

import { mockCreateListing, mockProfile, signIn } from "./support/mocks";

/**
 * Sell journey (Issue #30): fill the listing form and see the trade id back.
 */
test.describe("Create listing", ()=> {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await mockProfile(page);
    await mockCreateListing(page);
  });

  test("submits a listing and confirms with a trade id", async ({ page }) => {
    await page.goto("/sell");

    await page.locator("#assetType").selectOption({ index: 1 }).catch(async () => {
      await page.locator("#assetType").fill("MTN");
    });
    await page.locator("#tradeType").selectOption("escrow");
    await page.locator("#amount").fill("5000");

    const expiry = page.locator("#expiresInHours");
    if (await expiry.count()) await expiry.fill("24");

    await page.locator('button[type="submit"]').click();

    await expect(page.getByText(/trade_e2e_001|listing created|success/i).first()).toBeVisible({
      timeout: 10,000,
    });
  });

  test("will not submit an empty amount", async ({ page }) => {
    let posted = false;
    await page.route("**/api/v1/trades", (route) => {
      if (route.request().method() === "POST") posted = true;
      return route.fallback();
    });

    await page.goto("/sell");
    await page.locator('button[type="submit"]').click();

    expect(posted).toBe(false);
  });
}
