import { expect, test } from "@playwright/test";

/**
 * LanguageSwitcher integration into Navbar (Issue #607).
 *
 * The switcher itself (components/LanguageSwitcher.tsx) already existed, but
 * was not reachable from the Navbar on every screen size. These specs cover
 * the actual user-facing behaviour: switching locale from both the desktop
 * inline switcher and the mobile hamburger drawer, without a full page
 * reload, landing on the equivalent URL for the new locale.
 */

test.describe("Locale switcher", () => {
  test("switches locale from the desktop Navbar without a full page reload", async ({
    page,
  }) => {
    await page.goto("/");

    // A marker set on `window` only survives if the navigation that follows
    // is a client-side transition, not a full document reload.
    await page.evaluate(() => {
      (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker = true;
    });

    // Active locale (en) is shown on the toggle button.
    await expect(
      page.getByRole("button", { name: "English" })
    ).toBeVisible();

    await page.getByRole("button", { name: "English" }).click();
    const englishOption = page.getByRole("option", { name: "English" });
    // The active locale is visually indicated via aria-selected.
    await expect(englishOption).toHaveAttribute("aria-selected", "true");

    const yorubaOption = page.getByRole("option", { name: "Yorùbá" });
    await expect(yorubaOption).toBeVisible();
    await expect(yorubaOption).toHaveAttribute("aria-selected", "false");
    await yorubaOption.click();

    await page.waitForURL("**/yo");

    // The marker must still be set — a full reload would have cleared it.
    const markerSurvived = await page.evaluate(
      () => (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker === true
    );
    expect(markerSurvived).toBe(true);

    // The page re-rendered with Yoruba content.
    await expect(page.getByRole("link", { name: "Ọjà" })).toBeVisible();

    // The switcher now shows Yoruba as the active locale.
    await expect(page.getByRole("button", { name: "Yorùbá" })).toBeVisible();
  });

  test("is reachable from the mobile hamburger drawer and switches locale", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // On mobile the inline desktop switcher is hidden; open the drawer instead.
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation menu" });
    await expect(drawer).toBeVisible();

    const switcherToggle = drawer.getByRole("button", { name: "English" });
    await expect(switcherToggle).toBeVisible();
    await switcherToggle.click();

    await drawer.getByRole("option", { name: "Hausa" }).click();
    await page.waitForURL("**/ha");

    await expect(page.getByRole("link", { name: "Kasuwa" })).toBeVisible();
  });
});
