/**
 * phone.ts — Phone number normalisation.
 *
 * Issue: POST /api/v1/auth/request-otp accepted both the Nigerian local
 * format (0XXXXXXXXXX) and E.164 (+234XXXXXXXXXX) without normalising either
 * one before using `phone` as the unique key for the `users` row
 * (`INSERT ... ON CONFLICT (phone) DO NOTHING`). The same physical number
 * typed as "08012345678" on one signup and "+2348012345678" on another
 * therefore created two separate accounts instead of one.
 *
 * `normalizePhone` collapses every accepted input shape to a single E.164
 * representation so it can be used consistently as the phone column's value
 * everywhere a phone number is written or looked up (request-otp, verify-otp,
 * recover/change-phone).
 */

/**
 * Normalises a phone number to E.164 format where possible.
 *
 * Handles:
 *   - Nigerian local format: 0XXXXXXXXXX (11 digits, leading 0)
 *       → +234XXXXXXXXXX
 *   - Already E.164 (leading "+")
 *       → returned unchanged (aside from trimming)
 *   - Bare international digits with no leading "+" (e.g. "2348012345678")
 *       → "+" is prepended
 *
 * Anything that doesn't match one of the shapes above is returned trimmed
 * but otherwise unchanged — callers that need strict format validation
 * (e.g. requestOtpSchema's regex) should validate before normalising, since
 * this function's job is only to collapse equivalent representations, not to
 * reject malformed input.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();

  // Nigerian local format: 0XXXXXXXXXX (11 digits total, leading 0)
  if (/^0\d{10}$/.test(trimmed)) {
    return `+234${trimmed.slice(1)}`;
  }

  // Already E.164 (or at least already has a leading +)
  if (trimmed.startsWith("+")) {
    return trimmed;
  }

  // Bare international digits without a leading + (e.g. "2348012345678")
  if (/^[1-9]\d{9,14}$/.test(trimmed)) {
    return `+${trimmed}`;
  }

  return trimmed;
}
