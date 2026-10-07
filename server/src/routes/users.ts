import { Router } from "express";
import pool from "../db";
import { userRatingsPaginationSchema } from "../schemas/ratings.schemas";

const router = Router();

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
