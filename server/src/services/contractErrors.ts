/**
 * contractErrors.ts
 *
 * Typed TypeScript error classes that mirror the on-chain `ContractError` enum
 * defined in both Soroban contracts (escrow and marketplace).
 *
 * Discriminant values MUST match the Rust enum exactly. See
 * `contracts/ERROR_CODES.md` for the canonical reference table.
 *
 * Usage:
 *   import { parseContractError, TradeNotFoundError } from "./contractErrors";
 *
 *   const parsed = parseContractError(err);
 *   if (parsed instanceof TradeNotFoundError) { ... }
 */

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Base class for all Soroban contract errors.
 * Carries the numeric discriminant so callers can switch on `err.code`.
 */
export class ContractError extends Error {
  constructor(
    message: string,
    public readonly code: number
  ) {
    super(message);
    this.name = "ContractError";
    // Maintains correct prototype chain in transpiled ES5 environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Typed subclasses — one per ContractError variant
// ---------------------------------------------------------------------------

/** Code 1 — `initialize` called on an already-initialised contract. */
export class AlreadyInitializedError extends ContractError {
  constructor() {
    super("Contract has already been initialized", 1);
    this.name = "AlreadyInitializedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 2 — Caller is not the admin or authorised party. */
export class UnauthorizedContractError extends ContractError {
  constructor() {
    super("Caller is not authorized to perform this action", 2);
    this.name = "UnauthorizedContractError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 3 — No trade or listing exists for the given ID. */
export class TradeNotFoundError extends ContractError {
  constructor() {
    super("Trade or listing not found", 3);
    this.name = "TradeNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 4 — Trade or listing is in a state that disallows the action. */
export class WrongStatusError extends ContractError {
  constructor() {
    super("Trade or listing is in an invalid state for this operation", 4);
    this.name = "WrongStatusError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 5 — Trade or listing expiry timestamp has passed. */
export class TradeExpiredError extends ContractError {
  constructor() {
    super("Trade or listing has expired", 5);
    this.name = "TradeExpiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 6 — Fill or price amount exceeds available balance. */
export class InsufficientFundsError extends ContractError {
  constructor() {
    super("Fill amount exceeds the available amount in this trade", 6);
    this.name = "InsufficientFundsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 7 — Supplied `expires_at` is in the past or zero. */
export class InvalidExpiryError extends ContractError {
  constructor() {
    super("Expiry timestamp must be in the future", 7);
    this.name = "InvalidExpiryError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 8 — Dispute flag set on a trade already in Disputed status. */
export class AlreadyDisputedError extends ContractError {
  constructor() {
    super("This trade is already marked as disputed", 8);
    this.name = "AlreadyDisputedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 9 — State-mutating call made while circuit-breaker is active. */
export class ContractPausedError extends ContractError {
  constructor() {
    super("Contract is currently paused; no state mutations are allowed", 9);
    this.name = "ContractPausedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 10 — Buyer cancel attempted before the timelock window elapses. */
export class TimelockNotExpiredError extends ContractError {
  constructor() {
    super("The timelock period has not yet elapsed; cancellation is not available", 10);
    this.name = "TimelockNotExpiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 11 — Token address is not in the allowed-token list. */
export class UnsupportedTokenError extends ContractError {
  constructor() {
    super("The specified token is not supported by this contract", 11);
    this.name = "UnsupportedTokenError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 12 — Amount or fill amount is zero or negative. */
export class InvalidAmountError extends ContractError {
  constructor() {
    super("Amount must be a positive integer", 12);
    this.name = "InvalidAmountError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 13 — Sub-escrow fill has already been released or refunded. */
export class FillAlreadyProcessedError extends ContractError {
  constructor() {
    super("This escrow fill has already been released or refunded", 13);
    this.name = "FillAlreadyProcessedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Code 14 — Caller is neither seller nor a buyer of the trade. */
export class NotAPartyError extends ContractError {
  constructor() {
    super("Caller is not a party to this trade", 14);
    this.name = "NotAPartyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Maps numeric error code → zero-argument constructor. */
const ERROR_REGISTRY = new Map<number, new () => ContractError>([
  [1,  AlreadyInitializedError],
  [2,  UnauthorizedContractError],
  [3,  TradeNotFoundError],
  [4,  WrongStatusError],
  [5,  TradeExpiredError],
  [6,  InsufficientFundsError],
  [7,  InvalidExpiryError],
  [8,  AlreadyDisputedError],
  [9,  ContractPausedError],
  [10, TimelockNotExpiredError],
  [11, UnsupportedTokenError],
  [12, InvalidAmountError],
  [13, FillAlreadyProcessedError],
  [14, NotAPartyError],
]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a typed `ContractError` from an unknown error value.
 *
 * Extraction strategy (first match wins):
 *   1. XDR `errorResult` structure from the Stellar SDK `SendTransactionResponse`
 *      when `response.status === "ERROR"`.
 *   2. Pattern match on the error message string for `"Error(Contract, #N)"`,
 *      which Soroban SDK includes in some stringified error outputs.
 *
 * Returns `null` when the error is not a recognisable contract error
 * (e.g. network failure, auth error, fee error). Callers MUST re-throw the
 * original error when `null` is returned — never swallow it.
 *
 * This function never throws — all internal exceptions are caught and cause
 * the function to fall through to the next strategy.
 */
export function parseContractError(err: unknown): ContractError | null {
  // ------------------------------------------------------------------
  // Strategy 1: XDR errorResult on the Stellar SDK response object
  // ------------------------------------------------------------------
  try {
    // The Stellar SDK SendTransactionResponse shape when status === "ERROR"
    // has `errorResult` as an xdr.TransactionResult. We stringify it and
    // look for the contract error code pattern in the output, since XDR
    // traversal APIs vary across SDK versions.
    if (err !== null && typeof err === "object") {
      const candidate = err as Record<string, unknown>;

      // Direct errorResult on the response (status === "ERROR" path)
      if (candidate["errorResult"] !== undefined) {
        const code = extractCodeFromXdrResult(candidate["errorResult"]);
        if (code !== null) {
          return instantiate(code);
        }
      }

      // Error wrapping a response object (thrown after pollForResult FAILED)
      if (candidate["response"] !== undefined) {
        const resp = candidate["response"] as Record<string, unknown>;
        if (resp["errorResult"] !== undefined) {
          const code = extractCodeFromXdrResult(resp["errorResult"]);
          if (code !== null) {
            return instantiate(code);
          }
        }
      }
    }
  } catch {
    // fall through to string strategy
  }

  // ------------------------------------------------------------------
  // Strategy 2: Pattern match on the error message string
  // Soroban SDK sometimes includes "Error(Contract, #N)" in messages.
  // ------------------------------------------------------------------
  try {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
        ? err
        : JSON.stringify(err);

    const code = extractCodeFromString(message);
    if (code !== null) {
      return instantiate(code);
    }
  } catch {
    // fall through
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a contract error code from an XDR object by
 * stringifying it and applying the same regex as strategy 2.
 * Returns null if the object does not contain a contract error code.
 */
function extractCodeFromXdrResult(xdrResult: unknown): number | null {
  try {
    const str =
      typeof xdrResult === "string"
        ? xdrResult
        : JSON.stringify(xdrResult);
    return extractCodeFromString(str);
  } catch {
    return null;
  }
}

/**
 * Scans a string for the Soroban error pattern `Error(Contract, #N)` or
 * `ContractError(N)` and returns the integer N.
 * Returns null when no match is found.
 */
function extractCodeFromString(str: string): number | null {
  // "Error(Contract, #3)" — standard Soroban SDK stringification
  const sorobanMatch = /Error\(Contract,\s*#(\d+)\)/i.exec(str);
  if (sorobanMatch?.[1] !== undefined) {
    return parseInt(sorobanMatch[1], 10);
  }

  // "ContractError(3)" — alternative format in some SDK versions
  const altMatch = /ContractError\((\d+)\)/i.exec(str);
  if (altMatch?.[1] !== undefined) {
    return parseInt(altMatch[1], 10);
  }

  return null;
}

/**
 * Looks up the registry for the given code and returns a new instance,
 * or a generic `ContractError` with the unknown code if not found.
 */
function instantiate(code: number): ContractError {
  const Ctor = ERROR_REGISTRY.get(code);
  if (Ctor !== undefined) {
    return new Ctor();
  }
  // Unknown code — return a generic ContractError so callers still get a typed object
  return new ContractError(`Unknown contract error (code ${code})`, code);
}
