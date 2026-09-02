import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware navigation primitives (Link, useRouter, usePathname, redirect).
 * Use these instead of the plain `next/navigation` variants so navigation
 * preserves the active locale.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
