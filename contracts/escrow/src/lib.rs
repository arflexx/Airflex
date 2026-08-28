#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token, Address, Env, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

pub const MIN_TTL_LEDGERS: u32 = 2_592_000; // 30 days at 1s/ledger
pub const MAX_TTL_LEDGERS: u32 = 2_592_000; // 30 days
pub const SHORT_TTL_LEDGERS: u32 = 604_800; // 7 days

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

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ContractError {
    ContractPaused,
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

fn require_not_paused(env: &Env) {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        panic!("ContractPaused");
    }
}

fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialised")
}

fn bump_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
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

    pub fn initialize(env: Env, admin: Address, allowed_tokens: Vec<Address>) {
        bump_instance_ttl(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialised");
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
        env.storage().instance().extend_ttl(MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
    }

    // -----------------------------------------------------------------------
    // pause / unpause — admin-only circuit breakers
    // -----------------------------------------------------------------------

    /// Halts all state-mutating operations. Only callable by admin.
    /// Emits a `topics: ["contract", "paused"]` event.
    pub fn pause(env: Env) {
        bump_instance_ttl(&env);
        let admin = get_admin(&env);
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &true);

        env.events()
            .publish((topic_contract(), topic_paused()), ());
    }

    /// Resumes normal operations. Only callable by admin.
    /// Emits a `topics: ["contract", "unpaused"]` event.
    pub fn unpause(env: Env) {
        bump_instance_ttl(&env);
        let admin = get_admin(&env);
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);

        env.events()
            .publish((topic_contract(), topic_unpaused()), ());
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
    ) -> u64 {
        bump_instance_ttl(&env);
        seller.require_auth();
        require_not_paused(&env);

        if !env.storage().instance().has(&DataKey::AllowedToken(token.clone())) {
            panic!("unsupported token");
        }

        if amount <= 0 {
            panic!("amount must be positive");
        }

        let now = env.ledger().timestamp();
        if expires_at <= now {
            panic!("expires_at must be in the future");
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
        env.storage().persistent().extend_ttl(&DataKey::Trade(id), MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);

        env.events().publish((topic_created(), asset_type), (id, seller, amount));

        id
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    pub fn add_allowed_token(env: Env, token: Address) {
        bump_instance_ttl(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialised");
        admin.require_auth();
        env.storage().instance().set(&DataKey::AllowedToken(token), &true);
    }

    pub fn remove_allowed_token(env: Env, token: Address) {
        bump_instance_ttl(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialised");
        admin.require_auth();
        env.storage().instance().remove(&DataKey::AllowedToken(token));
    }

    /// Admin utility to manually extend a trade's TTL.
    pub fn bump_trade(env: Env, trade_id: u64) {
        bump_instance_ttl(&env);
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().persistent().extend_ttl(&DataKey::Trade(trade_id), MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
    }

    // -----------------------------------------------------------------------
    // deposit_to_escrow
    // -----------------------------------------------------------------------

    /// Locks the buyer's funds into the contract for a specific trade.
    ///
    /// Transfers `trade.amount` tokens from `buyer` → contract.
    /// Sets trade status to `Locked`.
    pub fn deposit_to_escrow(env: Env, buyer: Address, trade_id: u64, fill_amount: i128) {
        bump_instance_ttl(&env);
        buyer.require_auth();
        require_not_paused(&env);

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .expect("trade not found");
        env.storage().persistent().extend_ttl(&DataKey::Trade(trade_id), MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);

        if trade.status != TradeStatus::Open && trade.status != TradeStatus::PartiallyFilled {
            panic!("trade is not open");
        }

        let now = env.ledger().timestamp();
        if now >= trade.expires_at {
            panic!("trade has expired");
        }

        if buyer == trade.seller {
            panic!("seller cannot buy own trade");
        }

        if fill_amount <= 0 {
            panic!("fill amount must be positive");
        }

        if fill_amount > trade.total_amount - trade.filled_amount {
            panic!("fill amount exceeds available amount");
        }

        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(&buyer, &env.current_contract_address(), &fill_amount);

        trade.filled_amount += fill_amount;
        if trade.filled_amount == trade.total_amount {
            trade.status = TradeStatus::Locked;
        } else {
            trade.status = TradeStatus::PartiallyFilled;
        }

        env.storage().persistent().set(&DataKey::Trade(trade_id), &trade);

        let fill_id = env.storage().instance().get(&DataKey::TradeFillCounter(trade_id)).unwrap_or(0u64) + 1;
        env.storage().instance().set(&DataKey::TradeFillCounter(trade_id), &fill_id);

        let sub_escrow = SubEscrow {
            fill_id,
            buyer: buyer.clone(),
            amount: fill_amount,
            released: false,
            refunded: false,
        };
        env.storage().persistent().set(&DataKey::SubEscrow(trade_id, fill_id), &sub_escrow);

        env.events().publish((topic_locked(),), (trade_id, buyer));
    }

    // -----------------------------------------------------------------------
    // release_payment
    // -----------------------------------------------------------------------

    /// Releases escrowed funds to the seller once delivery is confirmed.
    ///
    /// The admin address (set at `initialize`) must authorise this call via
    /// `require_auth()`. In production the admin is the platform server signing
    /// key that verifies off-chain delivery before releasing escrow. In a more
    /// decentralised future this role could move to a multi-sig or oracle contract.
    pub fn release_payment(env: Env, trade_id: u64, fill_id: u64) {
        bump_instance_ttl(&env);
        require_not_paused(&env);

        let admin = get_admin(&env);
        admin.require_auth();

        let mut trade: TradeOffer = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .expect("trade not found");
        env.storage().persistent().extend_ttl(&DataKey::Trade(trade_id), MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::PartiallyFilled {
            panic!("trade is not locked");
        }

        let mut sub_escrow: SubEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::SubEscrow(trade_id, fill_id))
            .expect("fill not found");

        if sub_escrow.released || sub_escrow.refunded {
            panic!("fill already processed");
        }

        let token_client = token::Client::new(&env, &trade.token);
        token_client.transfer(
            &env.current_contract_address(),
            &trade.seller,
            &sub_escrow.amount,
        );

        sub_escrow.released = true;
        env.storage().persistent().set(&DataKey::SubEscrow(trade_id, fill_id), &sub_escrow);

        if trade.filled_amount == trade.total_amount {
            let fill_count = env.storage().instance().get(&DataKey::TradeFillCounter(trade_id)).unwrap_or(0);
            let mut all_released = true;
            for i in 1..=fill_count {
                if let Some(sub) = env.storage().persistent().get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i)) {
                    if !sub.released && !sub.refunded {
                        all_released = false;
                        break;
                    }
                }
            }
            if all_released {
                env.storage().persistent().extend_ttl(&DataKey::Trade(trade_id), SHORT_TTL_LEDGERS, SHORT_TTL_LEDGERS);
            }
            if all_released {
                trade.status = TradeStatus::Completed;
                env.storage().persistent().set(&DataKey::Trade(trade_id), &trade);
            }
        }

        env.events().publish((topic_completed(),), (trade_id, trade.seller.clone()));
    }

    // -----------------------------------------------------------------------
    // cancel_and_refund
    // -----------------------------------------------------------------------

    pub fn cancel_and_refund(env: Env, caller: Address, trade_id: u64) {
        require_not_paused(&env);
        caller.require_auth();

        let admin = get_admin(&env);
        let is_admin = caller == admin;

        let mut trade: TradeOffer = env.storage().persistent().get(&DataKey::Trade(trade_id)).expect("trade not found");

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::Disputed && trade.status != TradeStatus::PartiallyFilled {
            panic!("trade cannot be refunded in its current state");
        }

        let now = env.ledger().timestamp();
        let fill_count = env.storage().instance().get(&DataKey::TradeFillCounter(trade_id)).unwrap_or(0);
        let mut refunded_amount = 0;
        let mut caller_has_fills = false;

        let token_client = token::Client::new(&env, &trade.token);

        for i in 1..=fill_count {
            if let Some(mut sub) = env.storage().persistent().get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i)) {
                if !sub.released && !sub.refunded {
                    let is_buyer = sub.buyer == caller;
                    if is_admin || is_buyer {
                        if is_buyer && !is_admin && now < trade.expires_at {
                            panic!("timelock has not expired yet");
                        }
                        caller_has_fills = true;
                        token_client.transfer(
                            &env.current_contract_address(),
                            &sub.buyer,
                            &sub.amount,
                        );
                        sub.refunded = true;
                        env.storage().persistent().set(&DataKey::SubEscrow(trade_id, i), &sub);
                        refunded_amount += sub.amount;
                    }
                }
            }
        }

        if !is_admin && !caller_has_fills {
            panic!("only admin or buyer can cancel");
        }

        trade.filled_amount -= refunded_amount;

        if is_admin {
            trade.status = TradeStatus::Cancelled;
        } else if trade.filled_amount == 0 {
            trade.status = TradeStatus::Open;
        } else if trade.filled_amount < trade.total_amount {
            trade.status = TradeStatus::PartiallyFilled;
        }

        env.storage().persistent().set(&DataKey::Trade(trade_id), &trade);
        env.events().publish((topic_cancelled(),), (trade_id, caller));
    }

    // -----------------------------------------------------------------------
    // flag_dispute
    // -----------------------------------------------------------------------

    pub fn flag_dispute(env: Env, caller: Address, trade_id: u64) {
        require_not_paused(&env);
        caller.require_auth();

        let mut trade: TradeOffer = env.storage().persistent().get(&DataKey::Trade(trade_id)).expect("trade not found");

        if trade.status != TradeStatus::Locked && trade.status != TradeStatus::PartiallyFilled {
            panic!("only a Locked or PartiallyFilled trade can be disputed");
        }

        let mut is_party = caller == trade.seller;
        
        if !is_party {
            let fill_count = env.storage().instance().get(&DataKey::TradeFillCounter(trade_id)).unwrap_or(0);
            for i in 1..=fill_count {
                if let Some(sub) = env.storage().persistent().get::<_, SubEscrow>(&DataKey::SubEscrow(trade_id, i)) {
                    if sub.buyer == caller {
                        is_party = true;
                        break;
                    }
                }
            }
        }

        if !is_party {
            panic!("only trade parties can flag a dispute");
        }

        trade.status = TradeStatus::Disputed;
        env.storage().persistent().set(&DataKey::Trade(trade_id), &trade);
        env.events().publish((topic_disputed(),), (trade_id, caller));
    }

    // -----------------------------------------------------------------------
    // View helpers  (NOT blocked by paused flag)
    // -----------------------------------------------------------------------

    pub fn get_trade(env: Env, trade_id: u64) -> TradeOffer {
        env.storage()
            .persistent()
            .get(&DataKey::Trade(trade_id))
            .expect("trade not found")
    }

    pub fn trade_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TradeCounter)
            .unwrap_or(0u64)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialised")
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

    fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, Address, Address) {
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
    // Existing functional tests
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
    #[should_panic(expected = "fill amount exceeds available amount")]
    fn test_over_fill_rejection() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &trade_id, &600_0000000i128);
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
    #[should_panic(expected = "timelock has not expired yet")]
    fn test_cancel_before_expiry_fails() {
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

        client.cancel_and_refund(&buyer, &trade_id);
    }

    // -----------------------------------------------------------------------
    // Pausability tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_pause_and_unpause() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();

        // Initially not paused
        assert!(!client.is_paused());

        // Pause
        client.pause();
        assert!(client.is_paused());

        // Unpause
        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_create_listing_blocked_when_paused() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_deposit_to_escrow_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.pause();

        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_release_payment_blocked_when_paused() {
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

        client.pause();

        client.release_payment(&trade_id, &1);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_cancel_and_refund_blocked_when_paused() {
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

        // Advance past expiry
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_401);

        client.pause();

        client.cancel_and_refund(&buyer, &trade_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
    fn test_flag_dispute_blocked_when_paused() {
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

        client.pause();

        client.flag_dispute(&buyer, &trade_id);
    }

    #[test]
    fn test_read_only_views_not_blocked_when_paused() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        client.pause();

        // These should all succeed even while paused
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
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        // Pause and then unpause
        client.pause();
        client.unpause();

        // Should be able to create a listing again
        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("AIRTIME"),
            &(1_000_000 + 86_400),
        );

        // And deposit
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Locked);
    }

    #[test]
    fn test_release_payment_admin_on_locked_trade() {
        let (env, client, admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        let trade_before = client.get_trade(&trade_id);
        assert_eq!(trade_before.status, TradeStatus::Locked);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &client.mock_invoke(&client.release_payment, (&trade_id, &1u64)),
        }]);

        client.release_payment(&trade_id, &1);

        let trade = client.get_trade(&trade_id);
        assert_eq!(trade.status, TradeStatus::Completed);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&seller), 500_0000000i128);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_release_payment_non_admin_rejected() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let non_admin = Address::generate(&env);

        let trade_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &symbol_short!("DATA"),
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &trade_id, &500_0000000i128);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &client.mock_invoke(&client.release_payment, (&trade_id, &1u64)),
        }]);

        client.release_payment(&trade_id, &1);
    }

    #[test]
    #[should_panic(expected = "not initialised")]
    fn test_pause_fails_if_not_initialised() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Calling pause without initializing should panic
        client.pause();
    }
}
