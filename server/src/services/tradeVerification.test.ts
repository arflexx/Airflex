process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
import { calculatePlatformFee } from "./tradeVerification";

describe("calculatePlatformFee", () => {
  afterEach(() => {
    delete process.env["PLATFORM_FEE_PERCENT"];
  });

  it("uses the default fee for the minimum trade amount", () => {
    expect(calculatePlatformFee(0.01)).toBe(0);
  });

  it("supports a zero-fee configuration", () => {
    process.env["PLATFORM_FEE_PERCENT"] = "0";

    expect(calculatePlatformFee(100)).toBe(0);
  });

  it("rounds the fee to two decimal places", () => {
    process.env["PLATFORM_FEE_PERCENT"] = "1.5";

    expect(calculatePlatformFee(10.37)).toBe(0.16);
  });
});