# AirFlex Soroban Smart Contract Error Codes

This document lists all error codes thrown by the AirFlex Escrow and Marketplace Soroban contracts.

Discriminants are the values of the `ContractError` enum in
`contracts/escrow/src/lib.rs` and `contracts/marketplace/src/lib.rs`. Codes `1`–`14`
are shared by both contracts; escrow appends `15`–`17`. The server-side mirror in
`server/src/services/contractErrors.ts` maps every code back to a typed error.

**Never renumber an existing variant** — new variants are always appended with the
next integer, because deployed callers decode by discriminant.

---

## Shared Error Codes (Escrow & Marketplace)

The following codes appear in both contracts with identical discriminant values.

---

### `1` — `AlreadyInitialized`

| Field | Value |
|---|---|
| **Numeric value** | `1` |
| **Contract** | Escrow & Marketplace |
| **Relevant function** | `initialize` |

**Description:** `initialize` was called on a contract that already has an admin stored.

**Trigger conditions:** A second call to `initialize` on a contract that was successfully initialised in a prior transaction.

**Client-side handling:** Do not retry. Check whether the contract is already deployed and initialised before calling `initialize`. If your deployment pipeline runs `initialize` idempotently, treat this error as a no-op success.

---

### `2` — `Unauthorized`

| Field | Value |
|---|---|
| **Numeric value** | `2` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute`, `flag_dispute`, `pause`, `unpause`, `add_allowed_token`, `remove_allowed_token`, `add_category`, `remove_category`, `transfer_admin`, `update_listing`, `cancel_listing`, `emergency_withdraw` |

**Description:** The caller does not have permission to perform this action. Covers: missing Soroban auth signature, a seller attempting to buy their own listing, an admin attempting to act as a buyer, or a caller who is not recognised as a party to the trade.

**Trigger conditions:**
- `require_auth()` check fails because the transaction was not signed by the expected address.
- The seller calls `deposit_to_escrow` on their own listing.
- The admin calls `deposit_to_escrow` (conflict of interest — admin controls release and dispute resolution).
- An unrecognised address calls a function restricted to admin, seller, or buyer.
- `cancel_and_refund` is called by an address that is neither admin nor a buyer with an active fill.

**Client-side handling:** Verify that the transaction is signed by the correct key and that the caller address matches the expected role for the operation. Do not retry without correcting the signer.

---

### `3` — `TradeNotFound`

| Field | Value |
|---|---|
| **Numeric value** | `3` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute`, `flag_dispute`, `get_trade`, `get_listing`, `release_by_timelock`, `close_expired_listing` |

**Description:** No trade or listing with the supplied ID exists in persistent storage.

**Trigger conditions:**
- An ID that was never created is passed.
- The trade's persistent storage entry has been archived by the network TTL and was not extended before expiry.
- `close_expired_listing` already removed the entry from storage.
- A `SubEscrow` or `DisputeWindowCloseAt` entry referenced internally is missing (indicates a corrupted or archived state).

**Client-side handling:** Confirm the trade or listing ID against the creation event. If the entry may have been archived, attempt a TTL restore via the Stellar RPC `restoreFootprint` operation before retrying.

---

### `4` — `WrongStatus`

