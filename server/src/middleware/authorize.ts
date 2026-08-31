import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./authenticate";
import pool from "../db";

/**
 * authorize — role-based access-control middleware factory.
 *
 * Ensures the authenticated user (attached by `authenticate`) has one of the
 * required roles in the `users` table. Returns 403 otherwise.
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

    if (!rows.length || !roles.includes(rows[0].role)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    next();
  };
}
