#![no_std]
#![allow(clippy::too_many_arguments)]

extern crate alloc;

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    token, Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    /// Persistent trade record keyed by trade ID.
    Trade(u64),
    /// Instance storage counter for the last allocated trade ID.
    TradeCount,
    /// Instance storage admin address authorized for privileged actions.
    Admin,
    /// Instance storage token contract address used for escrow payments.
    Token,
    /// Pause flag used to halt state-changing operations.
    Paused,
PausedAt,
    /// Token addresses accepted by the contract.
    AllowedToken(Address),
    /// Counter for partial fill records.
    TradeFillCounter(u64),
    /// Per-fill escrow record under a trade.
    SubEscrow(u64, u64),
}

pub const EMERGENCY_TIMELOCK_SECS: u64 = 72 * 60 * 60; // 72 hours = 259,200 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum TradeStatus {
    /// Listed and waiting for a buyer.
    Open,
    /// Buyer has deposited funds into escrow.
    Locked,
    /// A portion of the trade amount has been escrowed.
    PartiallyFilled,
    /// Escrowed funds were released to the seller.
    Completed,
    /// Trade was flagged for admin intervention.
    Disputed,
    /// Trade was cancelled and funds were returned when applicable.
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeOffer {
    /// Unique trade ID allocated from DataKey::TradeCount.
    pub id: u64,
    /// Seller address that created the trade and receives released funds.
    pub seller: Address,
    /// Buyer address once funds are locked, or None while the trade is open.
    pub buyer: Option<Address>,
    /// Stablecoin amount to escrow, expressed in token base units such as stroops.
    pub amount: i128,
    /// Off-chain asset category being purchased, for example AIRTIME or DATA.
    pub asset_type: Symbol,
    /// Current lifecycle state for the trade.
    pub status: TradeStatus,
    /// Expiration time as a Unix timestamp in ledger seconds.
    pub expires_at: u64,
    /// Whether escrowed funds have been released to the seller.
    pub released: bool,
    /// Whether escrowed funds have been refunded to the buyer.
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
NotAParty            = 14,
    PauseCooldownNotExpired = 15,
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
}

fn topic_locked() -> Symbol {
    symbol_short!("locked")
}

fn topic_completed() -> Symbol {
    symbol_short!("completed")
}

fn topic_cancelled() -> Symbol {
    symbol_short!("cancelled")
}

fn topic_disputed() -> Symbol {
    symbol_short!("disputed")
}

fn topic_contract() -> Symbol {
    symbol_short!("contract")
}

fn topic_paused() -> Symbol {
    symbol_short!("paused")
}

fn topic_unpaused() -> Symbol {
    symbol_short!("unpaused")
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
        panic!("ContractPaused");
    }
    Ok(())
}

fn get_admin_address(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialised")
}

fn get_token_address(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .expect("not initialised")
}

fn get_trade_or_panic(env: &Env, trade_id: u64) -> TradeOffer {
    env.storage()
        .persistent()
        .get(&DataKey::Trade(trade_id))
        .expect("trade not found")
}

fn set_trade(env: &Env, trade_id: u64, trade: &TradeOffer) {
    let key = DataKey::Trade(trade_id);
    env.storage().persistent().set(&key, trade);
    env.storage()
        .persistent()
        .extend_ttl(&key, 17_280, 17_280 * 30);
}

const PAUSE_COOLDOWN_SECONDS: u64 = 300;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::TradeCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
env.storage().instance().set(&DataKey::LastPauseAt, &0u64);
        for token in allowed_tokens.iter() {
            env.storage()
                .instance()
                .set(&DataKey::AllowedToken(token.clone()), &true);
        }
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token), &true);
        // Bump instance TTL so it survives long-running trades
        env.storage().instance().extend_ttl(17_280, 17_280 * 30);
        Ok(())
    }

    pub fn add_allowed_token(env: Env, token: Address) {
        let admin = get_admin_address(&env);
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token), &true);
    }

    pub fn remove_allowed_token(env: Env, token: Address) {
        let admin = get_admin_address(&env);
        admin.require_auth();
        env.storage()
            .instance()
            .remove(&DataKey::AllowedToken(token));
    }

