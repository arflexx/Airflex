#![no_std]
#![allow(clippy::too_many_arguments)]

extern crate alloc;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
    Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    /// The admin `Address` set at `initialize`; never reassigned except via `set_admin`.
    Admin,
    /// Monotonically increasing `u64` counter used to allocate the next `Trade(u64)` id.
    TradeCounter,
    /// Persistent storage slot for a single `TradeOffer`, keyed by trade id.
    Trade(u64),
    /// Circuit-breaker flag (`bool`); when `true` state-mutating calls are rejected.
    Paused,
    /// Unix timestamp (ledger time, seconds) at which `pause` was last called.
    PausedAt,
    /// Allow-list membership (`bool`) for a token contract `Address` accepted as trade collateral.
    AllowedToken(Address),
    /// Monotonically increasing `u64` counter of sub-escrow fills created for a given trade id.
    TradeFillCounter(u64),
    /// Persistent storage slot for a single `SubEscrow` fill, keyed by `(trade_id, fill_id)`.
    SubEscrow(u64, u64),
    /// Allow-list membership (`bool`) for an asset-type `Symbol` (e.g. `AIRTIME`, `DATA`).
    AllowedCategory(Symbol),
    /// Unix timestamp (ledger time, seconds) after which a disputed trade's window closes, keyed by trade id.
    DisputeWindowCloseAt(u64),
    /// Per-contract dispute cooldown window, in seconds (issue #642). Set at
    /// `initialize` so it is readable (and, in principle, admin-tunable) the
    /// same way every other configuration value in this contract is.
    DisputeCooldownSecs,
    /// Ledger timestamp of the most recent `flag_dispute` call on this trade
    /// (issue #642), used to reject a repeat call before the cooldown window
    /// has elapsed.
    LastDisputeAt(u64),
    /// Maximum `total_amount` (in the token's smallest unit, e.g. stroops) a
    /// single listing may lock (issue #636). Set at `initialize`, updated via
    /// `update_max_amount`.
    MaxAmount,
}

pub const EMERGENCY_TIMELOCK_SECS: u64 = 72 * 60 * 60; // 72 hours = 259,200 seconds
pub const MAX_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60; // 30 days = 2,592,000 seconds
pub const DISPUTE_WINDOW_SECS: u64 = 24 * 60 * 60; // 24 hours = 86,400 seconds
/// Default per-listing cap written at `initialize` (issue #636). It is
/// effectively uncapped so existing integrations keep working; deployments set
/// the real cap straight after init via `update_max_amount` (see deploy.sh).
pub const DEFAULT_MAX_AMOUNT: i128 = i128::MAX;
/// Default minimum time between successive `flag_dispute` calls on the same
/// trade (issue #642). A malicious party repeatedly calling `flag_dispute`
/// could otherwise spam the dispute path to exhaust the counterparty's
/// ability to respond, or to game dispute-resolution timing. Stored into
/// instance storage at `initialize` and read back on every `flag_dispute`
/// call.
pub const DEFAULT_DISPUTE_COOLDOWN_SECS: u64 = 3600; // 1 hour

// ---------------------------------------------------------------------------
// Deposit amount bounds (issue #506)
// ---------------------------------------------------------------------------

/// Minimum deposit amount in stroops (1 XLM = 10,000,000 stroops).
///
/// Enforced in `deposit_to_escrow` to prevent dust attacks: a buyer sending a
/// 1-stroop fill consumes a sub-escrow storage slot and a fill-counter entry
/// for a negligible economic contribution, which could be used to spam listings
/// or grief sellers.
///
/// Set to 1_000_000 stroops (0.1 XLM) — small enough to be inclusive for
/// micro-trade use-cases while rejecting non-economical dust fills.
pub const MIN_DEPOSIT_AMOUNT: i128 = 1_000_000; // 0.1 XLM in stroops

/// Maximum deposit amount in stroops.
///
/// Enforced in `deposit_to_escrow` to prevent integer overflow edge cases
/// and to cap the single-fill exposure that a compromised signing key could
/// lock. `i128::MAX` is 170,141,183,460,469,231,731,687,303,715,884,105,727,
/// which is far beyond any realistic trade size; using a capped maximum makes
/// the invariant explicit and auditable.
///
/// Set to 1_000_000_000_000_000 stroops (100,000,000 XLM) — safely within
/// `i128` and above any foreseeable single-trade maximum on this platform.
pub const MAX_DEPOSIT_AMOUNT: i128 = 1_000_000_000_000_000; // 100,000,000 XLM in stroops

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Lifecycle status of a [`TradeOffer`] (issue #150).
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum TradeStatus {
    /// Listed and open for one or more buyers to deposit into.
    Open,
    /// At least one buyer has deposited but capacity remains (multi-fill listings).
    PartiallyFilled,
    /// Fully funded; no further deposits are accepted.
    Locked,
    /// All sub-escrow fills have been released or refunded; terminal state.
    Completed,
    /// A buyer has raised a dispute within the dispute window; terminal pending resolution.
    Disputed,
    /// Cancelled by the seller or admin before being filled; terminal state.
    Cancelled,
}

/// Outcome an arbitrator assigns to a disputed trade (Issue #508).
///
/// `Release` — the seller prevails: every still-escrowed sub-escrow is released
/// to the seller and the trade completes.
/// `Refund`  — the buyer prevails: every still-escrowed sub-escrow is returned
/// to its buyer and the trade is cancelled.
///
/// See `AUDIT_PREP.md` → `TradeStatus` state machine.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DisputeResolution {
    Release,
    Refund,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TradeOffer {
    /// Unique trade id, allocated from `DataKey::TradeCounter`.
    pub id: u64,
    /// The seller `Address` who created the listing and will receive payment.
    pub seller: Address,
    /// Token contract `Address` used for settlement (e.g. USDC or NGNC), must be allow-listed.
    pub token: Address,
    /// Total amount offered, in stroops (1 XLM = 10_000_000 stroops; same unit for other SEP-41 tokens).
    pub total_amount: i128,
    /// Amount already claimed across all sub-escrow fills, in stroops.
    pub filled_amount: i128,
    /// Asset category symbol, e.g. `symbol_short!("AIRTIME")`, must be on the allowed categories list.
    pub asset_type: Symbol,
    /// Current lifecycle status of the trade.
    pub status: TradeStatus,
    /// Unix timestamp (ledger time, seconds) after which the listing can no longer be filled.
    pub expires_at: u64,
}

/// A single buyer's deposit against a [`TradeOffer`] (issue #150).
///
/// Multiple `SubEscrow` entries can exist per trade id, one per buyer fill,
/// keyed by `DataKey::SubEscrow(trade_id, fill_id)`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SubEscrow {
    /// Id of this fill, unique within its parent trade (see `DataKey::TradeFillCounter`).
    pub fill_id: u64,
    /// The buyer `Address` who deposited into this fill.
    pub buyer: Address,
    /// Amount deposited by this buyer, in stroops.
    pub amount: i128,
    /// `true` once funds have been released to the seller for this fill.
    pub released: bool,
    /// `true` once funds have been refunded back to the buyer for this fill.
    pub refunded: bool,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Standardised contract error enum.
///
/// Discriminant values are stable — never change an existing value.
/// New variants must always be appended at the end with the next integer.
/// See `contracts/ERROR_CODES.md` for the full reference table.
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    TradeNotFound = 3,
    WrongStatus = 4,
    TradeExpired = 5,
    InsufficientFunds = 6,
    InvalidExpiry = 7,
    AlreadyDisputed = 8,
    ContractPaused = 9,
    TimelockNotExpired = 10,
    UnsupportedToken = 11,
    InvalidAmount = 12,
    FillAlreadyProcessed = 13,
    NotAParty = 14,
    PauseCooldownNotExpired = 15,
    InvalidCategory = 16,
    DuplicateFill = 17,
    /// `flag_dispute` was called on this trade before `dispute_cooldown_seconds`
    /// had elapsed since the previous dispute flag (issue #642).
    DisputeCooldownActive = 18,
    /// `create_listing` amount is above the admin-configured `MaxAmount`
    /// (issue #636).
    AmountExceedsMax = 19,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Event topics defined with `symbol_short!` are limited to at most 9 ASCII
// characters (e.g. "completed" and "cancelled" are exactly 9 chars, at the limit).
// Any topic strings approaching or exceeding 9 characters must use `Symbol::new(env, "...")`
// to avoid compile-time macro panics.
fn topic_created() -> Symbol {
    symbol_short!("created")
} // 7 chars
fn topic_locked() -> Symbol {
    symbol_short!("locked")
} // 6 chars
fn topic_completed() -> Symbol {
    symbol_short!("completed")
} // 9 chars (max limit for symbol_short!)
fn topic_cancelled() -> Symbol {
    symbol_short!("cancelled")
} // 9 chars (max limit for symbol_short!)
fn topic_disputed() -> Symbol {
    symbol_short!("disputed")
} // 8 chars
fn topic_resolved() -> Symbol {
    symbol_short!("resolved")
} // 8 chars
fn topic_contract() -> Symbol {
    symbol_short!("contract")
} // 8 chars
fn topic_paused() -> Symbol {
    symbol_short!("paused")
} // 6 chars
fn topic_unpaused() -> Symbol {
    symbol_short!("unpaused")
} // 8 chars
fn topic_token() -> Symbol {
    symbol_short!("token")
} // 5 chars
fn topic_allowed() -> Symbol {
    symbol_short!("allowed")
} // 7 chars
fn topic_removed() -> Symbol {
    symbol_short!("removed")
} // 7 chars
fn topic_released() -> Symbol {
    symbol_short!("released")
} // 8 chars
fn topic_admin() -> Symbol {
    symbol_short!("admin")
} // 5 chars
fn topic_transfer() -> Symbol {
    symbol_short!("transfer")
} // 8 chars

// Canonical state-transition events (issue #639). Each carries
// `(escrow_id, actor, amount, timestamp)` so indexers, audit tooling, and the
// backend oracle can subscribe to on-chain state changes instead of polling
// `get_trade`. Documented in `contracts/escrow/README.md`. These names are
// > 9 characters, so they must use `Symbol::new(env, "...")` rather than
// `symbol_short!` (see note above).
fn topic_escrow_created(env: &Env) -> Symbol {
    Symbol::new(env, "EscrowCreated")
}
fn topic_escrow_released(env: &Env) -> Symbol {
    Symbol::new(env, "EscrowReleased")
}
fn topic_escrow_refunded(env: &Env) -> Symbol {
    Symbol::new(env, "EscrowRefunded")
}
fn topic_escrow_disputed(env: &Env) -> Symbol {
    Symbol::new(env, "EscrowDisputed")
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn require_not_paused(env: &Env) -> Result<(), ContractError> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(ContractError::ContractPaused);
    }
    Ok(())
}

