import {
  validateEnv,
  assertEnvValid,
  REQUIRED_ENV_VARS,
  OPTIONAL_ENV_VARS,
} from "./validateEnv";

describe("validateEnv", () => {
  const validFullEnv: Record<string, string> = {
    JWT_SECRET: "a_long_random_string_at_least_32_chars",
    DATABASE_URL: "postgresql://postgres:password@localhost:5432/airflex",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    STELLAR_SERVER_SECRET: "S000000000000000000000000000000000000000000000000000000",
    PLATFORM_TREASURY_USER_ID: "00000000-0000-0000-0000-000000000000",
    PAYSTACK_SECRET_KEY: "sk_test_1234567890",
    TERMII_API_KEY: "TL12345678901234567890",
    PORT: "3001",
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    REDIS_URL: "redis://localhost:6379",
  };

  it("passes when all required variables are valid", () => {
    const result = validateEnv(validFullEnv);
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("identifies all missing required variables when given an empty environment", () => {
    const result = validateEnv({});
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toEqual(expect.arrayContaining([...REQUIRED_ENV_VARS]));
    expect(result.errors[0]).toContain("[startup] Missing required environment variables");
    for (const requiredVar of REQUIRED_ENV_VARS) {
      expect(result.errors[0]).toContain(requiredVar);
    }
  });

  it("validates that ENCRYPTION_KEY must be a 64-character hex string", () => {
    const resultShort = validateEnv({
      ...validFullEnv,
      ENCRYPTION_KEY: "too-short",
    });
    expect(resultShort.valid).toBe(false);
    expect(resultShort.errors).toContain(
      "[startup] ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );

    const resultNonHex = validateEnv({
      ...validFullEnv,
      ENCRYPTION_KEY: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    });
    expect(resultNonHex.valid).toBe(false);
    expect(resultNonHex.errors).toContain(
      "[startup] ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  });

  it("validates PORT range", () => {
    const resultInvalidPort = validateEnv({
      ...validFullEnv,
      PORT: "99999",
    });
    expect(resultInvalidPort.valid).toBe(false);
    expect(resultInvalidPort.errors[0]).toContain('Invalid PORT value: "99999"');
  });

  it("tracks missing optional environment variables without failing validity", () => {
    const minEnv: Record<string, string> = {
      JWT_SECRET: "a_long_random_string_at_least_32_chars",
      DATABASE_URL: "postgresql://postgres:password@localhost:5432/airflex",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      STELLAR_SERVER_SECRET: "S000000000000000000000000000000000000000000000000000000",
      PLATFORM_TREASURY_USER_ID: "00000000-0000-0000-0000-000000000000",
      PAYSTACK_SECRET_KEY: "sk_test_1234567890",
      TERMII_API_KEY: "TL12345678901234567890",
    };

    const result = validateEnv(minEnv);
    expect(result.valid).toBe(true);
    expect(result.missingOptional).toEqual(expect.arrayContaining([...OPTIONAL_ENV_VARS]));
  });

  describe("assertEnvValid", () => {
    it("throws an error when required variables are missing", () => {
      expect(() => assertEnvValid({})).toThrow(/Missing required environment variables/);
    });

    it("does not throw when environment is valid", () => {
      expect(() => assertEnvValid(validFullEnv)).not.toThrow();
    });
  });
});
