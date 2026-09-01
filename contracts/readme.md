# AirFlex Smart Contracts

Soroban (Rust) smart contracts for the AirFlex P2P airtime/data marketplace on the Stellar network.

**Last Updated:** August 28, 2026

---

## Contracts

| Contract    | Description                                             |
|-------------|--------------------------------------------------------|
| `escrow`    | Trustless escrow for P2P trades (deposit, release, refund) |
| `marketplace` | On-chain listing registry with seller reputation tracking |

See [ERROR_CODES.md](./ERROR_CODES.md) for the full list of typed contract error codes, their numeric values, and the conditions that trigger them.

---

## Deployed Addresses

Contract IDs are the canonical source of truth. Always cross-reference with
`contracts/deployments.json` — the file is updated automatically by `deploy.sh`
and the CI deploy workflow.

### Escrow Contract

| Network | Contract ID | Explorer |
|---------|-------------|----------|
| Testnet | `CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP` | [View on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP) |
| Mainnet | _not yet deployed_ | — |

**Network passphrase (Testnet):** `Test SDF Network ; September 2015`
**Network passphrase (Mainnet):** `Public Global Stellar Network ; September 2015`

### Marketplace Contract

| Network | Contract ID | Explorer |
|---------|-------------|----------|
| Testnet | _not yet deployed_ | — |
| Mainnet | _not yet deployed_ | — |

---

## Project Structure

```
contracts/
├── Cargo.toml            # Workspace manifest
├── Cargo.lock
├── deployments.json      # Canonical contract address registry
├── deploy.sh             # Build-and-deploy automation script
├── escrow/
│   ├── Cargo.toml
│   └── src/lib.rs        # Escrow contract source
└── marketplace/
    ├── Cargo.toml
    └── src/lib.rs        # Marketplace contract source
```

---

## Development

### Prerequisites

- Rust stable (with `wasm32v1-none` target)
- [`stellar-cli`](https://developers.stellar.org/docs/tools/developer-tools/stellar-cli) installed and on `$PATH`

Install the WASM target:

```bash
rustup target add wasm32v1-none
```

### Build

```bash
cd contracts
cargo build --release --target wasm32v1-none
```

Or using stellar-cli:

```bash
stellar contract build
```

### Test

```bash
cd contracts
cargo test --all-features
```

### Lint

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
```

---

## Deployment

### Automated (CI)

The `soroban-deploy.yml` workflow handles testnet deployment automatically on
successful CI runs against `main`. Mainnet deployment is **manual-dispatch only**
to prevent accidental production deploys.

### Manual (local)

Use the `deploy.sh` script from the repo root:

```bash
# Deploy all contracts to testnet
export SOROBAN_DEPLOYER_SECRET="S..."   # deployer Stellar secret key
export SOROBAN_ADMIN_ADDRESS="G..."     # admin public key

./contracts/deploy.sh --network testnet --contract all

# Deploy only escrow, skip auto-initialize
./contracts/deploy.sh --network testnet --contract escrow --initialize no

# Mainnet (requires interactive confirmation prompt)
./contracts/deploy.sh --network mainnet --contract escrow
```

After deployment the script:
1. Updates `contracts/deployments.json` with the new contract ID.
2. Commits the change (pass `--commit no` to skip).

Copy the new contract ID into your `server/.env`:

```
ESCROW_CONTRACT_ID=C...
MARKETPLACE_CONTRACT_ID=C...
```

---

## 🗄️ Storage Schema

The escrow contract stores state across two Soroban storage tiers. Keys are defined
in the `DataKey` enum in `escrow/src/lib.rs`.

| Key | Tier | Value type | Description |
|-----|------|------------|-------------|
| `DataKey::Admin` | **instance** | `Address` | Platform admin / server signing key set at `initialize` |
| `DataKey::TradeCounter` | **instance** | `u64` | Monotonic counter of listings created (`TradeCount` in docs) |
| `DataKey::AllowedToken(Address)` | **instance** | `bool` | Whitelist entry for an accepted payment token (`Token` in docs) |
| `DataKey::Paused` | **instance** | `bool` | Circuit-breaker pause flag |
| `DataKey::TradeFillCounter(u64)` | **instance** | `u64` | Per-trade fill counter for partial purchases |
| `DataKey::Trade(u64)` | **persistent** | `TradeOffer` | On-chain listing and escrow state for a trade ID |
| `DataKey::SubEscrow(u64, u64)` | **persistent** | `SubEscrow` | Per-fill escrow record (trade ID + fill ID) |

### TTL strategy

- **Instance storage** is bumped on every contract call via `extend_ttl(17_280, 17_280 * 30)` at initialization and on subsequent writes, keeping admin config and counters alive for the lifetime of active trades.
- **Persistent trade entries** (`DataKey::Trade`, `DataKey::SubEscrow`) are bumped on every state transition (create, deposit, release, cancel, dispute) with the same 30-day extension window — entries expire **30 days after their last update** if not refreshed.
- **Completed and cancelled trades** are retained on-ledger for **7 days** after their terminal state transition, then allowed to archive once TTL is not extended.

### 🔑 How to Query State Off-Chain

Read a `TradeOffer` from persistent storage using the Soroban RPC `getLedgerEntries`
endpoint. Replace `CONTRACT_ID`, `TRADE_ID`, and `SOROBAN_RPC_URL` with your values:

```bash
# Trade key is XDR-encoded (symbol "Trade" + u64 trade ID)
curl -s -X POST "$SOROBAN_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getLedgerEntries",
    "params": {
      "keys": [{
        "contractData": {
          "contract": "CONTRACT_ID",
          "key": "BASE64_ENCODED_DATA_KEY_TRADE_ID",
          "durability": "persistent"
        }
      }]
    }
  }'
