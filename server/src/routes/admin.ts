/**
 * admin.ts — Admin-only API routes.
 *
 * All routes require a valid Bearer JWT. In the MVP, admin access is checked
 * by looking for a role = 'admin' column on the users row.  The authenticate
 * middleware validates the JWT; the requireAdmin middleware below validates
 * the role.
 */

import { Router, Request, Response, NextFunction } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { QueueService } from "../jobs";
import pool from "../db";

const router = Router();

// ---------------------------------------------------------------------------
// requireAdmin middleware
// ---------------------------------------------------------------------------

/**
 * Ensures the authenticated user has role = 'admin' in the users table.
 * Returns 403 if the user is not an admin.
 */
async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { sub: userId } = (req as AuthenticatedRequest).user;

  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!rows.length || rows[0]?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/queues  (admin only)
// ---------------------------------------------------------------------------

/**
 * Returns queue depths and recent failure counts for all background job queues.
 *
 * Response shape:
 * {
 *   queues: Array<{
 *     name: string
 *     waiting: number
 *     active: number
 *     completed: number
 *     failed: number
 *     delayed: number
 *     recentFailures: Array<{ jobId, data, failedReason, timestamp }>
 *   }>
 * }
 */
router.get(
  "/queues",
  authenticate,
  requireAdmin,
  async (_req, res) => {
    const queues = QueueService.getStats();
    res.status(200).json({ queues });
  })
);

// ---------------------------------------------------------------------------
// Stub endpoints — to be implemented in future issues
// ---------------------------------------------------------------------------

router.get("/users", authenticate, requireAdmin, (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

router.get("/trades", authenticate, requireAdmin, (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

router.patch("/users/:id", authenticate, requireAdmin, (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

export default router;
