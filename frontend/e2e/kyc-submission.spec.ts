import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

import { API_URL, signIn } from "./support/mocks";

const fixtures = path.join(__dirname, "fixtures");

async function completeKycForm(page: Page, documentName: string) {
  await page.goto("/kyc");

  await page.getByLabel("Full legal name").fill("Ada Okonkwo");
  await page.getByLabel("Date of birth").fill("1990-01-01");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel(/National Identification Number/).fill("12345678901");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel(/Selfie or identity document photo/).setInputFiles(
    path.join(fixtures, documentName),
  );
  await expect(page.getByAltText("Selected document preview")).toBeVisible();
}

test.describe("KYC submission", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("submits identity documents for review and blocks listing creation while pending", async ({
    page,
  }) => {
    await page.route(`${API_URL}/api/kyc/submit`, (route) =>
      route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ status: "pending" }),
      }),
    );

    await completeKycForm(page, "valid-identity.png");
    await page.getByRole("button", { name: "Submit for review" }).click();

    await expect(page.getByRole("heading", { name: "KYC Pending Review" })).toBeVisible();
    await expect(page.getByText(/documents have been submitted/i)).toBeVisible();

    await page.route(`${API_URL}/api/v1/profile`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { kycStatus: "pending" } }),
      }),
    );
    await page.goto("/sell");

    await expect(page.getByRole("alert")).toContainText(/listing creation is disabled/i);
    await expect(page.locator("#assetType")).toBeDisabled();
    await expect(page.locator("#amount")).toBeDisabled();
    await expect(page.getByRole("button", { name: /create listing|submit/i })).toBeDisabled();
  });

  test("shows provider rejection details and guidance to resubmit", async ({ page }) => {
    const rejectionGuidance =
      "Document could not be verified. Please upload a clearer image and resubmit.";

    await page.route(`${API_URL}/api/kyc/submit`, (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: rejectionGuidance }),
      }),
    );

    await completeKycForm(page, "rejected-identity.png");
    await page.getByRole("button", { name: "Submit for review" }).click();

    await expect(page.getByRole("alert")).toHaveText(rejectionGuidance);
    await expect(page.getByRole("button", { name: "Submit for review" })).toBeEnabled();
  });
});
