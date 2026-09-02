import type { ReactNode } from "react";
import ThemeToggle from "../../../components/ThemeToggle";

export default function TradeDetailLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col dark:bg-gray-900">
      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
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
