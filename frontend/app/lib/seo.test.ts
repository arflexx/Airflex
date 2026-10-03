/**
 * SEO route policy (Issue #28).
 *
 * The rule these protect is simple and easy to break by accident: a private
 * route must never appear in the sitemap, and must be disallowed in robots.txt.
 * Adding a route to one list and forgetting the other is exactly the mistake
 * that leaks a wallet URL into a search index.
 */

import robots from "../robots";
import sitemap from "../sitemap";
import { PRIVATE_ROUTES, PUBLIC_ROUTES, isPrivateRoute, siteUrl } from "./seo";

describe("siteUrl", () => {
  const original = process.env["NEXT_PUBLIC_SITE_URL"];

  afterEach(() => {
    if (original === undefined) delete process.env["NEXT_PUBLIC_SITE_URL"];
    else process.env["NEXT_PUBLIC_SITE_URL"] = original;
  });

  it("uses the configured site URL", () => {
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://airflex.example";
    expect(siteUrl()).toBe("https://airflex.example");
  });

  it("falls back to localhost rather than throwing", () => {
    delete process.env["NEXT_PUBLIC_SITE_URL"];
    // metadataBase requires an absolute URL; a missing env var must not take
    // down the dev server.
    expect(() => new URL(siteUrl())).not.toThrow();
  });
});

describe("isPrivateRoute", () => {
  it("matches a private route exactly", () => {
    expect(isPrivateRoute("/wallet")).toBe(true);
  });

  it("matches nested paths under a private route", () => {
    expect(isPrivateRoute("/admin/users")).toBe(true);
    expect(isPrivateRoute("/auth/signup")).toBe(true);
  });

  it("does not match a public route", () => {
    expect(isPrivateRoute("/")).toBe(false);
    expect(isPrivateRoute("/sell")).toBe(false);
  });

  it("does not match a public route that merely starts with the same letters", () => {
    expect(isPrivateRoute("/walletsomething")).toBe(false);
  });
});

/** A fetch response stub returning the given trades page. */
function tradesResponse(data: unknown[], totalPages = 1) {
  return {
    ok: true,
    json: async () => ({ data, pagination: { page: 1, totalPages } }),
  };
}

function mockFetch(response: unknown) {
  global.fetch = jest.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("sitemap", () => {
  beforeEach(() => {
    // Default: no trades, so the static-route assertions below are isolated.
    mockFetch(tradesResponse([]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("lists every public route", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);

    for (const route of PUBLIC_ROUTES) {
      expect(urls.some((url) => url.endsWith(route.path))).toBe(true);
    }
  });

  it("excludes every private route, /admin included", async () => {
    const urls = (await sitemap()).map((entry) => new URL(entry.url).pathname);

    for (const priv of PRIVATE_ROUTES) {
      expect(urls).not.toContain(priv);
    }
    expect(urls).not.toContain("/admin");
  });

  it("emits absolute URLs, which the sitemap spec requires", async () => {
    for (const entry of await sitemap()) {
      expect(() => new URL(entry.url)).not.toThrow();
      expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it("gives the home page the highest priority", async () => {
    const home = (await sitemap()).find(
      (entry) => new URL(entry.url).pathname === "/",
    );
    expect(home?.priority).toBe(1);
  });
});

describe("sitemap trade listings (Issue #381)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("includes active trade URLs with lastmod from updated_at", async () => {
    mockFetch(
      tradesResponse([
        {
          id: "trade-1",
          status: "Active",
          updated_at: "2026-09-01T10:00:00.000Z",
        },
        {
          id: "trade-2",
          status: "Completed",
          updated_at: "2026-09-02T10:00:00.000Z",
        },
      ]),
    );

    const entries = await sitemap();
    const tradePaths = entries
      .map((entry) => new URL(entry.url).pathname)
      .filter((path) => path.startsWith("/trades/"));

    expect(tradePaths).toContain("/trades/trade-1");
    // Only Active trades are advertised.
    expect(tradePaths).not.toContain("/trades/trade-2");

    const active = entries.find(
      (entry) => new URL(entry.url).pathname === "/trades/trade-1",
    );
    expect(new Date(active!.lastModified as Date).toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
  });

  it("degrades to static routes when the listing API fails", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("boom")) as unknown as typeof fetch;

    const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);

    expect(paths.some((path) => path.startsWith("/trades/"))).toBe(false);
    expect(paths).toContain("/");
  });
});

describe("robots", () => {
  it("allows crawling the public site", () => {
    const rules = robots().rules as { allow?: string | string[] };
    expect(rules.allow).toEqual(expect.arrayContaining(["/", "/trades", "/sell"]));
  });

  it("disallows every private route", () => {
    const rules = robots().rules as { disallow?: string[] };

    for (const priv of PRIVATE_ROUTES) {
      expect(rules.disallow).toEqual(
        expect.arrayContaining([priv, `${priv}/`]),
      );
    }
  });

  it("keeps /admin, /api/*, /wallet, /kyc, and /profile out", () => {
    const rules = robots().rules as { disallow?: string[] };
    expect(rules.disallow).toEqual(
      expect.arrayContaining([
        "/admin",
        "/admin/",
        "/api/",
        "/wallet",
        "/wallet/",
        "/kyc",
        "/kyc/",
        "/profile",
        "/profile/",
      ]),
    );
  });

  it("points at the sitemap with an absolute URL", () => {
    const sitemapUrl = robots().sitemap as string;

    expect(sitemapUrl).toMatch(/\/sitemap\.xml$/);
    expect(() => new URL(sitemapUrl)).not.toThrow();
  });
});
