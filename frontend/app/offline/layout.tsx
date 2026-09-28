import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "You're offline",
};

export default function OfflineLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
