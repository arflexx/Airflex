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
    /// Token addresses accepted by the contract.
    AllowedToken(Address),
    /// Counter for partial fill records.
    TradeFillCounter(u64),
    /// Per-fill escrow record under a trade.
    SubEscrow(u64, u64),
}

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
    NotAParty = 14,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

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
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token), &true);
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
        env.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(env: Env) {
        let admin = get_admin_address(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
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

    pub fn deposit_to_escrow(env: Env, buyer: Address, trade_id: u64) -> Result<(), ContractError> {
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

        let token_address = get_token_address(&env);
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&buyer, &env.current_contract_address(), &trade.amount);

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

        trade.status = TradeStatus::Cancelled;
        set_trade(&env, trade_id, &trade);

        env.events()
            .publish((topic_cancelled(),), (trade_id, caller));
        Ok(())
    }

    pub fn flag_dispute(env: Env, caller: Address, trade_id: u64) -> Result<(), ContractError> {
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
}