# AirFlex Escrow Smart Contract

Soroban smart contract that securely holds buyer payment tokens (USDC/NGNC) in multi-buyer partial or full escrow until off-chain airtime/data delivery is cryptographically verified by the AirFlex oracle service.

---

## Deployed Addresses

| Network | Contract ID | Explorer |
|---|---|---|
| **Stellar Testnet** | `CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP` | [View on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP) |
| **Stellar Mainnet** | _Pending Production Release_ | — |

* **Network Passphrase (Testnet)**: `Test SDF Network ; September 2015`
* **Soroban SDK Version**: `soroban-sdk v22.0.11`
* **Rust Toolchain Target**: `wasm32v1-none`

---

## Contract Function Reference & Formal Invariants

### 1. `initialize(env: Env, admin: Address) -> Result<(), ContractError>`
* **Purpose**: Initializes contract state, sets the administrative authority, enables default allowed asset categories (`AIRTIME`, `DATA`), and initializes trade counter.
* **Pre-conditions**:
  - Contract has not been previously initialized (`DataKey::Admin` does not exist).
  - `admin` address must be a valid account or contract address.
* **Post-conditions**:
  - `DataKey::Admin` stores `admin`.
  - `DataKey::TradeCounter` initialized to 0.
  - Default categories `AIRTIME` and `DATA` are whitelisted.

### 2. `create_listing(env: Env, seller: Address, token: Address, total_amount: i128, asset_type: Symbol, expires_at: u64) -> Result<u64, ContractError>`
* **Purpose**: Called by a verified seller to publish an airtime or data trade offer on-chain.
* **Pre-conditions**:
  - Contract must not be paused.
  - `seller` must authenticate the transaction (`seller.require_auth()`).
  - `total_amount` must be greater than zero (`> 0`).
  - `token` must be in the approved `DataKey::AllowedToken` set.
  - `asset_type` must be in the approved `DataKey::AllowedCategory` set.
  - `expires_at` must be strictly in the future (`> ledger.timestamp()`) and within `MAX_EXPIRY_SECS` (30 days).
* **Post-conditions**:
  - Trade offer saved under `DataKey::Trade(trade_id)` with `TradeStatus::Open`.
  - Trade ID incremented and returned.
  - `trade_created` event emitted.

### 3. `deposit_to_escrow(env: Env, buyer: Address, trade_id: u64, amount: i128) -> Result<u64, ContractError>`
* **Purpose**: Called by a buyer to commit funds into escrow for a specific trade offer. Supports multi-buyer partial fills.
* **Pre-conditions**:
  - Contract must not be paused.
  - `buyer` must authenticate the transaction (`buyer.require_auth()`).
  - `amount > 0` and `trade.filled_amount + amount <= trade.total_amount`.
  - Trade must have status `Open` or `PartiallyFilled`, and ledger timestamp must be `< trade.expires_at`.
  - Buyer must possess sufficient token balance and approve token transfer.
* **Post-conditions**:
  - `amount` tokens transferred from `buyer` to the escrow contract account.
  - Sub-escrow recorded under `DataKey::SubEscrow(trade_id, fill_id)`.
  - `trade.filled_amount` incremented by `amount`. Status transitions to `Locked` if 100% filled, or `PartiallyFilled` otherwise.
  - Emits `escrow_deposit` event with fill ID and amounts.

### 4. `release_payment(env: Env, trade_id: u64, fill_id: u64) -> Result<(), ContractError>`
* **Purpose**: Invoked by the AirFlex oracle service once off-chain telco delivery of airtime/data is verified. Transfers escrowed funds to seller.
* **Pre-conditions**:
  - Contract must not be paused.
  - Caller must be the designated admin (`admin.require_auth()`).
  - Trade status must not be `Completed` or `Cancelled`.
  - Sub-escrow `fill_id` must be active and not previously released.
* **Post-conditions**:
  - Escrowed fill tokens transferred from contract to `trade.seller`.
  - Sub-escrow marked as released.
  - If all fills released, trade status transitions to `Completed`.
  - Emits `payment_released` event.

### 5. `release_by_timelock(env: Env, caller: Address, trade_id: u64, fill_id: u64) -> Result<(), ContractError>`
* **Purpose**: Permissionless or seller-initiated release of funds if delivery was completed and dispute window has elapsed without contest.
* **Pre-conditions**:
  - Contract must not be paused.
  - Caller must authenticate (`caller.require_auth()`).
  - Ledger timestamp must exceed the dispute window expiration (`ledger.timestamp() >= dispute_close_at`).
  - Sub-escrow must be active and trade not in `Disputed` state.
* **Post-conditions**:
  - Fill tokens transferred to `trade.seller`.
  - Sub-escrow marked resolved.
  - Emits `timelock_released` event.

### 6. `cancel_and_refund(env: Env, caller: Address, trade_id: u64, fill_id: u64) -> Result<(), ContractError>`
* **Purpose**: Refunds escrowed funds to buyer if seller fails to fulfill delivery, after trade expiration or via admin intervention.
* **Pre-conditions**:
  - Contract must not be paused.
  - Caller must be either the trade `buyer` (after `trade.expires_at` has passed) or the contract `admin`.
  - Sub-escrow must be in non-released state and trade status not `Completed`.
* **Post-conditions**:
  - Escrowed tokens transferred from contract back to `buyer`.
  - Sub-escrow marked refunded.
  - Emits `trade_refunded` event.

### 7. `flag_dispute(env: Env, caller: Address, trade_id: u64) -> Result<(), ContractError>`
* **Purpose**: Escalates a locked trade to `Disputed` status when buyer or seller reports non-delivery or invalid telco response.
* **Pre-conditions**:
  - Contract must not be paused.
  - Caller must be either `trade.seller`, a buyer of an active fill, or `admin` (`caller.require_auth()`).
  - Trade status must be `Locked` (fully committed) or active within dispute window.
* **Post-conditions**:
  - Trade status transitions to `TradeStatus::Disputed`.
  - Timelock release is frozen until manual admin resolution.
  - Emits `dispute_flagged` event.

### 8. Circuit Breakers & Administrative Controls
* **`pause(env: Env)`**: Admin-only. Freezes all deposits, listings, releases, and cancellations.
* **`unpause(env: Env)`**: Admin-only. Restores operations after verification cooldown.
* **`transfer_admin(env: Env, new_admin: Address)`**: Transfers contract administrative ownership.
* **`emergency_withdraw(env: Env, recipient: Address)`**: Allows emergency withdrawal of locked tokens to `recipient` only after contract has been paused for at least 72 hours (`EMERGENCY_TIMELOCK_SECS`).

---

## Trade Lifecycle State Machine

```
              ┌────────────────────────┐
              │          Open          │
              └───────────┬────────────┘
                          │ deposit_to_escrow (partial)
                          ▼
              ┌────────────────────────┐
              │    PartiallyFilled     │
              └───────────┬────────────┘
                          │ deposit_to_escrow (100% full)
                          ▼
              ┌────────────────────────┐
   ┌─────────►│         Locked         │◄─────────┐
   │          └───────────┬────────────┘          │
   │                      │                       │
   │       ┌──────────────┴──────────────┐        │
   │       │                             │        │
   │ flag_dispute                  release_payment│
   │       │                             │        │
   │       ▼                             ▼        │
┌──┴───────────────┐           ┌──────────────────┴───┐
│     Disputed     │           │      Completed       │
└──┬───────────────┘           └──────────────────────┘
   │
   │ cancel_and_refund
   ▼
┌──────────────────┐
│    Cancelled     │
└──────────────────┘
```