| Field | Value |
|---|---|
| **Numeric value** | `4` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute`, `flag_dispute`, `update_listing`, `cancel_listing`, `close_expired_listing`, `emergency_withdraw` |

**Description:** The requested action is not valid for the trade's or listing's current status.

**Trigger conditions:**
- Attempting to deposit into a trade that is `Locked`, `Completed`, `Cancelled`, or `Disputed`.
- Calling `release_payment` on a trade that is not `Locked` or `PartiallyFilled` (Escrow), or a listing that is not `Sold` (Marketplace).
- Calling `cancel_and_refund` on a trade that is `Open`, `Completed`, or `Cancelled`.
- Calling `flag_dispute` on a trade that is `PartiallyFilled`, `Completed`, or `Cancelled`.
- Calling `update_listing` or `cancel_listing` on a listing that is not `Active`.
- Calling `emergency_withdraw` while the contract is not paused.

**Client-side handling:** Fetch the current trade or listing status using `get_trade` / `get_listing` and branch on the actual status before retrying with the correct operation.

---

### `5` — `TradeExpired`

| Field | Value |
|---|---|
| **Numeric value** | `5` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `deposit_to_escrow`, `close_expired_listing` |

**Description:** The trade or listing has passed its `expires_at` timestamp. Also returned (inverted) by `close_expired_listing` when the listing has **not** yet expired.

**Trigger conditions:**
- `deposit_to_escrow` is called after `ledger.timestamp >= expires_at`.
- `close_expired_listing` is called while `ledger.timestamp < expires_at` (listing is not yet expired).

**Client-side handling:** For deposits, re-query the listing — it may still be purchasable if the expiry has not been reached. For `close_expired_listing`, wait until the expiry timestamp has passed before retrying.

---

### `6` — `InsufficientFunds`

| Field | Value |
|---|---|
| **Numeric value** | `6` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `deposit_to_escrow`, `emergency_withdraw`, `cancel_and_refund` (escrow internal arithmetic) |

**Description:** The requested amount exceeds the trade's remaining unfilled capacity, the contract's on-chain token balance, or would underflow the tracked `filled_amount` during a refund.

**Trigger conditions:**
- `fill_amount > trade.total_amount - trade.filled_amount` in `deposit_to_escrow`.
- The contract's token balance is less than `amount` in `emergency_withdraw`.
- Internal `checked_sub` underflows during `cancel_and_refund` (indicates invariant violation).

**Client-side handling:** Fetch the latest trade state to get the current `filled_amount` and recompute the available capacity before retrying with a smaller amount.

---

### `7` — `InvalidExpiry`

| Field | Value |
|---|---|
| **Numeric value** | `7` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `create_listing` (both contracts), `update_listing` (Marketplace) |

**Description:** The supplied `expires_at` is not a valid future timestamp.

**Trigger conditions:**
- `expires_at <= current ledger timestamp` — expiry is in the past or the present slot.
- Escrow only: `expires_at > now + MAX_EXPIRY_SECS` (30 days) — expiry is too far in the future.

**Client-side handling:** Use the current ledger timestamp from `Horizon` or the Soroban RPC `getLedger` response as a base. Set `expires_at` to a timestamp that is strictly greater than `now` and, for the Escrow contract, no more than 30 days (2,592,000 seconds) in the future.

---

### `8` — `AlreadyDisputed`

| Field | Value |
|---|---|
| **Numeric value** | `8` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `flag_dispute`, `release_by_timelock` |

**Description:** A dispute is already open on this trade.

**Trigger conditions:**
- `flag_dispute` is called on a trade whose status is already `Disputed`.
- `release_by_timelock` is called on a trade in `Disputed` status.

**Client-side handling:** Do not retry `flag_dispute`. Proceed to `resolve_dispute` (admin) or await admin resolution. For `release_by_timelock`, the dispute must be resolved by the admin before a timelock release is possible.

---

### `9` — `ContractPaused`

| Field | Value |
|---|---|
| **Numeric value** | `9` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | All state-mutating functions except `emergency_withdraw` |

**Description:** The contract is paused by the admin circuit breaker. All state-mutating operations are blocked.

**Trigger conditions:** Any state-mutating call while `DataKey::Paused` is `true`.

**Client-side handling:** Poll `is_paused()` before submitting a transaction. If paused, surface an informational message to the user and retry after the contract is unpaused. Do not loop-retry automatically — a pause may be indefinite in a security incident.

---

### `10` — `TimelockNotExpired`

| Field | Value |
|---|---|
| **Numeric value** | `10` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `cancel_and_refund`, `release_by_timelock`, `emergency_withdraw` |

**Description:** A timelocked action was attempted before the required waiting period has elapsed.

**Trigger conditions:**
- A buyer calls `cancel_and_refund` before the trade's `expires_at` timestamp.
- `release_by_timelock` is called before the dispute window close timestamp (`DisputeWindowCloseAt`) has passed.
- `emergency_withdraw` is called before 72 hours (`EMERGENCY_TIMELOCK_SECS = 259,200` seconds) have elapsed since `pause` was invoked.

**Client-side handling:** Calculate the remaining wait time from the relevant timestamp and present it to the user. Schedule a retry after that time elapses.

---

### `11` — `UnsupportedToken`

| Field | Value |
|---|---|
| **Numeric value** | `11` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `create_listing` (Escrow) |

**Description:** The token address supplied is not on the contract's allow-list.

**Trigger conditions:** `create_listing` is called with a `token` address that has not been added via `add_allowed_token`.

**Client-side handling:** Query the list of allowed tokens from the platform API or contract events before constructing a listing. Only present supported tokens to users in the UI.

---

### `12` — `InvalidAmount`

| Field | Value |
|---|---|
| **Numeric value** | `12` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `create_listing`, `deposit_to_escrow`, `update_listing`, `emergency_withdraw` |

**Description:** The amount is zero, negative, or (for escrow deposits) below the minimum deposit constant `MIN_DEPOSIT_AMOUNT`, or above the maximum deposit constant `MAX_DEPOSIT_AMOUNT`.

**Trigger conditions:**
- `amount <= 0` on any function that accepts an amount parameter.
- Escrow `deposit_to_escrow`: `fill_amount < MIN_DEPOSIT_AMOUNT` (dust attack prevention — see issue #506).
- Escrow `deposit_to_escrow`: `fill_amount > MAX_DEPOSIT_AMOUNT` (overflow protection — see issue #506).
- Marketplace `create_listing`: `price <= 0` or `quantity <= 0`.

**Client-side handling:** Validate amounts client-side before submission. For escrow deposits, enforce `MIN_DEPOSIT_AMOUNT` and `MAX_DEPOSIT_AMOUNT` bounds in the UI. Present human-readable minimum/maximum values to the user (convert from stroops).

---

### `13` — `FillAlreadyProcessed`

| Field | Value |
|---|---|
| **Numeric value** | `13` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `release_payment`, `release_by_timelock` |

**Description:** The specified sub-escrow fill has already been released or refunded.

**Trigger conditions:**
- `release_payment` or `release_by_timelock` is called with a `fill_id` whose `SubEscrow.released` or `SubEscrow.refunded` flag is already `true`.

**Client-side handling:** Do not retry. Query the sub-escrow state to confirm the fill was already processed. This is likely a double-submit or a stale event replay.

---

### `14` — `NotAParty`

| Field | Value |
|---|---|
| **Numeric value** | `14` |
| **Contract** | Escrow & Marketplace |
| **Relevant functions** | `flag_dispute` (Escrow), `resolve_dispute` (Marketplace) |

**Description:** The caller is neither the seller nor a buyer who holds a fill on this trade.

**Trigger conditions:**
- `flag_dispute` is called by an address that is not the trade's seller and does not appear in any `SubEscrow.buyer` for that trade.
- `resolve_dispute` is called with a `recipient` that is neither `listing.seller` nor `listing.buyer`.

**Client-side handling:** Confirm the caller address is a known party to the trade by fetching the trade or listing record before attempting the call. For `resolve_dispute`, the recipient must be one of the two parties.

---

## Escrow-Only Error Codes

The following codes are only emitted by `contracts/escrow/src/lib.rs`.

---

### `15` — `PauseCooldownNotExpired`

| Field | Value |
|---|---|
| **Numeric value** | `15` |
| **Contract** | Escrow only |
| **Relevant function** | `unpause` |

**Description:** `unpause` was called before the 5-minute pause cooldown has elapsed since the contract was paused.

**Trigger conditions:** `unpause` is called when `ledger.timestamp < paused_at + PAUSE_COOLDOWN_SECONDS` (300 seconds).

**Client-side handling:** Wait at least 5 minutes after `pause` was invoked before calling `unpause`. Read `PausedAt` from instance storage or the `contract.paused` event timestamp to calculate the earliest eligible unpause time.

---

### `16` — `InvalidCategory`

| Field | Value |
|---|---|
| **Numeric value** | `16` |
| **Contract** | Escrow only |
| **Relevant function** | `create_listing` |

**Description:** The `asset_type` symbol supplied to `create_listing` is not on the admin-managed allowed categories list.

**Trigger conditions:** `create_listing` is called with an `asset_type` symbol that has not been added via `add_category`. Default allowed categories seeded at initialisation are `AIRTIME` and `DATA`.

**Client-side handling:** Fetch the current allowed categories from the platform API before constructing a listing. Only present supported asset types to sellers in the UI.

---

### `17` — `DuplicateFill`

| Field | Value |
|---|---|
| **Numeric value** | `17` |
| **Contract** | Escrow only |
| **Relevant function** | `deposit_to_escrow` |

**Description:** The buyer already holds an active (unreleased and unrefunded) sub-escrow fill on this trade. Only one active fill per buyer per trade is permitted.

**Trigger conditions:** `deposit_to_escrow` is called by a buyer who already has a `SubEscrow` entry for the same `trade_id` where both `released` and `refunded` are `false`. Prevents a single buyer from monopolising a listing meant to be shared by many buyers (see issue #294).

**Client-side handling:** Check whether the buyer already holds an active fill on this listing before allowing a second deposit. A buyer may deposit again only after their previous fill has been released (`release_payment`) or refunded (`cancel_and_refund`).

---

## Marketplace-Only Error Codes

The following code is only emitted by `contracts/marketplace/src/lib.rs`.

---

### `15` — `StorageLimitExceeded`

| Field | Value |
|---|---|
| **Numeric value** | `15` |
| **Contract** | Marketplace only |
| **Relevant function** | `create_listing` |

**Description:** The seller has reached the maximum permitted number of concurrently active listings (`MAX_ACTIVE_LISTINGS_PER_SELLER = 10`).

**Trigger conditions:** `create_listing` is called when `ActiveListingCount` for the seller is already at or above `MAX_ACTIVE_LISTINGS_PER_SELLER`.

**Client-side handling:** Show the seller their current active listing count. Prompt them to cancel an existing listing via `cancel_listing`, wait for a buyer to purchase one, or allow an expired listing to be closed via `close_expired_listing` before creating a new one.

---

### `18` — `ReentrancyDetected`

| Field | Value |
|---|---|
| **Numeric value** | `18` |
| **Contract** | Marketplace only |
| **Relevant function** | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute` |

