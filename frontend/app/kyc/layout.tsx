import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Seller Verification",
  description:
    "Complete KYC verification to sell airtime and mobile data on AirFlex.",
};

export default function KycLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col dark:bg-gray-900">
      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
        {children}
      </main>
    </div>
  );
}
