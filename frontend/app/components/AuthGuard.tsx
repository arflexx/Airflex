"use client";

/**
 * AuthGuard — wraps page content that requires a particular account role.
 *
 * SECURITY NOTE: this is a **UX affordance, not the security boundary**. The
 * role is decoded from a JWT that lives in the browser and whose payload is
 * readable and editable by whoever holds it, so a determined user can always
 * make this component render. What actually protects the data is that every
 * admin endpoint runs `authenticate` + `requireAdmin` server-side, and the
 * Next.js middleware rejects a non-admin session at the edge. The guard exists
 * so a normal user sees a clean redirect instead of a broken dashboard.
 *
 * Behaviour:
 *  - While the auth provider is hydrating (`isLoading`), render a lightweight
 *    placeholder — never the protected children, and never a premature
 *    redirect (the role is still unknown at that point).
 *  - Once hydrated, if the signed-in user's role does not satisfy `role`,
 *    `router.replace("/")` and render a minimal notice instead of the children
 *    so the admin UI never flashes.
 *  - Otherwise render `children`.
 *
 * An `admin` satisfies both `role="admin"` and `role="user"`; a `user`
 * satisfies only `role="user"`.
 *
 * @example
 * <AuthGuard role="admin">
 *   <AdminDashboard />
 * </AuthGuard>
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";
import { Spinner } from "../../components/ui/Spinner";

interface AuthGuardProps {
  /** Minimum role required to view the wrapped content. */
  role: "admin" | "user";
  children: ReactNode;
}

export function AuthGuard({ role, children }: AuthGuardProps) {
  const { role: userRole, isLoading } = useAuth();
  const router = useRouter();

  const allowed =
    role === "admin"
      ? userRole === "admin"
      : userRole === "user" || userRole === "admin";

  useEffect(() => {
    if (!isLoading && !allowed) {
      router.replace("/");
    }
  }, [isLoading, allowed, router]);

  if (isLoading) {
    return (
      <main className="flex justify-center p-16">
        <Spinner size="lg" label="Checking access…" />
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="text-sm text-zinc-400">Redirecting…</p>
      </main>
    );
  }

  return <>{children}</>;
}

export default AuthGuard;
