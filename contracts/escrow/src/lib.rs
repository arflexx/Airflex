#![no_std]
#![allow(clippy::too_many_arguments)]

extern crate alloc;

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    token, Address, Env, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    Admin,
    TradeCounter,
    Trade(u64),
    Paused,
    PausedAt,
    AllowedToken(Address),
    TradeFillCounter(u64),
    SubEscrow(u64, u64),
}

pub const EMERGENCY_TIMELOCK_SECS: u64 = 72 * 60 * 60; // 72 hours = 259,200 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum TradeStatus {
    Open,
    PartiallyFilled,
    Locked,
    Completed,
    Disputed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeOffer {
    pub id: u64,
    pub seller: Address,
    pub token: Address,       // USDC or NGNC contract address
    pub total_amount: i128,   // total token amount in stroops
    pub filled_amount: i128,  // filled token amount in stroops
    pub asset_type: Symbol,   // e.g. symbol_short!("AIRTIME")
    pub status: TradeStatus,
    pub expires_at: u64,      // Unix timestamp (ledger time)
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SubEscrow {
    pub fill_id: u64,
    pub buyer: Address,
    pub amount: i128,
    pub released: bool,
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
    AlreadyInitialized   = 1,
    Unauthorized         = 2,
    TradeNotFound        = 3,
    WrongStatus          = 4,
    TradeExpired         = 5,
    InsufficientFunds    = 6,
    InvalidExpiry        = 7,
    AlreadyDisputed      = 8,
    ContractPaused       = 9,
    TimelockNotExpired   = 10,
    UnsupportedToken     = 11,
    InvalidAmount        = 12,
    FillAlreadyProcessed = 13,
    NotAParty            = 14,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Event topics defined with `symbol_short!` are limited to at most 9 ASCII
// characters (e.g. "completed" and "cancelled" are exactly 9 chars, at the limit).
// Any topic strings approaching or exceeding 9 characters must use `Symbol::new(env, "...")`
// to avoid compile-time macro panics.
fn topic_created()   -> Symbol { symbol_short!("created")   } // 7 chars
fn topic_locked()    -> Symbol { symbol_short!("locked")    } // 6 chars
fn topic_completed() -> Symbol { symbol_short!("completed") } // 9 chars (max limit for symbol_short!)
fn topic_cancelled() -> Symbol { symbol_short!("cancelled") } // 9 chars (max limit for symbol_short!)
fn topic_disputed()  -> Symbol { symbol_short!("disputed")  } // 8 chars
fn topic_contract()  -> Symbol { symbol_short!("contract")  } // 8 chars
fn topic_paused()    -> Symbol { symbol_short!("paused")    } // 6 chars
fn topic_unpaused()  -> Symbol { symbol_short!("unpaused")  } // 8 chars

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

fn get_admin(env: &Env) -> Result<Address, ContractError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ContractError::Unauthorized)
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // -----------------------------------------------------------------------
    // Initialise
    // -----------------------------------------------------------------------

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
        for token in allowed_tokens.iter() {
            env.storage()
                .instance()
                .set(&DataKey::AllowedToken(token.clone()), &true);
        }
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

        if !is_already_paused {
            let now = env.ledger().timestamp();
            env.storage().instance().set(&DataKey::PausedAt, &now);
        }

        env.storage().instance().set(&DataKey::Paused, &true);

        env.events()
            .publish((topic_contract(), topic_paused()), ());
        Ok(())
    }

    /// Resumes normal operations. Only callable by admin.
    /// Emits a `topics: ["contract", "unpaused"]` event.
    pub fn unpause(env: Env) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().remove(&DataKey::PausedAt);

        env.events()
            .publish((topic_contract(), topic_unpaused()), ());
        Ok(())
    }

    // -----------------------------------------------------------------------
    // create_listing — called by the Seller
    // -----------------------------------------------------------------------

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

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        if expires_at <= now {
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

        env.storage()
            .persistent()
            .set(&DataKey::Trade(id), &trade);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Trade(id), 17_280, 17_280 * 30);

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

        if fill_amount > trade.total_amount - trade.filled_amount {
            return Err(ContractError::InsufficientFunds);
        }

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

        env.events()
            .publish((topic_locked(),), (trade_id, buyer));
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
    pub fn release_payment(
        env: Env,
        trade_id: u64,
        fill_id: u64,
    ) -> Result<(), ContractError> {
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
            }
        }

        env.events()
            .publish((topic_completed(),), (trade_id, trade.seller.clone()));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // cancel_and_refund
    // -----------------------------------------------------------------------

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

    pub fn flag_dispute(
        env: Env,
        caller: Address,
        trade_id: u64,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        caller.require_auth();

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)?;

        if trade.status == TradeStatus::Disputed {
            return Err(ContractError::AlreadyDisputed);
        }

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::PartiallyFilled {
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
        env.events()
            .publish((topic_disputed(),), (trade_id, caller));
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

    pub fn trade_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TradeCounter)
            .unwrap_or(0u64)
    }

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
        Address, Env,
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

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_address);

        sac.mint(&buyer, &10_000_0000000i128);

        let allowed_tokens = vec![&env, token_address.clone()];
        client.initialize(&admin, &allowed_tokens);

        (env, client, admin, seller, buyer, token_address)
    }

    // -----------------------------------------------------------------------
    // Existing functional tests (updated to use Result-returning functions)
    // -----------------------------------------------------------------------

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

        let impersonator = Address::generate(&env);
        let expires_at = 1_000_000u64 + 86_400;

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &impersonator,
            invoke: &client.mock_invoke(
                &client.create_listing,
                (
                    &seller,
                    &token,
                    &500_0000000i128,
                    &symbol_short!("AIRTIME"),
                    &expires_at,
                ),
            ),
        }]);

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

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &seller,
            invoke: &client.mock_invoke(
                &client.create_listing,
                (
                    &seller,
                    &token,
                    &500_0000000i128,
                    &symbol_short!("AIRTIME"),
                    &expires_at,
                ),
            ),
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

        let impersonator = Address::generate(&env);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &impersonator,
            invoke: &client.mock_invoke(
                &client.deposit_to_escrow,
                (&buyer, &trade_id, &500_0000000i128),
            ),
        }]);

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

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &buyer,
            invoke: &client.mock_invoke(
                &client.deposit_to_escrow,
                (&buyer, &trade_id, &500_0000000i128),
            ),
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
        assert_eq!(token_client.balance(&buyer), 10_000_0000000i128);
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
        assert_eq!(token_client.balance(&buyer), 10_000_0000000i128);
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
    // Error variant tests — assert typed ContractError is returned
    // -----------------------------------------------------------------------

    #[test]
    fn test_err_already_initialized() {
        let (env, client, admin, _seller, _buyer, token) = setup();
        // setup() already called initialize; call it again
        let allowed = vec![&env, token.clone()];
        let result = client.try_initialize(&admin, &allowed);
        assert_eq!(result, Ok(Err(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_err_trade_not_found() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();
        let result = client.try_get_trade(&999u64);
        assert_eq!(result, Ok(Err(ContractError::TradeNotFound)));
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
        assert_eq!(result, Ok(Err(ContractError::UnsupportedToken)));
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
        assert_eq!(result, Ok(Err(ContractError::InvalidAmount)));
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
        assert_eq!(result, Ok(Err(ContractError::InvalidExpiry)));
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
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
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
        assert_eq!(result, Ok(Err(ContractError::TradeExpired)));
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
        assert_eq!(result, Ok(Err(ContractError::InsufficientFunds)));
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
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
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
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
        // Release fill #1 once
        client.release_payment(&trade_id, &1);
        // Release same fill again — should fail
        let result = client.try_release_payment(&trade_id, &1);
        assert_eq!(result, Ok(Err(ContractError::FillAlreadyProcessed)));
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
        assert_eq!(result, Ok(Err(ContractError::TimelockNotExpired)));
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
        assert_eq!(result, Ok(Err(ContractError::Unauthorized)));
    }

    #[test]
    fn test_err_already_disputed() {
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
        // First flag
        client.flag_dispute(&seller, &trade_id);
        // Second flag on already-Disputed trade
        let result = client.try_flag_dispute(&buyer, &trade_id);
        assert_eq!(result, Ok(Err(ContractError::AlreadyDisputed)));
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
        assert_eq!(result, Ok(Err(ContractError::NotAParty)));
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
        assert_eq!(result, Ok(Err(ContractError::ContractPaused)));
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

        // Verify that longer/new topics (> 9 chars, e.g. "emergency_withdrawal") work with Symbol::new(&env, ...)
        let long_topic = Symbol::new(&env, "emergency_withdrawal");
        assert_eq!(long_topic, Symbol::new(&env, "emergency_withdrawal"));
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
        token::StellarAssetClient,
        Address, Env,
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

    fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, EscrowContract);
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
            let total_amount = rng.range_i128(1, 100_000_0000000i128);

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
                let overfill = remaining + rng.range_i128(1, 1_000_000_0000000i128);
                let buyer = Address::generate(&env);
                sac.mint(&buyer, &overfill);
                let result = client.try_deposit_to_escrow(&buyer, &trade_id, &overfill);
                assert_eq!(result, Ok(Err(ContractError::InsufficientFunds)));
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

            let total_amount = rng.range_i128(3, 90_000_0000000i128);
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
        sac.mint(&contract_addr, &1_000_0000000i128);

        client.pause();

        // Advance ledger time past 72 hours
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + EMERGENCY_TIMELOCK_SECS + 1);

        let recipient = Address::generate(&env);
        let initial_balance = sac.balance(&recipient);

        client.emergency_withdraw(&token, &recipient, &500_0000000i128);

        assert_eq!(sac.balance(&recipient), initial_balance + 500_0000000i128);
    }

    #[test]
    fn test_emergency_withdraw_fails_before_timelock() {
        let (env, client, _admin, _seller, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client.address, &1_000_0000000i128);

        client.pause();

        // Only 1 hour passed
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 3600);

        let recipient = Address::generate(&env);
        let result = client.try_emergency_withdraw(&token, &recipient, &500_0000000i128);
        assert_eq!(result, Ok(Err(ContractError::TimelockNotExpired)));
    }

    #[test]
    fn test_emergency_withdraw_fails_when_not_paused() {
        let (env, client, _admin, _seller, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client.address, &1_000_0000000i128);

        let recipient = Address::generate(&env);
        let result = client.try_emergency_withdraw(&token, &recipient, &500_0000000i128);
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
    }
}
