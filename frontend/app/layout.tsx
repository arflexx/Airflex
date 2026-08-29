import type { ReactNode } from "react";
import type { Metadata } from "next";
import Navbar from "../components/Navbar";
import ServiceWorkerRegister from "../components/ServiceWorkerRegister";
import { AuthProvider } from "./context/AuthContext";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "./lib/seo";

export const metadata: Metadata = {
  // metadataBase makes every relative OG/Twitter image resolve to an absolute
  // URL. Without it Next.js emits a relative path, which social crawlers cannot
  // fetch — the preview silently falls back to no image at all.
  metadataBase: new URL(siteUrl()),
  title: {
    default: `${SITE_NAME} — Buy & Sell Airtime Peer-to-Peer`,
    // Per-route titles fill the slot, so a page sets only its own name.
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — Buy & Sell Airtime Peer-to-Peer`,
    description: SITE_DESCRIPTION,
    url: "/",
    images: [
      {
        url: "/og-default.png",
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} — peer-to-peer airtime marketplace`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — Buy & Sell Airtime Peer-to-Peer`,
    description: SITE_DESCRIPTION,
    images: ["/og-default.png"],
  },
  robots: { index: true, follow: true },
};

/**
 * Root layout — mounts the shared Navbar on every page and provides
 * application-wide authentication state via AuthProvider.
 *
 * AuthProvider is a "use client" component, but this layout can stay a
 * Server Component: Next.js allows importing client components from server
 * components as long as we don't call client-only hooks here.
 *
 * suppressHydrationWarning is set on <html> to accommodate the theme
 * toggling script injected by next-themes (when that branch is merged).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-gray-50 text-gray-900 antialiased dark:bg-gray-900 dark:text-gray-100">
        <AuthProvider>
          <Navbar />
          {children}
        </AuthProvider>
        {/* Registers the PWA service worker in production (issue #107) */}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
