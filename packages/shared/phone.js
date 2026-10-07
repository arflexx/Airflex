/**
 * phone.js — shared phone-number format rules (issue #283).
 *
 * Single source of truth for the phone shapes the OTP signup flow accepts.
 * The server's requestOtpSchema (server/src/schemas/auth.schemas.ts) enforces
 * the same rule; the signup page uses this module to validate on blur and show
 * inline feedback before a network round-trip.
 *
 * Shipped as plain CommonJS with a sibling `phone.d.ts` so it can be consumed
 * from Next.js, Jest and the Express server (`exports` map in package.json)
 * with no build step. Deliberately dependency-free: importing it costs nothing.
 */

/**
 * Strict E.164: a mandatory "+", a non-zero leading digit, then 9–14 more
 * digits — e.g. "+2348012345678".
 */
const E164_PHONE_REGEX = /^\+[1-9]\d{9,14}$/;

/**
 * Nigerian local dialling form: a leading 0 followed by 10 digits — e.g.
 * "08012345678". The server normalises this to "+2348012345678".
 */
const NGN_LOCAL_PHONE_REGEX = /^0\d{10}$/;

/**
 * Everything the signup form accepts, mirroring the server regex exactly:
 * the Nigerian local form, E.164, or bare international digits (which the
 * server prefixes with "+"). Accepting exactly what the API accepts means
 * client-side validation can never reject a number the server would have
 * taken — it only saves the user a round-trip on a genuinely malformed one.
 */
const PHONE_INPUT_REGEX = /^(?:0\d{10}|\+?[1-9]\d{9,14})$/;

/**
 * @param {unknown} phone
 * @returns {boolean} true when `phone` is a string in an accepted format
 *   (surrounding whitespace is ignored).
 */
function isValidPhoneInput(phone) {
  return typeof phone === "string" && PHONE_INPUT_REGEX.test(phone.trim());
}

module.exports = {
  E164_PHONE_REGEX,
  NGN_LOCAL_PHONE_REGEX,
  PHONE_INPUT_REGEX,
  isValidPhoneInput,
};
