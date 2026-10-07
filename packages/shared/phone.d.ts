/**
 * Type declarations for phone.js — the shared phone-number format rules
 * (issue #283). Kept next to the implementation so `@airflex/shared/phone`
 * resolves for TypeScript without a build step.
 */

/** Strict E.164: mandatory "+", non-zero leading digit, 9–14 more digits. */
export declare const E164_PHONE_REGEX: RegExp;

/** Nigerian local form: leading 0 followed by 10 digits (e.g. "08012345678"). */
export declare const NGN_LOCAL_PHONE_REGEX: RegExp;

/** Everything the signup form accepts (local form, E.164, bare international). */
export declare const PHONE_INPUT_REGEX: RegExp;

/**
 * @returns true when `phone` is a string in an accepted format; surrounding
 *   whitespace is ignored.
 */
export declare function isValidPhoneInput(phone: unknown): boolean;
