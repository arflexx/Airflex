import crypto from "crypto";

/**
 * Derives a short, stable, opaque display handle for a user (issue #330).
 *
 * Trade listings are public, so they must not carry anything derived from the
 * seller's UUID — correlating cards by a slice of the id lets anyone map a
 * seller's whole activity. A display handle is a public *label*: it is stable
 * for a given user (deterministic, so the same seller always renders the same
 * way) but reveals nothing about the id it was derived from.
 *
 * The algorithm is intentionally trivial: `@airflex_` + the first four hex
 * characters of the MD5 of the (already random) user id. MD5 is used here as a
 * fast, uniform mixing function for a non-secret label — it is not a password
 * hash and the handle is not a credential. Uniqueness is not required: two
 * sellers sharing a handle leaks nothing, since the listing's `id` is the
 * actual identifier.
 *
 * Keep this in lock-step with the SQL backfill in
 * `src/db/migrations/008_display_handle.sql`, which derives the same value for
 * users created before this column existed.
 */
export function generateDisplayHandle(userId: string): string {
  const digest = crypto.createHash("md5").update(userId).digest("hex");
  return `@airflex_${digest.slice(0, 4)}`;
}