pub fn pause(env: Env) {
        let admin = get_admin_address(&env);
        admin.require_auth();

        let is_already_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);

        if !is_already_paused {
            let now = env.ledger().timestamp();
            env.storage().instance().set(&DataKey::PausedAt, &now);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
env.storage().instance().set(&DataKey::LastPauseAt, &now);

        env.events()
            .publish((topic_contract(), topic_paused()), ());
        Ok(())
    }

    pub fn unpause(env: Env) {
        let admin = get_admin_address(&env);
        admin.require_auth();
let now = env.ledger().timestamp();
        let last_pause_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastPauseAt)
            .unwrap_or(0);

        if last_pause_at > 0 && now < last_pause_at.saturating_add(PAUSE_COOLDOWN_SECONDS) {
            return Err(ContractError::PauseCooldownNotExpired);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
env.storage().instance().remove(&DataKey::PausedAt);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn trade_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TradeCount)
            .unwrap_or(0)
    }

    pub fn create_listing(
        env: Env,
        seller: Address,
        amount: i128,
        asset_type: Symbol,
        expires_at: u64,
    ) -> Result<u64, ContractError> {
        seller.require_auth();
        require_not_paused(&env)?;

        let token = get_token_address(&env);

        if !env
            .storage()
            .instance()
            .has(&DataKey::AllowedToken(token.clone()))
        {
            panic!("unsupported token");
        }

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        if expires_at <= env.ledger().timestamp() {
            panic!("expires_at must be in the future");
        }

        let id = Self::trade_count(env.clone()) + 1;
        env.storage().instance().set(&DataKey::TradeCount, &id);

        let trade = TradeOffer {
            id,
            seller: seller.clone(),
            buyer: None,
            amount,
            asset_type: asset_type.clone(),
            status: TradeStatus::Open,
            expires_at,
            released: false,
            refunded: false,
        };

        set_trade(&env, id, &trade);

        env.events()
            .publish((topic_created(), asset_type), (id, seller, amount));

        Ok(id)
    }

