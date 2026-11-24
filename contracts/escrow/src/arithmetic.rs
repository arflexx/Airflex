//! Pure amount, split and deadline arithmetic for the escrow contract.
//!
//! Every function here is total: it never panics and never wraps, whatever the
//! input. The module deliberately has no `soroban_sdk` dependency so that the
//! `escrow_arithmetic` cargo-fuzz target (`contracts/fuzz`, issue #644) can
//! compile this exact source file and drive it without a host environment.

/// Minimum deposit amount in stroops (1 XLM = 10,000,000 stroops).
///
/// Enforced in `deposit_to_escrow` to prevent dust attacks: a buyer sending a
/// 1-stroop fill consumes a sub-escrow storage slot and a fill-counter entry
/// for a negligible economic contribution, which could be used to spam listings
/// or grief sellers (issue #506).
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
/// the invariant explicit and auditable (issue #506).
///
/// Set to 1_000_000_000_000_000 stroops (100,000,000 XLM) — safely within
/// `i128` and above any foreseeable single-trade maximum on this platform.
pub const MAX_DEPOSIT_AMOUNT: i128 = 1_000_000_000_000_000; // 100,000,000 XLM in stroops

/// Furthest into the future a listing may expire.
pub const MAX_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60; // 30 days = 2,592,000 seconds

/// Whether `fill` is within the per-fill deposit bounds.
pub fn is_fill_in_bounds(fill: i128) -> bool {
    (MIN_DEPOSIT_AMOUNT..=MAX_DEPOSIT_AMOUNT).contains(&fill)
}

/// Returns the listing's filled amount after adding `fill`, or `None` when
/// `fill` is not positive or does not fit in the unfilled remainder.
pub fn apply_fill(total: i128, filled: i128, fill: i128) -> Option<i128> {
    if fill <= 0 {
        return None;
    }
    let remaining = total.checked_sub(filled)?;
    if fill > remaining {
        return None;
    }
    filled.checked_add(fill)
}

/// Adds one settled fill to a running refund total.
pub fn accumulate(running: i128, amount: i128) -> Option<i128> {
    running.checked_add(amount)
}

/// Returns the listing's filled amount after `refund` leaves escrow, or `None`
/// when `refund` is negative or larger than what is recorded as filled.
pub fn apply_refund(filled: i128, refund: i128) -> Option<i128> {
    if refund < 0 || refund > filled {
        return None;
    }
    filled.checked_sub(refund)
}

/// Timestamp `window` seconds after `start`, saturating instead of overflowing.
pub fn deadline(start: u64, window: u64) -> u64 {
    start.saturating_add(window)
}

/// Whether `expires_at` is in the future and within `MAX_EXPIRY_SECS` of `now`.
pub fn is_valid_expiry(now: u64, expires_at: u64) -> bool {
    expires_at > now && expires_at <= deadline(now, MAX_EXPIRY_SECS)
}
