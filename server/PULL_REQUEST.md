# Pull Request: Issue #138, #140, #141, #142 - Encryption Key, Request ID, Database Pool, Async Error Handling

## Summary

This PR implements four critical infrastructure improvements for the AirFlex server:

- **#138**: ENCRYPTION_KEY validation and AES-256-GCM crypto utilities
- **#140**: X-Request-Id middleware for request correlation across logs
- **#141**: PostgreSQL connection pool with proper error handling
- **#142**: express-async-errors integration for proper async error handling

## Changes

### #138 - ENCRYPTION_KEY & Crypto Utilities

**Files Modified:**
- `server/.env.example` - Added ENCRYPTION_KEY with `openssl rand -hex 32` comment

**Files Created:**
- `server/src/utils/crypto.ts` - AES-256-GCM encrypt/decrypt utility
- `server/src/utils/crypto.test.ts` - Unit tests with round-trip verification

**Validation:**
- Server exits on startup if ENCRYPTION_KEY is not exactly 64 hex characters
- Routes can use `import { encrypt, decrypt } from "./utils/crypto"` for Stellar secret key encryption and KYC NIN encryption

### #140 - Request ID Middleware

**Files Created:**
- `server/src/middleware/requestId.ts` - UUID v4 generator per request

**Files Modified:**
- `server/src/index.ts` - Registered as first middleware, added morgan `:request-id` token

**Files Created:**
- `server/src/middleware/requestId.test.ts` - Unit tests for UUID format and uniqueness

**Features:**
- Sets `X-Request-Id` response header
- Stores ID in `res.locals.requestId` for route handler access
- All morgan log lines now include request ID for correlation

### #141 - PostgreSQL Connection Pool

**Files Created:**
- `server/src/db/pool.ts` - Singleton Pool with configuration (max: 10, idleTimeout: 30s, connectionTimeout: 5s)

**Files Modified:**
- `server/src/index.ts` - Added database startup validation with `SELECT 1` test query
- `server/src/index.ts` - Uses `query()` wrapper for `/ready` probe

**Files Deleted:**
- `server/src/db.ts` - Replaced with proper directory structure

**Features:**
- `db.query(text, params)` is the only way routes interact with database
- No raw pool imports in route files
- Error event handler prevents crashes on client errors
- Server exits on startup if DB connection fails

### #142 - Async Error Handling

**Files Modified:**
- `server/package.json` - Added `express-async-errors@3.1.1`

**Files Created:**
- `server/src/routes/docs.test.ts` - Unit test for async error handling

**Files Deleted:**
- `server/src/utils/asyncHandler.ts` - No longer needed

**Files Modified (route files):**
- All route files updated to remove `asyncHandler` imports:
  - `server/src/routes/admin.ts`
  - `server/src/routes/auth.ts`
  - `server/src/routes/profile.ts`
  - `server/src/routes/trades.ts`
  - `server/src/routes/wallet.ts`

**Features:**
- `import "express-async-errors"` at top of index.ts (before Express import)
- Async errors automatically forwarded to global error handler
- Dev-only test route `/api/v1/test-async-error` verifies async errors produce HTTP 500

## Testing

- All new utilities have unit tests
- `npm test` in server directory to run all tests
- Manual testing: 
  - Run `openssl rand -hex 32` to generate valid ENCRYPTION_KEY
  - Test request correlation via `X-Request-Id` header in responses
  - Verify async errors return HTTP 500 (not hanging)

## Deployment Notes

- **ENCRYPTION_KEY**: Must be set to a 64-character hex string before deployment
- **DATABASE_URL**: Must be configured and PostgreSQL must be reachable
- **express-async-errors**: Works transparently, no config needed

## References

- Issue #138: ENCRYPTION_KEY and crypto utilities
- Issue #140: Request ID middleware for log correlation
- Issue #141: PostgreSQL connection pool
- Issue #142: Async error handling with express-async-errors
