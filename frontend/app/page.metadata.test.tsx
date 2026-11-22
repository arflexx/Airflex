/**
 * Landing-page metadata (issue #464).
 *
 * Verifies the page-specific OpenGraph / Twitter / canonical overrides that
 * `generateMetadata` produces on top of the root layout's site-wide defaults.
 * The heavy child components are stubbed (via hoisted jest.mock) so this test
 * stays focused on the metadata shape and does not pull in the full render tree.
 */

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { generateMetadata } from "./page";

type OgImage = { url: string; width?: number; height?: number; alt?: string };

jest.mock("next-intl/server", () => ({
  getTranslations: jest.fn(),
}));

jest.mock("./components/ListingsGrid", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("../components/ThemeToggle", () => ({
  __esModule: true,
  default: () => null,
}));

const mockedGetTranslations = getTranslations as jest.Mock;

function tMock(map: Record<string, string>) {
  return jest.fn((key: string) => map[key] ?? key);
}

describe("HomePage generateMetadata (issue #464)", () => {
  const originalSiteUrl = process.env["NEXT_PUBLIC_SITE_URL"];

  afterEach(() => {
    jest.clearAllMocks();
    if (originalSiteUrl === undefined) delete process.env["NEXT_PUBLIC_SITE_URL"];
    else process.env["NEXT_PUBLIC_SITE_URL"] = originalSiteUrl;
  });

  it("returns a page-specific title built from the localised strings", async () => {
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://airflex.example";
    mockedGetTranslations.mockResolvedValue(
      tMock({ title1: "Buy & Sell Airtime", title2: "Peer-to-Peer", description: "desc" }),
    );

    const meta = (await generateMetadata()) as Metadata;

    // The root layout's title template is `%s | AirFlex`, so the page sets
    // only its own slot and Next composes the full title.
    expect(meta.title).toBe("Buy & Sell Airtime Peer-to-Peer");
  });

  it("overrides OpenGraph with a page-specific title, description and image", async () => {
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://airflex.example";
    mockedGetTranslations.mockResolvedValue(
      tMock({
        title1: "Buy & Sell Airtime",
        title2: "Peer-to-Peer",
        description: "Marketplace for airtime",
      }),
    );

    // Metadata["openGraph"] is a union whose members don't all declare
    // `type` or object images, so narrow to the shape this page emits.
    const og = (await generateMetadata()).openGraph as unknown as {
      type?: string;
      url?: unknown;
      title?: unknown;
      description?: unknown;
      siteName?: unknown;
      images?: OgImage | OgImage[];
    };

    expect(og.type).toBe("website");
    expect(og.url).toBe("https://airflex.example/");
    expect(og.title).toBe("Buy & Sell Airtime Peer-to-Peer | AirFlex");
    expect(og.description).toBe("Marketplace for airtime");
    expect(og.siteName).toBe("AirFlex");
    const image = Array.isArray(og.images) ? og.images[0] : og.images;
    expect(image?.url).toBe("/og-default.png");
    expect(image?.width).toBe(1200);
    expect(image?.height).toBe(630);
    expect(image?.alt).toBeTruthy();
  });

  it("emits a Twitter summary_large_image card mirroring OpenGraph", async () => {
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://airflex.example";
    mockedGetTranslations.mockResolvedValue(
      tMock({
        title1: "Buy & Sell Airtime",
        title2: "Peer-to-Peer",
        description: "Marketplace for airtime",
      }),
    );

    const twitter = (await generateMetadata()).twitter as unknown as {
      card?: string;
      title?: unknown;
      description?: unknown;
      images?: unknown;
    };

    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.title).toBe("Buy & Sell Airtime Peer-to-Peer | AirFlex");
    expect(twitter.description).toBe("Marketplace for airtime");
    expect(twitter.images).toEqual(["/og-default.png"]);
  });

  it("sets an absolute canonical URL", async () => {
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://airflex.example";
    mockedGetTranslations.mockResolvedValue(tMock({ description: "d" }));

    const canonical = (await generateMetadata()).alternates?.canonical;
    expect(canonical).toBe("https://airflex.example/");
  });

  it("the OG image file exists on disk at 1200x630", async () => {
    // Ensures the referenced preview image is actually shipped — a manifest
    // pointing at a missing file silently degrades to no preview.
    const fs = await import("fs");
    const path = await import("path");
    const file = path.join(process.cwd(), "public", "og-default.png");
    expect(fs.existsSync(file)).toBe(true);
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(buf.readUInt32BE(16)).toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(630);
  });
});
