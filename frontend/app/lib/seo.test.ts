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

describe("sitemap", () => {
  it("lists every public route", () => {
    const urls = sitemap().map((entry) => entry.url);

    for (const route of PUBLIC_ROUTES) {
      expect(urls.some((url) => url.endsWith(route.path))).toBe(true);
    }
  });

  it("excludes every private route, /admin included", () => {
    const urls = sitemap().map((entry) => new URL(entry.url).pathname);

    for (const priv of PRIVATE_ROUTES) {
      expect(urls).not.toContain(priv);
    }
    expect(urls).not.toContain("/admin");
  });

  it("emits absolute URLs, which the sitemap spec requires", () => {
    for (const entry of sitemap()) {
      expect(() => new URL(entry.url)).not.toThrow();
      expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it("gives the home page the highest priority", () => {
    const home = sitemap().find((entry) => new URL(entry.url).pathname === "/");
    expect(home?.priority).toBe(1);
  });
});

describe("robots", () => {
  it("allows crawling the public site", () => {
    const rules = robots().rules as { allow?: string | string[] };
    expect(rules.allow).toBe("/");
  });

  it("disallows every private route", () => {
    const rules = robots().rules as { disallow?: string[] };

    for (const priv of PRIVATE_ROUTES) {
      expect(rules.disallow).toContain(`${priv}/`);
    }
  });

  it("keeps /admin out", () => {
    const rules = robots().rules as { disallow?: string[] };
    expect(rules.disallow).toContain("/admin/");
  });

  it("points at the sitemap with an absolute URL", () => {
    const sitemapUrl = robots().sitemap as string;

    expect(sitemapUrl).toMatch(/\/sitemap\.xml$/);
    expect(() => new URL(sitemapUrl)).not.toThrow();
  });
});