**Description:** A reentrant call into a purchase or settlement function was detected while a prior call from the same transaction context is still executing.

**Trigger conditions:** A custom SAC token's transfer hook or any other cross-contract callback re-enters `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, or `resolve_dispute` while the reentrancy guard flag is set in temporary storage (see issue #507).

**Client-side handling:** This error should never occur during normal operation with vetted tokens. If encountered, it indicates a malicious or non-compliant token contract. Report it as a security incident. Do not retry.

---

## Escrow Contract — Canonical Error Code Table

The escrow contract (`contracts/escrow/src/lib.rs`) uses stable integer discriminants.
New codes are always appended; existing values are never changed.

| Discriminant | Variant name | Description | Relevant function(s) |
|---|---|---|---|
| `1` | `AlreadyInitialized` | Contract already initialized. | `initialize` |
| `2` | `Unauthorized` | Caller lacks required authority. | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `flag_dispute`, `pause`, `unpause`, `add_allowed_token`, `remove_allowed_token`, `add_category`, `remove_category`, `transfer_admin` |
| `3` | `TradeNotFound` | Trade ID not found in persistent storage. | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `flag_dispute`, `get_trade`, `release_by_timelock`, `close_expired_listing` |
| `4` | `WrongStatus` | State transition is invalid for current status. | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `flag_dispute`, `close_expired_listing` |
| `5` | `TradeExpired` | Trade has passed its expiry timestamp (or has not yet expired for `close_expired_listing`). | `deposit_to_escrow`, `close_expired_listing` |
| `6` | `InsufficientFunds` | Amount exceeds available or escrowed balance. | `deposit_to_escrow`, `emergency_withdraw`, `cancel_and_refund` |
| `7` | `InvalidExpiry` | Expiry is in the past or beyond the 30-day maximum. | `create_listing` |
| `8` | `AlreadyDisputed` | Trade already has an active dispute. | `flag_dispute`, `release_by_timelock` |
| `9` | `ContractPaused` | Contract is paused; state-mutating calls are blocked. | All state-mutating functions |
| `10` | `TimelockNotExpired` | Required timelock period has not elapsed. | `cancel_and_refund`, `release_by_timelock`, `emergency_withdraw` |
| `11` | `UnsupportedToken` | Token address is not on the allowed tokens list. | `create_listing` |
| `12` | `InvalidAmount` | Amount is zero, negative, below `MIN_DEPOSIT_AMOUNT`, or above `MAX_DEPOSIT_AMOUNT`. | `create_listing`, `deposit_to_escrow`, `emergency_withdraw` |
| `13` | `FillAlreadyProcessed` | Sub-escrow fill has already been released or refunded. | `release_payment`, `release_by_timelock` |
| `14` | `NotAParty` | Caller is not the seller or any buyer on this trade. | `flag_dispute` |
| `15` | `PauseCooldownNotExpired` | Pause cooldown window (5 minutes) has not elapsed before `unpause`. | `unpause` |
| `16` | `InvalidCategory` | `asset_type` symbol is not on the admin-managed allowed categories list. | `create_listing` |
| `17` | `DuplicateFill` | Buyer already holds an active sub-escrow on this trade (issue #294). | `deposit_to_escrow` |

## Marketplace Contract — Canonical Error Code Table

The marketplace contract (`contracts/marketplace/src/lib.rs`) uses stable integer discriminants.
New codes are always appended; existing values are never changed.

| Discriminant | Variant name | Description | Relevant function(s) |
|---|---|---|---|
| `1` | `AlreadyInitialized` | Contract already initialized. | `initialize` |
| `2` | `Unauthorized` | Caller lacks required authority. | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute`, `update_listing`, `cancel_listing`, `pause`, `unpause`, `transfer_admin` |
| `3` | `TradeNotFound` | Listing ID not found in persistent storage. | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute`, `update_listing`, `cancel_listing`, `get_listing`, `close_expired_listing` |
| `4` | `WrongStatus` | Action is invalid for the listing's current status. | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute`, `update_listing`, `cancel_listing`, `close_expired_listing`, `emergency_withdraw` |
| `5` | `TradeExpired` | Listing has passed its expiry (or has not yet expired for `close_expired_listing`). | `deposit_to_escrow`, `close_expired_listing` |
| `6` | `InsufficientFunds` | Contract balance is less than the requested withdrawal amount. | `emergency_withdraw` |
| `7` | `InvalidExpiry` | Expiry is in the past or the present slot. | `create_listing`, `update_listing` |
| `8` | `AlreadyDisputed` | (Reserved — not currently used by Marketplace.) | — |
| `9` | `ContractPaused` | Contract is paused; state-mutating calls are blocked. | All state-mutating functions |
| `10` | `TimelockNotExpired` | 72-hour emergency withdrawal timelock has not elapsed. | `emergency_withdraw` |
| `11` | `UnsupportedToken` | (Reserved — not currently used by Marketplace.) | — |
| `12` | `InvalidAmount` | Amount is zero or negative. | `create_listing`, `update_listing`, `emergency_withdraw` |
| `13` | `FillAlreadyProcessed` | (Reserved — not currently used by Marketplace.) | — |
| `14` | `NotAParty` | Recipient is not the seller or the recorded buyer of this listing. | `resolve_dispute` |
| `15` | `StorageLimitExceeded` | Seller has reached the active listing cap (`MAX_ACTIVE_LISTINGS_PER_SELLER = 10`). | `create_listing` |
| `18` | `ReentrancyDetected` | Reentrant call detected during a purchase or settlement operation (issue #507). | `deposit_to_escrow`, `release_payment`, `cancel_and_refund`, `resolve_dispute` |

## Handling Errors

When calling contract functions via Soroban SDK or RPC:
- Errors are returned as contract error host functions (`panic_with_error`).
- Client SDKs map these panic codes to corresponding `Error` enums for handling in frontend and server services.
- Always prefer checking the error discriminant over string matching — the discriminant is stable across contract upgrades, the error message is not.
