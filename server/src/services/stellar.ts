import {
  Horizon,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Transaction,
  Address,
  nativeToScVal,
  scValToNative,
  Contract,
} from "@stellar/stellar-sdk";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import {
  ESCROW_CONTRACT_ID,
  MARKETPLACE_CONTRACT_ID,
} from "../config/contracts";
import { parseContractError } from "./contractErrors";
import logger from "../utils/logger";

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
  process.env["HORIZON_URL"] || "https://horizon-testnet.stellar.org";

const SOROBAN_RPC_URL =
  process.env["SOROBAN_RPC_URL"] || "https://soroban-testnet.stellar.org";

const horizonServer = new Horizon.Server(HORIZON_URL, { allowHttp: false });
const sorobanServer = new SorobanRpc.Server(SOROBAN_RPC_URL, {
  allowHttp: false,
});

// ---------------------------------------------------------------------------
// Soroban RPC timeout + retry
// ---------------------------------------------------------------------------
// Every Soroban RPC call goes through callSorobanRpc(), which bounds it with a
// timeout (SOROBAN_RPC_TIMEOUT_MS, default 10s) and retries transient failures
// — timeouts, HTTP 429 / 5xx, connection resets and TRY_AGAIN_LATER send
// responses — with exponential back-off (SOROBAN_RPC_MAX_RETRIES, default 2).
// A 429 Retry-After header is honoured. Contract and simulation errors are
// never retried: they would fail the same way again.
//
// Retrying sendTransaction is safe: a re-sent signed envelope has the same
// hash and sequence number, so it either lands once or comes back DUPLICATE,
// which the callers treat as submitted and go on to poll.

export const DEFAULT_SOROBAN_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_SOROBAN_RPC_MAX_RETRIES = 2;
const SOROBAN_RPC_RETRY_BASE_DELAY_MS = 500;
const SOROBAN_RPC_MAX_RETRY_DELAY_MS = 10_000;

