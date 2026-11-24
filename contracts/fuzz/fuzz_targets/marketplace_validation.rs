//! Fuzzes the marketplace contract's price, quantity, expiry and reputation
//! arithmetic (issue #644).
//!
//! | Bytes | Meaning                                   |
//! |-------|-------------------------------------------|
//! | 16    | `price` (`i128`, little-endian)           |
//! | 16    | `quantity` (`i128`, little-endian)        |
//! | 8     | `created_at` (`u64`, little-endian)       |
//! | 8     | `expires_at` (`u64`, little-endian)       |
//! | 8     | seconds elapsed since creation (`u64`)    |
//! | 16×N  | further settled trade volumes (`i128`)    |
//!
//! Short inputs are zero-extended. The target checks that validation accepts
//! exactly the documented range, that an offer is never both acceptable and
//! expired, and that reputation totals never wrap or decrease.

#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../marketplace/src/arithmetic.rs"]
mod arithmetic;

use arithmetic::{
    add_volume, bump_counter, check_expiry, deadline, is_offer_expired, is_positive_amount,
    ExpiryCheck, MAX_OFFER_EXPIRY_SECS,
};

/// Reads up to `N` bytes off the front of `data`, zero-extending short input.
fn take<const N: usize>(data: &mut &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    let n = data.len().min(N);
    out[..n].copy_from_slice(&data[..n]);
    *data = &data[n..];
    out
}

fuzz_target!(|input: &[u8]| {
    let mut data = input;
    let price = i128::from_le_bytes(take(&mut data));
    let quantity = i128::from_le_bytes(take(&mut data));
    let created_at = u64::from_le_bytes(take(&mut data));
    let expires_at = u64::from_le_bytes(take(&mut data));
    let elapsed = u64::from_le_bytes(take(&mut data));
    let now = deadline(created_at, elapsed);
    assert!(now >= created_at);

    // create_offer validates at creation, update_listing at some later `now`.
    for at in [created_at, now] {
        match check_expiry(created_at, at, expires_at) {
            ExpiryCheck::Valid => {
                assert!(expires_at > at);
                assert!(expires_at - created_at <= MAX_OFFER_EXPIRY_SECS);
                // An offer that has just been validated is acceptable.
                assert!(!is_offer_expired(at, expires_at));
            }
            ExpiryCheck::NotInFuture => assert!(expires_at <= at),
            ExpiryCheck::TooFar => {
                assert!(expires_at - created_at > MAX_OFFER_EXPIRY_SECS);
            }
        }
    }

    // Expiry is monotonic: once expired, an offer stays expired.
    if is_offer_expired(created_at, expires_at) {
        assert!(is_offer_expired(now, expires_at));
    }

    if !is_positive_amount(price) || !is_positive_amount(quantity) {
        assert!(price <= 0 || quantity <= 0);
        return;
    }

    // Lifetime volume of a seller settling this offer and then others.
    let mut volume = add_volume(0, price);
    let mut completed = bump_counter(u32::MAX - 2);
    assert_eq!(volume, price);
    while !data.is_empty() {
        let next_price = i128::from_le_bytes(take(&mut data));
        if !is_positive_amount(next_price) {
            continue;
        }
        let next = add_volume(volume, next_price);
        assert!(next >= volume);
        volume = next;
        let bumped = bump_counter(completed);
        assert!(bumped >= completed);
        completed = bumped;
    }
});
