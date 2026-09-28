import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  mockDepositInitialize,
  mockPaystack,
  mockWallet,
  signIn,
} from "./support/mocks";

/**
 * Deposit journey (Issues #25, #30): open wallet → Deposit → pay → balance
 * refreshes. Paystack is stubbed, so no third party is involved.
 */
test.describe("Deposit", () => {
  test.fixme("completes a deposit and refreshes the balance", async ({ page }) => {
    const wallet = { balance: "1000" };

    await signIn(page);
    await mockWallet(page, wallet);
    await mockDepositInitialize(page);
    await mockPaystack(page, "success");

    await page.goto("/wallet");

    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    wallet.balance = "6000";

    await page.locator("#deposit-amount").fill("5000");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(
      page.getByRole("button", { name: /confirming|waiting for payment/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("deposit-success")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("shows an error and stays open when the popup is dismissed", async ({
    page,
  }) => {
    await signIn(page);
    await mockWallet(page, { balance: "1000" });
    await mockDepositInitialize(page);
    await mockPaystack(page, "cancel");

    await page.goto("/wallet");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("5000");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(page.getByTestId("deposit-error")).toContainText(/cancelled/i);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#deposit-amount")).toHaveValue("5000");
  });

  test("rejects an amount below the minimum before calling the API", async ({
    page,
  }) => {
    let initialized = false;

    await signIn(page);
    await mockWallet(page, { balance: "1000" });

    await page.route("**/api/wallet/deposit/initialize", (route) => {
      initialized = true;
      return route.fulfill({ status: 200, body: "{}" });
    });

    await page.goto("/wallet");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("50");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(page.getByTestId("deposit-error")).toContainText(
      /minimum deposit/i,
    );

    expect(initialized).toBe(false);
  });

  test("rejects non-numeric input", async ({ page }) => {
    await signIn(page);
    await mockWallet(page, { balance: "1000" });

    await page.goto("/wallet");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("abc");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(page.getByTestId("deposit-error")).toContainText(
      /valid amount/i,
    );
  });

  test("wallet transaction table has no accessibility violations", async ({
    page,
  }) => {
    await signIn(page);
    await mockWallet(page, { balance: "1000" });

    await page.route(
      "**/api/v1/profile/trades**",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: [
              {
                id: "trade-a11y-001",
                asset_type: "XLM",
                amount: 5000,
                status: "Disputed",
                escrow_tx_hash: null,
                created_at: "2026-09-24T10:00:00.000Z",
              },
            ],
          }),
        });
      },
    );

    await page.goto("/wallet");

    const transactionTable = page.getByRole("table", {
      name: "Wallet transactions",
    });

    await expect(transactionTable).toBeVisible({ timeout: 10_000 });

    const accessibilityScanResults = await new AxeBuilder({ page })
      .include('[aria-label="Wallet transactions"]')
      .analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