/// Contracts initialised before issue #636 have no `MaxAmount` entry; treat
/// them as uncapped until the admin calls `update_max_amount`.
fn get_max_amount(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::MaxAmount)
        .unwrap_or(DEFAULT_MAX_AMOUNT)
}

fn get_admin(env: &Env) -> Result<Address, ContractError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ContractError::Unauthorized)
}

const PAUSE_COOLDOWN_SECONDS: u64 = 300;

/// Rejects a deposit from a buyer who already holds an *active* sub-escrow on
/// this trade (issue #294).
///
/// Without this check a single buyer could call `deposit_to_escrow` repeatedly
/// with small amounts — each one individually within the remaining capacity —
/// and take over a listing that is meant to be shared by many buyers.
///
/// The rule is per `(trade, buyer)` and counts only *active* fills: a fill that
/// has already been released or refunded no longer holds a place, so a buyer
/// whose delivery completed (or whose funds were returned) can still buy into
/// a listing that is only partially filled.
fn require_no_active_fill(env: &Env, trade_id: u64, buyer: &Address) -> Result<(), ContractError> {
    let fill_count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::TradeFillCounter(trade_id))
        .unwrap_or(0);

    for i in 1..=fill_count {
        if let Some(sub_escrow) = env
            .storage()
            .persistent()
            .get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i))
        {
            if sub_escrow.buyer == *buyer && !sub_escrow.released && !sub_escrow.refunded {
                return Err(ContractError::DuplicateFill);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Sets the admin address, seeds the trade counter, whitelists initial payment tokens,
    /// and registers default asset categories (AIRTIME, DATA).
    ///
    /// Pre-conditions:
    /// - Contract has not been previously initialized.
    /// - Admin address must authorize the call (`admin.require_auth()`).
    ///
    /// Post-conditions:
    /// - Admin stored in contract instance storage.
    /// - Trade counter initialized to 0 and paused state to false.
    /// - Initial payment tokens and default categories whitelisted.
    pub fn initialize(
        env: Env,
        admin: Address,
        allowed_tokens: Vec<Address>,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TradeCounter, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        // `PausedAt` doubles as "the moment we entered the paused state": 0
        // means the contract has never been paused, so no cooldown applies.
        env.storage().instance().set(&DataKey::PausedAt, &0u64);
        for token in allowed_tokens.iter() {
            env.storage()
                .instance()
                .set(&DataKey::AllowedToken(token.clone()), &true);
        }
        // Seed default asset categories
        let airtime = Symbol::new(&env, "AIRTIME");
        let data = Symbol::new(&env, "DATA");
        env.storage()
            .instance()
            .set(&DataKey::AllowedCategory(airtime), &true);
        env.storage()
            .instance()
            .set(&DataKey::AllowedCategory(data), &true);
        // Dispute cooldown (issue #642) — set at initialization, default 3600s.
        env.storage()
            .instance()
            .set(&DataKey::DisputeCooldownSecs, &DEFAULT_DISPUTE_COOLDOWN_SECS);
        // Per-listing amount cap (issue #636).
        env.storage()
            .instance()
            .set(&DataKey::MaxAmount, &DEFAULT_MAX_AMOUNT);
        // Bump instance TTL so it survives long-running trades
        env.storage().instance().extend_ttl(17_280, 17_280 * 30);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // pause / unpause — admin-only circuit breakers
    // -----------------------------------------------------------------------

    /// Halts all state-mutating operations. Only callable by admin.
    /// Emits a `topics: ["contract", "paused"]` event.
    pub fn pause(env: Env) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();

        let is_already_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);

        let now = env.ledger().timestamp();
        if !is_already_paused {
            env.storage().instance().set(&DataKey::PausedAt, &now);
        }

        env.storage().instance().set(&DataKey::Paused, &true);

        env.events().publish((topic_contract(), topic_paused()), ());
        Ok(())
    }

    /// Resumes normal operations. Only callable by admin.
    /// Emits a `topics: ["contract", "unpaused"]` event.
    pub fn unpause(env: Env) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();

        let now = env.ledger().timestamp();
        let last_pause_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PausedAt)
            .unwrap_or(0);

        if last_pause_at > 0 && now < last_pause_at.saturating_add(PAUSE_COOLDOWN_SECONDS) {
            return Err(ContractError::PauseCooldownNotExpired);
        }

        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().remove(&DataKey::PausedAt);

        env.events()
            .publish((topic_contract(), topic_unpaused()), ());
        Ok(())
    }

    /// Registers a new trade offer on the ledger for airtime or data.
    ///
    /// Pre-conditions:
    /// - Contract must not be paused.
    /// - `seller` must authenticate transaction (`seller.require_auth()`).
    /// - `amount > 0`.
    /// - `token` must be in the approved `AllowedToken` set.
    /// - `asset_type` must be in the approved `AllowedCategory` set.
    /// - `expires_at > ledger.timestamp()` and within `MAX_EXPIRY_SECS` (30 days).
    ///
    /// Post-conditions:
    /// - Trade stored with `TradeStatus::Open`.
    /// - Trade counter incremented.
    /// - `trade_created` event emitted.
    /// - Returns new trade ID.
    pub fn create_listing(
        env: Env,
        seller: Address,
        token: Address,
        amount: i128,
        asset_type: Symbol,
        expires_at: u64,
    ) -> Result<u64, ContractError> {
        seller.require_auth();
        require_not_paused(&env)?;

        if !env
            .storage()
            .instance()
            .has(&DataKey::AllowedToken(token.clone()))
        {
            return Err(ContractError::UnsupportedToken);
        }

        if !env
            .storage()
            .instance()
            .has(&DataKey::AllowedCategory(asset_type.clone()))
        {
            return Err(ContractError::InvalidCategory);
        }

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        // Every fill is bounded by the remaining listing amount, so capping
        // the listing total caps the funds any single escrow can lock.
        if amount > get_max_amount(&env) {
            return Err(ContractError::AmountExceedsMax);
        }

        let now = env.ledger().timestamp();
        if expires_at <= now || expires_at > now + MAX_EXPIRY_SECS {
            return Err(ContractError::InvalidExpiry);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TradeCounter)
            .unwrap_or(0u64)
            + 1;
        env.storage().instance().set(&DataKey::TradeCounter, &id);

        let trade = TradeOffer {
            id,
            seller: seller.clone(),
            token,
            total_amount: amount,
            filled_amount: 0,
            asset_type: asset_type.clone(),
            status: TradeStatus::Open,
            expires_at,
        };

        env.storage().persistent().set(&DataKey::Trade(id), &trade);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Trade(id), 17_280, 17_280 * 30);

        env.events()
            .publish((topic_created(), asset_type), (id, seller.clone(), amount));

        // Canonical state-transition event (issue #639): escrow_id, actor,
        // amount, timestamp.
        env.events().publish(
            (topic_escrow_created(&env),),
            (id, seller, amount, now),
        );

        Ok(id)
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    /// Adds `token` to the set of tokens listings may be created/filled in.
    /// Emits a `topics: ["token", "allowed"]` event carrying the token
    /// address, so off-chain indexers and admin tooling can observe changes
    /// to the allow-list without polling every token individually.
    /// Admin-only: set the maximum `amount` a single listing may lock
    /// (issue #636). Must be positive. Existing listings are unaffected.
    /// Emits `topics: ["max_amt"]` with `(old_max, new_max)`.
    pub fn update_max_amount(env: Env, new_max: i128) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        if new_max <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let old_max = get_max_amount(&env);
        env.storage().instance().set(&DataKey::MaxAmount, &new_max);
        env.events()
            .publish((symbol_short!("max_amt"),), (old_max, new_max));
        Ok(())
    }

    /// Current per-listing amount cap (issue #636).
    pub fn max_amount(env: Env) -> i128 {
        get_max_amount(&env)
    }

    pub fn add_allowed_token(env: Env, token: Address) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token.clone()), &true);

        env.events()
            .publish((topic_token(), topic_allowed()), token);
        Ok(())
    }

    /// Removes `token` from the set of allowed tokens. Emits a
    /// `topics: ["token", "removed"]` event carrying the token address —
    /// previously this state change was silent on-chain.
    pub fn remove_allowed_token(env: Env, token: Address) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .remove(&DataKey::AllowedToken(token.clone()));

        env.events()
            .publish((topic_token(), topic_removed()), token);
        Ok(())
    }

    /// Adds `category` to the set of allowed asset category symbols.
    /// Only callable by admin. Emits a `topics: ["category", "allowed"]` event.
    pub fn add_category(env: Env, category: Symbol) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AllowedCategory(category.clone()), &true);
        env.events().publish(
            (symbol_short!("category"), symbol_short!("allowed")),
            category,
        );
        Ok(())
    }

    /// Removes `category` from the set of allowed asset category symbols.
    /// Only callable by admin. Emits a `topics: ["category", "removed"]` event.
    pub fn remove_category(env: Env, category: Symbol) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .remove(&DataKey::AllowedCategory(category.clone()));
        env.events().publish(
            (symbol_short!("category"), symbol_short!("removed")),
            category,
        );
        Ok(())
    }

    /// Transfers admin ownership to a new address.
    /// Only callable by the current admin.
    /// Emits a `topics: ["admin", "transfer"]` event with `(old_admin, new_admin)`.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events()
            .publish((topic_admin(), topic_transfer()), (admin, new_admin));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // deposit_to_escrow
    // -----------------------------------------------------------------------

    /// Locks the buyer's funds into the contract for a specific trade.
    ///
    /// Transfers `fill_amount` tokens from `buyer` → contract.
    /// Sets trade status to `Locked` when fully filled, `PartiallyFilled` otherwise.
    ///
    /// At most one *active* sub-escrow per buyer per trade is allowed — a buyer
    /// holding an unreleased/unrefunded fill on this trade is rejected with
    /// `DuplicateFill` (issue #294), so no single buyer can fill a public
    /// listing repeatedly and monopolise it.
    pub fn deposit_to_escrow(
        env: Env,
        buyer: Address,
        trade_id: u64,
        fill_amount: i128,
    ) -> Result<(), ContractError> {
        buyer.require_auth();
        require_not_paused(&env)?;

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        if trade.status != TradeStatus::Open && trade.status != TradeStatus::PartiallyFilled {
            return Err(ContractError::WrongStatus);
        }

        let now = env.ledger().timestamp();
        if now >= trade.expires_at {
            return Err(ContractError::TradeExpired);
        }

        if buyer == trade.seller {
            return Err(ContractError::Unauthorized);
        }

        // The admin address is the same key that later calls release_payment
        // (the delivery oracle) and resolve_dispute/cancel_and_refund on this
        // very trade. Letting it also act as the buyer would let one party
        // control both sides of the trade plus its own arbitration — a
        // conflict of interest with no legitimate use case here.
        let admin = get_admin(&env)?;
        if buyer == admin {
            return Err(ContractError::Unauthorized);
        }

        if fill_amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        // Reject dust fills below the minimum to prevent spam / storage exhaustion
        // (issue #506). Reject over-sized fills to guard against overflow edge
        // cases and cap single-fill exposure.
        if fill_amount < MIN_DEPOSIT_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if fill_amount > MAX_DEPOSIT_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }

        if fill_amount > trade.total_amount - trade.filled_amount {
            return Err(ContractError::InsufficientFunds);
        }

        // One active sub-escrow per (trade, buyer) — issue #294. Checked before
        // any funds move, so a rejected duplicate fill is a pure no-op on the
        // trade's capacity and on the buyer's balance.
        require_no_active_fill(&env, trade_id, &buyer)?;

        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(&buyer, &env.current_contract_address(), &fill_amount);

        trade.filled_amount += fill_amount;
        if trade.filled_amount == trade.total_amount {
            trade.status = TradeStatus::Locked;
        } else {
            trade.status = TradeStatus::PartiallyFilled;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id), &trade);

        let fill_id = env
            .storage()
            .instance()
            .get(&DataKey::TradeFillCounter(trade_id))
            .unwrap_or(0u64)
            + 1;
        env.storage()
            .instance()
            .set(&DataKey::TradeFillCounter(trade_id), &fill_id);

        let sub_escrow = SubEscrow {
            fill_id,
            buyer: buyer.clone(),
            amount: fill_amount,
            released: false,
            refunded: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::SubEscrow(trade_id, fill_id), &sub_escrow);

        // Record dispute window close deadline (Issue #504)
        let window_close = now.saturating_add(DISPUTE_WINDOW_SECS);
        env.storage()
            .persistent()
            .set(&DataKey::DisputeWindowCloseAt(trade_id), &window_close);
        env.storage().persistent().extend_ttl(
            &DataKey::DisputeWindowCloseAt(trade_id),
            17_280,
            17_280 * 30,
        );

        env.events().publish((topic_locked(),), (trade_id, buyer));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // release_payment
    // -----------------------------------------------------------------------

    /// Releases escrowed funds to the seller once delivery is confirmed.
    ///
    /// The admin address (set at `initialize`) must authorise this call via
    /// `require_auth()`. In production the admin is the platform server signing
    /// key that verifies off-chain delivery before releasing escrow.
    pub fn release_payment(env: Env, trade_id: u64, fill_id: u64) -> Result<(), ContractError> {
        require_not_paused(&env)?;

        let admin = get_admin(&env)?;
        admin.require_auth();

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::PartiallyFilled {
            return Err(ContractError::WrongStatus);
        }

        let mut sub_escrow: SubEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::SubEscrow(trade_id, fill_id))
            .ok_or(ContractError::TradeNotFound)?;

        if sub_escrow.released || sub_escrow.refunded {
            return Err(ContractError::FillAlreadyProcessed);
        }

        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(
            &env.current_contract_address(),
            &trade.seller,
            &sub_escrow.amount,
        );

        sub_escrow.released = true;
        env.storage()
            .persistent()
            .set(&DataKey::SubEscrow(trade_id, fill_id), &sub_escrow);

        let mut completed = false;
        if trade.filled_amount == trade.total_amount {
            let fill_count = env
                .storage()
                .instance()
                .get(&DataKey::TradeFillCounter(trade_id))
                .unwrap_or(0);
            let mut all_released = true;
            for i in 1..=fill_count {
                if let Some(sub) = env
                    .storage()
                    .persistent()
                    .get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i))
                {
                    if !sub.released && !sub.refunded {
                        all_released = false;
                        break;
                    }
                }
            }
            if all_released {
                trade.status = TradeStatus::Completed;
                env.storage()
                    .persistent()
                    .set(&DataKey::Trade(trade_id), &trade);
                completed = true;
            }
        }

        env.events().publish(
            (topic_released(),),
            (trade_id, fill_id, trade.seller.clone()),
        );

        // Canonical state-transition event (issue #639): escrow_id, actor,
        // amount, timestamp.
        let now = env.ledger().timestamp();
        env.events().publish(
            (topic_escrow_released(&env),),
            (trade_id, trade.seller.clone(), sub_escrow.amount, now),
        );

        if completed {
            env.events()
                .publish((topic_completed(),), (trade_id, trade.seller.clone()));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // release_by_timelock — called after dispute window elapses (Issue #504)
    // -----------------------------------------------------------------------

    /// Releases escrowed funds to the seller after the dispute window has elapsed
    /// without a dispute being flagged.
    ///
    /// Requirements:
    /// - Contract must not be paused.
    /// - `caller` must be the seller or admin.
    /// - The trade must not be in `Disputed` status (returns `Err(ContractError::AlreadyDisputed)`).
    /// - The trade must be in `Locked` or `PartiallyFilled` status.
    /// - Current ledger timestamp must be >= `dispute_window_close_at` (returns `Err(ContractError::TimelockNotExpired)`).
    /// - The specified `fill_id` must not be already released or refunded.
    pub fn release_by_timelock(
        env: Env,
        caller: Address,
        trade_id: u64,
        fill_id: u64,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        caller.require_auth();

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        let admin = get_admin(&env)?;
        if caller != trade.seller && caller != admin {
            return Err(ContractError::Unauthorized);
        }

        if trade.status == TradeStatus::Disputed {
            return Err(ContractError::AlreadyDisputed);
        }

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::PartiallyFilled {
            return Err(ContractError::WrongStatus);
        }

        let window_close: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::DisputeWindowCloseAt(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        let now = env.ledger().timestamp();
        if now < window_close {
            return Err(ContractError::TimelockNotExpired);
        }

        let mut sub_escrow: SubEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::SubEscrow(trade_id, fill_id))
            .ok_or(ContractError::TradeNotFound)?;

        if sub_escrow.released || sub_escrow.refunded {
            return Err(ContractError::FillAlreadyProcessed);
        }

        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(
            &env.current_contract_address(),
            &trade.seller,
            &sub_escrow.amount,
        );

        sub_escrow.released = true;
        env.storage()
            .persistent()
            .set(&DataKey::SubEscrow(trade_id, fill_id), &sub_escrow);

        let mut completed = false;
        if trade.filled_amount == trade.total_amount {
            let fill_count = env
                .storage()
                .instance()
                .get(&DataKey::TradeFillCounter(trade_id))
                .unwrap_or(0);
            let mut all_released = true;
            for i in 1..=fill_count {
                if let Some(sub) = env
                    .storage()
                    .persistent()
                    .get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i))
                {
                    if !sub.released && !sub.refunded {
                        all_released = false;
                        break;
                    }
                }
            }
            if all_released {
                trade.status = TradeStatus::Completed;
                env.storage()
                    .persistent()
                    .set(&DataKey::Trade(trade_id), &trade);
                completed = true;
            }
        }

        env.events().publish(
            (topic_released(),),
            (trade_id, fill_id, trade.seller.clone()),
        );

        // Canonical state-transition event (issue #639): escrow_id, actor,
        // amount, timestamp. `now` was already read above to check the
        // dispute-window timelock.
        env.events().publish(
            (topic_escrow_released(&env),),
            (trade_id, trade.seller.clone(), sub_escrow.amount, now),
        );

        if completed {
            env.events()
                .publish((topic_completed(),), (trade_id, trade.seller.clone()));
        }
        Ok(())
    }

    /// Refunds the buyer or closes an unfulfilled trade, callable by buyer after expiry or admin.
    ///
    /// Pre-conditions:
    /// - Contract must not be paused.
    /// - `caller` must authenticate transaction (`caller.require_auth()`).
    /// - If not admin, caller must be authorized party after `trade.expires_at`.
    /// - Trade status must not be `Completed`.
    ///
    /// Post-conditions:
    /// - Committed escrow tokens transferred back to buyer.
    /// - Trade status transitions to `TradeStatus::Cancelled`.
    /// - `trade_refunded` event emitted.
    pub fn cancel_and_refund(
        env: Env,
        caller: Address,
        trade_id: u64,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        caller.require_auth();

        let admin = get_admin(&env)?;
        let is_admin = caller == admin;

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        if trade.status != TradeStatus::Locked
            && trade.status != TradeStatus::Disputed
            && trade.status != TradeStatus::PartiallyFilled
        {
            return Err(ContractError::WrongStatus);
        }

        let now = env.ledger().timestamp();
        let fill_count = env
            .storage()
            .instance()
            .get(&DataKey::TradeFillCounter(trade_id))
            .unwrap_or(0);
        let mut refunded_amount = 0;
        let mut caller_has_fills = false;

        let token_client = token::Client::new(&env, &trade.token);

        for i in 1..=fill_count {
            if let Some(mut sub) = env
                .storage()
                .persistent()
                .get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i))
            {
                if !sub.released && !sub.refunded {
                    let is_buyer = sub.buyer == caller;
                    if is_admin || is_buyer {
                        if is_buyer && !is_admin && now < trade.expires_at {
                            return Err(ContractError::TimelockNotExpired);
                        }
                        caller_has_fills = true;
                        token_client.transfer(
                            &env.current_contract_address(),
                            &sub.buyer,
                            &sub.amount,
                        );
                        sub.refunded = true;
                        env.storage()
                            .persistent()
                            .set(&DataKey::SubEscrow(trade_id, i), &sub);
                        refunded_amount += sub.amount;

                        // Canonical state-transition event (issue #639):
                        // escrow_id, actor, amount, timestamp. Emitted per
                        // refunded buyer, since a single `cancel_and_refund`
                        // call can settle several sub-escrows at once.
                        env.events().publish(
                            (topic_escrow_refunded(&env),),
                            (trade_id, sub.buyer.clone(), sub.amount, now),
                        );
                    }
                }
            }
        }

        if !is_admin && !caller_has_fills {
            return Err(ContractError::Unauthorized);
        }

        // `refunded_amount` is the sum of sub-escrow amounts we just walked and
        // refunded above, so it should never exceed `filled_amount` — but a
        // plain `-=` would either silently wrap (host panics are disabled) or
        // abort the whole contract call on a host trap (this workspace builds
        // with `overflow-checks = true`) if that invariant were ever violated
        // by a future change. `checked_sub` turns that into an ordinary
        // `Result::Err` the caller can handle instead of a low-level trap.
        trade.filled_amount = trade
            .filled_amount
            .checked_sub(refunded_amount)
            .ok_or(ContractError::InsufficientFunds)?;

        if is_admin {
            trade.status = TradeStatus::Cancelled;
        } else if trade.filled_amount == 0 {
            trade.status = TradeStatus::Open;
        } else if trade.filled_amount < trade.total_amount {
            trade.status = TradeStatus::PartiallyFilled;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id), &trade);
        env.events()
            .publish((topic_cancelled(),), (trade_id, caller));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // close_expired_listing
    // -----------------------------------------------------------------------

    /// Removes an unfilled listing after its expiry so its persistent storage
    /// can be reclaimed. Anyone may trigger this cleanup.
    pub fn close_expired_listing(env: Env, trade_id: u64) -> Result<(), ContractError> {
        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        if trade.status != TradeStatus::Open {
            return Err(ContractError::WrongStatus);
        }

        if env.ledger().timestamp() < trade.expires_at {
            return Err(ContractError::TradeExpired);
        }

        trade.status = TradeStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id), &trade);
        env.storage().persistent().remove(&DataKey::Trade(trade_id));
        env.events().publish((topic_cancelled(),), (trade_id,));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // flag_dispute
    // -----------------------------------------------------------------------

    /// Escalates a fully-filled (`Locked`) trade to `Disputed`.
    ///
    /// `PartiallyFilled` trades are rejected with `WrongStatus`: delivery is
    /// only attempted once a trade is locked, so a buyer who deposited a
    /// single stroop has no delivery grievance yet and must not be able to
    /// freeze the seller's listing.
    ///
    /// Dispute-spam guard (issue #642): a repeat call on the same trade —
    /// whether re-flagging an already-`Disputed` trade or (if this contract
    /// ever reopens disputed trades in the future) flagging it again after
    /// resolution — is rejected with `DisputeCooldownActive` until
    /// `dispute_cooldown_seconds` (default 3600s, set at `initialize`) has
    /// elapsed since the previous flag. This stops either party from
    /// spamming the dispute path to exhaust the counterparty's ability to
    /// respond, or to game dispute-resolution timing. Once the cooldown has
    /// elapsed, flagging again on an already-`Disputed` trade is accepted as
    /// a re-escalation (e.g. to bump the last-flagged timestamp and re-notify
    /// the admin/oracle) rather than an error.
    pub fn flag_dispute(env: Env, caller: Address, trade_id: u64) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        caller.require_auth();

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        let now = env.ledger().timestamp();
        let cooldown: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DisputeCooldownSecs)
            .unwrap_or(DEFAULT_DISPUTE_COOLDOWN_SECS);
        if let Some(last_dispute_at) = env
            .storage()
            .persistent()
            .get::<_, u64>(&DataKey::LastDisputeAt(trade_id))
        {
            if now < last_dispute_at.saturating_add(cooldown) {
                return Err(ContractError::DisputeCooldownActive);
            }
        }

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::Disputed {
            return Err(ContractError::WrongStatus);
        }

        let mut is_party = caller == trade.seller;

        if !is_party {
            let fill_count = env
                .storage()
                .instance()
                .get(&DataKey::TradeFillCounter(trade_id))
                .unwrap_or(0);
            for i in 1..=fill_count {
                if let Some(sub) = env
                    .storage()
                    .persistent()
                    .get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i))
                {
                    if sub.buyer == caller {
                        is_party = true;
                        break;
                    }
                }
            }
        }

        if !is_party {
            return Err(ContractError::NotAParty);
        }

        trade.status = TradeStatus::Disputed;
        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id), &trade);

        env.storage()
            .persistent()
            .set(&DataKey::LastDisputeAt(trade_id), &now);
        env.storage().persistent().extend_ttl(
            &DataKey::LastDisputeAt(trade_id),
            17_280,
            17_280 * 30,
        );

        env.events()
            .publish((topic_disputed(),), (trade_id, caller.clone()));

        // Canonical state-transition event (issue #639): escrow_id, actor,
        // amount, timestamp. `amount` is the trade's currently-filled
        // (escrowed) balance at the time of the dispute.
        env.events().publish(
            (topic_escrow_disputed(&env),),
            (trade_id, caller, trade.filled_amount, now),
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // resolve_dispute — arbitrator (admin) settles a disputed trade (Issue #508)
    // -----------------------------------------------------------------------

    /// Settles a `Disputed` trade, releasing every still-escrowed sub-escrow
    /// either back to its buyer (`Refund`) or to the seller (`Release`).
    ///
    /// Mirrors the state machine documented in `AUDIT_PREP.md`:
    ///   `Disputed --> Completed : resolve_dispute(Release) [Admin]`
    ///   `Disputed --> Cancelled : resolve_dispute(Refund)  [Admin]`
    ///
    /// Authorisation is gated on the contract admin (the platform's
    /// arbitration key) via `admin.require_auth()`, so a caller that is not
    /// the arbitrator cannot move escrowed funds — the host rejects the
    /// invocation before any state changes (see
    /// `test_non_arbitrator_cannot_resolve_dispute`).
    pub fn resolve_dispute(
        env: Env,
        trade_id: u64,
        resolution: DisputeResolution,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;

        let admin = get_admin(&env)?;
        admin.require_auth();

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        if trade.status != TradeStatus::Disputed {
            return Err(ContractError::WrongStatus);
        }

        let fill_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TradeFillCounter(trade_id))
            .unwrap_or(0);
        if fill_count == 0 {
            return Err(ContractError::TradeNotFound);
        }

        let token_client = token::Client::new(&env, &trade.token);

        // Settle every still-escrowed sub-escrow in the direction the
        // arbitrator ruled. Fills already settled before the dispute (if any)
        // are left untouched.
        for i in 1..=fill_count {
            if let Some(mut sub) = env
                .storage()
                .persistent()
                .get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i))
            {
                if sub.released || sub.refunded {
                    continue;
                }

                let recipient = match &resolution {
                    DisputeResolution::Refund => sub.buyer.clone(),
                    DisputeResolution::Release => trade.seller.clone(),
                };
                token_client.transfer(
                    &env.current_contract_address(),
                    &recipient,
                    &sub.amount,
                );

                match &resolution {
                    DisputeResolution::Refund => sub.refunded = true,
                    DisputeResolution::Release => sub.released = true,
                }
                env.storage()
                    .persistent()
                    .set(&DataKey::SubEscrow(trade_id, i), &sub);

                env.events()
                    .publish((topic_resolved(),), (trade_id, i, recipient));
            }
        }

        // Transition the whole trade per the documented state machine:
        // Release -> Completed, Refund -> Cancelled.
        trade.status = match &resolution {
            DisputeResolution::Release => TradeStatus::Completed,
            DisputeResolution::Refund => TradeStatus::Cancelled,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id), &trade);

        match &resolution {
            DisputeResolution::Release => {
                env.events()
                    .publish((topic_completed(),), (trade_id, trade.seller.clone()));
            }
            DisputeResolution::Refund => {
                env.events().publish((topic_cancelled(),), (trade_id,));
            }
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // emergency_withdraw — admin recovery for trapped funds (Issue #346)
    // -----------------------------------------------------------------------

    /// Recovers trapped funds in the event of a critical bug or settlement deadlock.
    ///
    /// Requirements:
    /// - Callable only by the admin.
    /// - Contract must be currently paused.
    /// - A 72-hour timelock must have elapsed since the contract was paused.
    /// - Emits a high-severity `emergency_withdrawal` event.
    pub fn emergency_withdraw(
        env: Env,
        token: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);

        if !is_paused {
            return Err(ContractError::WrongStatus);
        }

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let paused_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PausedAt)
            .unwrap_or(0);

        let now = env.ledger().timestamp();
        if now < paused_at + EMERGENCY_TIMELOCK_SECS {
            return Err(ContractError::TimelockNotExpired);
        }

        let token_client = token::Client::new(&env, &token);
        let contract_balance = token_client.balance(&env.current_contract_address());
        if contract_balance < amount {
            return Err(ContractError::InsufficientFunds);
        }

        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        env.events().publish(
            (Symbol::new(&env, "emergency_withdrawal"),),
            (token, recipient, amount),
        );

        Ok(())
    }

    /// Read-only query returning the current state of a trade offer.
    ///
    /// Pre-conditions:
    /// - Trade ID must exist in contract storage.
    ///
    /// Post-conditions:
    /// - Returns `TradeOffer` struct and extends entry TTL.
    pub fn get_trade(env: Env, trade_id: u64) -> Result<TradeOffer, ContractError> {
        let trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        // Reading an entry does not by itself keep it alive: extend the TTL on
        // every read, not just on write (as create_listing already does).
        // Without this, a trade that is read frequently but written rarely
        // (e.g. repeatedly polled while Locked, waiting on off-chain delivery)
        // can still be evicted between the read here and a later write, since
        // the two are not atomic from the caller's perspective (TOCTOU).
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Trade(trade_id), 17_280, 17_280 * 30);

        Ok(trade)
    }

    /// Returns the total number of trade offers ever created.
    pub fn trade_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TradeCounter)
            .unwrap_or(0u64)
    }

    /// Returns the currently configured administrative address for the contract.
    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Returns the Unix timestamp when the dispute window closes for `trade_id`.
    pub fn get_dispute_window_close_at(env: Env, trade_id: u64) -> Result<u64, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::DisputeWindowCloseAt(trade_id))
            .ok_or(ContractError::TradeNotFound)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
        token::{Client as TokenClient, StellarAssetClient},
        vec, Address, Env, IntoVal,
    };

    fn setup() -> (
        Env,
        EscrowContractClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_address);

        sac.mint(&buyer, &100_000_000_000i128);

        let allowed_tokens = vec![&env, token_address.clone()];
        client.initialize(&admin, &allowed_tokens);

        (env, client, admin, seller, buyer, token_address)
    }

    // -----------------------------------------------------------------------
    // Existing functional tests (updated to use Result-returning functions)
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Issue #636: per-listing amount cap
    // -----------------------------------------------------------------------

    #[test]
    fn test_max_amount_defaults_to_uncapped() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();
        assert_eq!(client.max_amount(), DEFAULT_MAX_AMOUNT);
    }

    #[test]
    fn test_create_listing_at_max_amount_succeeds() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        client.update_max_amount(&1_000_0000000i128);

        assert!(client.try_create_listing(&seller, &token, &1_000_0000000i128, &symbol_short!("AIRTIME"), &(1_000_000 + 86_400)).is_ok());
    }

    #[test]
    fn test_create_listing_above_max_amount_fails() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        client.update_max_amount(&1_000_0000000i128);

        assert_eq!(
            client.try_create_listing(&seller, &token, &1_000_0000001i128, &symbol_short!("AIRTIME"), &(1_000_000 + 86_400)),
            Err(Ok(ContractError::AmountExceedsMax))
        );
        assert_eq!(client.trade_count(), 0);
    }

    #[test]
    fn test_admin_can_raise_and_lower_max_amount() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.update_max_amount(&100i128);
        assert_eq!(client.try_create_listing(&seller, &token, &101i128, &symbol_short!("AIRTIME"), &(1_000_000 + 86_400)), Err(Ok(ContractError::AmountExceedsMax)));

        client.update_max_amount(&1_000i128);
        assert_eq!(client.max_amount(), 1_000);
        assert!(client.try_create_listing(&seller, &token, &101i128, &symbol_short!("AIRTIME"), &(1_000_000 + 86_400)).is_ok());
    }

    #[test]
    fn test_update_max_amount_rejects_non_positive() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();
        assert_eq!(client.try_update_max_amount(&0i128), Err(Ok(ContractError::InvalidAmount)));
        assert_eq!(client.try_update_max_amount(&-5i128), Err(Ok(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_update_max_amount_requires_admin_auth() {
        let (env, client, _admin, seller, _buyer, _token) = setup();
        env.set_auths(&[]);
        let result = client
            .mock_auths(&[MockAuth {
                address: &seller,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "update_max_amount",
                    args: (5i128,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_update_max_amount(&5i128);
        assert!(result.is_err());
        assert_eq!(client.max_amount(), DEFAULT_MAX_AMOUNT);
    }

    #[test]
    fn test_create_listing() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        assert_eq!(trade_id, 1);
        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Open);
        assert_eq!(trade.seller, seller);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_create_listing_unauthorised_seller_rejected() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let expires_at = 1_000_000u64 + 86_400;

        // `set_auths(&[])` turns off the auth mocking `setup()` enabled, so the
        // seller's `require_auth()` runs for real and has to fail.
        env.set_auths(&[]);

        client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &expires_at,
        );
    }

    #[test]
    fn test_create_listing_authorised_seller_succeeds() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let expires_at = 1_000_000u64 + 86_400;

        // Only the seller's signature is mocked, so the listing can only be
        // created if that auth satisfies `seller.require_auth()`.
        env.mock_auths(&[MockAuth {
            address: &seller,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "create_listing",
                args: (
                    &seller,
                    &token,
                    &500_0000000i128,
                    &symbol_short!("AIRTIME"),
                    &expires_at,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &expires_at,
        );

        assert_eq!(trade_id, 1);
        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Open);
        assert_eq!(trade.seller, seller);
    }

    #[test]
    fn test_deposit_to_escrow_full_fill() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.filled_amount, 500_0000000i128);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_deposit_to_escrow_unauthorised_buyer_rejected() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        // No auth is provided, so the buyer's `require_auth()` cannot pass.
        env.set_auths(&[]);

        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
    }

    #[test]
    fn test_deposit_to_escrow_authorised_buyer_succeeds() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        // Only the buyer's signature is mocked, so the deposit can only land if
        // that auth covers both the root call and the token transfer it nests.
        env.mock_auths(&[MockAuth {
            address: &buyer,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "deposit_to_escrow",
                args: (&buyer, &trade_id, &500_0000000i128).into_val(&env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &token,
                    fn_name: "transfer",
                    args: (&buyer, &client.address, &500_0000000i128).into_val(&env),
                    sub_invokes: &[],
                }],
            },
        }]);

        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.filled_amount, 500_0000000i128);
    }

    #[test]
    fn test_deposit_to_escrow_partial_fill() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id, &200_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::PartiallyFilled);
        assert_eq!(trade.filled_amount, 200_0000000i128);
    }

    #[test]
    fn test_deposit_to_escrow_multiple_fills() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id, &200_0000000i128);

        let buyer2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&buyer2, &500_0000000i128);

        client.deposit_to_escrow(&buyer2, &trade_id, &300_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.filled_amount, 500_0000000i128);
    }

    // -----------------------------------------------------------------------
    // Issue #294 — one active sub-escrow per (trade, buyer)
    // -----------------------------------------------------------------------

    /// A buyer cannot stack a second active fill on the same listing: the
    /// monopolising pattern from the issue (repeated deposits that each fit the
    /// remaining capacity) is rejected with `DuplicateFill`.
    #[test]
    fn test_deposit_to_escrow_rejects_duplicate_fill_by_same_buyer() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id, &100_0000000i128);

        // Second and third fills by the same buyer while the first is active.
        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &100_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::DuplicateFill)));

        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &400_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::DuplicateFill)));

        // The rejected attempts moved no money and consumed no capacity, so the
        // remainder of the listing stays available to other buyers.
        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::PartiallyFilled);
        assert_eq!(trade.filled_amount, 100_0000000i128);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(
            token_client.balance(&buyer),
            100_000_000_000i128 - 100_0000000i128
        );
    }

    /// The limit is per buyer, not per trade: several buyers can still split a
    /// listing, and the trade only locks once the capacity is exhausted.
    #[test]
    fn test_deposit_to_escrow_multi_buyer_partial_fills() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        let sac = StellarAssetClient::new(&env, &token);
        let buyer2 = Address::generate(&env);
        let buyer3 = Address::generate(&env);
        sac.mint(&buyer2, &200_0000000i128);
        sac.mint(&buyer3, &200_0000000i128);

        client.deposit_to_escrow(&buyer, &trade_id, &200_0000000i128);
        client.deposit_to_escrow(&buyer2, &trade_id, &200_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::PartiallyFilled);
        assert_eq!(trade.filled_amount, 400_0000000i128);

        client.deposit_to_escrow(&buyer3, &trade_id, &100_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.filled_amount, 500_0000000i128);

        // Each buyer deposited exactly once, so all three fills are distinct
        // and independently releasable.
        client.release_payment(&trade_id, &1);
        client.release_payment(&trade_id, &2);
        client.release_payment(&trade_id, &3);

        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Completed);
        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&seller), 500_0000000i128);
    }

    /// "Active" is the rule, not "has ever deposited": once a buyer's fill has
    /// been settled they may buy into the same (still partially filled)
    /// listing again, which opens a new sub-escrow with a new fill id.
    #[test]
    fn test_deposit_to_escrow_allows_refill_after_release() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id, &200_0000000i128);
        // Fill #1 is delivered and settled while the listing is still open.
        client.release_payment(&trade_id, &1);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::PartiallyFilled);
        assert_eq!(trade.filled_amount, 200_0000000i128);

        // The buyer holds no active fill any more, so a second deposit is
        // accepted rather than rejected as a duplicate.
        client.deposit_to_escrow(&buyer, &trade_id, &300_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.filled_amount, 500_0000000i128);

        // The settled fill stays settled: only the new fill #2 is releasable.
        let result = client.try_release_payment(&trade_id, &1);
        assert_eq!(result, Err(Ok(ContractError::FillAlreadyProcessed)));

        client.release_payment(&trade_id, &2);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Completed);
    }

    #[test]
    fn test_release_payment() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        client.release_payment(&trade_id, &1);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Completed);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&seller), 500_0000000i128);
    }

    #[test]
    fn test_cancel_and_refund_after_expiry() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_401);

        client.cancel_and_refund(&buyer, &trade_id);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Open);
        assert_eq!(trade.filled_amount, 0);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&buyer), 100_000_000_000i128);
    }

    #[test]
    fn test_admin_cancels_immediately() {
        let (env, client, admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        client.cancel_and_refund(&admin, &trade_id);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Cancelled);
        assert_eq!(trade.filled_amount, 0);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&buyer), 100_000_000_000i128);
    }

    #[test]
    fn test_close_expired_open_listing_removes_storage() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_400);
        client.close_expired_listing(&trade_id);

        assert_eq!(
            client.try_get_trade(&trade_id),
            Err(Ok(ContractError::TradeNotFound))
        );
    }

    #[test]
    fn test_close_expired_listing_rejects_unexpired_listing() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        let result = client.try_close_expired_listing(&trade_id);

        assert_eq!(result, Err(Ok(ContractError::TradeExpired)));
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Open);
    }

    #[test]
    fn test_close_expired_listing_rejects_filled_listing() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_400);

        let result = client.try_close_expired_listing(&trade_id);

        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Locked);
    }

    // -----------------------------------------------------------------------
    // Error variant tests — assert typed ContractError is returned
    // -----------------------------------------------------------------------

    #[test]
    fn test_err_already_initialized() {
        let (env, client, admin, _seller, _buyer, token) = setup();
        // setup() already called initialize; call it again
        let allowed = vec![&env, token.clone()];
        let result = client.try_initialize(&admin, &allowed);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_err_trade_not_found() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();
        let result = client.try_get_trade(&999u64);
        assert_eq!(result, Err(Ok(ContractError::TradeNotFound)));
    }

    #[test]
    fn test_err_unsupported_token() {
        let (env, client, _admin, seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        // Generate an address that was never added to the allowed list
        let bad_token = Address::generate(&env);
        let result = client.try_create_listing(
            &seller,
            &bad_token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Err(Ok(ContractError::UnsupportedToken)));
    }

    #[test]
    fn test_err_invalid_amount_zero() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let result = client.try_create_listing(
            &seller,
            &token,
            &0i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_err_invalid_expiry() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        // expires_at in the past
        let result = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &999_999u64,
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidExpiry)));
    }

    #[test]
    fn test_err_wrong_status_deposit_on_completed_trade() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        client.release_payment(&trade_id, &1);
        // trade is now Completed — depositing again should fail
        let buyer2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&buyer2, &500_0000000i128);
        let result = client.try_deposit_to_escrow(&buyer2, &trade_id, &100_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
    }

    #[test]
    fn test_err_trade_expired() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        // Advance time past expiry
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_401);

        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::TradeExpired)));
    }

    #[test]
    fn test_err_insufficient_funds_overfill() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &600_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::InsufficientFunds)));
    }

    #[test]
    fn test_err_wrong_status_release_on_open_trade() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        // No deposit — trade is still Open
        let result = client.try_release_payment(&trade_id, &1);
        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
    }

    #[test]
    fn test_err_fill_already_processed() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        // A *partial* fill keeps the trade out of its terminal state once the
        // fill settles, which is what makes a second release reach the
        // already-processed guard instead of the terminal-state check.
        client.deposit_to_escrow(&buyer, &trade_id, &200_0000000i128);
        // Release fill #1 once
        client.release_payment(&trade_id, &1);
        // Release same fill again — should fail
        let result = client.try_release_payment(&trade_id, &1);
        assert_eq!(result, Err(Ok(ContractError::FillAlreadyProcessed)));
    }

    #[test]
    fn test_err_timelock_not_expired() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        // Buyer tries to cancel before expiry
        let result = client.try_cancel_and_refund(&buyer, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::TimelockNotExpired)));
    }

    #[test]
    fn test_err_unauthorized_seller_cancel() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        // Seller is not a buyer and not admin — should get Unauthorized
        let result = client.try_cancel_and_refund(&seller, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    // -----------------------------------------------------------------------
    // Issue #642 — dispute cooldown (anti-spam on flag_dispute)
    // -----------------------------------------------------------------------

    /// First dispute on a Locked trade succeeds; an immediate second flag —
    /// from either the same or a different party — is rejected with the new
    /// `DisputeCooldownActive` error rather than being silently accepted or
    /// panicking, superseding the old `AlreadyDisputed`-only behaviour now
    /// that re-flagging is permitted once the cooldown elapses (see
    /// `test_flag_dispute_succeeds_again_after_cooldown_elapses` below).
    #[test]
    fn test_err_dispute_cooldown_active_on_immediate_redispute() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        // First flag succeeds.
        client.flag_dispute(&seller, &trade_id);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Disputed);

        // Immediate second flag (same ledger timestamp) on the same trade —
        // from the other party — is rejected by the cooldown guard.
        let result = client.try_flag_dispute(&buyer, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::DisputeCooldownActive)));
    }

    /// Once `dispute_cooldown_seconds` (default 3600s) has elapsed since the
    /// last flag, calling `flag_dispute` again on the same (still-Disputed)
    /// trade succeeds rather than erroring, allowing a party to re-escalate.
    #[test]
    fn test_flag_dispute_succeeds_again_after_cooldown_elapses() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        client.flag_dispute(&seller, &trade_id);

        // Advance past the default 3600s cooldown window.
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + DEFAULT_DISPUTE_COOLDOWN_SECS + 1);

        // Re-flagging now succeeds instead of erroring.
        let result = client.try_flag_dispute(&buyer, &trade_id);
        assert!(result.is_ok());
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Disputed);
    }

    // -----------------------------------------------------------------------
    // Issue #639 — Soroban events for every escrow state transition
    // -----------------------------------------------------------------------

    #[test]
    fn test_escrow_created_event_emitted() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        let created_symbol = Symbol::new(&env, "EscrowCreated");
        let all_events = env.events().all();
        let has_created = all_events
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&created_symbol.to_val())));
        assert!(has_created, "EscrowCreated event should be published");
    }

    #[test]
    fn test_escrow_released_event_emitted() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        client.release_payment(&trade_id, &1);

        let released_symbol = Symbol::new(&env, "EscrowReleased");
        let all_events = env.events().all();
        let has_released = all_events
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&released_symbol.to_val())));
        assert!(has_released, "EscrowReleased event should be published");
    }

    #[test]
    fn test_escrow_refunded_event_emitted() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        // Buyer can only self-refund after expiry.
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_401);
        client.cancel_and_refund(&buyer, &trade_id);

        let refunded_symbol = Symbol::new(&env, "EscrowRefunded");
        let all_events = env.events().all();
        let has_refunded = all_events
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&refunded_symbol.to_val())));
        assert!(has_refunded, "EscrowRefunded event should be published");
    }

    #[test]
    fn test_escrow_disputed_event_emitted() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        client.flag_dispute(&seller, &trade_id);

        let disputed_symbol = Symbol::new(&env, "EscrowDisputed");
        let all_events = env.events().all();
        let has_disputed = all_events
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&disputed_symbol.to_val())));
        assert!(has_disputed, "EscrowDisputed event should be published");
    }

    #[test]
    fn test_err_not_a_party() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let stranger = Address::generate(&env);
        let result = client.try_flag_dispute(&stranger, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::NotAParty)));
    }

    #[test]
    fn test_err_contract_paused() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        let result = client.try_create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn test_err_unpause_requires_pause_cooldown() {
        let (env, client, _admin, _seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        let result = client.try_unpause();
        assert_eq!(result, Err(Ok(ContractError::PauseCooldownNotExpired)));
    }

    #[test]
    fn test_unpause_after_cooldown_succeeds() {
        let (env, client, _admin, _seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 301);

        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    fn test_err_unauthorized_get_admin_uninitialised() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        // Contract not initialised — get_admin should return Unauthorized
        let result = client.try_get_admin();
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    // -----------------------------------------------------------------------
    // Input validation — deposit amount bounds (issue #506)
    //
    // Tests that `deposit_to_escrow` enforces MIN_DEPOSIT_AMOUNT and
    // MAX_DEPOSIT_AMOUNT. Each test includes both a negative case (rejected)
    // and a positive case (accepted) to confirm the boundary is correctly placed.
    // -----------------------------------------------------------------------

    /// A deposit below `MIN_DEPOSIT_AMOUNT` (dust) must be rejected with
    /// `InvalidAmount`. A deposit at exactly `MIN_DEPOSIT_AMOUNT` must succeed.
    #[test]
    fn test_deposit_below_minimum_rejected() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        // 1 stroop — far below MIN_DEPOSIT_AMOUNT (1_000_000)
        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &1i128);
        assert_eq!(
            result,
            Err(Ok(ContractError::InvalidAmount)),
            "1-stroop deposit must be rejected with InvalidAmount"
        );

        // MIN_DEPOSIT_AMOUNT - 1 — one stroop below the floor
        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &(MIN_DEPOSIT_AMOUNT - 1));
        assert_eq!(
            result,
            Err(Ok(ContractError::InvalidAmount)),
            "deposit one stroop below MIN_DEPOSIT_AMOUNT must be rejected"
        );

        // Exactly MIN_DEPOSIT_AMOUNT — must succeed (positive case)
        client.deposit_to_escrow(&buyer, &trade_id, &MIN_DEPOSIT_AMOUNT);
        let trade = client.get_trade(&trade_id);
        assert_eq!(
            trade.filled_amount, MIN_DEPOSIT_AMOUNT,
            "deposit at exactly MIN_DEPOSIT_AMOUNT must be accepted"
        );
    }

    /// A deposit above `MAX_DEPOSIT_AMOUNT` must be rejected with `InvalidAmount`.
    /// A deposit at exactly `MAX_DEPOSIT_AMOUNT` (when the listing is large enough)
    /// must succeed.
    #[test]
    fn test_deposit_above_maximum_rejected() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        // Create a listing sized at MAX_DEPOSIT_AMOUNT so we can test the exact boundary
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token);
        // Mint enough to cover MAX_DEPOSIT_AMOUNT + 1 for the buyer
        sac.mint(&buyer, &(MAX_DEPOSIT_AMOUNT + 1));

        let trade_id = client.create_listing(
            &seller,
            &token,
            &MAX_DEPOSIT_AMOUNT,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        // MAX_DEPOSIT_AMOUNT + 1 — one stroop above the ceiling
        let result = client.try_deposit_to_escrow(&buyer, &trade_id, &(MAX_DEPOSIT_AMOUNT + 1));
        assert_eq!(
            result,
            Err(Ok(ContractError::InvalidAmount)),
            "deposit one stroop above MAX_DEPOSIT_AMOUNT must be rejected"
        );

        // Exactly MAX_DEPOSIT_AMOUNT — must succeed (positive case)
        client.deposit_to_escrow(&buyer, &trade_id, &MAX_DEPOSIT_AMOUNT);
        let trade = client.get_trade(&trade_id);
        assert_eq!(
            trade.filled_amount, MAX_DEPOSIT_AMOUNT,
            "deposit at exactly MAX_DEPOSIT_AMOUNT must be accepted"
        );
    }

    /// Existing tests with amounts between MIN and MAX must continue to pass —
    /// confirms the new bounds do not break backward compatibility for normal
    /// trade sizes. All standard test amounts (200_0000000 to 500_0000000)
    /// are within [MIN_DEPOSIT_AMOUNT, MAX_DEPOSIT_AMOUNT].
    #[test]
    fn test_deposit_normal_amount_within_bounds_accepted() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );

        // 500 XLM — well within bounds
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.filled_amount, 500_0000000i128);
        assert_eq!(trade.status, TradeStatus::Locked);
    }
}

    #[test]
    fn test_event_topic_lengths_and_long_topic_handling() {
        let env = Env::default();

        // Compile-time & runtime verification that symbol_short! topics stay within <= 9 chars
        const SHORT_TOPICS: &[&str] = &[
            "created",
            "locked",
            "completed",
            "cancelled",
            "disputed",
            "contract",
            "paused",
            "unpaused",
            "token",
            "allowed",
            "removed",
            "category",
            "released",
            "admin",
            "transfer",
        ];

        for topic in SHORT_TOPICS {
            assert!(
                topic.len() <= 9,
                "symbol_short! topic '{topic}' exceeds 9 characters"
            );
        }

        // Test topic functions
        let _ = topic_created();
        let _ = topic_locked();
        let _ = topic_completed();
        let _ = topic_cancelled();
        let _ = topic_disputed();
        let _ = topic_contract();
        let _ = topic_paused();
        let _ = topic_unpaused();
        let _ = topic_token();
        let _ = topic_allowed();
        let _ = topic_removed();
        let _ = topic_released();
        let _ = topic_admin();
        let _ = topic_transfer();

        // Verify that longer/new topics (> 9 chars, e.g. "emergency_withdrawal") work with Symbol::new(&env, ...)
        let long_topic = Symbol::new(&env, "emergency_withdrawal");
        assert_eq!(long_topic, Symbol::new(&env, "emergency_withdrawal"));
    }

    // -----------------------------------------------------------------------
    // Category validation tests
    // -----------------------------------------------------------------------

    /// Default categories (AIRTIME, DATA) seeded at initialize are accepted.
    #[test]
    fn test_default_categories_accepted() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(trade_id, 1);

        let trade_id2 = client.create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(trade_id2, 2);
    }

    /// An unknown category symbol is rejected with InvalidCategory.
    #[test]
    fn test_err_invalid_category_unknown_symbol() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let result = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("GIFT"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidCategory)));
    }

    /// Admin can add a new category; listings using it are then accepted.
    #[test]
    fn test_admin_add_category_then_listing_succeeds() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        // "ELEC" (electricity voucher) is not seeded by default — should fail first.
        let result_before = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("ELEC"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(result_before, Err(Ok(ContractError::InvalidCategory)));

        // Admin adds the category.
        client.add_category(&symbol_short!("ELEC"));

        // Now the listing should succeed.
        let trade_id = client.create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("ELEC"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(trade_id, 1);
        assert_eq!(
            client.get_trade(&trade_id).asset_type,
            symbol_short!("ELEC")
        );
    }

    /// Admin can remove a category; listings using it are then rejected.
    #[test]
    fn test_admin_remove_category_then_listing_fails() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        // AIRTIME is seeded by default — listing works before removal.
        let trade_id = client.create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(trade_id, 1);

        // Admin removes AIRTIME from allowed categories.
        client.remove_category(&symbol_short!("AIRTIME"));

        // Subsequent listing with AIRTIME should now fail.
        let result = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidCategory)));
    }

    /// Non-admin cannot call add_category.
    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_err_non_admin_cannot_add_category() {
        let (env, client, _admin, _seller, _buyer, _token) = setup();

        env.set_auths(&[]);
        client.add_category(&symbol_short!("GIFT"));
    }

    /// Non-admin cannot call remove_category.
    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_err_non_admin_cannot_remove_category() {
        let (env, client, _admin, _seller, _buyer, _token) = setup();

        env.set_auths(&[]);
        client.remove_category(&symbol_short!("DATA"));
    }

    #[test]
    fn test_create_listing_max_expiry_window() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        let now = 1_000_000u64;
        env.ledger().with_mut(|l| l.timestamp = now);

        // Exceeds max expiry window
        let result = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &(now + MAX_EXPIRY_SECS + 1),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidExpiry)));

        // At exact max expiry window -> succeeds
        let trade_id = client.create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &symbol_short!("AIRTIME"),
            &(now + MAX_EXPIRY_SECS),
        );
        assert_eq!(trade_id, 1);
    }

    #[test]
    fn test_transfer_admin_authorized_and_functional() {
        let (env, client, admin, _seller, _buyer, _token) = setup();
        assert_eq!(client.get_admin(), admin);

        let new_admin = Address::generate(&env);
        client.transfer_admin(&new_admin);
        assert_eq!(client.get_admin(), new_admin);

        // Verify new admin can perform admin-only operation (pause)
        client.pause();
        assert!(client.is_paused());
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_err_transfer_admin_unauthorized() {
        let (env, client, _admin, _seller, _buyer, _token) = setup();
        let new_admin = Address::generate(&env);

        env.set_auths(&[]);
        client.transfer_admin(&new_admin);
    }

    #[test]
    fn test_release_payment_event_topics_partial_and_completed() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );

        // First deposit: partial fill (200 out of 500)
        client.deposit_to_escrow(&buyer, &trade_id, &200_0000000i128);

        // Release first fill
        client.release_payment(&trade_id, &1);

        // Check events after partial release: topic "released" is present, but "completed" is NOT
        let all_events = env.events().all();
        let released_symbol = symbol_short!("released");
        let completed_symbol = symbol_short!("completed");

        let has_released = all_events
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&released_symbol.to_val())));
        let has_completed = all_events
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&completed_symbol.to_val())));

        assert!(has_released, "Event topic 'released' should be published");
        assert!(
            !has_completed,
            "Event topic 'completed' should NOT be published on partial release"
        );

        // Second deposit: completes remaining 300
        client.deposit_to_escrow(&buyer, &trade_id, &300_0000000i128);
        client.release_payment(&trade_id, &2);

        // Check events after final release: now "completed" MUST be present
        let all_events_after = env.events().all();
        let has_completed_final = all_events_after
            .iter()
            .any(|e| e.1.iter().any(|t| t.shallow_eq(&completed_symbol.to_val())));
        assert!(
            has_completed_final,
            "Event topic 'completed' should be published on trade completion"
        );
    }

    // -----------------------------------------------------------------------
    // Escrow Release Timelock After Dispute Window (Issue #504)
    // -----------------------------------------------------------------------

    #[test]
    fn test_release_by_timelock_blocked_before_window_closes() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let window_close = client.get_dispute_window_close_at(&trade_id);
        assert_eq!(window_close, 1_000_000 + DISPUTE_WINDOW_SECS);

        // Advance time partially (only 1 hour into 24-hour dispute window)
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 3600);

        // Seller attempts early self-release before dispute window expires
        let result = client.try_release_by_timelock(&seller, &trade_id, &1);
        assert_eq!(result, Err(Ok(ContractError::TimelockNotExpired)));
    }

    #[test]
    fn test_release_by_timelock_succeeds_after_window_elapses() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        // Advance ledger time past the dispute window
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + DISPUTE_WINDOW_SECS + 1);

        // Beneficiary (seller) self-releases funds
        let token_client = token::Client::new(&env, &token);
        let seller_balance_before = token_client.balance(&seller);

        client.release_by_timelock(&seller, &trade_id, &1);

        let seller_balance_after = token_client.balance(&seller);
        assert_eq!(
            seller_balance_after - seller_balance_before,
            500_0000000i128
        );

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Completed);
    }

    #[test]
    fn test_release_by_timelock_blocked_during_open_dispute() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        // Buyer flags dispute within dispute window
        client.flag_dispute(&buyer, &trade_id);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Disputed);

        // Even after dispute window timestamp has passed...
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + DISPUTE_WINDOW_SECS + 3600);

        // Release must be blocked because dispute is open
        let result = client.try_release_by_timelock(&seller, &trade_id, &1);
        assert_eq!(result, Err(Ok(ContractError::AlreadyDisputed)));
    }

    #[test]
    fn test_release_by_timelock_unauthorized_caller_rejected() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + DISPUTE_WINDOW_SECS + 1);

        let stranger = Address::generate(&env);
        let result = client.try_release_by_timelock(&stranger, &trade_id, &1);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }
}