// -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    /// Adds `token` to the set of tokens listings may be created/filled in.
    /// Emits a `topics: ["token", "allowed"]` event carrying the token
    /// address, so off-chain indexers and admin tooling can observe changes
    /// to the allow-list without polling every token individually.
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

    // -----------------------------------------------------------------------
    // deposit_to_escrow
    // -----------------------------------------------------------------------

    /// Locks the buyer's funds into the contract for a specific trade.
    ///
    /// Transfers `fill_amount` tokens from `buyer` → contract.
    /// Sets trade status to `Locked` when fully filled, `PartiallyFilled` otherwise.
    pub fn deposit_to_escrow(
        env: Env,
        buyer: Address,
        trade_id: u64,
        fill_amount: i128,
    ) -> Result<(), ContractError> {
        buyer.require_auth();
        require_not_paused(&env)?;

        let mut trade = get_trade_or_panic(&env, trade_id);

        if trade.status != TradeStatus::Open {
            panic!("trade is not open");
        }

        if env.ledger().timestamp() >= trade.expires_at {
            panic!("trade has expired");
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

        if fill_amount > trade.total_amount - trade.filled_amount {
            return Err(ContractError::InsufficientFunds);
        }

        let token_address = get_token_address(&env);
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&buyer, &env.current_contract_address(), &trade.amount);

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

        trade.buyer = Some(buyer.clone());
        trade.status = TradeStatus::Locked;
        set_trade(&env, trade_id, &trade);

        env.events().publish((topic_locked(),), (trade_id, buyer));
        Ok(())
    }

    pub fn release_payment(env: Env, trade_id: u64) -> Result<(), ContractError> {
        require_not_paused(&env)?;

        let admin = get_admin_address(&env);
        admin.require_auth();

        let mut trade = get_trade_or_panic(&env, trade_id);

        if trade.status != TradeStatus::Locked {
            panic!("trade is not locked");
        }

        let token_address = get_token_address(&env);
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(
            &env.current_contract_address(),
            &trade.seller,
            &trade.amount,
        );

        trade.status = TradeStatus::Completed;
        trade.released = true;
        trade.refunded = false;
        set_trade(&env, trade_id, &trade);

        env.events()
            .publish((topic_completed(),), (trade_id, trade.seller));
        Ok(())
    }

    pub fn cancel_and_refund(
        env: Env,
        caller: Address,
        trade_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        require_not_paused(&env)?;

        let admin = get_admin_address(&env);
        let mut trade = get_trade_or_panic(&env, trade_id);
        let is_admin = caller == admin;
        let is_buyer = trade.buyer.as_ref().is_some_and(|buyer| buyer == &caller);

        if !is_admin && !is_buyer {
            panic!("only admin or buyer can cancel");
        }

        if !is_admin && env.ledger().timestamp() < trade.expires_at {
            panic!("timelock has not expired yet");
        }

        if trade.status == TradeStatus::Locked {
            let buyer = trade.buyer.clone().expect("buyer not found");
            let token_address = get_token_address(&env);
            let token_client = token::Client::new(&env, &token_address);
            token_client.transfer(&env.current_contract_address(), &buyer, &trade.amount);
            trade.refunded = true;
        } else if trade.status != TradeStatus::Open && trade.status != TradeStatus::Disputed {
            panic!("trade cannot be cancelled in its current state");
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

        trade.status = TradeStatus::Cancelled;
        set_trade(&env, trade_id, &trade);

        env.events()
            .publish((topic_cancelled(),), (trade_id, caller));
        Ok(())
    }

// -----------------------------------------------------------------------
    // close_expired_listing
    // -----------------------------------------------------------------------

    /// Removes an unfilled listing after its expiry so its persistent storage
    /// can be reclaimed. Anyone may trigger this cleanup.
    pub fn close_expired_listing(
        env: Env,
        trade_id: u64,
    ) -> Result<(), ContractError> {
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
        env.storage()
            .persistent()
            .remove(&DataKey::Trade(trade_id));
        env.events()
            .publish((topic_cancelled(),), (trade_id,));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // flag_dispute
    // -----------------------------------------------------------------------

    pub fn flag_dispute(env: Env, caller: Address, trade_id: u64) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        caller.require_auth();
        require_not_paused(&env)?;

        let mut trade = get_trade_or_panic(&env, trade_id);
        let is_buyer = trade.buyer.as_ref().is_some_and(|buyer| buyer == &caller);

        if caller != trade.seller && !is_buyer {
            return Err(ContractError::Unauthorized);
        }

        if trade.status == TradeStatus::Disputed {
            return Err(ContractError::AlreadyDisputed);
        }

        if trade.status == TradeStatus::Open
            || trade.status == TradeStatus::Completed
            || trade.status == TradeStatus::Cancelled
        {
            return Err(ContractError::WrongStatus);
        }

        trade.status = TradeStatus::Disputed;
        set_trade(&env, trade_id, &trade);

        env.events().publish((topic_disputed(),), (trade_id, caller));
        Ok(())
    }
}
            panic!("only trade parties can flag a dispute");
        }

        if trade.status != TradeStatus::Locked {
            panic!("only a locked trade can be disputed");
        }

        trade.status = TradeStatus::Disputed;
        set_trade(&env, trade_id, &trade);

        env.events().publish((topic_disputed(),), (trade_id, caller));
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

    // -----------------------------------------------------------------------
    // View helpers  (NOT blocked by paused flag)
    // -----------------------------------------------------------------------

    pub fn get_trade(env: Env, trade_id: u64) -> TradeOffer {
        get_trade_or_panic(&env, trade_id)
    }

    pub fn trade_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TradeCount)
            .unwrap_or(0u64)
    }

    pub fn get_admin(env: Env) -> Address {
        get_admin_address(&env)
    }

    pub fn get_token(env: Env) -> Address {
        get_token_address(&env)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
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
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&buyer, &100_000_000_000_i128);

        client.initialize(&admin, &token_address);

        (env, client, admin, seller, buyer, token_address)
    }

    #[test]
    fn test_create_listing() {
        let (env, client, _admin, seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        assert_eq!(trade_id, 1);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.id, trade_id);
        assert_eq!(trade.seller, seller);
        assert_eq!(trade.buyer, None);
        assert_eq!(trade.amount, 500_0000000i128);
        assert_eq!(trade.asset_type, symbol_short!("AIRTIME"));
        assert_eq!(trade.status, TradeStatus::Open);
    }

    #[test]
    fn test_deposit_to_escrow() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
        assert_eq!(trade.buyer, Some(buyer));

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&client.address), 500_0000000i128);
    }

    #[test]
    fn test_release_payment() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);
        client.release_payment(&trade_id);

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
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_401);
        client.cancel_and_refund(&buyer, &trade_id);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Cancelled);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&buyer), 100_000_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "timelock has not expired yet")]
    fn test_cancel_before_expiry_fails() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        client.cancel_and_refund(&buyer, &trade_id);
    }

    #[test]
    fn test_admin_cancels_immediately() {
        let (env, client, admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        client.cancel_and_refund(&admin, &trade_id);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Cancelled);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&buyer), 100_000_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "only admin or buyer can cancel")]
    fn test_seller_cancel_fails() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        client.cancel_and_refund(&seller, &trade_id);
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

        assert_eq!(client.try_get_trade(&trade_id), Ok(Err(ContractError::TradeNotFound)));
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

        assert_eq!(result, Ok(Err(ContractError::TradeExpired)));
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

        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
        assert_eq!(client.get_trade(&trade_id).status, TradeStatus::Locked);
    }

    // -----------------------------------------------------------------------
    // Pausability tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_pause_and_unpause() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();

        assert!(!client.is_paused());

        client.pause();
        assert!(client.is_paused());

        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_create_listing_blocked_when_paused() {
        let (env, client, _admin, seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_deposit_to_escrow_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.pause();

        client.deposit_to_escrow(&buyer, &trade_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_release_payment_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        client.pause();

        client.release_payment(&trade_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_cancel_and_refund_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        client.pause();

        client.cancel_and_refund(&buyer, &trade_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_flag_dispute_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id);

        client.pause();

        client.flag_dispute(&buyer, &trade_id);
    }

    #[test]
    fn test_read_only_views_not_blocked_when_paused() {
        let (env, client, _admin, seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.pause();

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.id, trade_id);

        let count = client.trade_count();
        assert_eq!(count, 1);

        let admin = client.get_admin();
        assert!(!admin.to_string().is_empty());

        assert!(client.is_paused());
    }

    #[test]
    fn test_operations_resume_after_unpause() {
        let (env, client, _admin, seller, buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();
        client.unpause();

        let trade_id = client.create_listing(
            &seller,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
    }

    #[test]
    fn test_err_already_initialized() {
        let (env, client, admin, _seller, _buyer, token) = setup();
        let result = client.try_initialize(&admin, &token);
        assert_eq!(result, Ok(Err(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_err_invalid_amount_zero() {
        let (env, client, _admin, seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let result = client.try_create_listing(
            &seller,
            &0i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
assert_eq!(result, Ok(Err(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_err_unpause_requires_pause_cooldown() {
        let (env, client, _admin, _seller, _buyer, _token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        let result = client.try_unpause();
        assert_eq!(result, Ok(Err(ContractError::PauseCooldownNotExpired)));
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
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        // Contract not initialised — get_admin should return Unauthorized
        let result = client.try_get_admin();
        assert_eq!(result, Ok(Err(ContractError::Unauthorized)));
    }
}
