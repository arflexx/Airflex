"use client";

/**
 * Navbar.tsx — Shared persistent navigation bar.
 *
 * Responsibilities
 * ----------------
 * - Renders AirFlex logo, primary nav links, auth-aware right side, and
 *   a ThemeToggle button on every page via the root layout.
 * - Reads auth state from localStorage (client-side only) and shows either
 *   the user's masked phone + wallet balance + logout, or a Sign In button.
 * - Fetches wallet balance from GET /api/v1/wallet after mount.
 * - On mobile (< md breakpoint) nav links collapse into a hamburger button
 *   that opens/closes a full-width slide-in drawer.
 * - Drawer traps focus (via aria-modal) and closes on Escape key or clicking
 *   the overlay backdrop.
 *
 * All interactive logic is isolated to this file so every layout only needs
 * a single `<Navbar />` import — no props required.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { getToken, getUser, clearToken, isAuthenticated } from "../app/lib/auth";
import LanguageSwitcher from "./LanguageSwitcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalletResponse {
  balance?: string;
  asset?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { href: "/",         labelKey: "marketplace" },
  { href: "/sell",     labelKey: "sell"        },
  { href: "/profile",  labelKey: "wallet"      },
] as const;

// ---------------------------------------------------------------------------
// Icons (inline SVG — no icon library dependency)
// ---------------------------------------------------------------------------

function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="6"  x2="20" y2="6"  />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6"  x2="6"  y2="18" />
      <line x1="6"  y1="6"  x2="18" y2="18" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ThemeToggle — inlined so Navbar has no sibling component dependency.
// When the dark-mode branch is merged this can be replaced with the import.
// ---------------------------------------------------------------------------

function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }

  if (!mounted) return <span className="h-9 w-9 inline-block" aria-hidden="true" />;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
    >
      {isDark ? (
        /* Sun — switch to light */
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        /* Moon — switch to dark */
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Masked phone helper
// ---------------------------------------------------------------------------

function maskPhone(phone: string): string {
  if (!phone || phone.length < 6) return "***";
  const visible = phone.slice(-4);
  const prefix  = phone.startsWith("+") ? phone.slice(0, 4) : phone.slice(0, 3);
  return `${prefix} *** ${visible}`;
}

// ---------------------------------------------------------------------------
// Navbar
// ---------------------------------------------------------------------------

