# AirFlex Marketplace Smart Contract

Soroban smart contract for peer-to-peer listing creation, escrow settlement, and on-chain seller reputation scoring on the Stellar Network.

---

## Deployed Addresses

| Network | Contract ID | Explorer |
|---|---|---|
| **Stellar Testnet** | _Pending Deployment_ | — |
| **Stellar Mainnet** | _Pending Production Release_ | — |

* **Network Passphrase (Testnet)**: `Test SDF Network ; September 2015`
* **Soroban SDK Version**: `soroban-sdk v22.0.11`
* **Rust Toolchain Target**: `wasm32v1-none`

---

## Contract Functions & Formal Invariants

### 1. `initialize(env: Env, admin: Address) -> Result<(), ContractError>`
* **Purpose**: Configures the initial contract administrator and zeroes out total listing counters.
* **Pre-conditions**:
  - Contract has not been previously initialized.
  - `admin` address must be valid.
* **Post-conditions**:
  - `DataKey::Admin` stores `admin`.
  - `DataKey::ListingCounter` initialized to 0.

### 2. `create_listing(env: Env, seller: Address, token: Address, price: i128, asset_category: Symbol, asset_type: Symbol, quantity: i128, expires_at: u64) -> Result<u64, ContractError>`
* **Purpose**: Allows a seller to create a new airtime or data trade listing on the marketplace.
* **Pre-conditions**:
  - Contract must not be paused.
  - `seller` must authenticate transaction (`seller.require_auth()`).
  - `price > 0` and `quantity > 0`.
  - Seller must not exceed the active listing cap (`ACTIVE_LISTING_CAP = 100`).
  - `expires_at > ledger.timestamp()` and `<= ledger.timestamp() + MAX_EXPIRY_SECS`.
* **Post-conditions**:
  - Increments active listing count for seller.
  - Stores `Listing` under `DataKey::Listing(listing_id)` with `ListingStatus::Active`.
  - Emits `listing_created` event and returns new listing ID.

### 3. `deposit_to_escrow(env: Env, buyer: Address, listing_id: u64) -> Result<(), ContractError>`
* **Purpose**: Locks buyer payment tokens in the contract against a specific active listing.
* **Pre-conditions**:
  - Contract must not be paused.
  - `buyer` must authenticate (`buyer.require_auth()`).
  - Caller cannot be the seller (`buyer != listing.seller`).
  - Listing must have status `ListingStatus::Active` and not be expired.
  - Buyer must possess sufficient balance of `listing.token`.
* **Post-conditions**:
  - Transfers `listing.price` tokens from `buyer` to the contract.
  - Listing status transitions to `ListingStatus::Sold` (locked in escrow).
  - Decrements seller's active listing count.
  - Emits `escrow_deposited` event.

### 4. `release_payment(env: Env, listing_id: u64) -> Result<(), ContractError>`
* **Purpose**: Admin/Oracle confirmation of telco fulfillment. Disburses payment tokens to the seller and increments on-chain reputation.
* **Pre-conditions**:
  - Contract must not be paused.
  - Caller must be the designated admin (`admin.require_auth()`).
  - Listing must be in `ListingStatus::Sold` state.
* **Post-conditions**:
  - Transfers `listing.price` tokens from contract to `listing.seller`.
  - Listing status transitions to `ListingStatus::Completed`.
  - Seller reputation score updated: `completed_trades += 1` and `total_volume += listing.price`.
  - Emits `payment_released` event.

### 5. `cancel_and_refund(env: Env, buyer: Address, listing_id: u64) -> Result<(), ContractError>`
* **Purpose**: Refunds the buyer if the seller fails to deliver airtime/data within the service window.
* **Pre-conditions**:
  - Contract must not be paused.
  - Caller must be either `admin` or the `listing.buyer` (after trade expiry).
  - Listing must be in `ListingStatus::Sold` or `Disputed` state.
* **Post-conditions**:
  - Transfers `listing.price` tokens from contract back to `buyer`.
  - Listing status transitions to `ListingStatus::Cancelled`.
  - Increments seller's `disputed_trades` metric in reputation ledger.
  - Emits `listing_cancelled` event.

### 6. `cancel_listing(env: Env, seller: Address, listing_id: u64) -> Result<(), ContractError>`
* **Purpose**: Allows a seller to cancel an open listing before any buyer commits funds.
* **Pre-conditions**:
  - Contract must not be paused.
  - `seller` must authenticate and match `listing.seller`.
  - Listing status must be `ListingStatus::Active`.
* **Post-conditions**:
  - Listing status transitions to `ListingStatus::Cancelled`.
  - Decrements seller's active listing count.
  - Emits `listing_cancelled` event.

### 7. `update_listing(env: Env, seller: Address, listing_id: u64, new_price: i128, new_quantity: i128) -> Result<(), ContractError>`
* **Purpose**: Modifies price or quantity of an unsold listing.
* **Pre-conditions**:
  - Contract must not be paused.
  - `seller` must authenticate (`seller.require_auth()`).
  - Listing must be in `ListingStatus::Active` status.
  - `new_price > 0` and `new_quantity > 0`.
* **Post-conditions**:
  - Updates listing attributes on-chain.
  - Emits `listing_updated` event.

### 8. `resolve_dispute(env: Env, listing_id: u64, recipient: Address) -> Result<(), ContractError>`
* **Purpose**: Admin arbitration resolving a contested transaction.
* **Pre-conditions**:
  - Caller must be `admin`.
  - `recipient` must be either `listing.buyer` or `listing.seller`.
* **Post-conditions**:
  - Transfers funds to `recipient`.
  - Updates listing status to `Completed` (if seller) or `Cancelled` (if buyer).
  - Emits `dispute_resolved` event.

### 9. Read-Only Query Functions
* **`get_listing(env: Env, listing_id: u64) -> Result<Listing, ContractError>`**: Returns full listing struct.
* **`get_reputation(env: Env, user: Address) -> Reputation`**: Returns seller score `{ completed_trades, disputed_trades, total_volume }`.
* **`get_active_listing_count(env: Env, seller: Address) -> u32`**: Returns currently open listing count for a seller.
* **`listing_count(env: Env) -> u64`**: Total lifetime listings created.
* **`is_paused(env: Env) -> bool`**: Returns circuit breaker status.