// ---------------------------------------------------------------------------
// Fuzz-style tests — numeric arithmetic on stroop amounts and fill counters
// ---------------------------------------------------------------------------
//
// This workspace has no fuzzing harness set up (no cargo-fuzz target, no
// proptest/quickcheck dependency), and adding an external crate here isn't
// something this change can verify resolves without network access to
// crates.io and a Cargo.lock update. Instead, this uses a small deterministic
// PRNG (xorshift64, no new dependency) to exercise deposit_to_escrow and
// cancel_and_refund across many randomised stroop amounts, fill splits, and
// fill counts, asserting the arithmetic invariants around `filled_amount`
// and the fill counter hold for every generated case rather than just the
// handful of fixed values the existing unit tests use. Each test seeds its
// PRNG with a fixed constant so a failure is reproducible.
#[cfg(test)]
mod fuzz {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        vec, Address, Env,
    };

    /// Minimal deterministic PRNG (xorshift64).
    struct Xorshift64(u64);

    impl Xorshift64 {
        fn new(seed: u64) -> Self {
            // xorshift64 requires a non-zero state.
            Xorshift64(if seed == 0 { 0x9E3779B97F4A7C15 } else { seed })
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        /// Returns a value in the inclusive range [min, max].
        fn range_i128(&mut self, min: i128, max: i128) -> i128 {
            debug_assert!(max >= min);
            let span = (max - min + 1) as u128;
            min + (self.next_u64() as u128 % span) as i128
        }
    }

    fn setup() -> (
        Env,
        EscrowContractClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();

        let allowed_tokens = vec![&env, token_address.clone()];
        client.initialize(&admin, &allowed_tokens);

        (env, client, admin, seller, token_address)
    }

    /// Fuzzes deposit_to_escrow with random total amounts and random
    /// multi-buyer partial fills (stroop amounts), asserting that
    /// `filled_amount` never exceeds `total_amount`, that it always equals
    /// the running sum of accepted fills, and that any attempt to fill more
    /// than what remains is rejected with InsufficientFunds — never a panic
    /// or a silently wrapped value.
    #[test]
    fn fuzz_deposit_to_escrow_never_exceeds_total() {
        let mut rng = Xorshift64::new(0xC0FFEE);

        for iteration in 0..200u32 {
            let (env, client, _admin, seller, token) = setup();
            env.ledger().with_mut(|l| l.timestamp = 1_000_000);

            // Random total amount: 1 stroop up to ~10,000 XLM in stroops.
            let total_amount = rng.range_i128(1, 1_000_000_000_000i128);

            let trade_id = client.create_listing(
                &seller,
                &token,
                &total_amount,
                &symbol_short!("AIRTIME"),
                &(1_000_000 + 86_400),
            );

            let sac = StellarAssetClient::new(&env, &token);
            let mut running_filled: i128 = 0;

            // A random number of partial fills, each sized to stay within
            // what remains — exercises the running-sum bookkeeping without
            // ever expecting InsufficientFunds along this path.
            let fill_count = 1 + (rng.next_u64() % 5) as u32;
            for _ in 0..fill_count {
                let remaining = total_amount - running_filled;
                if remaining <= 0 {
                    break;
                }
                let fill_amount = rng.range_i128(1, remaining);

                let buyer = Address::generate(&env);
                sac.mint(&buyer, &fill_amount);
                client.deposit_to_escrow(&buyer, &trade_id, &fill_amount);

                running_filled += fill_amount;

                let trade = client.get_trade(&trade_id);
                assert!(
                    trade.filled_amount <= trade.total_amount,
                    "iteration {iteration}: filled_amount {} exceeded total_amount {}",
                    trade.filled_amount,
                    trade.total_amount
                );
                assert_eq!(trade.filled_amount, running_filled);
            }

            // Whatever is left over must reject an over-fill with a typed
            // error rather than panicking or wrapping.
            let remaining = total_amount - running_filled;
            if remaining < total_amount {
                let overfill = remaining + rng.range_i128(1, 10_000_000_000_000i128);
                let buyer = Address::generate(&env);
                sac.mint(&buyer, &overfill);
                let result = client.try_deposit_to_escrow(&buyer, &trade_id, &overfill);
                assert_eq!(result, Err(Ok(ContractError::InsufficientFunds)));
            }

            let final_trade = client.get_trade(&trade_id);
            assert_eq!(final_trade.filled_amount, running_filled);
        }
    }

    /// Fuzzes cancel_and_refund's fill-counter walk (the underflow this file
    /// now guards with `checked_sub` — see cancel_and_refund) across random
    /// total amounts and random two-way fill splits, asserting
    /// `filled_amount` always settles back to exactly zero after a full
    /// admin refund, with no panic and no negative/overflowed intermediate
    /// value.
    #[test]
    fn fuzz_cancel_and_refund_settles_to_zero() {
        let mut rng = Xorshift64::new(0xBADF00D);

        for iteration in 0..100u32 {
            let (env, client, admin, seller, token) = setup();
            env.ledger().with_mut(|l| l.timestamp = 1_000_000);

            let total_amount = rng.range_i128(3, 900_000_000_000i128);
            let trade_id = client.create_listing(
                &seller,
                &token,
                &total_amount,
                &symbol_short!("DATA"),
                &(1_000_000 + 86_400),
            );

            let sac = StellarAssetClient::new(&env, &token);
            let split = rng.range_i128(1, total_amount - 1);

            for amount in [split, total_amount - split] {
                let buyer = Address::generate(&env);
                sac.mint(&buyer, &amount);
                client.deposit_to_escrow(&buyer, &trade_id, &amount);
            }

            // Admin can cancel_and_refund immediately regardless of expiry —
            // this walks the full fill counter and exercises the
            // checked_sub fix in one call, across many random splits.
            client.cancel_and_refund(&admin, &trade_id);

            let trade = client.get_trade(&trade_id);
            assert_eq!(
                trade.filled_amount, 0,
                "iteration {iteration}: filled_amount did not settle to zero after full admin refund"
            );
            assert_eq!(trade.status, TradeStatus::Cancelled);
        }
    }

    // -----------------------------------------------------------------------
    // emergency_withdraw tests (Issue #346)
    // -----------------------------------------------------------------------

    #[test]
    fn test_emergency_withdraw_success_after_timelock() {
        let (env, client, _admin, _seller, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        let contract_addr = client.address.clone();
        sac.mint(&contract_addr, &10_000_000_000i128);

        client.pause();

        // Advance ledger time past 72 hours
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + EMERGENCY_TIMELOCK_SECS + 1);

        let recipient = Address::generate(&env);
        let token_client = TokenClient::new(&env, &token);
        let initial_balance = token_client.balance(&recipient);

        client.emergency_withdraw(&token, &recipient, &500_0000000i128);

        assert_eq!(
            token_client.balance(&recipient),
            initial_balance + 500_0000000i128
        );
    }

    #[test]
    fn test_emergency_withdraw_fails_before_timelock() {
        let (env, client, _admin, _seller, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client.address, &10_000_000_000i128);

        client.pause();

        // Only 1 hour passed
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 3600);

        let recipient = Address::generate(&env);
        let result = client.try_emergency_withdraw(&token, &recipient, &500_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::TimelockNotExpired)));
    }

    #[test]
    fn test_emergency_withdraw_fails_when_not_paused() {
        let (env, client, _admin, _seller, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client.address, &10_000_000_000i128);

        let recipient = Address::generate(&env);
        let result = client.try_emergency_withdraw(&token, &recipient, &500_0000000i128);
        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
    }

    // -----------------------------------------------------------------------
    // flag_dispute status restriction (#240)
    // -----------------------------------------------------------------------

    fn partially_filled_trade(
        env: &Env,
        client: &EscrowContractClient<'static>,
        seller: &Address,
        buyer: &Address,
        token: &Address,
    ) -> u64 {
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let trade_id = client.create_listing(
            seller,
            token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(buyer, &trade_id, &1i128);
        assert_eq!(
            client.get_trade(&trade_id).status,
            TradeStatus::PartiallyFilled
        );
        trade_id
    }

    #[test]
    fn test_err_buyer_cannot_dispute_partially_filled_trade() {
        let (env, client, _admin, seller, token) = setup();
        let buyer = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&buyer, &100_000_000_000i128);
        let trade_id = partially_filled_trade(&env, &client, &seller, &buyer, &token);

        let result = client.try_flag_dispute(&buyer, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
        assert_eq!(
            client.get_trade(&trade_id).status,
            TradeStatus::PartiallyFilled
        );
    }

    #[test]
    fn test_err_seller_cannot_dispute_partially_filled_trade() {
        let (env, client, _admin, seller, token) = setup();
        let buyer = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&buyer, &100_000_000_000i128);
        let trade_id = partially_filled_trade(&env, &client, &seller, &buyer, &token);

        let result = client.try_flag_dispute(&seller, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
    }

    #[test]
    fn test_err_cannot_dispute_open_trade() {
        let (env, client, _admin, seller, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        let result = client.try_flag_dispute(&seller, &trade_id);
        assert_eq!(result, Err(Ok(ContractError::WrongStatus)));
    }

    #[test]
    fn test_dispute_allowed_once_partial_fill_is_locked() {
        let (env, client, _admin, seller, token) = setup();
        let buyer = Address::generate(&env);
        let buyer2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&buyer, &100_000_000_000i128);
        sac.mint(&buyer2, &100_000_000_000i128);
        let trade_id = partially_filled_trade(&env, &client, &seller, &buyer, &token);

        client.deposit_to_escrow(&buyer2, &trade_id, &(500_0000000i128 - 1));
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Locked);

        client.flag_dispute(&buyer, &trade_id);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Disputed);
    }

    // -----------------------------------------------------------------------
    // Issue #508 — escrow dispute resolution
    // -----------------------------------------------------------------------

    /// Fully fills a trade and raises a dispute on it, returning the disputed
    /// trade id. Reused by the `resolve_dispute` tests below.
    fn disputed_trade(
        env: &Env,
        client: &EscrowContractClient<'static>,
        seller: &Address,
        buyer: &Address,
        token: &Address,
    ) -> u64 {
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let trade_id = client.create_listing(
            seller,
            token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(buyer, &trade_id, &500_0000000i128);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Locked);
        client.flag_dispute(buyer, &trade_id);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Disputed);
        trade_id
    }

    /// Raising a dispute on a fully-filled trade transitions its state to
    /// `Disputed`.
    #[test]
    fn test_flag_dispute_transitions_to_disputed() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Locked);

        client.flag_dispute(&buyer, &trade_id);

        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Disputed);
    }

    /// The arbitrator can resolve a dispute in favour of the seller: all
    /// escrowed funds are released to the seller and the trade completes.
    #[test]
    fn test_resolve_dispute_in_favour_of_seller_releases_funds() {
        let (env, client, _admin, seller, buyer, token) = setup();
        let trade_id = disputed_trade(&env, &client, &seller, &buyer, &token);

        let token_client = TokenClient::new(&env, &token);
        let seller_before = token_client.balance(&seller);
        let contract_before = token_client.balance(&client.address);

        client.resolve_dispute(&trade_id, &DisputeResolution::Release);

        // Funds moved seller-ward; escrow drained; trade completed.
        assert_eq!(token_client.balance(&seller), seller_before + 500_0000000i128);
        assert_eq!(
            token_client.balance(&client.address),
            contract_before - 500_0000000i128
        );
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Completed);
    }

    /// The arbitrator can resolve a dispute in favour of the buyer: all
    /// escrowed funds are returned to the buyer and the trade is cancelled.
    #[test]
    fn test_resolve_dispute_in_favour_of_buyer_refunds_funds() {
        let (env, client, _admin, seller, buyer, token) = setup();
        let trade_id = disputed_trade(&env, &client, &seller, &buyer, &token);

        let token_client = TokenClient::new(&env, &token);
        // 100e9 minted minus the 5e9 locked in escrow.
        assert_eq!(
            token_client.balance(&buyer),
            100_000_000_000i128 - 500_0000000i128
        );

        client.resolve_dispute(&trade_id, &DisputeResolution::Refund);

        // Funds returned to the buyer; escrow drained; trade cancelled.
        assert_eq!(token_client.balance(&buyer), 100_000_000_000i128);
        assert_eq!(token_client.balance(&client.address), 0i128);
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Cancelled);
    }

    /// A non-arbitrator cannot resolve a dispute: once blanket auth mocking is
    /// disabled, the admin's `require_auth()` inside `resolve_dispute` is
    /// enforced for real, so a buyer invoking the call is rejected with a host
    /// auth error before any funds move.
    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_non_arbitrator_cannot_resolve_dispute() {
        let (env, client, _admin, seller, buyer, token) = setup();
        let trade_id = disputed_trade(&env, &client, &seller, &buyer, &token);

        // Disable blanket auth mocking so `admin.require_auth()` is enforced
        // for real. The buyer (not the admin) is invoking the call, so the
        // admin's authorisation is absent and the host rejects it.
        env.set_auths(&[]);

        client.resolve_dispute(&trade_id, &DisputeResolution::Release);
    }
}
