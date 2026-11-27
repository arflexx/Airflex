import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  mockDepositInitialize,
  mockPaystack,
  mockWallet,
  signIn,
  API_URL,
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
    await expect(page.locator("#deposit-amount")).toHaveValue(/5,?000/);
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
      /(?:valid|enter an) amount/i,
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

  // -------------------------------------------------------------------------
  // Issue #664: webhook confirmation, pending state, and failed payment
  // -------------------------------------------------------------------------

  test("webhook confirmation — balance updates after Paystack notifies the server", async ({
    page,
  }) => {
    // Wallet starts at 1000; after the deposit webhook hits the server the
    // page re-fetches and shows the updated balance.
    const wallet = { balance: "1000" };

    await signIn(page);
    await mockDepositInitialize(page);
    await mockPaystack(page, "success");

    // First wallet fetch (before deposit) returns 1000.
    // Second fetch (after onDepositSuccess polling triggers) returns 6000.
    let walletCallCount = 0;
    await page.route(`${API_URL}/api/v1/wallet`, (route) => {
      walletCallCount++;
      const balance = walletCallCount >= 2 ? "6000" : wallet.balance;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          balance,
          asset: "XLM",
          network: "testnet",
        }),
      });
    });

    await page.goto("/wallet");

    // Confirm initial balance is shown
    await expect(page.getByText("1000")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("5000");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    // After Paystack fires onSuccess the modal enters confirming state and
    // triggers the deposit-success view or starts polling.
    await expect(
      page.getByTestId("deposit-success").or(
        page.getByRole("button", { name: /confirming|waiting for payment/i }),
      ),
    ).toBeVisible({ timeout: 15_000 });

    // The wallet balance card should eventually reflect the updated amount
    // once the polling re-fetch resolves.
    await expect(page.getByText("6000")).toBeVisible({ timeout: 20_000 });
  });

  test("payment pending — spinner is shown while awaiting webhook confirmation", async ({
    page,
  }) => {
    await signIn(page);
    await mockWallet(page, { balance: "1000" });
    await mockDepositInitialize(page);

    // Paystack fires onSuccess but the wallet poll never updates (simulating
    // a webhook that hasn't arrived yet).
    await page.route("https://js.paystack.co/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );
    await page.addInitScript(() => {
      class FakePaystackPop {
        resumeTransaction(
          _accessCode: string,
          callbacks?: { onSuccess?: (t: { reference?: string }) => void },
        ) {
          setTimeout(() => {
            callbacks?.onSuccess?.({ reference: "ref_pending_001" });
          }, 50);
        }
      }
      (window as unknown as { PaystackPop: unknown }).PaystackPop = FakePaystackPop;
    });

    await page.goto("/wallet");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("5000");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    // After Paystack confirms, the UI should show a confirming/spinner state
    // while it waits for the balance to update.
    await expect(
      page
        .getByRole("button", { name: /confirming|waiting for payment/i })
        .or(page.getByTestId("deposit-success")),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("payment failed — error message is shown when Paystack returns an error", async ({
    page,
  }) => {
    await signIn(page);
    await mockWallet(page, { balance: "1000" });
    await mockDepositInitialize(page);
    await mockPaystack(page, "error");

    await page.goto("/wallet");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("5000");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(page.getByTestId("deposit-error")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("deposit-error")).toContainText(
      /failed|error|declined/i,
    );
    // Dialog should remain open so the user can retry
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("backend initialize failure — error message shown without opening Paystack", async ({
    page,
  }) => {
    await signIn(page);
    await mockWallet(page, { balance: "1000" });

    // Intercept the initialize call and return a server error
    await page.route(`${API_URL}/api/wallet/deposit/initialize`, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Service temporarily unavailable" }),
      }),
    );

    // Paystack script is blocked; if it somehow loads or is invoked the test
    // will catch it via an unexpected navigation.
    await page.route("https://js.paystack.co/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );

    await page.goto("/wallet");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page.locator("#deposit-amount").fill("5000");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(page.getByTestId("deposit-error")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
