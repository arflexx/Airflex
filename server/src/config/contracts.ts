/**
 * contracts.ts
 *
 * Resolves Soroban contract IDs at startup.
 *
 * Resolution order (first non-empty value wins):
 *   1. ESCROW_CONTRACT_ID / MARKETPLACE_CONTRACT_ID environment variables
 *   2. Legacy ESCROW_CONTRACT_ADDRESS environment variable (backwards compat)
 *   3. Testnet defaults from contracts/deployments.json (local dev fallback)
 *
 * In production (Railway) always set the env vars explicitly.
 * In local development, if no env var is set, the testnet address from
 * deployments.json is used automatically so developers can start the server
 * without any manual .env configuration.
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Load deployments.json — used only as a fallback for local development
// ---------------------------------------------------------------------------

interface Deployments {
  testnet: { escrow: string; marketplace: string; token: string };
  mainnet: { escrow: string; marketplace: string; token: string };
}

function loadDeployments(): Deployments {
  try {
    // Resolve relative to this file: server/src/config/ → repo root → contracts/
    const deploymentsPath = join(
      __dirname,
      "..",
      "..",
      "..",
      "contracts",
      "deployments.json"
    );
    const raw = readFileSync(deploymentsPath, "utf-8");
    return JSON.parse(raw) as Deployments;
  } catch {
    // Not critical — deployments.json may not exist in some environments
    return {
      testnet: { escrow: "", marketplace: "", token: "" },
      mainnet: { escrow: "", marketplace: "", token: "" },
    };
  }
}

// ---------------------------------------------------------------------------
// Resolve contract IDs
// ---------------------------------------------------------------------------

const network =
  process.env["STELLAR_NETWORK"] === "mainnet" ? "mainnet" : "testnet";

const deployments = loadDeployments();
const defaults = deployments[network];

/**
 * The escrow contract ID to use.
 * Reads ESCROW_CONTRACT_ID, falls back to ESCROW_CONTRACT_ADDRESS (legacy),
 * then falls back to the testnet default in deployments.json.
 */
export const ESCROW_CONTRACT_ID: string =
  process.env["ESCROW_CONTRACT_ID"] ||
  process.env["ESCROW_CONTRACT_ADDRESS"] ||
  defaults.escrow ||
  "";

/**
 * The marketplace contract ID to use.
 * Reads MARKETPLACE_CONTRACT_ID, falls back to the network default
 * in deployments.json.
 */
export const MARKETPLACE_CONTRACT_ID: string =
  process.env["MARKETPLACE_CONTRACT_ID"] ||
  defaults.marketplace ||
  "";

// ---------------------------------------------------------------------------
// Warn at startup if contract IDs are missing
// ---------------------------------------------------------------------------

if (!ESCROW_CONTRACT_ID) {
  console.warn(
    "[contracts] ESCROW_CONTRACT_ID is not set. " +
      "Soroban escrow calls will fail. " +
      "Set ESCROW_CONTRACT_ID in server/.env or deploy the contract first."
  );
}

if (!MARKETPLACE_CONTRACT_ID) {
  console.warn(
    "[contracts] MARKETPLACE_CONTRACT_ID is not set. " +
      "Soroban marketplace calls will fail. " +
      "Set MARKETPLACE_CONTRACT_ID in server/.env or deploy the contract first."
  );
}
