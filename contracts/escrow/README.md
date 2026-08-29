# AirFlex Escrow Contract

Soroban smart contract that holds buyer funds in escrow until airtime/data delivery is confirmed by the AirFlex oracle.

---

## Deployed Addresses

| Network | Contract ID | Explorer |
|---------|-------------|----------|
| Testnet | `CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP` | [View on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP) |
| Mainnet | _not yet deployed_ | — |

**Network passphrase (Testnet):** `Test SDF Network ; September 2015`
**Network passphrase (Mainnet):** `Public Global Stellar Network ; September 2015`

> Contract IDs are also tracked in [`contracts/deployments.json`](../deployments.json).

---

## Contract Functions

### `initialize(admin: Address)`
Sets the admin address and seeds the trade counter. Can only be called once after deployment.

### `create_listing(seller, asset_type, amount, expires_at) → u64`
Called by the seller to register a new trade offer. Returns the listing ID.

### `deposit_to_escrow(listing_id, buyer, amount)`
Called by the buyer to lock funds in the contract. Sets trade status to `Locked`.

### `release_payment(trade_id)`
**Admin-only.** Called by the AirFlex oracle after delivery is confirmed. Transfers funds to the seller.

### `cancel_and_refund(trade_id)`
Refunds the buyer. Can be called by the buyer after the timelock expires, or by admin.

### `flag_dispute(trade_id)`
Escalates a trade to `Disputed` status for manual admin resolution.

### `get_trade(trade_id) → TradeOffer`
Read-only view of a specific trade.

### `pause()` / `unpause()`
Admin-only circuit breakers to halt all state-mutating operations.

---

## Trade Status Lifecycle

```
Open → Locked → Completed
          ↓          ↑
       Disputed ──────┘
          ↓
       Cancelled
```

---

## Build & Test

```bash
cd contracts
cargo build --release --target wasm32v1-none
cargo test --all-features
```

See [`contracts/README.md`](../readme.md) for full deployment instructions.