export default function Navbar() {
  const pathname = usePathname();
  const t = useTranslations("Nav");

  // ---- auth / user state --------------------------------------------------
  const [mounted, setMounted]         = useState(false);
  const [authed, setAuthed]           = useState(false);
  const [maskedPhone, setMaskedPhone] = useState<string>("");

  // ---- wallet balance -----------------------------------------------------
  const [balance, setBalance]         = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  // ---- mobile drawer ------------------------------------------------------
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const drawerRef                     = useRef<HTMLDivElement>(null);
  const hamburgerRef                  = useRef<HTMLButtonElement>(null);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  // ---- resolve auth on mount ----------------------------------------------
  useEffect(() => {
    setMounted(true);
    if (isAuthenticated()) {
      setAuthed(true);
      const user = getUser();
      if (user?.phone) setMaskedPhone(maskPhone(user.phone));
    }
  }, []);

  // ---- fetch wallet balance when authenticated ----------------------------
  const fetchBalance = useCallback(() => {
    const token = getToken();
    if (!token) return;

    setBalanceLoading(true);
    fetch(`${apiUrl}/api/v1/wallet`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<WalletResponse>)
      .then((data) => {
        if (data.balance) {
          // Format to 2 dp and append asset symbol
          const num = parseFloat(data.balance);
          setBalance(`${isNaN(num) ? data.balance : num.toFixed(2)} ${data.asset ?? "XLM"}`);
        }
      })
      .catch(() => {/* silent — balance is non-critical */})
      .finally(() => setBalanceLoading(false));
  }, [apiUrl]);

  useEffect(() => {
    if (mounted && authed) fetchBalance();
  }, [mounted, authed, fetchBalance]);

  // ---- close drawer on route change ---------------------------------------
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // ---- Escape key closes drawer -------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
        hamburgerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // ---- trap focus inside drawer -------------------------------------------
  useEffect(() => {
    if (!drawerOpen) return;
    // Focus the first focusable element inside the drawer
    const first = drawerRef.current?.querySelector<HTMLElement>(
      'a, button, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, [drawerOpen]);

  // ---- logout -------------------------------------------------------------
  function handleLogout() {
    clearToken();
    setAuthed(false);
    setMaskedPhone("");
    setBalance(null);
    setDrawerOpen(false);
    window.location.href = "/";
  }

  // ---- active link helper -------------------------------------------------
  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname?.startsWith(href) ?? false;
  }

  // ---- shared link classes ------------------------------------------------
  const desktopLinkBase =
    "text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded-lg px-2 py-1";
  const desktopLinkActive  = "text-violet-700 dark:text-violet-400";
  const desktopLinkDefault = "text-gray-600 hover:text-violet-700 dark:text-gray-400 dark:hover:text-violet-400";

  const drawerLinkBase =
    "flex items-center rounded-xl px-4 py-3 text-base font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";
  const drawerLinkActive  = "bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300";
  const drawerLinkDefault = "text-gray-700 hover:bg-gray-50 hover:text-violet-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-violet-400";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Main header bar                                                      */}
      {/* ------------------------------------------------------------------ */}
      <header className="sticky top-0 z-40 border-b border-gray-100 bg-white/80 backdrop-blur-md dark:border-gray-700 dark:bg-gray-900/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">

          {/* Logo */}
          <a
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <span aria-hidden="true" className="text-2xl">🌀</span>
            <span className="text-xl font-extrabold tracking-tight text-violet-700 dark:text-violet-400">
              AirFlex
            </span>
          </a>

          {/* Desktop nav links — hidden on mobile */}
          <nav
            aria-label={t("primary")}
            className="hidden md:flex items-center gap-1"
          >
            {NAV_LINKS.map(({ href, labelKey }) => (
              <a
                key={href}
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
                className={`${desktopLinkBase} ${isActive(href) ? desktopLinkActive : desktopLinkDefault}`}
              >
                {t(labelKey)}
              </a>
            ))}
          </nav>

          {/* Right side — auth state + theme toggle */}
          <div className="flex items-center gap-2">

            {/* Only render auth-dependent UI after hydration */}
            {mounted && (
              authed ? (
                /* ---- Authenticated ---------------------------------------- */
                <div className="hidden md:flex items-center gap-3">
                  {/* Wallet balance pill */}
                  <div
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-700 dark:bg-gray-800"
                    title="Stellar wallet balance"
                  >
                    <WalletIcon />
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 tabular-nums">
                      {balanceLoading ? "…" : (balance ?? "—")}
                    </span>
                  </div>

                  {/* Masked phone — links to profile */}
                  <a
                    href="/profile"
                    className="hidden lg:flex items-center rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-gray-400 dark:hover:text-violet-400"
                    aria-label={t("viewProfile")}
                  >
                    {maskedPhone}
                  </a>

                  {/* Logout */}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    {t("logOut")}
                  </button>
                </div>
              ) : (
                /* ---- Unauthenticated --------------------------------------- */
                <a
                  href="/auth/signup"
                  className="hidden md:inline-flex items-center rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                >
                  {t("signIn")}
                </a>
              )
            )}

            {/* Theme toggle — always visible */}
            <LanguageSwitcher />
            <ThemeToggle />

            {/* Hamburger — mobile only */}
            <button
              ref={hamburgerRef}
              type="button"
              onClick={() => setDrawerOpen((o) => !o)}
              aria-expanded={drawerOpen}
              aria-controls="mobile-drawer"
              aria-label={drawerOpen ? t("closeMenu") : t("openMenu")}
              className="inline-flex md:hidden h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              {drawerOpen ? <CloseIcon /> : <HamburgerIcon />}
            </button>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Mobile drawer overlay + panel                                        */}
      {/* ------------------------------------------------------------------ */}
      {drawerOpen && (
        /* Semi-transparent backdrop — click to close */
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <div
        id="mobile-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("navMenu")}
        className={`fixed inset-y-0 right-0 z-50 w-72 max-w-full transform bg-white shadow-2xl transition-transform duration-200 ease-in-out md:hidden dark:bg-gray-900 ${
          drawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700">
          <a
            href="/"
            className="flex items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            onClick={() => setDrawerOpen(false)}
          >
            <span aria-hidden="true" className="text-2xl">🌀</span>
            <span className="text-lg font-extrabold tracking-tight text-violet-700 dark:text-violet-400">
              AirFlex
            </span>
          </a>
          <button
            type="button"
            onClick={() => { setDrawerOpen(false); hamburgerRef.current?.focus(); }}
            aria-label={t("closeMenu")}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Drawer nav links */}
        <nav aria-label={t("mobilePrimary")} className="flex flex-col gap-1 px-3 pt-4">
          {NAV_LINKS.map(({ href, labelKey }) => (
            <a
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={`${drawerLinkBase} ${isActive(href) ? drawerLinkActive : drawerLinkDefault}`}
            >
              {t(labelKey)}
            </a>
          ))}
        </nav>

        {/* Drawer auth section */}
        {mounted && (
          <div className="mt-4 border-t border-gray-100 px-3 pt-4 dark:border-gray-700">
            {authed ? (
              <div className="flex flex-col gap-3">
                {/* Wallet balance */}
                <div className="flex items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
                  <WalletIcon />
                  <div className="flex flex-col">
                    <span className="text-xs text-gray-400 dark:text-gray-500">{t("balance")}</span>
                    <span className="text-sm font-semibold text-gray-800 tabular-nums dark:text-gray-200">
                      {balanceLoading ? t("loadingBalance") : (balance ?? "—")}
                    </span>
                  </div>
                </div>

                {/* Masked phone */}
                <a
                  href="/profile"
                  className="flex items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  <span aria-hidden="true">👤</span>
                  {maskedPhone}
                </a>

                {/* Logout */}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  {t("logOut")}
                </button>
              </div>
            ) : (
              <a
                href="/auth/signup"
                className="flex w-full items-center justify-center rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              >
                {t("signIn")}
              </a>
            )}
          </div>
        )}
      </div>
    </>
  );
}