```

Generate the base64 key with the Stellar CLI:

```bash
stellar contract read --id CONTRACT_ID --key Trade --trade-id TRADE_ID --durability persistent
```

The returned XDR decodes to a `TradeOffer` struct (seller, token, amounts, status, etc.).

---

## ⚡ Contract Functions

### 1. `create_listing`

**Who calls it:** The Seller

* **Parameters:** `seller: Address`, `token: Address`, `amount: i128`, `asset_type: Symbol`, `expires_at: u64`
* **Returns:** `u64` (the new trade ID)
* **Logic:** Registers a new trade offer in persistent storage and sets its status to `Open`. Validates that `expires_at` is in the future, `amount` is positive, and the payment token is whitelisted.
* **Authorisation:** The seller address must sign the transaction — `seller.require_auth()` is enforced before any state writes.

### 2. `deposit_to_escrow`

**Who calls it:** The Buyer

* **Parameters:** `buyer: Address`, `trade_id: u64`, `fill_amount: i128`
* **Returns:** `()`
* **Logic:** Transfers tokens from the buyer to the contract's escrow storage. Records a sub-escrow entry for the fill and transitions trade status to `Locked` once fully filled (or `PartiallyFilled` for partial purchases).
* **Authorisation:** Caller must be the buyer — `buyer.require_auth()` is enforced before reading trade state or transferring tokens.

### 3. `release_payment`

**Who calls it:** System Backend (via Oracle / Admin)

* **Parameters:** `caller: Address`, `trade_id: u64`, `fill_id: u64`
* **Returns:** `()`
* **Logic:** Finalizes the trade once delivery of airtime or data is verified by transferring funds from the contract to the seller. Sets the sub-escrow to released and transitions the trade status to `Completed` when all fills are released.
* **Authorisation:** Caller must be the contract admin address — `caller.require_auth()` is enforced.

### 4. `cancel_and_refund`

**Who calls it:** Buyer (after timelock) or Admin (immediate bypass)

* **Parameters:** `caller: Address`, `trade_id: u64`
* **Returns:** `()`
* **Logic:** Caller guard enforces that only the buyer or the contract admin can invoke this function. If the caller is the buyer, an additional check enforces the 24-hour timelock (the trade must have been in `Locked` status for at least 86,400 seconds; premature calls fail). If the caller is the admin, the timelock check is bypassed for immediate cancellation and dispute resolution. Escrowed tokens are transferred back to the buyer and trade status transitions to `Cancelled`.
* **Authorisation:** Caller must authenticate with `caller.require_auth()`. Any caller other than the buyer or admin is rejected with an unauthorized error.

---

## Security

- **Address authorisation:** Every contract function that accepts an `Address` parameter representing the caller (e.g. `seller`, `buyer`, `admin`) must call `address.require_auth()` before reading state or transferring tokens. This prevents impersonation attacks where a third party acts on behalf of an unwitting user.
- **Timelocks:** Buyers can self-refund after 24 hours if the trade is not completed.
- **Admin-only oracle:** Only the initialised admin address can call `release_payment`.
  Who calls it: System Backend (must be the admin/oracle address set at initialization).
- **Pause circuit-breaker:** Admin can pause all state-mutating operations in an emergency.
- **Reentrancy:** Soroban's host environment prevents re-entrant calls natively.
