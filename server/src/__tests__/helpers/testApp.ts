import "./env";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "../../app";
import pool from "../../db";
import { encryptSecret } from "../../services/stellar";

/**
 * testApp.ts — shared fixtures for the integration suite.
 */

/** Fresh Express app (no listener) — the exact same middleware/route stack as production. */
export const app = createApp();

const API = "/api/v1";
export { API };

/** Mints a signed access token, exactly like POST /api/v1/auth/verify-otp does. */
export function signToken(userId: string, stellarPublicKey = ""): string {
  return jwt.sign({ sub: userId, stellarPublicKey }, process.env["JWT_SECRET"]!, {
    expiresIn: "7d",
  });
}

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export interface SeededUser {
  id: string;
  phone: string;
  publicKey?: string;
  secretKey?: string;
  token: string;
}

interface SeedUserOptions {
  phone?: string;
  withWallet?: boolean;
  /** Pre-set OTP fields (e.g. for verify-otp flows). */
  otpPinId?: string | null;
  otpExpiresAt?: Date | null;
  publicKey?: string;
}

/** Inserts a user (and optionally a wallet) directly into the DB. */
export async function seedUser(opts: SeedUserOptions = {}): Promise<SeededUser> {
  const id = uuidv4();
  const phone = opts.phone ?? `+23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  await pool.query(
    `INSERT INTO users (id, phone, otp_pin_id, otp_expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, phone, opts.otpPinId ?? null, opts.otpExpiresAt ?? null]
  );

  let publicKey: string | undefined;
  let secretKey: string | undefined;

  if (opts.withWallet) {
    // Real keypair so Horizon-mocked lookups use a plausible account id.
    const kp = opts.publicKey ? null : Keypair.random();
    publicKey = opts.publicKey ?? kp!.publicKey();
    secretKey = kp?.secret() ?? "SBPLACEHOLDERSECRETKEYVALUEXXXXXXXXXXXXXXXXXXXXXXX";

    await pool.query(
      `INSERT INTO wallets (id, user_id, stellar_public_key, stellar_secret_key)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), id, publicKey, encryptSecret(secretKey)]
    );
    await pool.query(`UPDATE users SET stellar_public_key = $1 WHERE id = $2`, [
      publicKey,
      id,
    ]);
  }

  return { id, phone, publicKey, secretKey, token: signToken(id, publicKey ?? "") };
}

export interface SeedTradeOptions {
  sellerId: string;
  buyerId?: string | null;
  assetType?: string;
  amount?: number;
  status?: "Active" | "Locked" | "Completed" | "Cancelled" | "Disputed";
  contractListingId?: string | null;
  escrowTxHash?: string | null;
  expiresInHours?: number;
  createdAtOffsetMs?: number;
}

/** Inserts a trade_offers row directly into the DB and returns its id. */
export async function seedTrade(opts: SeedTradeOptions): Promise<string> {
  const id = uuidv4();
  const expiresAt = new Date(
    Date.now() + (opts.expiresInHours ?? 24) * 60 * 60 * 1000
  );

  await pool.query(
    `INSERT INTO trade_offers
       (id, seller_id, buyer_id, asset_type, amount, status,
        contract_listing_id, escrow_tx_hash, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      id,
      opts.sellerId,
      opts.buyerId ?? null,
      opts.assetType ?? "airtime",
      opts.amount ?? 500,
      opts.status ?? "Active",
      opts.contractListingId !== undefined
        ? opts.contractListingId
        : `listing-${Math.floor(Math.random() * 1_000_000)}`,
      opts.escrowTxHash ?? null,
      expiresAt,
      new Date(Date.now() + (opts.createdAtOffsetMs ?? 0)),
    ]
  );

  return id;
}

/** Waits until `predicate` sees what it wants, polling the DB. Uses real timers. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5_000, tickMs = 25 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}
