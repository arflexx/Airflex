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
Escalates a trade to `Disputed` status for manual admin resolution. Only `Locked`
(fully filled) trades can be disputed; `PartiallyFilled` and `Open` trades return
`WrongStatus`.

**Dispute cooldown (Issue #642):** a per-trade `dispute_cooldown_seconds`
window (default `3600`, set at `initialize`) gates repeat calls — calling
`flag_dispute` again on the same trade before the cooldown elapses returns
`DISPUTE_COOLDOWN_ACTIVE` instead of silently succeeding or being spammed.
Once the cooldown has elapsed, calling it again on an already-`Disputed`
trade succeeds as a re-escalation (bumping the last-flagged timestamp and
re-emitting the dispute events) rather than erroring.

### `get_trade(trade_id) → TradeOffer`
Read-only view of a specific trade.

### `pause()` / `unpause()`
Admin-only circuit breakers to halt all state-mutating operations.

---

## Events (Issues #638, #639)

The contract publishes a canonical event for every escrow state transition,
each carrying `(escrow_id, actor, amount, timestamp)` so indexers, audit
tooling, and the backend oracle can subscribe on-chain instead of polling
`get_trade`:

| Topic | Emitted by | `actor` | `amount` |
|---|---|---|---|
| `EscrowCreated` | `create_listing` | seller | listing's total amount |
| `EscrowReleased` | `release_payment`, `release_by_timelock`, `resolve_dispute(Release)` | seller (recipient), once per released fill | the released sub-escrow's fill amount |
| `EscrowRefunded` | `cancel_and_refund`, `resolve_dispute(Refund)` | buyer (recipient), once per refunded fill | the refunded sub-escrow's fill amount |
| `EscrowDisputed` | `flag_dispute` | caller who flagged | the trade's currently-filled amount |

These are emitted in addition to (not instead of) the contract's existing
short-form topics (`created`, `locked`, `released`, `completed`, `cancelled`,
`disputed`, …), which remain unchanged for backward compatibility.

### Wire format

Each event has exactly one topic, the name above as a `Symbol`. The data is a
four-element vector, in this order:

| Index | Field | Type |
|---|---|---|
| 0 | `escrow_id` (trade ID) | `u64` |
| 1 | `actor` | `Address` |
| 2 | `amount`, in the token's smallest unit | `i128` |
| 3 | `timestamp` (ledger time, unix seconds) | `u64` |

### Consuming the events

`server/src/services/stellar.ts` provides:

- `subscribeToEscrowEvents({ onEvent })` — polls Soroban RPC `getEvents` and
  delivers each event in order, at least once. Handlers must be idempotent.
- `fetchEscrowEvents(startLedger)` — a one-shot, paginated read for backfills.

Set `ESCROW_EVENTS_ENABLED=true` to have the server subscribe at startup and
write every event to its structured log. The subscription does not change trade
status in the database, and it starts from the latest ledger after a restart;
use `fetchEscrowEvents` to cover a gap.

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
