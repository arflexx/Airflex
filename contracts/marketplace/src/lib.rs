#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    token, Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    Admin,
    ListingCounter,
    Listing(u64),
    Reputation(Address),
    Paused,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum ListingStatus {
    Active,
    Sold,
    Cancelled,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum AssetCategory {
    Airtime,
    Data,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Listing {
    pub id: u64,
    pub seller: Address,
    pub token: Address,        // payment token (e.g. USDC / NGNC)
    pub price: i128,           // price in base token units
    pub asset_category: AssetCategory,
    pub asset_type: Symbol,    // e.g. symbol_short!("MTN")
    pub quantity: i128,        // units of airtime/data being sold
    pub status: ListingStatus,
    pub created_at: u64,       // ledger timestamp
    pub expires_at: u64,       // listing expiry
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Reputation {
    pub completed_trades: u32,
    pub disputed_trades: u32,
    pub total_volume: i128,
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

fn topic_listed()    -> Symbol { symbol_short!("listed")    }
fn topic_sold()      -> Symbol { symbol_short!("sold")      }
fn topic_cancelled() -> Symbol { symbol_short!("cancelled") }
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

fn update_reputation(env: &Env, seller: &Address, volume: i128, disputed: bool) {
    let mut rep: Reputation = env
        .storage()
        .persistent()
        .get(&DataKey::Reputation(seller.clone()))
        .unwrap_or(Reputation {
            completed_trades: 0,
            disputed_trades: 0,
            total_volume: 0,
        });

    if disputed {
        rep.disputed_trades += 1;
    } else {
        rep.completed_trades += 1;
        rep.total_volume += volume;
    }

    env.storage()
        .persistent()
        .set(&DataKey::Reputation(seller.clone()), &rep);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Reputation(seller.clone()), 17_280, 17_280 * 365);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MarketplaceContract;

#[contractimpl]
impl MarketplaceContract {
    // -----------------------------------------------------------------------
    // initialize — must be called once after deployment
    // -----------------------------------------------------------------------

    /// Sets the admin address and seeds the listing counter.
    /// Returns `Err(ContractError::AlreadyInitialized)` if called more than once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::ListingCounter, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
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

    /// Posts a new airtime/data offer on the marketplace.
    ///
    /// Returns the new listing ID.
    pub fn create_listing(
        env: Env,
        seller: Address,
        token: Address,
        price: i128,
        asset_category: AssetCategory,
        asset_type: Symbol,
        quantity: i128,
        expires_at: u64,
    ) -> Result<u64, ContractError> {
        require_not_paused(&env)?;
        seller.require_auth();

        if price <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        if quantity <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        if expires_at <= now {
            return Err(ContractError::InvalidExpiry);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ListingCounter)
            .unwrap_or(0u64)
            + 1;
        env.storage().instance().set(&DataKey::ListingCounter, &id);

        let listing = Listing {
            id,
            seller: seller.clone(),
            token,
            price,
            asset_category,
            asset_type: asset_type.clone(),
            quantity,
            status: ListingStatus::Active,
            created_at: now,
            expires_at,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Listing(id), &listing);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Listing(id), 17_280, 17_280 * 30);

        env.events()
            .publish((topic_listed(), asset_type), (id, seller, price, quantity));

        Ok(id)
    }

    // -----------------------------------------------------------------------
    // deposit_to_escrow — called by the Buyer
    // -----------------------------------------------------------------------

    /// Locks buyer funds into the contract for a specific listing.
    ///
    /// Transfers `listing.price` tokens from `buyer` → contract.
    /// Sets listing status to `Sold`.
    pub fn deposit_to_escrow(
        env: Env,
        buyer: Address,
        listing_id: u64,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        buyer.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .ok_or(ContractError::TradeNotFound)?;

        if listing.status != ListingStatus::Active {
            return Err(ContractError::WrongStatus);
        }

        let now = env.ledger().timestamp();
        if now >= listing.expires_at {
            return Err(ContractError::TradeExpired);
        }

        if buyer == listing.seller {
            return Err(ContractError::Unauthorized);
        }

        let token_client = token::Client::new(&env, &listing.token);
        token_client.transfer(&buyer, &env.current_contract_address(), &listing.price);

        listing.status = ListingStatus::Sold;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(listing_id), &listing);

        env.events()
            .publish((topic_sold(),), (listing_id, buyer, listing.price));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // release_payment — called by the Backend / Oracle after delivery
    // -----------------------------------------------------------------------

    /// Releases escrowed funds to the seller once delivery is confirmed.
    /// Updates the seller's reputation on-chain.
    ///
    /// Only the admin account can call this.
    pub fn release_payment(env: Env, listing_id: u64) -> Result<(), ContractError> {
        require_not_paused(&env)?;

        let admin = get_admin(&env)?;
        admin.require_auth();

        let listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .ok_or(ContractError::TradeNotFound)?;

        if listing.status != ListingStatus::Sold {
            return Err(ContractError::WrongStatus);
        }

        let token_client = token::Client::new(&env, &listing.token);
        token_client.transfer(
            &env.current_contract_address(),
            &listing.seller,
            &listing.price,
        );

        update_reputation(&env, &listing.seller, listing.price, false);

        env.events()
            .publish((topic_sold(),), (listing_id, listing.seller, listing.price));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // cancel_and_refund — called by Admin
    // -----------------------------------------------------------------------

    /// Returns escrowed funds to the buyer and marks the listing Cancelled.
    ///
    /// Only admin can call this directly in the marketplace contract.
    pub fn cancel_and_refund(
        env: Env,
        buyer: Address,
        listing_id: u64,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;

        let admin = get_admin(&env)?;
        admin.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .ok_or(ContractError::TradeNotFound)?;

        if listing.status != ListingStatus::Sold {
            return Err(ContractError::WrongStatus);
        }

        let token_client = token::Client::new(&env, &listing.token);
        token_client.transfer(
            &env.current_contract_address(),
            &buyer,
            &listing.price,
        );

        listing.status = ListingStatus::Cancelled;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(listing_id), &listing);

        update_reputation(&env, &listing.seller, 0, true);

        env.events()
            .publish((topic_cancelled(),), (listing_id, buyer));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // resolve_dispute — called by Admin
    // -----------------------------------------------------------------------

    /// Admin resolves a disputed listing, transferring funds to the
    /// specified `recipient` (either the buyer for a refund or the seller
    /// for a release).
    pub fn resolve_dispute(
        env: Env,
        listing_id: u64,
        recipient: Address,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;

        let admin = get_admin(&env)?;
        admin.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .ok_or(ContractError::TradeNotFound)?;

        if listing.status != ListingStatus::Sold {
            return Err(ContractError::WrongStatus);
        }

        let token_client = token::Client::new(&env, &listing.token);
        token_client.transfer(
            &env.current_contract_address(),
            &recipient,
            &listing.price,
        );

        listing.status = ListingStatus::Cancelled;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(listing_id), &listing);

        // If recipient is the seller, count as completed; otherwise disputed
        let is_seller = recipient == listing.seller;
        update_reputation(&env, &listing.seller, listing.price, !is_seller);

        env.events()
            .publish((topic_cancelled(),), (listing_id, recipient));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // View helpers  (NOT blocked by paused flag)
    // -----------------------------------------------------------------------

    /// Returns a listing by ID.
    pub fn get_listing(env: Env, listing_id: u64) -> Result<Listing, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .ok_or(ContractError::TradeNotFound)
    }

    /// Returns the reputation record for a given address.
    pub fn get_reputation(env: Env, user: Address) -> Reputation {
        env.storage()
            .persistent()
            .get(&DataKey::Reputation(user))
            .unwrap_or(Reputation {
                completed_trades: 0,
                disputed_trades: 0,
                total_volume: 0,
            })
    }

    /// Returns the balance of a token held by this contract.
    pub fn balance(env: Env, token: Address) -> i128 {
        let token_client = token::Client::new(&env, &token);
        token_client.balance(&env.current_contract_address())
    }

    /// Returns the current listing counter (total listings ever created).
    pub fn listing_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ListingCounter)
            .unwrap_or(0u64)
    }

    /// Returns the admin address.
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
        MarketplaceContractClient<'static>,
        Address, // admin
        Address, // seller
        Address, // buyer
        Address, // token
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, MarketplaceContract);
        let client = MarketplaceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_address);

        // Mint tokens to buyer
        sac.mint(&buyer, &10_000_0000000i128);

        client.initialize(&admin);

        (env, client, admin, seller, buyer, token_address)
    }

    // -----------------------------------------------------------------------
    // Core functional tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_create_listing() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );

        assert_eq!(listing_id, 1);
        let listing = client.get_listing(&listing_id);
        assert_eq!(listing.status, ListingStatus::Active);
        assert_eq!(listing.seller, seller);
    }

    #[test]
    fn test_deposit_to_escrow() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("AIRTEL"),
            &500i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);

        let listing = client.get_listing(&listing_id);
        assert_eq!(listing.status, ListingStatus::Sold);
    }

    #[test]
    fn test_release_payment_updates_reputation() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("GLO"),
            &200i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);
        client.release_payment(&listing_id);

        let rep = client.get_reputation(&seller);
        assert_eq!(rep.completed_trades, 1);
        assert_eq!(rep.total_volume, 500_0000000i128);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&seller), 500_0000000i128);
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
    fn test_create_listing_blocked_when_paused() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        let result = client.try_create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Ok(Err(ContractError::ContractPaused)));
    }

    #[test]
    fn test_deposit_to_escrow_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("9MOBILE"),
            &300i128,
            &(1_000_000 + 86_400),
        );

        client.pause();

        let result = client.try_deposit_to_escrow(&buyer, &listing_id);
        assert_eq!(result, Ok(Err(ContractError::ContractPaused)));
    }

    #[test]
    fn test_release_payment_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);
        client.pause();

        let result = client.try_release_payment(&listing_id);
        assert_eq!(result, Ok(Err(ContractError::ContractPaused)));
    }

    #[test]
    fn test_cancel_and_refund_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("AIRTEL"),
            &500i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);
        client.pause();

        let result = client.try_cancel_and_refund(&buyer, &listing_id);
        assert_eq!(result, Ok(Err(ContractError::ContractPaused)));
    }

    #[test]
    fn test_resolve_dispute_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);
        client.pause();

        let result = client.try_resolve_dispute(&listing_id, &buyer);
        assert_eq!(result, Ok(Err(ContractError::ContractPaused)));
    }

    #[test]
    fn test_read_only_views_not_blocked_when_paused() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);
        client.release_payment(&listing_id);

        client.pause();

        let listing = client.get_listing(&listing_id);
        assert_eq!(listing.id, listing_id);

        let rep = client.get_reputation(&seller);
        assert_eq!(rep.completed_trades, 1);

        let bal = client.balance(&token);
        assert_eq!(bal, 0i128);

        let count = client.listing_count();
        assert_eq!(count, 1);

        let admin_addr = client.get_admin();
        assert!(!admin_addr.to_string().is_empty());

        assert!(client.is_paused());
    }

    #[test]
    fn test_operations_resume_after_unpause() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();
        client.unpause();

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("GLO"),
            &1000i128,
            &(1_000_000 + 86_400),
        );

        client.deposit_to_escrow(&buyer, &listing_id);

        let listing = client.get_listing(&listing_id);
        assert_eq!(listing.status, ListingStatus::Sold);
    }

    // -----------------------------------------------------------------------
    // Error variant tests — assert typed ContractError is returned
    // -----------------------------------------------------------------------

    #[test]
    fn test_err_already_initialized() {
        let (_env, client, admin, _seller, _buyer, _token) = setup();
        // setup() already initialised — call again
        let result = client.try_initialize(&admin);
        assert_eq!(result, Ok(Err(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_err_unauthorized_uninitialised_pause() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MarketplaceContract);
        let client = MarketplaceContractClient::new(&env, &contract_id);
        // Contract not initialised — pause should fail with Unauthorized
        let result = client.try_pause();
        assert_eq!(result, Ok(Err(ContractError::Unauthorized)));
    }

    #[test]
    fn test_err_trade_not_found() {
        let (_env, client, _admin, _seller, _buyer, _token) = setup();
        let result = client.try_get_listing(&999u64);
        assert_eq!(result, Ok(Err(ContractError::TradeNotFound)));
    }

    #[test]
    fn test_err_invalid_amount_zero_price() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let result = client.try_create_listing(
            &seller,
            &token,
            &0i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Ok(Err(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_err_invalid_amount_zero_quantity() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let result = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &0i128,
            &(1_000_000 + 86_400),
        );
        assert_eq!(result, Ok(Err(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_err_invalid_expiry() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let result = client.try_create_listing(
            &seller,
            &token,
            &100_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("AIRTEL"),
            &500i128,
            &999_999u64,
        );
        assert_eq!(result, Ok(Err(ContractError::InvalidExpiry)));
    }

    #[test]
    fn test_err_wrong_status_deposit_on_sold_listing() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );
        client.deposit_to_escrow(&buyer, &listing_id);
        // Listing is now Sold — deposit again should fail
        let buyer2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&buyer2, &500_0000000i128);
        let result = client.try_deposit_to_escrow(&buyer2, &listing_id);
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
    }

    #[test]
    fn test_err_trade_expired() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("GLO"),
            &200i128,
            &(1_000_000 + 86_400),
        );
        // Advance past expiry
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 86_401);

        let result = client.try_deposit_to_escrow(&buyer, &listing_id);
        assert_eq!(result, Ok(Err(ContractError::TradeExpired)));
    }

    #[test]
    fn test_err_unauthorized_seller_buys_own_listing() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );
        let result = client.try_deposit_to_escrow(&seller, &listing_id);
        assert_eq!(result, Ok(Err(ContractError::Unauthorized)));
    }

    #[test]
    fn test_err_wrong_status_release_on_active_listing() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );
        // No deposit — still Active
        let result = client.try_release_payment(&listing_id);
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
    }

    #[test]
    fn test_err_wrong_status_cancel_on_active_listing() {
        let (env, client, _admin, seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let listing_id = client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Data,
            &symbol_short!("AIRTEL"),
            &500i128,
            &(1_000_000 + 86_400),
        );
        // Listing is Active, not Sold
        let result = client.try_cancel_and_refund(&buyer, &listing_id);
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
    }
}
