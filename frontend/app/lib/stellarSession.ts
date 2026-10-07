/**
 * stellarSession.ts — in-memory, session-scoped custody of the buyer's
 * Stellar secret key (Issue #342).
 *
 * The buy flow used to collect the secret key in a plaintext `<input>` and POST
 * it to the backend. That put the key in the DOM, in the browser's form
 * autocomplete, in devtools' network tab, and in the server's request logs.
 *
 * The replacement holds the key in a module-scoped variable and nowhere else:
 *
 *   - never `localStorage` or `sessionStorage` — both survive the tab and are
 *     readable by any script that lands on the origin
 *   - never a form field, so it cannot be autocompleted, autofilled, or
 *     serialized by a stray `new FormData(form)`
 *   - never a URL or query parameter, so it cannot reach history or a Referer
 *     header
 *
 * The practical consequence is that the key is gone on reload, on a new tab,
 * and on sign-out. That is the intended lifetime: callers that find the store
 * empty must send the user back through authentication rather than persisting
 * the key to survive a refresh.
 */

let secretKey: string | null = null;
let publicKey: string | null = null;

/**
 * Puts the key in the session store. Call this from the authentication flow
 * only — never from a form submit handler.
 */
export function setSessionKey(params: { secretKey: string; publicKey: string }): void {
  secretKey = params.secretKey;
  publicKey = params.publicKey;
}

/** The key for this session, or null when the user must re-authenticate. */
export function getSessionKey(): { secretKey: string; publicKey: string } | null {
  if (!secretKey || !publicKey) return null;
  return { secretKey, publicKey };
}

/** True when a key is held for this session. */
export function hasSessionKey(): boolean {
  return secretKey !== null;
}

/** Drops the key. Call on sign-out, and after any signing failure. */
export function clearSessionKey(): void {
  secretKey = null;
  publicKey = null;
}
