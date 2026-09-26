import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Navbar from "./Navbar";

let currentPathname = "/";

jest.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      marketplace: "Marketplace",
      sell: "Sell",
      wallet: "Wallet",
      primary: "Primary",
      mobilePrimary: "Mobile primary",
      signIn: "Sign In",
      logOut: "Log out",
      closeMenu: "Close menu",
      openMenu: "Open menu",
      navMenu: "Navigation menu",
      viewProfile: "View your profile",
    };
    return translations[key] ?? key;
  },
  useLocale: () => "en",
}));

// Mock child components that might touch external browser state
jest.mock("./ThemeToggle", () => () => <button>ThemeToggle</button>);
jest.mock("./LanguageSwitcher", () => () => <div>LanguageSwitcher</div>);

describe("Navbar Active Route Indicator (Issue #327)", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("applies aria-current='page' and active style to Marketplace link when at '/'", () => {
    currentPathname = "/";
    render(<Navbar />);

    const marketplaceLinks = screen.getAllByRole("link", { name: "Marketplace" });
    const sellLinks = screen.getAllByRole("link", { name: "Sell" });
    const walletLinks = screen.getAllByRole("link", { name: "Wallet" });

    const desktopMarketplace = marketplaceLinks[0];
    const desktopSell = sellLinks[0];
    const desktopWallet = walletLinks[0];

    expect(desktopMarketplace).toHaveAttribute("aria-current", "page");
    expect(desktopMarketplace?.className).toContain("text-violet-700");
    expect(desktopMarketplace?.className).toContain("bg-violet-50");

    expect(desktopSell).not.toHaveAttribute("aria-current");
    expect(desktopWallet).not.toHaveAttribute("aria-current");
  });

  it("applies aria-current='page' and active style to Sell link when at '/sell'", () => {
    currentPathname = "/sell";
    render(<Navbar />);

    const marketplaceLinks = screen.getAllByRole("link", { name: "Marketplace" });
    const sellLinks = screen.getAllByRole("link", { name: "Sell" });
    const walletLinks = screen.getAllByRole("link", { name: "Wallet" });

    const desktopMarketplace = marketplaceLinks[0];
    const desktopSell = sellLinks[0];
    const desktopWallet = walletLinks[0];

    expect(desktopSell).toHaveAttribute("aria-current", "page");
    expect(desktopSell?.className).toContain("text-violet-700");
    expect(desktopSell?.className).toContain("bg-violet-50");

    expect(desktopMarketplace).not.toHaveAttribute("aria-current");
    expect(desktopWallet).not.toHaveAttribute("aria-current");
  });

  it("applies aria-current='page' and active style to Wallet link when at '/wallet'", () => {
    currentPathname = "/wallet";
    render(<Navbar />);

    const marketplaceLinks = screen.getAllByRole("link", { name: "Marketplace" });
    const sellLinks = screen.getAllByRole("link", { name: "Sell" });
    const walletLinks = screen.getAllByRole("link", { name: "Wallet" });

    const desktopMarketplace = marketplaceLinks[0];
    const desktopSell = sellLinks[0];
    const desktopWallet = walletLinks[0];

    expect(desktopWallet).toHaveAttribute("aria-current", "page");
    expect(desktopWallet?.className).toContain("text-violet-700");
    expect(desktopWallet?.className).toContain("bg-violet-50");

    expect(desktopMarketplace).not.toHaveAttribute("aria-current");
    expect(desktopSell).not.toHaveAttribute("aria-current");
  });
});
