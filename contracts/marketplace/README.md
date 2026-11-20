# AirFlex Marketplace Contract

Soroban smart contract for on-chain listing management with integrated seller reputation tracking.

---

## Deployed Addresses

| Network | Contract ID | Explorer |
|---------|-------------|----------|
| Testnet | _not yet deployed_ | — |
| Mainnet | _not yet deployed_ | — |

**Network passphrase (Testnet):** `Test SDF Network ; September 2015`
**Network passphrase (Mainnet):** `Public Global Stellar Network ; September 2015`

To deploy to testnet, run:

```bash
export SOROBAN_DEPLOYER_SECRET="S..."
export SOROBAN_ADMIN_ADDRESS="G..."
./contracts/deploy.sh --network testnet --contract marketplace
```

> Contract IDs are tracked in [`contracts/deployments.json`](../deployments.json).

---

## Contract Functions

### `initialize(admin: Address)`
Sets the admin address and seeds the listing counter. Can only be called once after deployment.

### `create_listing(seller, token, price, asset_category, asset_type, quantity, expires_at) → u64`
Called by the seller to post a new airtime/data offer. Returns the listing ID.

- `asset_category`: `Airtime` or `Data`
- `asset_type`: Symbol identifying the carrier, e.g. `MTN`, `AIRTEL`, `GLO`
- `token`: Address of the payment token (USDC/NGNC)

### `deposit_to_escrow(buyer, listing_id)`
Called by the buyer to lock funds. Transfers `listing.price` tokens from buyer to the contract.

### `release_payment(listing_id)`
**Admin-only.** Transfers escrowed funds to the seller and increments their reputation score.

### `cancel_and_refund(buyer, listing_id)`
**Admin-only.** Refunds the buyer and increments the seller's `disputed_trades` count.

### `resolve_dispute(listing_id, recipient)`
**Admin-only.** Transfers funds to the specified recipient (buyer or seller) to resolve a dispute.

### `get_listing(listing_id) → Listing`
Returns the **hot** listing fields only: `id`, `seller`, `token`, `price`,
`quantity`, `status`, `expires_at`, `buyer`. This is what every state-mutating
call (`deposit_to_escrow`, `release_payment`, `cancel_and_refund`,
`resolve_dispute`, `update_listing`, `cancel_listing`) reads on every
invocation, so it is kept in its own compact ledger entry.

### `get_listing_details(listing_id) → ListingDetails`
Returns both the hot `Listing` record above **and** the cold metadata:
`asset_category`, `asset_type`, `created_at`. Use this only when the
descriptive/display fields are actually needed — most callers should prefer
`get_listing`.

### `get_reputation(user: Address) → Reputation`
Returns a seller's on-chain reputation: `completed_trades`, `disputed_trades`, `total_volume`.

### `listing_count() → u64`
Returns the total number of listings ever created.

### `pause()` / `unpause()`
Admin-only circuit breakers.

---

## Storage Layout — Hot/Cold Offer Split (Issue #641)

A listing's data is split across two persistent ledger entries so routine
reads/writes never pay for rarely-accessed descriptive fields:

| Key | Struct | Fields | Read by |
|---|---|---|---|
| `DataKey::Listing(id)` (hot) | `Listing` | `id`, `seller`, `token`, `price`, `quantity`, `status`, `expires_at`, `buyer` | Every state-mutating call and `get_listing` |
| `DataKey::ListingMeta(id)` (cold) | `ListingMetadata` | `asset_category`, `asset_type`, `created_at` | Only `get_listing_details` |

Both entries are written once at `create_listing` and share the same TTL
policy (`17_280` / `17_280 * 30` ledgers). Only the hot entry is touched by
`deposit_to_escrow`, `release_payment`, `cancel_and_refund`,
`resolve_dispute`, `update_listing`, and `cancel_listing` — the cold entry is
immutable after creation and is fetched only by `get_listing_details`.

Approximate per-offer footprint:
- Hot (`Listing`): 2 `Address` fields + 2 `i128` + 1 enum + 1 `u64` + 1
  `Option<Address>` — the fields every lookup during an active trade needs.
- Cold (`ListingMetadata`): 1 enum + 1 `Symbol` + 1 `u64` — write-once
  descriptive data.

Splitting these means a hot-path call (e.g. `release_payment`) never
deserializes or re-serializes the cold metadata it doesn't use, keeping its
instruction and storage-write cost bounded as more descriptive fields are
added to `ListingMetadata` in the future.

## Listing Status Lifecycle

```
Active → Sold → (release_payment)
           ↓
        Cancelled (cancel_and_refund / resolve_dispute)
```

---

## Build & Test

```bash
cd contracts
cargo build --release --target wasm32v1-none
cargo test --all-features
```

See [`contracts/README.md`](../readme.md) for full deployment instructions.
