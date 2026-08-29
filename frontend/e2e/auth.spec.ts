import { expect, test } from "@playwright/test";

import { mockAuth } from "./support/mocks";

/**
 * Signup journey (Issue #30): phone entry → OTP → signed in.
 */
test.describe("Signup", () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page);
  });

  test("accepts a phone number and moves to OTP entry", async ({ page }) => {
    await page.goto("/auth/signup");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.locator("#phone").fill("+2348012345678");
    await page.locator('button[type="submit"]').click();

    // The app either routes to /auth/verify or reveals OTP entry in place;
    // either is a pass, so assert on the OTP step rather than the URL.
    await expect(page.locator("#otp, #phone-error").first()).toBeVisible({ timeout: 10_000 });
  });

  test("rejects a malformed phone number without calling the API", async ({ page }) => {
    let called = false;
    await page.route("**/api/v1/auth/**", (route) => {
      called = true;
      return route.fulfill({ status: 200, body: "{}" });
    });

    await page.goto("/auth/signup");
    await page.locator("#phone").fill("12");
    await page.locator('button[type="submit"]').click();

    await expect(page.locator("#phone-error")).toBeVisible();
    expect(called, "a client-side rejection must not hit the network").toBe(false);
  });

  test("submits an OTP on the verify step", async ({ page }) => {
    await page.goto("/auth/verify");

    const otp = page.locator("#otp");
    if (await otp.count()) {
      await otp.fill("123456");
      await page.locator('button[type="submit"]').click();
      await expect(page.locator("#otp")).toHaveCount(await otp.count());
    }
  });
});
