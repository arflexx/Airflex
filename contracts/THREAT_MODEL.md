# AirFlex Smart Contracts Threat Model

This document outlines the threat modeling analysis for AirFlex Soroban smart contracts, detailing the top 5 attack vectors and the specific mitigations implemented to secure user funds on mainnet.

---

## Top 5 Attack Vectors & Mitigations

### 1. Unauthorized Dispute Resolution or Admin Takeover
* **Threat Vector**: An attacker attempts to forge admin credentials or exploit missing authorization checks on `resolve_dispute`, `pause`, or token whitelist modification functions to steal escrowed funds or lock the marketplace.
* **Impact**: Critical — Loss of funds across all open escrows.
* **Mitigation**:
  * Strict authentication using Soroban's `admin.require_auth()` checks on all privileged operations.
  * Multi-signature requirement for administrative keys on mainnet deployment.
  * Separation of admin concerns between Escrow governance and Marketplace operations.

---

### 2. Double-Spending & Reentrancy via Custom SAC Tokens
* **Threat Vector**: An attacker uses a custom Soroban token contract with callbacks to re-enter `release_payment` or `cancel_and_refund` before contract state is updated, leading to double withdrawals.
* **Impact**: High — Draining contract balances.
* **Mitigation**:
  * **Checks-Effects-Interactions Pattern**: Contract state is set to `Completed` or `Cancelled` *before* invoking external token transfer calls.
  * **Token Whitelisting**: Only vetted asset contracts approved via `add_allowed_token` can be used for trade escrow.
  * **Reentrancy Guard (issue #507)**: The marketplace `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, and `resolve_dispute` functions set a boolean flag in Soroban **temporary storage** (`DataKey::Reentrancy`) at function entry. Any reentrant call that arrives while the flag is `true` returns `ContractError::ReentrancyDetected` (discriminant `18`) immediately, before any state is read or modified. Temporary storage is scoped to the current transaction and zeroed when the transaction ends, so the flag never persists across ledger boundaries and cannot block future legitimate calls. The guard is cleared explicitly on both the success path and every early error return to minimise the window and make the cleanup auditable. See `contracts/ERROR_CODES.md` for the full entry on `ReentrancyDetected`.

---

### 3. Front-Running & Order Sniping on `deposit_to_escrow`
* **Threat Vector**: A malicious bot monitors mempool transactions for high-value listings and front-runs legitimate buyers to lock the listing, blocking legitimate users or forcing ransom negotiations.
* **Impact**: Medium — Denial of service and poor market liquidity.
* **Mitigation**:
  * Explicit `buyer` specification and atomic listing assignment upon deposit initiation.
  * Expiry timestamps on pending deposits so uncompleted locks automatically release back to the open market after a short window.

---

### 4. Flash Loan & Volume Manipulation / Fake Reputation Inflation
* **Threat Vector**: Sybil accounts create rapid cyclic trades with zero-fee structures to artificially inflate seller reputation scores (`get_reputation`) and entice victim buyers into fraudulent transactions.
* **Impact**: Medium — Social engineering / fraud against marketplace users.
* **Mitigation**:
  * Mandatory verification thresholds and backend velocity rate limiting on trade creation.
  * Minimum transaction size constraints and reputation weighting based on successful non-self trade completions.

---

### 5. Soroban Storage Entry Expiry / State Archival Attack
* **Threat Vector**: An attacker deliberately delays trade resolution so that persistent storage entries (`DataKey::Trade`) hit their TTL limit and become archived by the Stellar network, making escrow state unreadable.
* **Impact**: High — Funds trapped in contract instance without active state record.
* **Mitigation**:
  * Automated TTL extension (bumping persistent storage entries) on every interaction with a trade listing.
  * Emergency admin recovery mechanism to restore state from on-chain event logs if archival occurs.

---

### 6. Dispute Spam / Griefing via Repeated `flag_dispute` Calls (Mitigated — Issue #642)
* **Threat Vector**: Either trading party calls `flag_dispute` repeatedly on the same trade — re-flagging immediately after the first call — to spam the dispute path, exhaust the counterparty's ability to respond in time, or game the timing of admin dispute resolution.
* **Impact**: Medium — Griefing / denial-of-service against the counterparty and the admin resolution queue. No direct fund loss, but it degrades trust in the dispute mechanism and can be used to pressure a counterparty.
* **Mitigation**:
  * A per-trade `dispute_cooldown_seconds` window (default `3600`, set once at `initialize`) gates every `flag_dispute` call, tracked via a `DataKey::LastDisputeAt(trade_id)` ledger timestamp.
  * A repeat call inside the cooldown window reverts with `ContractError::DisputeCooldownActive` (error code `18`, see [ERROR_CODES.md](./ERROR_CODES.md)) instead of silently succeeding or re-emitting dispute events.
  * Once the cooldown has elapsed, a further call is accepted as a legitimate re-escalation (bumping the last-flagged timestamp) rather than being rejected outright, so a dispute that is still genuinely unresolved isn't permanently stuck.

---

### 7. Secret Key Transmitted in Trade Request Body (Resolved — Issue #245)
* **Threat Vector**: The original `POST /api/v1/trades/:id/buy` endpoint accepted a `buyerSecretKey` field in the JSON body and forwarded it to `depositToEscrow`. The key appeared in access logs, was visible to any process with HTTP-body access, and gave the server full, unaudited control over the buyer's funds.
* **Impact**: Critical — Full compromise of every buyer's Stellar wallet from a single log-file leak. Any platform operator with log access could drain all buyer accounts.
* **Mitigation (implemented)**:
  * `buyerSecretKey` is removed from the request schema entirely. The Zod schema (`buyTradeSchema`) now accepts only `{ signedXdr: string }` — the server never receives secret key material in a trade request.
  * Transaction signing is moved client-side. The `/buy/prepare` endpoint returns an unsigned XDR envelope; the browser signs it in memory (using the short-lived key from `/wallet/unlock`); only the signed envelope is submitted.
  * The server calls `submitSignedTransaction({ signedXdr, expectedSourceAccount })`, which verifies the envelope's source account before submission — it cannot be replayed for a different buyer.
  * See [docs/security.md](../../docs/security.md#stellar-key-handling--client-side-signing-model) for the full model description.

* **Threat Vector**: A zero-day defect or irrecoverable logic deadlock permanently breaks settlement workflows (`release_payment`, `cancel_and_refund`, `resolve_dispute`), locking protocol assets permanently inside contract balances with no standard path for user withdrawal.
* **Impact**: Critical — Permanent loss of trapped protocol liquidity and user deposits.
* **Mitigation**:
  * **Emergency Withdrawal Function**: Both Escrow and Marketplace contracts provide an `emergency_withdraw(env, token, recipient, amount)` function designed specifically to extract trapped assets during catastrophic protocol failure.
  * **Strict Role Authorization**: Execution requires explicit caller authentication by the configured protocol administrator via `admin.require_auth()`.
  * **Enforced Circuit Breaker**: The function is strictly gated behind the paused contract state (`DataKey::Paused == true`) with `ContractError::WrongStatus` returned if executed while active.
  * **72-Hour Anti-Rugpull Timelock**: To prevent compromised admin keys or insider attacks from draining user funds unilaterally, a mandatory 72-hour delay (`EMERGENCY_TIMELOCK_SECS = 259_200`) is enforced between `pause` invocation and `emergency_withdraw` eligibility. Attempted withdrawals before timelock expiry revert with `ContractError::TimelockNotExpired`.
  * **Transparent Observability**: Every execution emits a high-severity `emergency_withdrawal` event with full payload telemetry (`token`, `recipient`, `amount`), providing on-chain visibility and alerting capabilities for the community and protocol monitors.

