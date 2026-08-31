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
