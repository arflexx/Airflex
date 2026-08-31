/**
 * recoveryCodes.ts — 2FA recovery backup codes (issue #108).
 *
 * At the end of OTP signup, 8 single-use 16-character recovery codes are
 * generated, bcrypt-hashed, and stored in the `recovery_codes` table. The
 * plaintext codes are shown to the user exactly once (returned by
 * POST /api/v1/auth/verify-otp on first signup) and never stored.
 *
 * Redemption looks a row up by a deterministic SHA-256 of the submitted code
 * (an 80-bit keyspace — not enumerable), verifies it with bcrypt, and marks it
 * used inside a transaction so a code can only ever be redeemed once.
 */

import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import pool from "../db";

/** Number of recovery codes issued per user. */
export const RECOVERY_CODES_PER_USER = 8;

/** Length of each recovery code. */
export const RECOVERY_CODE_LENGTH = 16;

/**
 * Unambiguous alphabet: no 0/O, 1/I, or L — codes are typed by hand from a
 * paper backup, and confusable characters cause lockouts.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Deterministic lookup key for a recovery code. */
export function recoveryCodeSha256(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Generate a single 16-character recovery code from a CSPRNG. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return code;
}

/** bcrypt-hash a recovery code for storage. */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Generate and persist `RECOVERY_CODES_PER_USER` codes for a user.
 *
 * Returns the plaintext codes — the ONLY time they are ever available. The
 * caller is responsible for returning them to the user once and discarding
 * them (never log them).
 */
export async function generateRecoveryCodesForUser(userId: string): Promise<string[]> {
  const codes: string[] = [];
  const rows: Array<[string, string, string, string]> = [];

  for (let i = 0; i < RECOVERY_CODES_PER_USER; i++) {
    const code = generateRecoveryCode();
    // Sequential bcrypt hashing is slow by design; 8 rounds of cost-10 hashing
    // at signup is acceptable.
    const codeHash = await hashRecoveryCode(code);
    rows.push([uuidv4(), userId, recoveryCodeSha256(code), codeHash]);
    codes.push(code);
  }

  await pool.query(
    `INSERT INTO recovery_codes (id, user_id, code_sha256, code_hash)
     VALUES ($1, $2, $3, $4)`,
    rows
  );

  return codes;
}

/** True if the user has ever been issued recovery codes. */
export async function userHasRecoveryCodes(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM recovery_codes WHERE user_id = $1`,
    [userId]
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** How many unused recovery codes a user has left. */
export async function countRemainingRecoveryCodes(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM recovery_codes
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return Number(rows[0]?.n ?? 0);
}

export type RedeemResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "used" };

/**
 * Redeem a recovery code.
 *
 * - invalid — no matching code, or the code did not match its bcrypt hash.
 * - used   — the code matched but was already redeemed (single-use).
 *
 * The row is locked (FOR UPDATE) and updated inside a transaction so two
 * concurrent redemptions of the same code cannot both succeed.
 */
export async function redeemRecoveryCode(code: string): Promise<RedeemResult> {
  const lookup = recoveryCodeSha256(code);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id: string;
      user_id: string;
      code_hash: string;
      used_at: string | null;
    }>(
      `SELECT id, user_id, code_hash, used_at
       FROM recovery_codes
       WHERE code_sha256 = $1
       FOR UPDATE`,
      [lookup]
    );

    const row = rows[0];

    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid" };
    }

    if (row.used_at) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "used" };
    }

    const matches = await bcrypt.compare(code, row.code_hash);
    if (!matches) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid" };
    }

    await client.query(
      `UPDATE recovery_codes SET used_at = NOW() WHERE id = $1`,
      [row.id]
    );

    await client.query("COMMIT");
    return { ok: true, userId: row.user_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
