import { expect, test } from "@playwright/test";

/**
 * SEO & robots.txt verification (Issue #369).
 *
 * Verifies that the /robots.txt response matches the expected configuration,
 * explicitly disallowing sensitive/private routes while allowing public pages.
 */
test.describe("robots.txt", () => {
  test("serves robots.txt with correct allow and disallow directives", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.ok()).toBe(true);

    const body = await response.text();

    // Verify User-Agent
    expect(body).toContain("User-Agent: *");

    // Verify allowed routes
    expect(body).toMatch(/Allow:\s+\//);
    expect(body).toMatch(/Allow:\s+\/trades/);
    expect(body).toMatch(/Allow:\s+\/sell/);

    // Verify disallowed routes
    expect(body).toMatch(/Disallow:\s+\/admin/);
    expect(body).toMatch(/Disallow:\s+\/api/);
    expect(body).toMatch(/Disallow:\s+\/wallet/);
    expect(body).toMatch(/Disallow:\s+\/kyc/);
    expect(body).toMatch(/Disallow:\s+\/profile/);

    // Verify sitemap reference
    expect(body).toMatch(/Sitemap:\s+https?:\/\/.+\/sitemap\.xml/);
  });
});
