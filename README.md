# 🌀 AirFlex

> **Open-source P2P Airtime & Data Exchange Marketplace powered by the Stellar Network**

![Status](https://img.shields.io/badge/status-active-success)
![License](https://img.shields.io/badge/license-MIT-blue)
![Stellar](https://img.shields.io/badge/blockchain-Stellar-7D00FF)
![Soroban](https://img.shields.io/badge/contracts-Soroban-orange)
![Node](https://img.shields.io/badge/node-20.x-green)
![TypeScript](https://img.shields.io/badge/typescript-5.5-blue)

AirFlex is an open-source fintech platform that enables users to securely buy, sell, and
exchange airtime and mobile data through a peer-to-peer marketplace backed by Stellar. By
combining traditional payment rails with Soroban smart contracts, AirFlex delivers
transparent, low-cost, escrow-backed telecom value exchange.

---

## Why AirFlex?

Millions of users accidentally over-purchase airtime or data but have no safe way to recover
its value. AirFlex creates a structured marketplace where telecom value can be exchanged
safely — Stellar handles fast, low-fee settlement and Soroban smart contracts guarantee that
funds only move when delivery is confirmed.

---

## Features

- 📱 P2P airtime & data marketplace
- 🔐 JWT authentication with OTP verification
- 💳 Virtual bank accounts via Paystack
- 👛 Integrated Stellar wallet generation
- ⛓ Soroban escrow contracts — funds locked until delivery confirmed
- 💸 Fast deposits & withdrawals
- 📊 Admin dashboard
- 🔔 Webhook-driven payment processing

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js + Tailwind CSS |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL |
| Smart Contracts | Rust + Soroban SDK |
| Blockchain | Stellar (Horizon + Soroban RPC) |
| Payments | Paystack |
| Messaging | Termii |

---

## Architecture

```
User
 │
 ▼
Next.js Web App
 │
 ▼
Express API  ──── PostgreSQL
 │           ──── Paystack
 │           ──── Termii
 │
 ▼
Stellar Network
 ├── Horizon RPC
 ├── Soroban RPC
 └── Escrow Contract
```

Full architecture diagram → [docs/architecture.md](./docs/architecture.md)

---

## Deployed Contracts

| Contract | Network | Address |
|----------|---------|---------|
| Escrow | Testnet | `CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP` |

---

## Repository Structure

```
airflex/
├── apps/
│   └── docs-site/       # Public documentation site (Next.js + Nextra), deployed to docs.airflex.io
├── contracts/           # Soroban smart contracts (escrow, marketplace, token)
├── frontend/
│   └── app/             # Next.js application
├── server/
│   ├── src/
│   │   ├── middleware/ # Express middleware (auth, etc.)
│   │   ├── routes/     # API route handlers
│   │   ├── services/   # External integrations (Stellar SDK, etc.)
│   │   ├── types/      # Shared TypeScript types
│   │   ├── db.ts       # PostgreSQL connection pool
│   │   └── index.ts    # Server entry point
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── .gitignore
├── LICENSE
└── README.md
```

---

## Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/airflex)

Full deployment guide → [docs/deployment.md](./docs/deployment.md)

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/dark-sarge/Airflex.git
cd Airflex
```

### 2. Set up the server

```bash
cd server
cp .env.example .env   # fill in your values
npm install
npm run dev
```

Server runs on `http://localhost:3001`.

```bash
curl http://localhost:3001/health
# → {"status":"ok","version":"1.0.0","timestamp":"..."}
```

### 3. Check the API

```bash
# List active trades
curl "http://localhost:3001/api/v1/trades?page=1&limit=10"
```

Full setup instructions → [docs/getting-started.md](./docs/getting-started.md)

---

## Environment Variables

Minimum required variables to start the server:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/airflex
JWT_SECRET=a_long_random_string_at_least_32_characters
ESCROW_CONTRACT_ADDRESS=CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP
```

Full reference → [docs/environment.md](./docs/environment.md)

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Server health check |
| `GET` | `/api/v1/trades` | — | Paginated active listings |
| `POST` | `/api/v1/trades` | ✅ | Create a trade offer |
| `GET` | `/api/v1/trades/:id` | — | Get trade by ID |
| `POST` | `/api/v1/trades/:id/buy` | ✅ | Buy a trade (locks escrow) |

Full API docs → [docs/api-reference.md](./docs/api-reference.md)

---

## Smart Contract

The escrow contract is live on Stellar Testnet:

```
CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP
```

| Function | Caller | Description |
|----------|--------|-------------|
| `initialize` | Deployer | Set admin, seed counter |
| `create_listing` | Seller | Register trade on-chain |
| `deposit_to_escrow` | Buyer | Lock funds in contract |
| `release_payment` | Admin | Release funds to seller |
| `cancel_and_refund` | Buyer / Admin | Refund buyer |
| `flag_dispute` | Buyer / Seller | Escalate to admin |

Contract reference → [docs/smart-contract.md](./docs/smart-contract.md)  
Deployment guide → [SOROBAN_DEPLOY_GUIDE.md](./SOROBAN_DEPLOY_GUIDE.md)

---

## Marketplace Flow

1. User signs up with phone number
2. OTP verification completes
3. Wallet, Stellar keypair, and virtual account are created
4. Seller lists airtime/data → `create_listing` called on-chain
5. Buyer accepts offer → `deposit_to_escrow` locks funds
6. Platform verifies delivery
7. `release_payment` transfers funds to seller
8. Trade marked Completed

---

## Roadmap

The full public roadmap — milestones, issue mapping, target dates, and
deliberately deferred features — lives in
**[`ROADMAP.md`](./ROADMAP.md)**.

| Milestone | Focus | Target |
|-----------|-------|--------|
| v0.1.0 — Foundation | Monorepo, CI/CD, Docker, core server scaffold | Q3 2026 |
| v0.2.0 — Auth & Wallets | OTP, Stellar wallet, virtual accounts, Paystack deposits | Q4 2026 |
| v0.3.0 — Marketplace MVP | Trade listings, buy flow, escrow integration | Q1 2027 |
| v0.4.0 — Full Trade Lifecycle | Dispute resolution, delivery confirmation, notifications | Q2 2027 |
| v0.5.0 — Polish & Launch | Admin dashboard, PWA, i18n, docs site | Q3 2027 |

---

## Documentation

The full documentation site (API Reference, Contract Reference, SDK Reference,
Deployment, and Contributing guides) is published at **docs.airflex.io** —
built from [`apps/docs-site`](./apps/docs-site) via [Nextra](https://nextra.site).
The table below links to the equivalent hand-written Markdown in this repo.

| Document | Description |
|----------|-------------|
| [Overview](./docs/overview.md) | Concepts, trade lifecycle, system components |
| [Getting Started](./docs/getting-started.md) | Local setup from scratch |
| [API Reference](./docs/api-reference.md) | All endpoints, request/response shapes |
| [Smart Contract](./docs/smart-contract.md) | Contract functions, security, events |
| [Architecture](./docs/architecture.md) | System diagrams, request flows, design decisions |
| [Environment](./docs/environment.md) | All environment variables explained |
| [Deployment Guide](./docs/deployment.md) | Deploy to Vercel + Railway (server + DB + Redis) |
| [Deploy Guide](./SOROBAN_DEPLOY_GUIDE.md) | How to deploy a Soroban contract from scratch |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Make your changes
4. Open a pull request

---

## Security

AirFlex handles real user funds — security is a first-class concern.

Please report vulnerabilities **privately** via email at **security@airflex.io**
or through [GitHub's private vulnerability reporting](https://github.com/arflexx/Airflex/security/advisories/new).
Never disclose security issues publicly before a fix is available.

We acknowledge reports within **48 hours**, complete triage within **7 days**,
and communicate a fix timeline within **14 days**. Researchers who report
valid issues in good faith are credited in the published advisory and will not
face legal action.

Full policy, scope, and coordinated disclosure terms → [SECURITY.md](./SECURITY.md)

---

## License

[MIT](./LICENSE)
