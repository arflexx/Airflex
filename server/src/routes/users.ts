import { Router, type Request } from "express";
import pool from "../db";
import { userRatingsPaginationSchema } from "../schemas/ratings.schemas";
import { authenticate, type AuthenticatedRequest } from "../middleware/authenticate";
import { QueueService } from "../jobs";
import { decrypt } from "../utils/crypto";
import logger from "../utils/logger";
import {
  DATA_EXPORT_COOLDOWN_HOURS,
  downloadLinkTtlSeconds,
  getDataExportRequest,
  requestDataExport,
  signDownload,
  verifyDownloadSignature,
  type DataExportRequest,
} from "../services/dataExport";

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GDPR data portability export (issue #539)
// ---------------------------------------------------------------------------

/** Absolute base for links: PUBLIC_API_URL when set, else the request's own host. */
function exportBaseUrl(req: Request): string {
  const configured = process.env["PUBLIC_API_URL"]?.replace(/\/+$/, "");
  const origin = configured || `${req.protocol}://${req.get("host")}`;
  return `${origin}${req.baseUrl}/me/export`;
}

/** Public view of an export request, with a fresh signed URL once ready. */
function presentExport(req: Request, request: DataExportRequest) {
  const base = exportBaseUrl(req);
  let download: { url: string; expiresAt: string } | null = null;

  if (request.status === "ready") {
    const ttlExpiry = Math.floor(Date.now() / 1000) + downloadLinkTtlSeconds();
    const exportExpiry = request.expires_at
      ? Math.floor(new Date(request.expires_at).getTime() / 1000)
      : ttlExpiry;
    const { expires, signature } = signDownload(
      request.id,
      request.user_id,
      Math.min(ttlExpiry, exportExpiry)
    );
    download = {
      url: `${base}/${request.id}/download?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  return {
    id: request.id,
    status: request.status,
    format: request.format,
    requestedAt: new Date(request.requested_at).toISOString(),
    completedAt: request.completed_at ? new Date(request.completed_at).toISOString() : null,
    expiresAt: request.expires_at ? new Date(request.expires_at).toISOString() : null,
    statusUrl: `${base}/${request.id}`,
    download,
  };
}

/**
 * `GET /api/v1/users/me/export` — request a machine-readable export of all
 * personal data held about the caller (account, KYC, trades, ratings, wallet
 * ledger, withdrawals, referrals).
 *
 * The export is generated asynchronously: responds 202 with a status URL and
 * the user is notified by SMS when it is ready. Limited to one request per
 * user per 24 h — a repeat inside the window gets 429 with Retry-After and
 * the existing request (whose status URL yields the download once ready).
 */
router.get("/me/export", authenticate, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).user.sub;
  const result = await requestDataExport(userId);

  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({
      error: `Only one data export may be requested every ${DATA_EXPORT_COOLDOWN_HOURS} hours.`,
      retryAfterSeconds: result.retryAfterSeconds,
      export: presentExport(req, result.existing),
    });
    return;
  }

  await QueueService.enqueue("generate-data-export", {
    exportId: result.request.id,
    userId,
  });

  res.status(202).json({
    message: "Your data export is being prepared. You will receive an SMS when it is ready.",
    export: presentExport(req, result.request),
  });
});

/**
 * `GET /api/v1/users/me/export/:exportId` — status of one of the caller's
 * exports. Once ready, includes a signed download URL valid for
 * DATA_EXPORT_LINK_TTL_SECONDS (default 15 minutes); call again for a new one.
 */
router.get("/me/export/:exportId", authenticate, async (req, res) => {
  const { exportId } = req.params;
  if (!exportId || !UUID_PATTERN.test(exportId)) {
    res.status(400).json({ error: "Invalid export id" });
    return;
  }

  const userId = (req as unknown as AuthenticatedRequest).user.sub;
  const request = await getDataExportRequest(userId, exportId);
  if (!request) {
    res.status(404).json({ error: "Data export not found" });
    return;
  }

  res.status(200).json({ export: presentExport(req, request) });
});

/**
 * `GET /api/v1/users/me/export/:exportId/download?expires=&signature=`
 *
 * Streams the decrypted export as a JSON attachment. Authorised by the HMAC
 * signature (bound to export id, owner and expiry) rather than a Bearer
 * token, so the URL works as a direct browser download. Returns 404 for
 * missing/invalid export IDs, and 403 for expired or tampered signatures.
 */
router.get("/me/export/:exportId/download", async (req, res) => {
  const { exportId } = req.params;
  const expires = Number(req.query["expires"]);
  const signature = typeof req.query["signature"] === "string" ? req.query["signature"] : "";
  const notFound = () => res.status(404).json({ error: "Data export not found" });
  const forbidden = () => res.status(403).json({ error: "Download link is invalid or has expired" });

  if (!exportId || !UUID_PATTERN.test(exportId) || !signature) {
    notFound();
    return;
  }

  const { rows } = await pool.query<{
    user_id: string;
    status: string;
    payload_encrypted: string | null;
    payload_sha256: string | null;
    requested_at: Date;
  }>(
    `SELECT user_id, status, payload_encrypted, payload_sha256, requested_at
     FROM data_export_requests WHERE id = $1 LIMIT 1`,
    [exportId]
  );
  const row = rows[0];

  if (!row || row.status !== "ready" || !row.payload_encrypted) {
    notFound();
    return;
  }

  if (!verifyDownloadSignature(exportId, row.user_id, expires, signature)) {
    forbidden();
    return;
  }

  let json: string;
  try {
    json = decrypt(row.payload_encrypted);
  } catch (err) {
    logger.error({ exportId, err: (err as Error).message }, "[data-export] Failed to decrypt export");
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  await pool.query(
    `UPDATE data_export_requests SET downloaded_at = NOW() WHERE id = $1`,
    [exportId]
  );

  const date = new Date(row.requested_at).toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="airflex-data-export-${date}.json"`);
  res.setHeader("Cache-Control", "no-store");
  if (row.payload_sha256) res.setHeader("Digest", `sha-256=${Buffer.from(row.payload_sha256, "hex").toString("base64")}`);
  res.status(200).send(json);
});

/**
 * `GET /api/users/:id/ratings` — paginated ratings received by a user (#119).
 */
router.get("/:id/ratings", async (req, res) => {
  const userId = req.params["id"];
  const parsed = userRatingsPaginationSchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  const { rows: avgRows } = await pool.query<{ avg_stars: string; total: string }>(
    `SELECT COALESCE(AVG(stars), 0)::numeric(4,2) AS avg_stars,
            COUNT(*)::text AS total
     FROM ratings
     WHERE reviewee_id = $1`,
    [userId]
  );

  const { rows: ratings } = await pool.query(
    `SELECT id, trade_id, reviewer_id, reviewee_id, stars, comment, created_at
     FROM ratings
     WHERE reviewee_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const total = parseInt(avgRows[0]?.total ?? "0", 10);

  res.status(200).json({
    averageStars: Number(avgRows[0]?.avg_stars ?? 0),
    totalReviews: total,
    data: ratings,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

export default router;
