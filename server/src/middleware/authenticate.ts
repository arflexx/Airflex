import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import pool from "../db";

export interface AuthPayload {
  userId: string;
  phone: string;
  role: string;
  iat: number;
  exp: number;
  sub: string;        // user id
  stellarPublicKey: string;
  /**
   * The users.token_version value at issuance (see migrations/
   * 008_token_revocation.sql). Absent on tokens issued before this field
   * existed — treated as version 1, the column's default, so already-issued
   * tokens keep working after this change ships. Compared against the
   * user's current token_version on every request so POST /api/v1/auth/revoke
   * can invalidate outstanding tokens before their natural expiry.
   */
  tokenVersion?: number;
}

/** Extends Express's Request so downstream handlers get req.user typed */
export interface AuthenticatedRequest extends Request {
  user: AuthPayload;
}

/**
 * Returns true if `payload`'s token_version still matches the user's current
 * one in the database — i.e. the token has not been revoked since issuance.
 * A DB error fails closed (returns false): an auth check that silently
 * passed through on a database blip would defeat the point of a revocation
 * check.
 */
async function isTokenVersionCurrent(payload: AuthPayload): Promise<boolean> {
  const { rows } = await pool.query<{ token_version: number }>(
    `SELECT token_version FROM users WHERE id = $1 LIMIT 1`,
    [payload.sub]
  );

  if (!rows.length) {
    // User no longer exists — token cannot be valid.
    return false;
  }

  const issuedVersion = payload.tokenVersion ?? 1;
  return issuedVersion === rows[0]!.token_version;
}

/**
 * Middleware that validates a Bearer JWT in the Authorization header.
 * Attaches the decoded payload to `req.user` on success.
 *
 * Also checks that the token's `tokenVersion` still matches the user's
 * current `token_version` in the database, so a token can be revoked (via
 * POST /api/v1/auth/revoke) before its natural 7-day expiry.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers["authorization"];

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice(7);
  const secret = process.env["JWT_SECRET"]!;

  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, secret) as AuthPayload;
  } catch {
    res.status(401).json({ error: "Token is invalid or expired" });
    return;
  }

  try {
    if (!(await isTokenVersionCurrent(payload))) {
      res.status(401).json({ error: "Token has been revoked" });
      return;
    }
  } catch (err) {
    console.error("[authenticate] Token revocation check failed:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  (req as unknown as AuthenticatedRequest).user = payload;
  next();
}

/**
 * Like `authenticate`, but never rejects the request. If a valid Bearer JWT
 * is present, `req.user` is attached exactly as `authenticate` would; if the
 * header is missing, malformed, or the token is invalid/expired, the request
 * simply proceeds unauthenticated (no `req.user`).
 *
 * For endpoints that are public but return additional fields to a caller who
 * turns out to be a party to the resource (see GET /api/v1/trades/:id, which
 * only includes internal fee/settlement fields for the trade's own buyer or
 * seller).
 */
export function optionalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers["authorization"];

  if (!header || !header.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = header.slice(7);
  const secret = process.env["JWT_SECRET"]!;

  try {
    const payload = jwt.verify(token, secret) as AuthPayload;
    (req as unknown as AuthenticatedRequest).user = payload;
  } catch {
    // Invalid/expired token on a public endpoint — proceed anonymously
    // rather than rejecting the request.
  }

  next();
}
