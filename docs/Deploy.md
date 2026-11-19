# AirFlex Production Deployment Guide & Runbook

This guide covers deploying the AirFlex API server, Soroban escrow smart contracts, and web applications on Railway and Vercel.

---

## Quick Reference Links
- **Interactive Web Documentation**: [`apps/docs-site/pages/deployment.mdx`](../apps/docs-site/pages/deployment.mdx)
- **Environment Configuration**: [`server/.env.example`](../server/.env.example)
- **Railway Configuration**: [`railway.json`](../railway.json)
- **Soroban Smart Contract Guide**: [`SOROBAN_DEPLOY_GUIDE.md`](../SOROBAN_DEPLOY_GUIDE.md)

---

## 1. Fast Track Deployment (Railway)

1. **Clone & Setup**:
   ```bash
   git clone https://github.com/arflexx/Airflex.git
   cd Airflex
   ```

2. **Server Environment Setup**:
   ```bash
   cd server
   cp .env.example .env
   # Populate DATABASE_URL, JWT_SECRET, and ESCROW_CONTRACT_ADDRESS
   pnpm install
   pnpm build
   pnpm start
   ```

3. **Verify Health Endpoint**:
   ```bash
   curl http://localhost:3001/health
   # Expected: {"status":"ok","version":"1.0.0","timestamp":"..."}
   ```

---

## 2. Zero-Downtime Deployment Configuration

Railway deploys using `railway.json` Nixpacks specifications:
- **Build Command**: `pnpm install --frozen-lockfile && pnpm build`
- **Deploy Command**: `pnpm start`
- **Healthcheck Probe**: `GET /health` with 100-second timeout
- **Restart Policy**: `ON_FAILURE` (max 3 retries)

Railway ensures the incoming release satisfies the healthcheck before terminating existing containers, guaranteeing zero dropped requests during rolling upgrades.

---

## 3. Secret Rotation & Incident Runbook Summary
For detailed step-by-step procedures regarding:
- **Zero-Downtime Secret Rotation** (`JWT_SECRET`, `DATABASE_URL`, `ADMIN_SECRET_KEY`)
- **Rollback Procedures** via Railway CLI and Web Dashboard
- **Production Incident Mitigations** (PostgreSQL pool exhaustion, Redis memory eviction, Stellar RPC failover)

Please consult the primary deployment documentation in [`apps/docs-site/pages/deployment.mdx`](../apps/docs-site/pages/deployment.mdx).
