/**
 * admin.ts — Admin-only API routes.
 *
 * All routes require a valid Bearer JWT. In the MVP, admin access is checked
 * by looking for a role = 'admin' column on the users row.  The authenticate
 * middleware validates the JWT; the requireAdmin middleware below validates
 * the role.
 */

import { Router, Request, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { QueueService } from "../jobs";
import { authorize } from "../middleware/authorize";
import { z } from "zod";
import pool from "../db";

const router = Router();

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
  authorize("admin"),
  async (_req, res) => {
    const queues = QueueService.getStats();
    res.status(200).json({ queues });
  }
);

// ---------------------------------------------------------------------------
// Stub endpoints — to be implemented in future issues
// ---------------------------------------------------------------------------

router.get("/users", authenticate, authorize("admin"), (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

router.get("/trades", authenticate, authorize("admin"), (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

router.patch("/users/:id", authenticate, authorize("admin"), (_req: Request, res: Response) => {
  res.status(501).json({ error: "Not Implemented" });
});

const kycSchema = z.object({
  status: z.enum(["unverified", "pending", "verified"]),
});

router.patch("/users/:id/kyc", authenticate, authorize("admin"), async (req, res) => {
  const parsed = kycSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid KYC status", details: parsed.error.flatten() });
    return;
  }

  const { rows } = await pool.query(
    `UPDATE users SET kyc_status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, kyc_status`,
    [parsed.data.status, req.params.id]
  );

  if (!rows.length) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(200).json({ data: rows[0] });
});

export default router;
