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
    AllowedToken(Address),
    TradeFillCounter(u64),
    SubEscrow(u64, u64),
}

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

fn topic_created()   -> Symbol { symbol_short!("created")   }
fn topic_locked()    -> Symbol { symbol_short!("locked")    }
fn topic_completed() -> Symbol { symbol_short!("completed") }
fn topic_cancelled() -> Symbol { symbol_short!("cancelled") }
fn topic_disputed()  -> Symbol { symbol_short!("disputed")  }
fn topic_contract()  -> Symbol { symbol_short!("contract")  }
fn topic_paused()    -> Symbol { symbol_short!("paused")    }
fn topic_unpaused()  -> Symbol { symbol_short!("unpaused")  }

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

    pub fn add_allowed_token(env: Env, token: Address) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token), &true);
        Ok(())
    }

    pub fn remove_allowed_token(env: Env, token: Address) -> Result<(), ContractError> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .remove(&DataKey::AllowedToken(token));
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

        trade.filled_amount -= refunded_amount;

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
    // View helpers  (NOT blocked by paused flag)
    // -----------------------------------------------------------------------

    pub fn get_trade(env: Env, trade_id: u64) -> Result<TradeOffer, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)
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
}
