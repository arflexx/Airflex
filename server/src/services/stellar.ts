import {
  Horizon,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  Contract,
} from "@stellar/stellar-sdk";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import {
  ESCROW_CONTRACT_ID,
  MARKETPLACE_CONTRACT_ID,
} from "../config/contracts";
import { parseContractError } from "./contractErrors";

// ---------------------------------------------------------------------------
// OpenTelemetry tracing helpers
// ---------------------------------------------------------------------------
// We use a lazy accessor so that this module can be loaded even when the
// OTel packages aren't installed (test env, pre-install). If the packages
// aren't present the tracer falls back to a no-op implementation.

import type { Tracer, Span } from "@opentelemetry/api";

function getTracer(): Tracer {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace } = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    return trace.getTracer("airflex-stellar", "1.0.0");
  } catch {
    // Return a no-op tracer if @opentelemetry/api isn't available
    return {
      startSpan: () => ({
        setAttribute: () => {},
        setStatus: () => {},
        recordException: () => {},
        end: () => {},
      } as unknown as Span),
      startActiveSpan: <F extends (span: Span) => unknown>(_n: string, fn: F) =>
        fn({
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        } as unknown as Span) as ReturnType<F>,
    } as unknown as Tracer;
  }
}

const NETWORK_PASSPHRASE =
  process.env["STELLAR_NETWORK"] === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const HORIZON_URL =
  process.env["HORIZON_URL"] ?? "https://horizon-testnet.stellar.org";

const SOROBAN_RPC_URL =
  process.env["SOROBAN_RPC_URL"] ?? "https://soroban-testnet.stellar.org";

const horizonServer = new Horizon.Server(HORIZON_URL, { allowHttp: false });
const sorobanServer = new SorobanRpc.Server(SOROBAN_RPC_URL, {
  allowHttp: false,
});

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;   // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

/**
 * Returns a 32-byte Buffer derived from the ENCRYPTION_KEY env variable.
 * The key must be a 64-character hex string (32 bytes).
 */
