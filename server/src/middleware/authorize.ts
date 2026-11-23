import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./authenticate";
import pool from "../db";

/**
 * Roles that inherit the permissions of other roles. A super_admin can do
 * everything an admin can, plus super_admin-only actions such as reading the
 * audit trail (issue #539).
 */
const IMPLIED_ROLES: Record<string, readonly string[]> = {
  super_admin: ["admin"],
};

/** True when a user holding `role` satisfies one of `required`. */
export function roleSatisfies(role: string, required: readonly string[]): boolean {
  if (required.includes(role)) return true;
  return (IMPLIED_ROLES[role] ?? []).some((implied) => required.includes(implied));
}

/**
 * authorize — role-based access-control middleware factory.
 *
 * Ensures the authenticated user (attached by `authenticate`) has one of the
 * required roles in the `users` table (or a role implying one, see
 * IMPLIED_ROLES). Returns 403 otherwise.
 *
 * Usage:
 *   router.get("/", authenticate, authorize("admin"), handler);
 */
export function authorize(...roles: string[]) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );

    if (!rows.length || !roleSatisfies(rows[0].role, roles)) {
      res.status(403).json({
        error: roles.includes("super_admin") ? "Super-admin access required" : "Admin access required",
      });
      return;
    }

    next();
  };
}

/**
 * requirePermission — permission-based access-control middleware factory.
 *
 * Ensures the authenticated user has the specific permission in their
 * `admin_permissions` JSONB array. Returns 403 otherwise.
 *
 * This provides granular, least-privilege access control for admin endpoints.
 *
 * Usage:
 *   router.post("/", authenticate, requirePermission("trades.resolve"), handler);
 */
export function requirePermission(permission: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows } = await pool.query<{ admin_permissions: string[] }>(
      `SELECT admin_permissions FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const permissions = rows[0].admin_permissions || [];
    if (!permissions.includes(permission)) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    next();
  };
}
