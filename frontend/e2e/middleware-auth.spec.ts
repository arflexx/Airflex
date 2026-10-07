import { expect, test } from "@playwright/test";

/**
 * Edge auth guard (Issue #340).
 *
 * The point of moving the guard into `middleware.ts` is that an unauthenticated
 * request to a protected route never gets the protected page's HTML — the
 * redirect happens before rendering. These tests assert exactly that, by
 * reading the raw response chain rather than the post-navigation DOM: a
 * client-side `useEffect` guard would also end up on /auth/signup, but only
 * after shipping the page first.
 */

const PROTECTED_PATHS = [
  "/wallet",
  "/sell",
  "/profile",
  "/kyc",
  "/trades/trade-123",
  "/admin",
];

test.describe("Middleware auth redirect", () => {
  for (const path of PROTECTED_PATHS) {
    test(`redirects ${path} to signup before any page HTML is sent`, async ({
      page,
    }) => {
      const response = await page.goto(path);
      expect(response, `no response for ${path}`).not.toBeNull();

      // Walk back up the redirect chain to the request we actually made.
      const chain: string[] = [];
      let request = response!.request();
      while (request.redirectedFrom()) {
        request = request.redirectedFrom()!;
        chain.push(request.url());
      }

      expect(
        chain.some((url) => new URL(url).pathname.endsWith(path)),
        `${path} was never redirected — it was served directly`
      ).toBe(true);

      const redirected = await request.response();
      expect(redirected?.status(), "the guard must answer with a redirect").toBe(307);

      const finalUrl = new URL(page.url());
      expect(finalUrl.pathname).toContain("/auth/signup");
      expect(finalUrl.searchParams.get("returnTo")).toBe(path);
    });
  }

  test("public routes are served without a redirect", async ({ page }) => {
    for (const path of ["/", "/auth/signup"]) {
      const response = await page.goto(path);
      expect(response?.request().redirectedFrom(), `${path} must not redirect`).toBeNull();
      expect(response?.status()).toBe(200);
    }
  });

  test("a valid session cookie is let through", async ({ page, context }) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(
      JSON.stringify({ sub: "user-1", role: "user", exp })
    ).toString("base64url");
    const token = `header.${payload}.signature`;

    await context.addCookies([
      {
        name: "session",
        value: token,
        url: "http://localhost:3000",
      },
    ]);

    const response = await page.goto("/wallet");
    expect(response?.request().redirectedFrom()).toBeNull();
  });
});
