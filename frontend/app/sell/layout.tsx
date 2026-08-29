import type { ReactNode } from "react";
import ThemeToggle from "../../components/ThemeToggle";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sell Airtime",
  description:
    "List airtime or mobile data for sale on AirFlex and get paid in naira once the escrow releases.",
  openGraph: {
    title: "Sell Airtime",
    description:
      "List airtime or mobile data for sale on AirFlex and get paid in naira once the escrow releases.",
  },
};

export default function SellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col dark:bg-gray-900">
      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-center text-xs text-gray-400 dark:text-gray-500">
            &copy; {new Date().getFullYear()} AirFlex — Open source under the MIT License.
          </p>
        </div>
      </footer>
    </div>
  );
}
