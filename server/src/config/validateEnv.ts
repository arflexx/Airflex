/**
 * validateEnv.ts
 *
 * Startup validation for AirFlex server environment variables.
 * Ensures all required environment variables are present and correctly formatted,
 * emitting clear errors or warnings before server boot.
 */
import logger from "../utils/logger";
import { validateCorsEnv } from "./cors";

// JWT_SECRET must be at least 32 characters so it provides ≥256-bit effective
// entropy when used as an HMAC-SHA256 secret.  A shorter secret allows
// offline brute-forcing of tokens — this is an independent check on top of
// the "present" check so the error message is actionable (issue #247).
const JWT_SECRET_MIN_LEN = 32;

/**
 * Variables that MUST be provided for the server to operate safely.
 * The server will refuse to start if any of these are missing.
 */
export const REQUIRED_ENV_VARS = [
  "JWT_SECRET",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "STELLAR_SERVER_SECRET",
  "PLATFORM_TREASURY_USER_ID",
  "PAYSTACK_SECRET_KEY",
  "TERMII_API_KEY",
] as const;

/**
 * Optional variables with fallback defaults. If absent, a startup warning is logged.
 */
export const OPTIONAL_ENV_VARS = [
  "STELLAR_NETWORK",
  "HORIZON_URL",
  "SOROBAN_RPC_URL",
  "REDIS_URL",
  "CORS_ALLOWED_ORIGINS",
  "PLATFORM_FEE_PERCENT",
  "MAX_TRADES_PER_HOUR",
  "MAX_DEPOSITS_PER_DAY",
  "MAX_WITHDRAWALS_PER_DAY",
  "OTP_RATE_LIMIT_MAX_REQUESTS",
  "OTP_RATE_LIMIT_WINDOW_MINUTES",
  // Storage — required in production when STORAGE_PROVIDER=s3 (default)
  "STORAGE_PROVIDER",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ENDPOINT",
] as const;

export interface EnvValidationResult {
  valid: boolean;
  missingRequired: string[];
  missingOptional: string[];
  errors: string[];
}

/**
 * Validates the provided environment dictionary against required schemas.
 *
 * @param env Environment variables record (defaults to process.env)
 * @returns Validation result with missing variables and error details
 */
export function validateEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): EnvValidationResult {
  const missingRequired = REQUIRED_ENV_VARS.filter((key) => !env[key]);
  const missingOptional = OPTIONAL_ENV_VARS.filter((key) => !env[key]);
  const errors: string[] = [];

  if (missingRequired.length > 0) {
    errors.push(
      `[startup] Missing required environment variables: ${missingRequired.join(", ")}\n` +
        `Copy server/.env.example to server/.env and fill in the values.`
    );
  }

  // JWT_SECRET quality check — must be long enough to resist offline brute-force
  // (issue #247).  Only run when the secret is present (missing case is already
  // covered by the missingRequired check above).
  const jwtSecret = env["JWT_SECRET"];
  if (jwtSecret && jwtSecret.length < JWT_SECRET_MIN_LEN) {
    errors.push(
      `[startup] JWT_SECRET is too short (${jwtSecret.length} chars). ` +
        `It must be at least ${JWT_SECRET_MIN_LEN} characters to provide adequate security. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }

  const encryptionKey = env["ENCRYPTION_KEY"];
  if (encryptionKey && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    errors.push("[startup] ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }

  const port = env["PORT"];
  if (port) {
    const parsedPort = Number.parseInt(port, 10);
    if (!Number.isFinite(parsedPort) || !Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      errors.push(`[startup] Invalid PORT value: "${port}". Must be an integer between 1024 and 65535.`);
    }
  }

  if (env["NODE_ENV"] === "production" && !env["REDIS_URL"]) {
    errors.push("[startup] REDIS_URL is required in production");
  }

  // CORS allowlist — wildcard origins are refused in production and every
  // entry must be a well-formed http(s) origin (issue #539).
  errors.push(...validateCorsEnv(env));

  // Storage validation — when STORAGE_PROVIDER is s3 (or unset, since s3 is the
  // default) the S3_BUCKET and S3_REGION variables are mandatory (issue #248).
  const storageProvider = (env["STORAGE_PROVIDER"] ?? "local").toLowerCase();
  if (storageProvider === "s3") {
    const missingS3 = ["S3_BUCKET", "S3_REGION"].filter((k) => !env[k]);
    if (missingS3.length > 0) {
      errors.push(
        `[startup] S3 storage is enabled (STORAGE_PROVIDER=${storageProvider}) but the following ` +
          `required variables are missing: ${missingS3.join(", ")}. ` +
          `Set STORAGE_PROVIDER=local to use the local filesystem for development.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    missingRequired,
    missingOptional,
    errors,
  };
}

/**
 * Asserts that the environment is valid. Throws an Error and logs structured output
 * if any required variables are missing or malformed.
 *
 * @param env Environment variables record (defaults to process.env)
 * @throws Error when required environment variables are missing or invalid
 */
export function assertEnvValid(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): void {
  const result = validateEnv(env);

  if (result.missingOptional.length > 0) {
    logger.warn(
      `[startup] Missing optional environment variables: ${result.missingOptional.join(", ")}`
    );
  }

  if (!result.valid) {
    const errorMessage = result.errors.join("\n");
    logger.error(errorMessage);
    console.error(errorMessage);
    throw new Error(errorMessage);
  }
}
