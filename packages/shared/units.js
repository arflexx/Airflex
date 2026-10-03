/**
 * units.js — unit conversion for trade amounts (issue #292).
 *
 * On-chain an amount is an integer number of stroops: 1 whole unit is
 * 1,000,000 stroops. The sell form collects whole naira and converts exactly
 * once, here, with `toStroops()`. The create-listing API then validates the
 * value as a positive integer that is *already* in stroops and forwards it
 * unchanged, so the number the seller typed and the number the escrow contract
 * receives are the same amount and no path multiplies by a literal twice.
 *
 * The platform's own ledger (wallets, transactions, `trade_offers.fee_amount`)
 * is denominated in naira, so `fromStroops()` converts back for storage and
 * display. `toStroops`/`fromStroops` are therefore exact inverses for every
 * amount the platform can produce (listing amounts are capped at
 * MAX_TRADE_STROOPS = 1e12, far inside Number.MAX_SAFE_INTEGER).
 *
 * Shipped as plain CommonJS with a sibling `.d.ts`, dependency-free, so the
 * Next.js app and the Express server share one implementation (the server
 * resolves it through the package's `exports` map).
 *
 * `BigInt(...)` is used instead of `1n` literals so the module can be bundled
 * for browser targets that predate BigInt literals.
 */

/** Stroops per whole unit — the contract's fixed-point scale. */
const STROOPS_PER_UNIT = BigInt(1000000);

/** Largest listing accepted, in whole units (₦1,000,000). */
const MAX_TRADE_UNITS = 1000000;

/** The same cap expressed in stroops. */
const MAX_TRADE_STROOPS = BigInt(MAX_TRADE_UNITS) * STROOPS_PER_UNIT;

/**
 * Converts a whole-unit amount (naira) to stroops.
 *
 * A pure converter: it does not validate that the amount is positive because
 * that is the caller's concern — the create-listing schema requires a positive
 * integer in stroops and the sell form rejects non-positive input before
 * calling here.
 *
 * `Math.round` (rather than truncation) keeps the result exact for naira: two
 * decimal places of naira map cleanly onto the six-decimal stroop scale, and
 * rounding avoids the silent one-stroop undercount `Math.trunc` would cause.
 *
 * @param {number} amount whole units, e.g. 500 for ₦500 (₦500.50 is allowed too)
 * @returns {bigint} the equivalent integer number of stroops
 * @throws {TypeError} when `amount` is not a finite number
 */
function toStroops(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new TypeError(
      `toStroops expects a finite number, received ${String(amount)}`
    );
  }
  return BigInt(Math.round(amount * Number(STROOPS_PER_UNIT)));
}

/**
 * Normalises a value that already represents stroops into a bigint.
 *
 * Accepts a bigint, an integer number, or a string, because the value can come
 * from a JS integer, a contract call, or a Postgres `NUMERIC` column (which
 * `pg` returns as a string, sometimes with a zero scale like "500000000.00").
 * Rejects anything else rather than coercing it.
 *
 * @param {bigint | number | string} value
 * @returns {bigint}
 * @throws {TypeError} when the value is not an integer representation
 * @throws {RangeError} when the value is negative
 */
function asStroops(value) {
  let stroops;

  if (typeof value === "bigint") {
    stroops = value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError(
        `asStroops expects an integer number of stroops, received ${String(value)}`
      );
    }
    stroops = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(?:\.0+)?$/.test(trimmed)) {
      throw new TypeError(
        `asStroops expects a non-negative integer, received "${value}"`
      );
    }
    stroops = BigInt(trimmed.split(".")[0]);
  } else {
    throw new TypeError(
      `asStroops expects a bigint, number or string, received ${typeof value}`
    );
  }

  if (stroops < BigInt(0)) {
    throw new RangeError(
      `asStroops expects a non-negative amount, received ${String(value)}`
    );
  }

  return stroops;
}

/**
 * Converts a stroop amount back to whole units for accounting/display.
 *
 * The result may be fractional (1,500,000 stroops → 1.5), since callers decide
 * how to format it.
 *
 * @param {bigint | number | string} stroops
 * @returns {number} the equivalent amount in whole units
 * @throws {TypeError} when the value is not an integer representation
 * @throws {RangeError} when the value is negative
 */
function fromStroops(stroops) {
  return Number(asStroops(stroops)) / Number(STROOPS_PER_UNIT);
}

module.exports = {
  STROOPS_PER_UNIT,
  MAX_TRADE_UNITS,
  MAX_TRADE_STROOPS,
  toStroops,
  asStroops,
  fromStroops,
};
