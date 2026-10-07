/**
 * Unit tests for the shared stroop conversion utilities (issue #292).
 *
 * The conversion lives in packages/shared (@airflex/shared/units) so the sell
 * form and the server convert amounts identically. `toStroops` is a pure
 * converter — positivity is enforced by the create-listing schema — so these
 * tests pin the behaviour for the edge cases the issue calls out: 0, negative
 * values and fractional inputs.
 */

import {
  MAX_TRADE_STROOPS,
  MAX_TRADE_UNITS,
  STROOPS_PER_UNIT,
  fromStroops,
  toStroops,
} from "@airflex/shared/units";

describe("toStroops (issue #292)", () => {
  it("exposes the contract's fixed-point scale", () => {
    expect(STROOPS_PER_UNIT).toBe(1_000_000n);
    expect(MAX_TRADE_STROOPS).toBe(1_000_000_000_000n);
  });

  it("converts a whole naira amount to stroops", () => {
    expect(toStroops(1)).toBe(1_000_000n);
    expect(toStroops(500)).toBe(500_000_000n);
    expect(toStroops(123_456)).toBe(123_456_000_000n);
  });

  it("accepts the largest listing the API allows", () => {
    expect(toStroops(MAX_TRADE_UNITS)).toBe(MAX_TRADE_STROOPS);
  });

  it("converts 0 to 0 stroops", () => {
    // Validation lives in the schema (positive integer), not in the converter.
    expect(toStroops(0)).toBe(0n);
  });

  it("converts negative values to the matching negative stroop count", () => {
    expect(toStroops(-1)).toBe(-1_000_000n);
    expect(toStroops(-500)).toBe(-500_000_000n);
  });

  it("converts fractional naira to the exact stroop count", () => {
    // Naira has two decimal places and stroops have six, so every kobo value
    // is representable exactly — rounding, not truncating, keeps it exact.
    expect(toStroops(0.5)).toBe(500_000n);
    expect(toStroops(500.5)).toBe(500_500_000n);
    expect(toStroops(500.25)).toBe(500_250_000n);
    expect(toStroops(0.000001)).toBe(1n);
  });

  it("rounds half a stroop to the nearest whole stroop", () => {
    // 1e-7 naira is half a stroop; Math.round takes it to 0, the next value up
    // to 1. The point is that the result is always an integer.
    expect(toStroops(0.0000005)).toBe(1n);
    expect(toStroops(0.0000001)).toBe(0n);
  });

  it("rejects non-finite values", () => {
    expect(() => toStroops(NaN)).toThrow(TypeError);
    expect(() => toStroops(Infinity)).toThrow(TypeError);
    expect(() => toStroops(-Infinity)).toThrow(TypeError);
  });

  it("rejects non-numeric input", () => {
    expect(() => toStroops("500" as unknown as number)).toThrow(TypeError);
    expect(() => toStroops(null as unknown as number)).toThrow(TypeError);
    expect(() => toStroops(undefined as unknown as number)).toThrow(TypeError);
  });
});

describe("fromStroops (issue #292)", () => {
  it("converts stroops back to whole units", () => {
    expect(fromStroops(1_000_000n)).toBe(1);
    expect(fromStroops(500_000_000n)).toBe(500);
    expect(fromStroops(MAX_TRADE_STROOPS)).toBe(MAX_TRADE_UNITS);
  });

  it("keeps sub-unit precision for smaller amounts", () => {
    expect(fromStroops(1n)).toBe(0.000001);
    expect(fromStroops(1_500_000n)).toBe(1.5);
  });

  it("accepts numbers", () => {
    expect(fromStroops(500_000_000)).toBe(500);
    expect(fromStroops(0)).toBe(0);
  });

  it("accepts Postgres NUMERIC strings", () => {
    expect(fromStroops("500000000")).toBe(500);
    expect(fromStroops("500000000.00")).toBe(500);
    expect(fromStroops("  2000000  ")).toBe(2);
  });

  it("rejects malformed strings", () => {
    expect(() => fromStroops("abc")).toThrow(TypeError);
    expect(() => fromStroops("500.5")).toThrow(TypeError);
    expect(() => fromStroops("-500000000")).toThrow(TypeError);
    expect(() => fromStroops("")).toThrow(TypeError);
  });

  it("rejects fractional numbers and other types", () => {
    expect(() => fromStroops(1.5)).toThrow(TypeError);
    expect(() => fromStroops(null as unknown as bigint)).toThrow(TypeError);
  });

  it("round-trips every amount the platform accepts", () => {
    for (const amount of [1, 2, 3, 500, 500.5, 999_999, MAX_TRADE_UNITS]) {
      expect(fromStroops(toStroops(amount))).toBe(amount);
    }
  });
});
