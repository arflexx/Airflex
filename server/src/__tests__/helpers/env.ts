/**
 * env.ts — test environment configuration.
 *
 * Loaded via Jest's `setupFiles` option, which runs BEFORE any test file (or
 * anything it imports) is evaluated. That guarantees the required environment
 * variables exist before `db.ts` constructs its connection pool and before
 * `app.ts`/routes read configuration.
 *
 * Values already present in the environment (e.g. set by CI) are respected —
 * we only fill in sensible local defaults.
 */

// The test database used by the suite. Provisioned + migrated by globalSetup.
process.env["DATABASE_URL"] ??= "postgresql://postgres:postgres@localhost:5432/airflex_test";

// Required by index.ts startup validation and various services. These are
// dummy values — every external service they authenticate against is mocked
// with msw in helpers/mockHttp.ts.
process.env["NODE_ENV"] = "test";
process.env["JWT_SECRET"] ??= "test-jwt-secret-do-not-use-in-production";
process.env["ESCROW_CONTRACT_ADDRESS"] ??= "CCTESTCONTRACTADDRESS00000000000000000000000000000000000000000";
process.env["ENCRYPTION_KEY"] ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex chars (32 bytes)
process.env["STELLAR_SERVER_SECRET"] ??=
  "SBTESTSERVERSECRET000000000000000000000000000000000000000000000";

// External services — all intercepted by msw, so keys are placeholders.
process.env["TERMII_API_KEY"] ??= "test-termii-api-key";
process.env["PAYSTACK_SECRET_KEY"] ??= "sk_test_placeholder_key";
process.env["STELLAR_NETWORK"] ??= "testnet";
process.env["HORIZON_URL"] ??= "https://horizon-testnet.stellar.org";
