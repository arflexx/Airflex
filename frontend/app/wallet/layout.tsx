import type { ReactNode } from "react";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet",
  description:
    "Fund your AirFlex wallet, track your balance, and withdraw to any Nigerian bank account.",
  openGraph: {
    title: "Wallet",
    description:
      "Fund your AirFlex wallet, track your balance, and withdraw to any Nigerian bank account.",
  },
  // Private to the signed-in user: useful to them, useless in an index.
  robots: { index: false, follow: false },
};

export default function WalletLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col dark:bg-gray-900">
      <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-center text-xs text-gray-500 dark:text-gray-400">
            &copy; {new Date().getFullYear()} AirFlex — Open source under the MIT License.
          </p>
        </div>
      </footer>
    </div>
  );
}
