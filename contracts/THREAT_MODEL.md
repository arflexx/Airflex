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

---

### 6. Marketplace Authorization Replay Attacks

* **Threat Vector**: A signed off-chain purchase authorization (for example a seller- or platform-issued voucher permitting a buyer to purchase a listing at a given price) is captured by an attacker or reused by the buyer, then replayed — against the same listing, against a *different* listing, or after the original listing has been cancelled — to force a second payment release or to hijack a listing the authorization was never meant for.
* **Attack Scenario**: A buyer legitimately authorizes a purchase of listing A with nonce `N`. The signature is observed (mempool, a compromised relayer, or a shared co-signer). The attacker resubmits the same signed authorization, either against listing A again (if it was refunded and re-listed) or against a different listing B, expecting the contract to honour it a second time.
* **Likelihood**: Medium — requires access to a captured authorization, but no special on-chain privileges.
* **Impact**: High — double-spend of a single authorization, unintended purchases, and loss of the one-time guarantee buyers and sellers rely on for off-chain co-signed trades.
* **Mitigation**:
  * **`deposit_to_escrow`** relies on Soroban's native `buyer.require_auth()`, which binds the buyer's signature to the exact invocation (contract id, function, and *all arguments*, including `listing_id`). The same authorization therefore cannot be replayed against a different listing — the arguments differ and the host rejects the signature.
  * **`purchase_with_auth(env, buyer, listing_id, auth_nonce)`** adds explicit, defense-in-depth replay protection for the off-chain-signed authorization flow: every call requires a strictly-increasing per-buyer `auth_nonce` (stored under `DataKey::BuyerNonce`). Because the nonce is part of the signed arguments, the authorization is single-use — replaying it is rejected with `ContractError::InvalidNonce` *before any funds move*. This also defeats replay *after* a listing is cancelled, since the consumed nonce can never be reused regardless of listing state.
  * The nonce is only consumed on a successful settlement, so a transient failure (e.g. an expired listing) does not burn the buyer's next valid nonce.
  * Verified by `test_replay_of_used_authorization_rejected` in `contracts/marketplace/src/lib.rs`.

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

