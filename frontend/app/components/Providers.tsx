import type { ReactNode } from "react";

/**
 * Composes app-wide providers. Kept as a simple passthrough so importing it
 * from tests and the component tree stays stable.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <>{children}</>;
}