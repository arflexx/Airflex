# Getting Started

This guide walks you through running AirFlex locally from a fresh clone.

---

## Prerequisites

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Node.js | 20.x | https://nodejs.org |
| npm | 10.x | Bundled with Node.js |
| PostgreSQL | 15.x | https://www.postgresql.org |
| Git | any | https://git-scm.com |
| Rust | 1.80+ | https://rustup.rs |
| stellar-cli | 27.x | See below |

### Install stellar-cli

**Windows:**
```bash
winget install -e --id Stellar.StellarCLI --accept-source-agreements --accept-package-agreements
```

**macOS / Linux:**
```bash
cargo install --locked stellar-cli
```

---

## 1. Clone the Repository

```bash
git clone https://github.com/dark-sarge/Airflex.git
cd Airflex
```

---

## 2. Set Up the Database

Create a PostgreSQL database:

```bash
createdb airflex
```

Run the schema (once a migrations file exists, use that instead):

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  stellar_public_key VARCHAR(60),
  stellar_secret_key TEXT, -- encrypt at rest in production
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trade_offers (
  id UUID PRIMARY KEY,
  seller_id UUID REFERENCES users(id),
  buyer_id UUID REFERENCES users(id),
  asset_type VARCHAR(50) NOT NULL,
  amount NUMERIC NOT NULL,
  fee_amount NUMERIC,
  seller_net_amount NUMERIC,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  contract_listing_id TEXT,
  escrow_tx_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trade_offers_status ON trade_offers(status);
CREATE INDEX idx_trade_offers_expires ON trade_offers(expires_at);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  trade_id UUID REFERENCES trade_offers(id),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('debit', 'credit')),
  type VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transactions_trade ON transactions(trade_id);
```

---

## 3. Configure the Server

The server requires configuration variables to run. Copy the template file [`server/.env.example`](file:///server/.env.example) to `server/.env`:

```bash
cd server
cp .env.example .env
```

Open `server/.env` and configure your local settings:

- **`DATABASE_URL`**: PostgreSQL connection string (e.g. `postgresql://postgres:password@localhost:5432/airflex`).
- **`JWT_SECRET`**: Random secret key for signing auth tokens (min 32 characters).
- **`ENCRYPTION_KEY`**: 64-character hex string for AES-256-GCM encryption (`openssl rand -hex 32`).
- **`STELLAR_SERVER_SECRET`**: Stellar admin signing key for escrow release operations (`stellar keys generate --network testnet server-admin`).
- **`PLATFORM_TREASURY_USER_ID`**: Treasury UUID receiving platform fee splits.
- **`PAYSTACK_SECRET_KEY`**: Paystack test secret key (`sk_test_...`) for fiat transactions.
- **`TERMII_API_KEY`**: Termii API key for SMS OTP delivery.
- **`REDIS_URL`**: Redis connection URL for background jobs and caching (`redis://localhost:6379`).
- **`STELLAR_NETWORK` / `HORIZON_URL` / `SOROBAN_RPC_URL`**: Stellar testnet endpoints.
- **`MAX_TRADES_PER_HOUR` / `MAX_DEPOSITS_PER_DAY` / `MAX_WITHDRAWALS_PER_DAY`**: Anti-fraud velocity limits.

The server validates these environment variables on boot via `src/config/validateEnv.ts` and will report any missing or invalid values.

See [Environment Variables Reference](./environment.md) for full documentation of every variable.

---

## 4. Start the API Server

```bash
cd server
npm install
npm run dev
```

The server starts on `http://localhost:3001`.

Verify it's running:

```bash
curl http://localhost:3001/health
# → {"status":"ok","timestamp":"..."}
```

---

## 5. Start the Frontend

```bash
cd frontend
# install dependencies once a package.json exists
npm install
npm run dev
```

The frontend starts on `http://localhost:3000`.

---

## 6. Verify the Contract

The escrow contract is already deployed on testnet. You can inspect it:

```bash
stellar contract invoke \
  --id CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP \
  --source your-key-alias \
  --network testnet \
  -- trade_count
```

---

## Available Server Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Development | `npm run dev` | Hot-reload dev server via ts-node-dev |
| Build | `npm run build` | Compile TypeScript to `dist/` |
| Start | `npm run start` | Run compiled production build |

---

## Next Steps

- Read the [API Reference](./api-reference.md) to explore all endpoints
- Read the [Smart Contract Reference](./smart-contract.md) to understand the on-chain logic
- See [Architecture](./architecture.md) for a full system diagram
