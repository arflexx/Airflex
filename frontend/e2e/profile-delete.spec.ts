import { expect, test } from "@playwright/test";
import { API_URL, signIn } from "./support/mocks";

test.describe("Account deletion confirmation (Issue #343)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);

    await page.route(`${API_URL}/api/v1/profile`, (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ message: "Account deletion scheduled." }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "user_e2e",
            maskedPhone: "+234 *** *** 7890",
            createdAt: new Date().toISOString(),
            totalTradesCompleted: 5,
            stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            kycStatus: "verified",
          },
        }),
      });
    });

    await page.route(`${API_URL}/api/v1/profile/trades*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          pagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
        }),
      }),
    );
  });

  test("verifies delete button cannot be clicked without the confirmation phrase", async ({ page }) => {
    await page.goto("/profile");

    // Click "Delete account" to open modal
    const deleteBtn = page.getByRole("button", { name: "Delete account" });
    await expect(deleteBtn).toBeVisible({ timeout: 10_000 });
    await deleteBtn.click();

    // Modal appears
    await expect(page.getByRole("heading", { name: /confirm account deletion/i })).toBeVisible();

    const input = page.getByLabel(/confirmation phrase/i);
    await expect(input).toBeVisible();

    // Confirm deletion button should be disabled initially without phrase
    const confirmBtn = page.getByRole("button", { name: /confirm deletion/i });
    await expect(confirmBtn).toBeDisabled();

    // Type incorrect phrase
    await input.fill("DELETE ACCOUNT");
    await expect(confirmBtn).toBeDisabled();

    // Type another incorrect phrase
    await input.fill("delete");
    await expect(confirmBtn).toBeDisabled();

    // Type exact phrase (case-insensitive)
    await input.fill("delete my account");

    // After phrase is typed and 5s countdown finishes, confirm button becomes enabled
    await expect(confirmBtn).toBeEnabled({ timeout: 7000 });
  });
});
