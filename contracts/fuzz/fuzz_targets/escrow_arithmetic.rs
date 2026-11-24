//! Fuzzes the escrow contract's amount, split and deadline arithmetic
//! (issue #644).
//!
//! The input is a listing followed by a sequence of operations on it:
//!
//! | Bytes | Meaning                                   |
//! |-------|-------------------------------------------|
//! | 16    | `total_amount` (`i128`, little-endian)    |
//! | 8     | `now` (`u64`, little-endian)              |
//! | 8     | `expires_at` (`u64`, little-endian)       |
//! | 17×N  | op tag (`u8`), amount (`i128`)            |
//!
//! Short inputs are zero-extended. The target replays the operations the way
//! `deposit_to_escrow` and `cancel_and_refund` do and checks that the fills
//! recorded on a listing always add up, never exceed its total, and that no
//! input panics.

#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../escrow/src/arithmetic.rs"]
mod arithmetic;

use arithmetic::{
    accumulate, apply_fill, apply_refund, deadline, is_fill_in_bounds, is_valid_expiry,
    MAX_DEPOSIT_AMOUNT, MAX_EXPIRY_SECS, MIN_DEPOSIT_AMOUNT,
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
    let total = i128::from_le_bytes(take(&mut data));
    let now = u64::from_le_bytes(take(&mut data));
    let expires_at = u64::from_le_bytes(take(&mut data));

    // Deadlines never move backwards, and the expiry window is never exceeded.
    assert!(deadline(now, MAX_EXPIRY_SECS) >= now);
    if is_valid_expiry(now, expires_at) {
        assert!(expires_at > now);
        assert!(expires_at - now <= MAX_EXPIRY_SECS);
    }

    // Raw, unvalidated inputs: every function must stay total.
    let raw = i128::from(now) - i128::from(expires_at);
    for (a, b) in [
        (total, raw),
        (raw, total),
        (i128::MIN, total),
        (total, i128::MIN),
    ] {
        let _ = apply_fill(a, b, total);
        let _ = apply_refund(a, b);
        let _ = accumulate(a, b);
    }

    // `create_listing` rejects non-positive totals before anything is stored.
    if total <= 0 {
        return;
    }

    let mut filled: i128 = 0;
    let mut fills: Vec<i128> = Vec::new();

    while !data.is_empty() && fills.len() < 64 {
        let [tag] = take::<1>(&mut data);
        let amount = i128::from_le_bytes(take(&mut data));

        if tag % 4 == 3 {
            // cancel_and_refund: settle every active fill in one call.
            let mut refunded: i128 = 0;
            for fill in fills.drain(..) {
                refunded = accumulate(refunded, fill).expect("fills on a listing sum to an i128");
            }
            filled = apply_refund(filled, refunded).expect("refund never exceeds filled");
            assert_eq!(filled, 0);
            continue;
        }

        // deposit_to_escrow
        if !is_fill_in_bounds(amount) {
            assert!(amount < MIN_DEPOSIT_AMOUNT || amount > MAX_DEPOSIT_AMOUNT);
            continue;
        }
        match apply_fill(total, filled, amount) {
            Some(next) => {
                assert!(next > filled);
                assert!(next <= total);
                filled = next;
                fills.push(amount);
            }
            None => assert!(amount > total - filled),
        }
        assert_eq!(filled, fills.iter().sum::<i128>());
    }
});
