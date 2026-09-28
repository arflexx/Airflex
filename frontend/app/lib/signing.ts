/**
 * signing.ts — client-side Stellar transaction signing (Issue #342).
 *
 * The server builds and simulates the escrow deposit; this module signs it in
 * the browser and hands back only the signed envelope. The secret key is read
 * from the in-memory session store and is never passed out of this module.
 */
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { getSessionKey, hasSessionKey, setSessionKey } from "./stellarSession";

/** Thrown when there is no key in session and the user must re-authenticate. */
export class SessionKeyMissingError extends Error {
  constructor() {
    super("No signing key in session");
    this.name = "SessionKeyMissingError";
  }
}

/** Thrown when the envelope does not belong to the session's account. */
export class AccountMismatchError extends Error {
  constructor() {
    super("Transaction was built for a different account");
    this.name = "AccountMismatchError";
  }
}

/**
 * Signs an unsigned transaction envelope with the session key.
 *
 * The source account is checked against the session's public key before
 * signing, so a tampered or stale `prepare` response cannot get the user to
 * sign a transaction that moves someone else's funds.
 *
 * @returns the signed envelope as base64 XDR, ready to POST back
 * @throws {SessionKeyMissingError} when the session holds no key
 * @throws {AccountMismatchError} when the envelope's source is not the user
 */
export function signTransactionXdr(params: {
  xdr: string;
  networkPassphrase: string;
}): string {
  const session = getSessionKey();
  if (!session) throw new SessionKeyMissingError();

  const transaction = TransactionBuilder.fromXDR(params.xdr, params.networkPassphrase);

  // A fee-bump envelope hides its real operations one level down; never sign
  // one here.
  if (!(transaction instanceof Transaction)) {
    throw new AccountMismatchError();
  }

  if (transaction.source !== session.publicKey) {
    throw new AccountMismatchError();
  }

  transaction.sign(Keypair.fromSecret(session.secretKey));
  return transaction.toXDR();
}

/** Thrown when the wallet could not be unlocked for this session. */
export class UnlockFailedError extends Error {
  constructor(public readonly status: number) {
    super(`Wallet unlock failed (${status})`);
    this.name = "UnlockFailedError";
  }
}

/**
 * Makes sure the session holds a signing key, fetching it once if it does not.
 *
 * The key lives in memory only, so it is gone after a reload or in a new tab —
 * this is what refills it, lazily, the first time something actually needs to
 * sign. Callers should treat a 401 as "send the user back through
 * authentication".
 *
 * @throws {UnlockFailedError} when the server refuses to release the key
 */
export async function ensureSessionKey(apiUrl: string, token: string): Promise<void> {
  if (hasSessionKey()) return;

  const res = await fetch(`${apiUrl}/api/v1/wallet/unlock`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new UnlockFailedError(res.status);

  const body = (await res.json()) as {
    data?: { publicKey: string; secretKey: string };
  };

  if (!body.data?.secretKey || !body.data.publicKey) {
    throw new UnlockFailedError(res.status);
  }

  setSessionKey({
    secretKey: body.data.secretKey,
    publicKey: body.data.publicKey,
  });
}
