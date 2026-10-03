/**
 * Type declarations for units.js — the shared trade-amount conversion
 * utilities (issue #292). Kept next to the implementation so
 * `@airflex/shared/units` resolves for TypeScript without a build step.
 */

/** Stroops per whole unit — the contract's fixed-point scale. */
export declare const STROOPS_PER_UNIT: bigint;

/** Largest listing accepted, in whole units (₦1,000,000). */
export declare const MAX_TRADE_UNITS: number;

/** The same cap expressed in stroops. */
export declare const MAX_TRADE_STROOPS: bigint;

/**
 * Converts a whole-unit amount (naira) to stroops. A pure converter: callers
 * are responsible for rejecting non-positive amounts.
 *
 * @throws {TypeError} when `amount` is not a finite number.
 */
export declare function toStroops(amount: number): bigint;

/**
 * Normalises a value that already represents stroops into a bigint. Accepts
 * bigint, an integer number, or a decimal string from a Postgres `NUMERIC`
 * column (e.g. "500000000.00").
 *
 * @throws {TypeError} when the value is not an integer representation.
 * @throws {RangeError} when the value is negative.
 */
export declare function asStroops(value: bigint | number | string): bigint;

/**
 * Converts a stroop amount back to whole units for accounting/display.
 * Accepts bigint, number or string (Postgres `NUMERIC` columns arrive as
 * strings); the result may be fractional.
 *
 * @throws {TypeError} when the value is not an integer representation.
 * @throws {RangeError} when the value is negative.
 */
export declare function fromStroops(stroops: bigint | number | string): number;
