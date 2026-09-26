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
    PausedAt,
}

pub const EMERGENCY_TIMELOCK_SECS: u64 = 72 * 60 * 60; // 72 hours = 259,200 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum ListingStatus {
    Active,
    Sold,
    /// Payment has been released to the seller after delivery was confirmed.
    /// Distinct from `Sold` so a completed sale can be told apart from one
    /// still awaiting release — release_payment used to leave a listing in
    /// `Sold` forever, making the two indistinguishable and leaving nothing
    /// to stop `release_payment` being called again on the same listing.
    Released,
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
    /// Set by deposit_to_escrow once a buyer locks funds. Used by
    /// resolve_dispute to confirm a recipient is actually a party to the
    /// trade before funds are moved to them.
    pub buyer: Option<Address>,
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

// Event topics defined with `symbol_short!` are limited to at most 9 ASCII
// characters (e.g. "cancelled" is exactly 9 chars, at the limit).
// Any topic strings approaching or exceeding 9 characters must use `Symbol::new(env, "...")`
// to avoid compile-time macro panics.
fn topic_listed()    -> Symbol { symbol_short!("listed")    } // 6 chars
fn topic_sold()      -> Symbol { symbol_short!("sold")      } // 4 chars
fn topic_cancelled() -> Symbol { symbol_short!("cancelled") } // 9 chars (max limit for symbol_short!)
fn topic_contract()  -> Symbol { symbol_short!("contract")  } // 8 chars
fn topic_paused()    -> Symbol { symbol_short!("paused")    } // 6 chars
fn topic_unpaused()  -> Symbol { symbol_short!("unpaused")  } // 8 chars
fn topic_updated()   -> Symbol { symbol_short!("updated")   } // 7 chars

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
            buyer: None,
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
        listing.buyer = Some(buyer.clone());

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
            &listing.seller,
            &listing.price,
        );

        // Previously the listing was never re-saved here, so it stayed
        // `Sold` forever — indistinguishable from a listing whose payment had
        // not yet been released, and with nothing stopping this function
        // being called again on the same listing to drain it a second time.
        listing.status = ListingStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Listing(listing_id), &listing);

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

        // `recipient` must be a known party to this specific trade — either
        // the seller (a release) or the buyer who actually deposited into
        // escrow (a refund). Without this check the admin key could move a
        // listing's escrowed funds to any arbitrary address, since nothing
        // here previously tied `recipient` back to the trade at all.
        let is_seller = recipient == listing.seller;
        let is_buyer = listing.buyer.as_ref() == Some(&recipient);
        if !is_seller && !is_buyer {
            return Err(ContractError::NotAParty);
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
        update_reputation(&env, &listing.seller, listing.price, !is_seller);

        env.events()
            .publish((topic_cancelled(),), (listing_id, recipient));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // update_listing — called by the Seller (Issue #345)
    // -----------------------------------------------------------------------

    /// Updates the price and expiration timestamp of an active listing.
    ///
    /// Only the original seller can call this, and only while the listing is `Active`.
    /// Emits an `updated` event.
    pub fn update_listing(
        env: Env,
        seller: Address,
        listing_id: u64,
        new_price: i128,
        new_expires_at: u64,
    ) -> Result<(), ContractError> {
        require_not_paused(&env)?;
        seller.require_auth();

        if new_price <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        if new_expires_at <= now {
            return Err(ContractError::InvalidExpiry);
        }

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(listing_id))
            .ok_or(ContractError::TradeNotFound)?;

        if listing.seller != seller {
            return Err(ContractError::Unauthorized);
        }

        if listing.status != ListingStatus::Active {
            return Err(ContractError::WrongStatus);
        }

        listing.price = new_price;
        listing.expires_at = new_expires_at;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(listing_id), &listing);

        env.events()
            .publish((topic_updated(),), (listing_id, seller, new_price, new_expires_at));

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

    #[test]
    fn test_event_topic_lengths_and_long_topic_handling() {
        let env = Env::default();

        // Compile-time & runtime verification that symbol_short! topics stay within <= 9 chars
        const SHORT_TOPICS: &[&str] = &[
            "listed",
            "sold",
            "cancelled",
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
        let _ = topic_listed();
        let _ = topic_sold();
        let _ = topic_cancelled();
        let _ = topic_contract();
        let _ = topic_paused();
        let _ = topic_unpaused();

        // Verify that longer/new topics (> 9 chars, e.g. "emergency_withdrawal") work with Symbol::new(&env, ...)
        let long_topic = Symbol::new(&env, "emergency_withdrawal");
        assert_eq!(long_topic, Symbol::new(&env, "emergency_withdrawal"));
    }

    // -----------------------------------------------------------------------
    // update_listing tests (Issue #345)
    // -----------------------------------------------------------------------

    #[test]
    fn test_update_listing_authorized() {
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

        let new_price = 600_0000000i128;
        let new_expires_at = 1_000_000 + 172_800;

        client.update_listing(&seller, &listing_id, &new_price, &new_expires_at);

        let updated = client.get_listing(&listing_id);
        assert_eq!(updated.price, new_price);
        assert_eq!(updated.expires_at, new_expires_at);
        assert_eq!(updated.status, ListingStatus::Active);
    }

    #[test]
    fn test_update_listing_unauthorized() {
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

        let result = client.try_update_listing(&buyer, &listing_id, &600_0000000i128, &(1_000_000 + 100_000));
        assert_eq!(result, Ok(Err(ContractError::Unauthorized)));
    }

    #[test]
    fn test_update_listing_non_active_fails() {
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

        // Buyer deposits, making listing Sold
        client.deposit_to_escrow(&buyer, &listing_id);

        let result = client.try_update_listing(&seller, &listing_id, &600_0000000i128, &(1_000_000 + 100_000));
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
    }

    // -----------------------------------------------------------------------
    // emergency_withdraw tests (Issue #346)
    // -----------------------------------------------------------------------

    #[test]
    fn test_emergency_withdraw_success_after_timelock() {
        let (env, client, _admin, _seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        let contract_addr = client.address.clone();
        sac.mint(&contract_addr, &1_000_0000000i128);

        // Must be paused
        client.pause();

        // Advance ledger time past 72 hours
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + EMERGENCY_TIMELOCK_SECS + 1);

        let recipient = buyer.clone();
        let initial_balance = sac.balance(&recipient);

        client.emergency_withdraw(&token, &recipient, &500_0000000i128);

        assert_eq!(sac.balance(&recipient), initial_balance + 500_0000000i128);
    }

    #[test]
    fn test_emergency_withdraw_fails_before_timelock() {
        let (env, client, _admin, _seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client.address, &1_000_0000000i128);

        client.pause();

        // Only 1 hour passed
        env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 3600);

        let result = client.try_emergency_withdraw(&token, &buyer, &500_0000000i128);
        assert_eq!(result, Ok(Err(ContractError::TimelockNotExpired)));
    }

    #[test]
    fn test_emergency_withdraw_fails_when_not_paused() {
        let (env, client, _admin, _seller, buyer, token) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client.address, &1_000_0000000i128);

        // Not paused
        let result = client.try_emergency_withdraw(&token, &buyer, &500_0000000i128);
        assert_eq!(result, Ok(Err(ContractError::WrongStatus)));
    }
}