export function getSorobanRpcTimeoutMs(): number {
  const parsed = parseInt(process.env["SOROBAN_RPC_TIMEOUT_MS"] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOROBAN_RPC_TIMEOUT_MS;
}

export function getSorobanRpcMaxRetries(): number {
  const parsed = parseInt(process.env["SOROBAN_RPC_MAX_RETRIES"] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SOROBAN_RPC_MAX_RETRIES;
}

export class SorobanRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Soroban RPC ${method} timed out after ${timeoutMs}ms`);
    this.name = "SorobanRpcTimeoutError";
  }
}

/** A transient RPC condition reported in a response body rather than as an HTTP error. */
export class SorobanRpcRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorobanRpcRetryableError";
  }
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
]);

interface HttpLikeError {
  code?: string;
  response?: { status?: number; headers?: Record<string, unknown> };
}

function httpStatusOf(err: unknown): number | undefined {
  return (err as HttpLikeError | null)?.response?.status;
}

export function isRetryableSorobanRpcError(err: unknown): boolean {
  if (err instanceof SorobanRpcTimeoutError || err instanceof SorobanRpcRetryableError) {
    return true;
  }
  const status = httpStatusOf(err);
  if (status !== undefined) return status === 429 || status >= 500;
  const code = (err as HttpLikeError | null)?.code;
  return code !== undefined && RETRYABLE_NETWORK_CODES.has(code);
}

/** Delay before retry `attempt` (1-based): Retry-After on a 429, else exponential with jitter. */
function sorobanRetryDelayMs(err: unknown, attempt: number, baseDelayMs: number): number {
  if (httpStatusOf(err) === 429) {
    const retryAfter = Number((err as HttpLikeError).response?.headers?.["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1_000, SOROBAN_RPC_MAX_RETRY_DELAY_MS);
    }
  }
  const exp = Math.min(baseDelayMs * Math.pow(2, attempt - 1), SOROBAN_RPC_MAX_RETRY_DELAY_MS);
  return Math.round(exp + exp * 0.2 * Math.random());
}

function withTimeout<T>(method: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SorobanRpcTimeoutError(method, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface SorobanRpcCallOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Runs one Soroban RPC call with a timeout and retry fallback. `fn` is invoked
 * afresh on each attempt.
 */
export async function callSorobanRpc<T>(
  method: string,
  fn: () => Promise<T>,
  opts: SorobanRpcCallOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? getSorobanRpcTimeoutMs();
  const maxRetries = opts.maxRetries ?? getSorobanRpcMaxRetries();
  const baseDelayMs = opts.baseDelayMs ?? SOROBAN_RPC_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(method, fn(), timeoutMs);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableSorobanRpcError(err)) throw err;
      await sleep(sorobanRetryDelayMs(err, attempt + 1, baseDelayMs));
    }
  }
}

function prepareTransaction(tx: Transaction): Promise<Transaction> {
  return callSorobanRpc("prepareTransaction", () => sorobanServer.prepareTransaction(tx));
}

function sendTransaction(tx: Transaction): Promise<SorobanRpc.Api.SendTransactionResponse> {
  return callSorobanRpc("sendTransaction", async () => {
    const response = await sorobanServer.sendTransaction(tx);
    if (response.status === "TRY_AGAIN_LATER") {
      throw new SorobanRpcRetryableError(
        `Soroban RPC sendTransaction returned TRY_AGAIN_LATER for ${response.hash}`
      );
    }
    return response;
  });
}

function getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
  return callSorobanRpc("getTransaction", () => sorobanServer.getTransaction(hash));
}

// ---------------------------------------------------------------------------
// Server signing key (issue #313) — parsed and validated exactly once, on
// first use, so a missing/invalid STELLAR_SERVER_SECRET surfaces as a clear
// error instead of failing queued release jobs at runtime mid-flight.
//
// Deliberately *not* validated as a module-load side effect: boot-time
// validation is owned by index.ts / config/validateEnv.ts (issue #383), which
// reports every missing variable in one place and exits non-zero. Keeping this
// module side-effect free also lets route tests import the app without a real
// signing key configured. A non-fatal warning is still logged at startup (see
// below) so a misconfigured deployment is visible in the boot logs.
// ---------------------------------------------------------------------------

function loadServerKeypair(): Keypair {
  const secret = process.env["STELLAR_SERVER_SECRET"];
  if (!secret) {
    throw new Error(
      "STELLAR_SERVER_SECRET environment variable is not set. Set it to the admin Stellar secret key before starting the server."
    );
  }
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new Error(
      "STELLAR_SERVER_SECRET is invalid (not a decodable Stellar secret seed)."
    );
  }
}

let cachedServerKeypair: Keypair | null = null;

/**
 * Internal accessor for the server signing keypair.
 *
 * The key is parsed and validated once and then cached; call sites use this
 * getter so the secret-derived object never leaks into logs or responses.
 */
export function getServerKeypair(): Keypair {
  if (!cachedServerKeypair) {
    cachedServerKeypair = loadServerKeypair();
  }
  return cachedServerKeypair;
}

// Resolve (and validate) the server key as soon as this module loads so a
// misconfigured deployment is visible in the startup logs immediately. This
// only warns (never throws/exits) — index.ts's own REQUIRED_ENV_VARS check is
// what actually fails startup for a missing STELLAR_SERVER_SECRET; this
// mirrors the same non-fatal pattern used in config/contracts.ts for missing
// contract IDs. Skipped under jest so test suites can import freely.
const isTestEnv =
  process.env["NODE_ENV"] === "test" || process.env["JEST_WORKER_ID"] !== undefined;

if (!isTestEnv) {
  try {
    getServerKeypair();
  } catch (err) {
    console.warn(`[stellar] ${(err as Error).message}`);
  }
}

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
 * `amountStroops` is passed straight through to the contract: the caller
 * converts the naira the seller quoted exactly once with `toStroops()` from
 * packages/shared (issue #292), so no scale factor lives here and a
 * fractional/ambiguous amount cannot sneak in unnoticed.
 *
 * @returns The contract listing ID (stringified i128 sequence number)
 */
export async function createListing(params: {
  sellerPublicKey: string;
  sellerSecretKey: string;
  assetType: string;
  /** Listing amount in stroops (1 NGN = 1,000,000 stroops). */
  amountStroops: bigint;
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
    span.setAttribute("trade.amount_stroops", params.amountStroops.toString());

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
            nativeToScVal(params.amountStroops, { type: "i128" }),
            nativeToScVal(
              BigInt(Math.floor(params.expiresAt.getTime() / 1000)),
              { type: "u64" }
            )
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await prepareTransaction(tx);
      preparedTx.sign(keypair);

      const response = await sendTransaction(preparedTx);

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
 * Builds — but does not sign — the `deposit_to_escrow` transaction for a buyer.
 *
 * This is the first half of the client-side signing flow (Issue #342). The
 * server knows the contract, the listing and the amount; the buyer's browser
 * knows the key. Splitting build from submit means the secret key never leaves
 * the buyer's device and never appears in a request body.
 *
 * The returned XDR is already simulated and assembled by
 * `prepareTransaction`, so the client only has to sign it.
 *
 * `amountStroops` must be the listing amount in stroops. `trade_offers.amount`
 * is stored in naira (the platform ledger's unit), so the caller converts it
 * back with `toStroops()` from packages/shared before calling; the deposit then
 * matches the listing exactly (issue #292).
 *
 * @returns the unsigned transaction envelope (base64 XDR) plus the network
 *          passphrase the client must sign against
 */
export async function buildEscrowDepositXdr(params: {
  buyerPublicKey: string;
  listingId: string;
  amountStroops: bigint;
}): Promise<{ xdr: string; networkPassphrase: string }> {
  const contractAddress = ESCROW_CONTRACT_ID;
  if (!contractAddress) {
    throw new Error(
      "ESCROW_CONTRACT_ID is not set. Deploy the escrow contract or set the env variable."
    );
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.build_deposit_xdr", async (span: Span) => {
    span.setAttribute("soroban.contract_id", contractAddress);
    span.setAttribute("soroban.function", "deposit_to_escrow");
    span.setAttribute("trade.listing_id", params.listingId);
    span.setAttribute("trade.amount_stroops", params.amountStroops.toString());

    try {
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
            nativeToScVal(params.amountStroops, { type: "i128" })
          )
        )
        // Longer than the server-signed path: the clock is now running while a
        // human finds their key and the browser signs, not just while the
        // server round-trips.
        .setTimeout(180)
        .build();

      const preparedTx = await prepareTransaction(tx);

      return {
        xdr: preparedTx.toXDR(),
        networkPassphrase: NETWORK_PASSPHRASE,
      };
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
 * Submits a transaction the client already signed, and waits for it to confirm.
 *
 * `expectedSourceAccount` is checked before submission so a caller cannot use
 * their own session to push through a transaction signed for someone else's
 * account.
 *
 * @returns Transaction hash of the confirmed transaction
 */
export async function submitSignedTransaction(params: {
  signedXdr: string;
  expectedSourceAccount: string;
}): Promise<string> {
  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.submit_signed_tx", async (span: Span) => {
    try {
      let tx;
      try {
        tx = TransactionBuilder.fromXDR(params.signedXdr, NETWORK_PASSPHRASE);
      } catch {
        throw new Error("Signed transaction is not valid XDR for this network");
      }

      // Soroban invocations are never fee-bump envelopes, and a fee-bump wraps
      // an inner transaction whose source we have not checked — reject rather
      // than reason about it.
      if (!(tx instanceof Transaction)) {
        throw new Error("Fee-bump transactions are not accepted for escrow deposits");
      }

      if (tx.source !== params.expectedSourceAccount) {
        throw new Error("Signed transaction source account does not match the authenticated buyer");
      }

      if (!tx.signatures.length) {
        throw new Error("Transaction is not signed");
      }

      const response = await sendTransaction(tx);

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
 * SECURITY: The secret key is validated once at module load (see
 * getServerKeypair), used to sign the transaction, and the Keypair object
 * is not exported or logged anywhere.
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

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.release_payment", async (span: Span) => {
    span.setAttribute("soroban.contract_id", contractAddress);
    span.setAttribute("soroban.function", "release_payment");
    span.setAttribute("soroban.network", process.env["STELLAR_NETWORK"] ?? "testnet");
    span.setAttribute("trade.contract_trade_id", contractTradeId);

    try {
      // Cached keypair, resolved and validated once — never log this object
      const keypair = getServerKeypair();
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

      const preparedTx = await prepareTransaction(tx);
      preparedTx.sign(keypair);

      const response = await sendTransaction(preparedTx);

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

  // Cached keypair, resolved and validated once — never log this object
  const keypair = getServerKeypair();
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

  const preparedTx = await prepareTransaction(tx);
  preparedTx.sign(keypair);

  const response = await sendTransaction(preparedTx);

  if (response.status === "ERROR") {
    const parsed = parseContractError(response);
    throw parsed ?? new Error(
      `Contract resolve_dispute failed: ${JSON.stringify(response.errorResult)}`
    );
  }

  await pollForResult(response.hash);
  return response.hash;
}

// ---------------------------------------------------------------------------
// Escrow event processing (issues #638, #639)
// ---------------------------------------------------------------------------
// The escrow contract publishes a canonical `EscrowCreated` / `EscrowReleased`
// / `EscrowRefunded` / `EscrowDisputed` event for every state transition (see
// contracts/escrow/README.md#events-issue-639), each carrying
// `(escrow_id, actor, amount, timestamp)`. Indexers, audit tooling, and the
// backend oracle can subscribe to these events via Soroban RPC's `getEvents`
// instead of polling `get_trade` after every trade action. The helpers below
// fetch and parse them.

/** The four canonical escrow state-transition event topics (issue #639). */
export type EscrowEventTopic =
  | "EscrowCreated"
  | "EscrowReleased"
  | "EscrowRefunded"
  | "EscrowDisputed";

const ESCROW_EVENT_TOPICS: ReadonlySet<string> = new Set<EscrowEventTopic>([
  "EscrowCreated",
  "EscrowReleased",
  "EscrowRefunded",
  "EscrowDisputed",
]);

/** A parsed, typed escrow state-transition event (issue #639). */
export interface EscrowStateTransitionEvent {
  /** Which canonical state transition this event represents. */
  topic: EscrowEventTopic;
  /** On-chain trade ID (the escrow's `DataKey::Trade` key). */
  escrowId: string;
  /** Address that triggered (or is the recipient subject of) the transition. */
  actor: string;
  /** Amount, in stroops, associated with the transition. */
  amount: string;
  /** Contract-recorded ledger timestamp (unix seconds) of the transition. */
  timestamp: string;
  /** Soroban RPC ledger sequence the event was emitted in. */
  ledger: number;
  /** Hash of the transaction that triggered the event. */
  txHash: string;
  /** Opaque Soroban RPC pagination cursor for this individual event. */
  id: string;
}

/**
 * Parses a single raw Soroban RPC event into a typed
 * `EscrowStateTransitionEvent`, or returns `null` when the event isn't one of
 * the four canonical state-transition topics (issue #639) — e.g. it's one of
 * the contract's pre-existing short-form topics (`created`, `locked`, …), or
 * belongs to an unrelated invocation. `getEvents` returns every event a
 * contract emits, so callers always need this filter, not just a fetch.
 */
export function parseEscrowEvent(
  event: SorobanRpc.Api.EventResponse
): EscrowStateTransitionEvent | null {
  const topicScVal = event.topic[0];
  if (!topicScVal) {
    return null;
  }

  let topicName: string;
  try {
    topicName = scValToNative(topicScVal) as string;
  } catch {
    return null;
  }

  if (!ESCROW_EVENT_TOPICS.has(topicName)) {
    return null;
  }

  try {
    const [escrowId, actor, amount, timestamp] = scValToNative(event.value) as [
      bigint | number | string,
      string,
      bigint | number | string,
      bigint | number | string
    ];

    return {
      topic: topicName as EscrowEventTopic,
      escrowId: String(escrowId),
      actor: String(actor),
      amount: String(amount),
      timestamp: String(timestamp),
      ledger: event.ledger,
      txHash: event.txHash,
      id: event.id,
    };
  } catch {
    // Malformed/unexpected value shape — skip rather than throw, so one bad
    // event doesn't take down an entire batch for an indexer/poller.
    return null;
  }
}

/** Events requested per `getEvents` page (also the RPC's default limit). */
const ESCROW_EVENT_PAGE_SIZE = 100;

/**
 * Upper bound on the ledgers a single `getEvents` call scans. A response can
 * therefore stop short of `latestLedger`, so the subscription below never
 * advances its position by more than this per poll.
 */
const ESCROW_EVENT_MAX_SCAN_LEDGERS = 10_000;

/** RPC-side topic filter: the canonical events have exactly one topic each. */
function escrowTopicFilter(): string[][] {
  return [...ESCROW_EVENT_TOPICS].map((topic) => [
    nativeToScVal(topic, { type: "symbol" }).toXDR("base64"),
  ]);
}

interface EscrowEventScan {
  events: EscrowStateTransitionEvent[];
  /** Latest ledger known to the RPC when the scan began. */
  latestLedger: number;
}

/** Reads every page of canonical escrow events from `startLedger` onward. */
async function scanEscrowEvents(startLedger: number): Promise<EscrowEventScan> {
  const contractAddress = ESCROW_CONTRACT_ID;
  if (!contractAddress) {
    throw new Error(
      "ESCROW_CONTRACT_ID is not set. Deploy the escrow contract or set the env variable."
    );
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("soroban.fetch_escrow_events", async (span: Span) => {
    span.setAttribute("soroban.contract_id", contractAddress);
    span.setAttribute("soroban.start_ledger", startLedger);

    try {
      const filters: SorobanRpc.Api.EventFilter[] = [
        {
          type: "contract",
          contractIds: [contractAddress],
          topics: escrowTopicFilter(),
        },
      ];

      const events: EscrowStateTransitionEvent[] = [];
      let latestLedger: number | undefined;
      let cursor: string | undefined;

      for (;;) {
        // The RPC accepts either a start ledger or a cursor, never both.
        const page = await sorobanServer.getEvents({
          ...(cursor ? { cursor } : { startLedger }),
          filters,
          limit: ESCROW_EVENT_PAGE_SIZE,
        });
        latestLedger ??= page.latestLedger;

        for (const rawEvent of page.events) {
          const parsed = parseEscrowEvent(rawEvent);
          if (parsed) {
            events.push(parsed);
          }
        }

        const last = page.events[page.events.length - 1];
        if (!last || page.events.length < ESCROW_EVENT_PAGE_SIZE) {
          break;
        }
        cursor = last.id;
      }

      span.setAttribute("soroban.events_found", events.length);
      return { events, latestLedger };
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
 * Fetches and parses the canonical escrow state-transition events (issues
 * #638, #639) emitted by the escrow contract from `startLedger` onward
 * (inclusive), following pagination.
 *
 * One-shot helper for backfills and audits. To follow events continuously use
 * `subscribeToEscrowEvents`, which tracks its own position.
 *
 * @param startLedger first ledger sequence (inclusive) to scan for events.
 */
export async function fetchEscrowEvents(
  startLedger: number
): Promise<EscrowStateTransitionEvent[]> {
  const { events } = await scanEscrowEvents(startLedger);
  return events;
}

export interface EscrowEventSubscriptionOptions {
  /**
   * Called once per event, in ledger order. If it rejects, the event is not
   * considered delivered and is retried on the next poll, so handlers must be
   * idempotent (at-least-once delivery).
   */
  onEvent: (event: EscrowStateTransitionEvent) => Promise<void> | void;
  /** First ledger to read (inclusive). Defaults to the current latest ledger. */
  startLedger?: number;
  /** Delay between polls. Defaults to 5s, roughly one ledger. */
  intervalMs?: number;
  /** Called when a poll or handler fails; the subscription keeps running. */
  onError?: (err: Error) => void;
}

export interface EscrowEventSubscription {
  /** Stops polling. An in-flight handler finishes; no further events follow. */
  stop(): void;
}

/**
 * Subscribes to the escrow contract's state-transition events (issue #638).
 *
 * Soroban RPC has no push transport, so this polls `getEvents`. The position
 * is kept as a ledger plus the last delivered event id: the boundary ledger is
 * re-read on the next poll and already delivered ids are skipped, so no event
 * is missed or repeated across polls.
 */
export function subscribeToEscrowEvents(
  options: EscrowEventSubscriptionOptions
): EscrowEventSubscription {
  const intervalMs = options.intervalMs ?? 5_000;
  let nextLedger = options.startLedger;
  let lastEventId: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function poll(): Promise<void> {
    if (nextLedger === undefined) {
      nextLedger = (await sorobanServer.getLatestLedger()).sequence;
    }

    const scanStart = nextLedger;
    const { events, latestLedger } = await scanEscrowEvents(scanStart);

    for (const event of events) {
      if (stopped) return;
      // Event ids are fixed-width and zero-padded, so they sort as strings.
      if (lastEventId !== undefined && event.id <= lastEventId) continue;
      await options.onEvent(event);
      lastEventId = event.id;
      nextLedger = event.ledger;
    }

    nextLedger = Math.max(
      nextLedger,
      Math.min(latestLedger, scanStart + ESCROW_EVENT_MAX_SCAN_LEDGERS)
    );
  }

  async function run(): Promise<void> {
    try {
      await poll();
    } catch (err) {
      options.onError?.(err as Error);
    }
    if (!stopped) {
      timer = setTimeout(() => void run(), intervalMs);
      timer.unref();
    }
  }

  void run();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Default processing for an escrow event: one structured log line.
 *
 * Trade status in Postgres is owned by the API and delivery-oracle flows, so
 * events are recorded for audit and reconciliation rather than used to
 * overwrite it. Disputes are logged at warn level because they need a human.
 */
export function processEscrowEvent(event: EscrowStateTransitionEvent): void {
  const context = {
    topic: event.topic,
    escrowId: event.escrowId,
    actor: event.actor,
    amountStroops: event.amount,
    timestamp: event.timestamp,
    ledger: event.ledger,
    txHash: event.txHash,
    eventId: event.id,
  };
  if (event.topic === "EscrowDisputed") {
    logger.warn(context, "[escrow-events] Escrow disputed on-chain");
  } else {
    logger.info(context, `[escrow-events] ${event.topic}`);
  }
}

/**
 * Starts the escrow event subscription when ESCROW_EVENTS_ENABLED=true.
 * Returns null when it is disabled or no escrow contract is configured.
 */
export function startEscrowEventSubscription(): EscrowEventSubscription | null {
  if (process.env["ESCROW_EVENTS_ENABLED"] !== "true") return null;
  if (!ESCROW_CONTRACT_ID) {
    logger.warn("[escrow-events] ESCROW_CONTRACT_ID is not set; subscription not started");
    return null;
  }
  logger.info({ contractId: ESCROW_CONTRACT_ID }, "[escrow-events] Subscription started");
  return subscribeToEscrowEvents({
    onEvent: processEscrowEvent,
    onError: (err) => logger.error({ err: err.message }, "[escrow-events] Poll failed"),
  });
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
        const result = await getTransaction(hash);

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
