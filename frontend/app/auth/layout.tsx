import type { ReactNode } from "react";
import ThemeToggle from "../../components/ThemeToggle";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Create an AirFlex account or sign in with your phone number to start trading airtime.",
  openGraph: {
    title: "Sign in",
    description:
      "Create an AirFlex account or sign in with your phone number to start trading airtime.",
  },
  // Private to the signed-in user: useful to them, useless in an index.
  robots: { index: false, follow: false },
};

/**
 * Auth layout — centred card on a violet-tinted background.
 * The shared Navbar is already rendered by the root layout above this.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[calc(100vh-57px)] bg-gradient-to-br from-violet-50 to-gray-100 flex flex-col dark:from-gray-900 dark:to-gray-800">
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
              Stellar-powered marketplace
            </p>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white px-8 py-10 shadow-md dark:border-gray-700 dark:bg-gray-800">
            {children}
          </div>

          <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">
            By continuing you agree to the AirFlex{" "}
            <a href="/terms" className="underline hover:text-gray-600 dark:hover:text-gray-300">
              Terms of Service
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
