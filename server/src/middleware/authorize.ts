import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./authenticate";
import pool from "../db";

export function authorize(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { sub: userId } = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query<{ role: string }>(
      "SELECT role FROM users WHERE id = $1 LIMIT 1",
      [userId]
    );

    if (!rows.length || !roles.includes(rows[0]!.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}
