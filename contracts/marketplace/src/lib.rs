#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
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
    /// Can only be called once (panics if already initialised).
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialised");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::ListingCounter, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(17_280, 17_280 * 30);
    }

    // -----------------------------------------------------------------------
    // pause / unpause — admin-only circuit breakers
    // -----------------------------------------------------------------------

    /// Halts all state-mutating operations. Only callable by admin.
    /// Emits a `topics: ["contract", "paused"]` event.
    pub fn pause(env: Env) {
        let admin = get_admin(&env);
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &true);

        env.events()
            .publish((topic_contract(), topic_paused()), ());
    }

    /// Resumes normal operations. Only callable by admin.
    /// Emits a `topics: ["contract", "unpaused"]` event.
    pub fn unpause(env: Env) {
        let admin = get_admin(&env);
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);

        env.events()
            .publish((topic_contract(), topic_unpaused()), ());
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
    ) -> u64 {
        require_not_paused(&env);
        seller.require_auth();

        if price <= 0 {
            panic!("price must be positive");
        }
        if quantity <= 0 {
            panic!("quantity must be positive");
        }

        let now = env.ledger().timestamp();
        if expires_at <= now {
            panic!("expires_at must be in the future");
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

        id
    }

    // -----------------------------------------------------------------------
    // deposit_to_escrow — called by the Buyer
    // -----------------------------------------------------------------------

    /// Locks buyer funds into the contract for a specific listing.
    ///
    /// Transfers `listing.price` tokens from `buyer` → contract.
    /// Sets listing status to `Sold`.
    pub fn deposit_to_escrow(env: Env, buyer: Address, listing_id: u64) {
        require_not_paused(&env);
        buyer.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .expect("listing not found");

        if listing.status != ListingStatus::Active {
            panic!("listing is not active");
        }

        let now = env.ledger().timestamp();
        if now >= listing.expires_at {
            panic!("listing has expired");
        }

        if buyer == listing.seller {
            panic!("seller cannot buy own listing");
        }

        let token_client = token::Client::new(&env, &listing.token);
        token_client.transfer(&buyer, &env.current_contract_address(), &listing.price);

        listing.status = ListingStatus::Sold;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(listing_id), &listing);

        env.events()
            .publish((topic_sold(),), (listing_id, buyer, listing.price));
    }

    // -----------------------------------------------------------------------
    // release_payment — called by the Backend / Oracle after delivery
    // -----------------------------------------------------------------------

    /// Releases escrowed funds to the seller once delivery is confirmed.
    /// Updates the seller's reputation on-chain.
    ///
    /// Only the admin account can call this.
    pub fn release_payment(env: Env, listing_id: u64) {
        require_not_paused(&env);

        let admin = get_admin(&env);
        admin.require_auth();

        let listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .expect("listing not found");

        if listing.status != ListingStatus::Sold {
            panic!("listing is not in Sold state");
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
    }

    // -----------------------------------------------------------------------
    // cancel_and_refund — called by Admin
    // -----------------------------------------------------------------------

    /// Returns escrowed funds to the buyer and marks the listing Cancelled.
    ///
    /// Only admin can call this directly in the marketplace contract.
    pub fn cancel_and_refund(env: Env, buyer: Address, listing_id: u64) {
        require_not_paused(&env);

        let admin = get_admin(&env);
        admin.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .expect("listing not found");

        if listing.status != ListingStatus::Sold {
            panic!("listing cannot be refunded in its current state");
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
    }

    // -----------------------------------------------------------------------
    // resolve_dispute — called by Admin
    // -----------------------------------------------------------------------

    /// Admin resolves a disputed listing, transferring funds to the
    /// specified `recipient` (either the buyer for a refund or the seller
    /// for a release).
    pub fn resolve_dispute(env: Env, listing_id: u64, recipient: Address) {
        require_not_paused(&env);

        let admin = get_admin(&env);
        admin.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .expect("listing not found");

        if listing.status != ListingStatus::Sold {
            panic!("only a Sold listing can have a dispute resolved");
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
    }

    // -----------------------------------------------------------------------
    // View helpers  (NOT blocked by paused flag)
    // -----------------------------------------------------------------------

    /// Returns a listing by ID.
    pub fn get_listing(env: Env, listing_id: u64) -> Listing {
        env.storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .expect("listing not found")
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
    #[should_panic(expected = "ContractPaused")]
    fn test_create_listing_blocked_when_paused() {
        let (env, client, _admin, seller, _buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        client.pause();

        client.create_listing(
            &seller,
            &token,
            &500_0000000i128,
            &AssetCategory::Airtime,
            &symbol_short!("MTN"),
            &1000i128,
            &(1_000_000 + 86_400),
        );
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
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

        client.deposit_to_escrow(&buyer, &listing_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
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
        client.release_payment(&listing_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
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
        client.cancel_and_refund(&buyer, &listing_id);
    }

    #[test]
    #[should_panic(expected = "ContractPaused")]
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
        client.resolve_dispute(&listing_id, &buyer);
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

        // get_listing should work while paused
        let listing = client.get_listing(&listing_id);
        assert_eq!(listing.id, listing_id);

        // get_reputation should work while paused
        let rep = client.get_reputation(&seller);
        assert_eq!(rep.completed_trades, 1);

        // balance should work while paused
        let bal = client.balance(&token);
        assert_eq!(bal, 0i128); // funds were released

        // listing_count should work while paused
        let count = client.listing_count();
        assert_eq!(count, 1);

        // get_admin should work while paused
        let admin_addr = client.get_admin();
        assert!(!admin_addr.to_string().is_empty());

        // is_paused should always work
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

    #[test]
    #[should_panic(expected = "not initialised")]
    fn test_pause_fails_if_not_initialised() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, MarketplaceContract);
        let client = MarketplaceContractClient::new(&env, &contract_id);

        client.pause();
    }
}
