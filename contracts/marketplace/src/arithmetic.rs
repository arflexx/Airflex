//! Pure price, expiry and reputation arithmetic for the marketplace contract.
//!
//! Every function here is total: it never panics and never wraps, whatever the
//! input. The module deliberately has no `soroban_sdk` dependency so that the
//! `marketplace_validation` cargo-fuzz target (`contracts/fuzz`, issue #644)
//! can compile this exact source file and drive it without a host environment.

/// Longest an offer may stay open, measured from its creation (issue #637).
pub const MAX_OFFER_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60; // 30 days = 2,592,000 seconds

/// Outcome of validating an offer's `expires_at`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpiryCheck {
    Valid,
    /// `expires_at` is not strictly in the future.
    NotInFuture,
    /// `expires_at` is more than `MAX_OFFER_EXPIRY_SECS` after creation.
    TooFar,
}

/// Whether a price or quantity is acceptable on an offer.
pub fn is_positive_amount(amount: i128) -> bool {
    amount > 0
}

/// Validates `expires_at` at time `now` for an offer created at `created_at`.
pub fn check_expiry(created_at: u64, now: u64, expires_at: u64) -> ExpiryCheck {
    if expires_at <= now {
        ExpiryCheck::NotInFuture
    } else if expires_at > deadline(created_at, MAX_OFFER_EXPIRY_SECS) {
        ExpiryCheck::TooFar
    } else {
        ExpiryCheck::Valid
    }
}

/// Whether an offer has expired: the ledger time exceeds `expires_at`.
///
/// `expires_at` itself is the last second at which the offer can be accepted.
pub fn is_offer_expired(now: u64, expires_at: u64) -> bool {
    now > expires_at
}

/// Timestamp `window` seconds after `start`, saturating instead of overflowing.
pub fn deadline(start: u64, window: u64) -> u64 {
    start.saturating_add(window)
}

/// Adds a settled trade to a seller's lifetime volume.
///
/// Saturates: reputation is informational, and a seller whose volume reaches
/// `i128::MAX` (possible with a worthless custom token) must not make every
/// later settlement trap with the buyer's funds still in escrow.
pub fn add_volume(total: i128, volume: i128) -> i128 {
    total.saturating_add(volume)
}

/// Increments a reputation counter, saturating for the same reason.
pub fn bump_counter(count: u32) -> u32 {
    count.saturating_add(1)
}