function getEncryptionKey(): Buffer {
  const raw = process.env["ENCRYPTION_KEY"];
  if (!raw || raw.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a single Base64 string encoding: iv (12 B) + tag (16 B) + ciphertext.
 * The secret key is never logged.
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Layout: [ iv (12) | tag (16) | ciphertext ]
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypts a value produced by `encryptSecret`.
 */
export function decryptSecret(encoded: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encoded, "base64");

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Wallet provisioning
// ---------------------------------------------------------------------------

/**
 * Generates a fresh Stellar keypair, funds it via Friendbot on testnet,
 * and returns the public key alongside the AES-256-GCM encrypted secret key.
 *
 * The plaintext secret key is held in memory only for the duration of this
 * call and is never returned to callers — only the encrypted form is.
 */
export async function generateAndFundWallet(): Promise<{
  publicKey: string;
  encryptedSecretKey: string;
}> {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();

  // Encrypt before any async suspension so the secret spends minimal time
  // in memory as a plain string.
  const encryptedSecretKey = encryptSecret(keypair.secret());

  // Scrub the reference — JS GC will collect the original string eventually,
  // but we won't hold an additional named reference to it.
  const friendbotUrl =
    process.env["FRIENDBOT_URL"] ??
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`;

  const url =
    friendbotUrl.includes("?addr=")
      ? friendbotUrl
      : `${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Friendbot funding failed for ${publicKey}: ${response.status} ${text}`
    );
  }

  return { publicKey, encryptedSecretKey };
}

/**
 * Fetches the current XLM balance of a Stellar account from Horizon.
 * Returns "0" when the account is not yet found (pre-funding race condition).
 */
export async function getWalletBalance(publicKey: string): Promise<string> {
  try {
    const account = await horizonServer.loadAccount(publicKey);
    const native = account.balances.find(
      (b): b is Horizon.HorizonApi.BalanceLine & { asset_type: "native" } =>
        b.asset_type === "native"
    );
    return native?.balance ?? "0";
  } catch (err) {
    // Horizon throws a 404-style error if the account doesn't exist yet
    if (
      err instanceof Error &&
      err.message.toLowerCase().includes("not found")
    ) {
      return "0";
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
/**
 * Calls the smart contract's `create_listing` function.
 *
 * In a real system the seller's keypair would come from a secure vault or
 * be signed client-side. Here we derive it from the seller's stored secret
 * or a platform hot-wallet for demonstration purposes.
 *
 * @returns The contract listing ID (stringified i128 sequence number)
 */
export async function createListing(params: {
  sellerPublicKey: string;
  sellerSecretKey: string;
  assetType: string;
  amount: number;
  expiresAt: Date;
}): Promise<string> {
  const contractAddress = ESCROW_CONTRACT_ID;
  if (!contractAddress) {
    throw new Error(
      "ESCROW_CONTRACT_ID is not set. Deploy the escrow contract or set the env variable."
    );
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.create_listing", async (span: Span) => {
    span.setAttribute("soroban.contract_id", contractAddress);
    span.setAttribute("soroban.function", "create_listing");
    span.setAttribute("soroban.network", process.env["STELLAR_NETWORK"] ?? "testnet");
    span.setAttribute("trade.asset_type", params.assetType);
    span.setAttribute("trade.amount", params.amount);

    try {
      const keypair = Keypair.fromSecret(params.sellerSecretKey);
      const account = await horizonServer.loadAccount(params.sellerPublicKey);
      const contract = new Contract(contractAddress);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            "create_listing",
            new Address(params.sellerPublicKey).toScVal(),
            nativeToScVal(params.assetType, { type: "symbol" }),
            nativeToScVal(BigInt(params.amount * 1_000_000), { type: "i128" }),
            nativeToScVal(
              BigInt(Math.floor(params.expiresAt.getTime() / 1000)),
              { type: "u64" }
            )
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await sorobanServer.prepareTransaction(tx);
      preparedTx.sign(keypair);

      const response = await sorobanServer.sendTransaction(preparedTx);

      if (response.status === "ERROR") {
        const parsed = parseContractError(response);
        throw parsed ?? new Error(
          `Contract create_listing failed: ${JSON.stringify(response.errorResult)}`
        );
      }

      span.setAttribute("soroban.tx_hash", response.hash);
      const listingId = await pollForResult(response.hash);
      span.setAttribute("trade.listing_id", listingId);
      return listingId;
    } catch (err) {
      span.recordException(err as Error);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SpanStatusCode } = require("@opentelemetry/api");
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Calls the smart contract's `deposit_to_escrow` function to lock
 * a buyer's funds against a specific listing.
 *
 * @returns Transaction hash of the confirmed escrow deposit
 */
export async function depositToEscrow(params: {
  buyerPublicKey: string;
  buyerSecretKey: string;
  listingId: string;
  amount: number;
}): Promise<string> {
  const contractAddress = ESCROW_CONTRACT_ID;
  if (!contractAddress) {
    throw new Error(
      "ESCROW_CONTRACT_ID is not set. Deploy the escrow contract or set the env variable."
    );
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.deposit_to_escrow", async (span: Span) => {
    span.setAttribute("soroban.contract_id", contractAddress);
    span.setAttribute("soroban.function", "deposit_to_escrow");
    span.setAttribute("soroban.network", process.env["STELLAR_NETWORK"] ?? "testnet");
    span.setAttribute("trade.listing_id", params.listingId);
    span.setAttribute("trade.amount", params.amount);

    try {
      const keypair = Keypair.fromSecret(params.buyerSecretKey);
      const account = await horizonServer.loadAccount(params.buyerPublicKey);
      const contract = new Contract(contractAddress);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            "deposit_to_escrow",
            nativeToScVal(params.listingId, { type: "symbol" }),
            new Address(params.buyerPublicKey).toScVal(),
            nativeToScVal(BigInt(params.amount * 1_000_000), { type: "i128" })
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await sorobanServer.prepareTransaction(tx);
      preparedTx.sign(keypair);

      const response = await sorobanServer.sendTransaction(preparedTx);

      if (response.status === "ERROR") {
        const parsed = parseContractError(response);
        throw parsed ?? new Error(
          `Contract deposit_to_escrow failed: ${JSON.stringify(response.errorResult)}`
        );
      }

      span.setAttribute("soroban.tx_hash", response.hash);
      await pollForResult(response.hash);
      return response.hash;
    } catch (err) {
      span.recordException(err as Error);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SpanStatusCode } = require("@opentelemetry/api");
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Calls the smart contract's `release_payment` function.
 *
 * This is the oracle step — called by the server after delivery is confirmed.
 * The server signing key (STELLAR_SERVER_SECRET) must be the admin address
 * that was set during contract initialisation.
 *
 * SECURITY: The secret key is read once from env, used to sign the transaction,
 * and the Keypair object is not exported or logged anywhere.
 *
 * @param contractTradeId  The on-chain trade ID (u64) stored in contract_listing_id
 * @returns Transaction hash of the confirmed release
 */
export async function releasePayment(contractTradeId: string): Promise<string> {
  const contractAddress = ESCROW_CONTRACT_ID;
  if (!contractAddress) {
    throw new Error(
      "ESCROW_CONTRACT_ID is not set. Deploy the escrow contract or set the env variable."
    );
  }

  const serverSecret = process.env["STELLAR_SERVER_SECRET"];
  if (!serverSecret) {
    throw new Error("STELLAR_SERVER_SECRET environment variable is not set");
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.release_payment", async (span: Span) => {
    span.setAttribute("soroban.contract_id", contractAddress);
    span.setAttribute("soroban.function", "release_payment");
    span.setAttribute("soroban.network", process.env["STELLAR_NETWORK"] ?? "testnet");
    span.setAttribute("trade.contract_trade_id", contractTradeId);

    try {
      // Derive keypair from server secret — never log this object
      const keypair = Keypair.fromSecret(serverSecret);
      const serverPublicKey = keypair.publicKey();

      const account = await horizonServer.loadAccount(serverPublicKey);
      const contract = new Contract(contractAddress);

      // The contract expects a u64 trade ID
      const tradeIdU64 = BigInt(contractTradeId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            "release_payment",
            nativeToScVal(tradeIdU64, { type: "u64" })
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await sorobanServer.prepareTransaction(tx);
      preparedTx.sign(keypair);

      const response = await sorobanServer.sendTransaction(preparedTx);

      if (response.status === "ERROR") {
        const parsed = parseContractError(response);
        throw parsed ?? new Error(
          `Contract release_payment failed: ${JSON.stringify(response.errorResult)}`
        );
      }

      span.setAttribute("soroban.tx_hash", response.hash);
      await pollForResult(response.hash);
      return response.hash;
    } catch (err) {
      span.recordException(err as Error);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SpanStatusCode } = require("@opentelemetry/api");
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}



/**
 * Calls the smart contract's `resolve_dispute` function to settle a disputed
 * trade. Only the admin (STELLAR_SERVER_SECRET) can invoke this — the same
 * signing key used by `release_payment`.
 *
 * The `resolution` maps to a `refund` flag on-chain:
 *   - "RELEASE" → funds are released to the seller (refund = false).
 *   - "REFUND"  → funds are returned to the buyer (refund = true).
 *
 * @param contractTradeId  The on-chain trade ID (u64) stored in contract_listing_id
 * @param resolution       "RELEASE" | "REFUND"
 * @returns Transaction hash of the confirmed resolution
 */
export async function resolveDispute(params: {
  contractTradeId: string;
  resolution: "RELEASE" | "REFUND";
}): Promise<string> {
  const contractAddress = process.env["ESCROW_CONTRACT_ADDRESS"];
  if (!contractAddress) {
    throw new Error("ESCROW_CONTRACT_ADDRESS environment variable is not set");
  }

  const serverSecret = process.env["STELLAR_SERVER_SECRET"];
  if (!serverSecret) {
    throw new Error("STELLAR_SERVER_SECRET environment variable is not set");
  }

  // Derive keypair from server secret — never log this object
  const keypair = Keypair.fromSecret(serverSecret);
  const serverPublicKey = keypair.publicKey();

  const account = await horizonServer.loadAccount(serverPublicKey);
  const contract = new Contract(contractAddress);

  const tradeIdU64 = BigInt(params.contractTradeId);
  const refund = params.resolution === "REFUND";

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "resolve_dispute",
        nativeToScVal(tradeIdU64, { type: "u64" }),
        nativeToScVal(refund, { type: "bool" })
      )
    )
    .setTimeout(30)
    .build();

  const preparedTx = await sorobanServer.prepareTransaction(tx);
  preparedTx.sign(keypair);

  const response = await sorobanServer.sendTransaction(preparedTx);

  if (response.status === "ERROR") {
    const parsed = parseContractError(response);
    throw parsed ?? new Error(
      `Contract resolve_dispute failed: ${JSON.stringify(response.errorResult)}`
    );
  }

  await pollForResult(response.hash);
  return response.hash;
}


/**
 * Polls Soroban RPC until a submitted transaction reaches a terminal state.
 * Returns the stringified return value on SUCCESS, throws on FAILED.
 */
async function pollForResult(hash: string): Promise<string> {
  const MAX_ATTEMPTS = 20;
  const INTERVAL_MS = 1_500;

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.poll_transaction", async (span: Span) => {
    span.setAttribute("soroban.tx_hash", hash);

    try {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await sleep(INTERVAL_MS);
        const result = await sorobanServer.getTransaction(hash);

        if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          span.setAttribute("soroban.poll_attempts", i + 1);
          const returnValue = (result as SorobanRpc.Api.GetSuccessfulTransactionResponse)
            .returnValue;
          if (returnValue) {
            return scValToString(returnValue);
          }
          return hash;
        }

        if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
          const parsed = parseContractError(result);
          throw parsed ?? new Error(`Transaction ${hash} failed on-chain`);
        }
        // NOT_FOUND means still pending — keep polling
      }

      throw new Error(`Transaction ${hash} did not confirm within timeout`);
    } catch (err) {
      span.recordException(err as Error);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SpanStatusCode } = require("@opentelemetry/api");
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

function scValToString(val: xdr.ScVal): string {
  try {
    // i128 / u64 return values
    if (
      val.switch() === xdr.ScValType.scvI128() ||
      val.switch() === xdr.ScValType.scvU64()
    ) {
      return val.value()?.toString() ?? "";
    }
    if (val.switch() === xdr.ScValType.scvSymbol()) {
      return val.sym()?.toString() ?? "";
    }
    if (val.switch() === xdr.ScValType.scvString()) {
      return val.str()?.toString() ?? "";
    }
  } catch {
    // fall through
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
