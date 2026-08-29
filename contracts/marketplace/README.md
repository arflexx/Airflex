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
Returns the full listing struct for a given ID.

### `get_reputation(user: Address) → Reputation`
Returns a seller's on-chain reputation: `completed_trades`, `disputed_trades`, `total_volume`.

### `listing_count() → u64`
Returns the total number of listings ever created.

### `pause()` / `unpause()`
Admin-only circuit breakers.

---

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
