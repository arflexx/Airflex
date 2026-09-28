# Environment Variables

All environment variables for the API server. Copy [`server/.env.example`](file:///server/.env.example) to `server/.env` and fill in your values before starting.

The server performs automated startup validation in `src/config/validateEnv.ts` and will refuse to start if any required environment variable is missing or malformed.

---

## Required Variables

The server **will not start** if any of these are missing:

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret key used to sign and verify JWT authentication tokens (minimum 32 characters). |
| `DATABASE_URL` | PostgreSQL connection string including credentials, host, port, and database name. |
| `ENCRYPTION_KEY` | 32-byte hex string (64 characters) used for AES-256-GCM symmetric encryption of wallet keys. |
| `STELLAR_SERVER_SECRET` | Stellar server signing key (`S...`) used by the oracle to execute `release_payment` on the escrow contract. Must match the admin address set during contract initialization. |
| `PLATFORM_TREASURY_USER_ID` | UUID of the system treasury user that receives platform fee splits. |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (`sk_test_...` or `sk_live_...`) for fiat deposits, dedicated virtual accounts (DVA), and withdrawals. |
| `TERMII_API_KEY` | Termii API key for OTP delivery and out-of-band transaction SMS alerts. |

---

## Full Reference

### Server & Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port the Express server listens on (integer between 1024 and 65535). |
| `NODE_ENV` | `development` | Set to `production` in deployed environments. Affects morgan logging format and stack traces. |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s). Set to your exact frontend domain in production (e.g. `https://airflex.app`). |
| `PLATFORM_FEE_PERCENT` | `1.5` | Percentage fee deducted from each completed trade settlement. |
| `REFERRAL_REWARD_NGN` | `100` | Referral reward amount credited in NGN to buyer and seller upon trade completion. |

### Database & Redis

| Variable | Example / Default | Description |
|----------|-------------------|-------------|
| `DATABASE_URL` | `postgresql://postgres:password@localhost:5432/airflex` | Full PostgreSQL connection string. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL used by the BullMQ-compatible `QueueService` and cache. |

### Stellar & Smart Contracts

| Variable | Example / Default | Description |
|----------|-------------------|-------------|
| `STELLAR_NETWORK` | `testnet` | Set to `mainnet` to use the public Stellar network, or `testnet`. |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon REST API endpoint for account loading and transaction submission. |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint for contract simulation and invocation. |
| `FRIENDBOT_URL` | `https://friendbot.stellar.org` | Friendbot funding endpoint for newly generated testnet wallets. |
| `ESCROW_CONTRACT_ID` | `CCBJ235OC...` | Contract ID of the deployed AirFlex escrow contract. |
| `MARKETPLACE_CONTRACT_ID` | `C...` | Contract ID of the deployed AirFlex marketplace contract. |
| `ESCROW_CONTRACT_ADDRESS` | `CCBJ235OC...` | Legacy alias for `ESCROW_CONTRACT_ID` (kept for backward compatibility). |
| `STELLAR_SERVER_SECRET` | `S0000...` | Secret key for oracle administration. |

**Mainnet endpoints:**
```env
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
```

### Payments & Messaging

| Variable | Example | Description |
|----------|---------|-------------|
| `PAYSTACK_SECRET_KEY` | `sk_test_xxx` | Paystack secret API key. |
| `PAYSTACK_PREFERRED_BANK` | `wema-bank` | Preferred bank slug for dedicated virtual accounts (`wema-bank`, `access-bank`, `gtbank`). |
| `TERMII_API_KEY` | `TLxxx` | Termii API key for OTP delivery via SMS. |

### Fraud Detection & Velocity Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TRADES_PER_HOUR` | `10` | Maximum number of trade offers a single user can create per hour. |
| `MAX_DEPOSITS_PER_DAY` | `5` | Maximum number of fiat deposits a user can initiate per day. |
| `MAX_WITHDRAWALS_PER_DAY` | `3` | Maximum number of fiat withdrawals a user can initiate per day. |

### Trade Verification Retries

| Variable | Default | Description |
|----------|---------|-------------|
| `RELEASE_RETRY_MAX` | `3` | Maximum number of delivery verification retry attempts before escalating to Disputed. |
| `RELEASE_RETRY_BASE_DELAY_MS` | `2000` | Base delay in milliseconds for exponential backoff and retry jitter. |

### OpenTelemetry (Distributed Tracing)

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OpenTelemetry OTLP HTTP trace collector endpoint. |
| `OTEL_SERVICE_NAME` | `airflex-server` | Service name reported to the distributed tracing collector. |
| `OTEL_ENABLED` | `true` | Set to `"false"` to disable telemetry instrumentation (e.g. in test environments). |

---

## Example `.env`

See [`server/.env.example`](file:///server/.env.example) for a complete template:

```env
# Server
PORT=3001
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000

# Database & Redis
DATABASE_URL=postgresql://postgres:password@localhost:5432/airflex
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
ESCROW_CONTRACT_ID=CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP
STELLAR_SERVER_SECRET=S000000000000000000000000000000000000000000000000000000

# Payments & Messaging
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TERMII_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Auth & Security
JWT_SECRET=change_me_to_a_long_random_string_at_least_32_chars
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
PLATFORM_TREASURY_USER_ID=00000000-0000-0000-0000-000000000000
```

---

## Security Notes

- Never commit `.env` to version control. It is listed in `.gitignore`.
- `JWT_SECRET` rotation invalidates all active sessions — plan for re-login.
- `ENCRYPTION_KEY` must be securely generated and stored in a secrets manager.
- `STELLAR_SERVER_SECRET` must NEVER be exposed or logged.
- Set `CORS_ORIGIN` to your exact frontend domain in production — never leave it as `*` in a live environment.
