# Contributing to AirFlex

Thanks for taking the time to contribute. AirFlex is an open-source P2P airtime and data
marketplace built on Stellar — every improvement, whether it's a bug fix, new feature, or
documentation update, helps the community.

Please read this guide before opening issues or pull requests.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Help](#getting-help)
3. [Project Structure](#project-structure)
4. [Development Setup](#development-setup)
5. [Branching Strategy](#branching-strategy)
6. [Making Changes](#making-changes)
7. [Commit Message Convention](#commit-message-convention)
8. [Pull Request Process](#pull-request-process)
9. [Coding Standards](#coding-standards)
10. [Smart Contract Guidelines](#smart-contract-guidelines)
11. [Local Contract Builds](#local-contract-builds)
12. [API Versioning Policy](#api-versioning-policy)
13. [Reporting Bugs](#reporting-bugs)
14. [Suggesting Features](#suggesting-features)
15. [Security Vulnerabilities](#security-vulnerabilities)

---

## Code of Conduct

Be respectful. Harassment, discrimination, or hostile behaviour of any kind will not be
tolerated. When in doubt, default to kindness.

---

## Getting Help

- Open a [GitHub Discussion](https://github.com/dark-sarge/Airflex/discussions) for
  questions about the codebase or architecture.
- Open a [GitHub Issue](https://github.com/dark-sarge/Airflex/issues) to report bugs or
  request features.
- Read the [docs/](./docs) folder — it covers architecture, the API, the smart contract,
  and environment setup in detail.

---

## Project Structure



## Development Setup

### Prerequisites

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Node.js | 20.x | https://nodejs.org |
| npm | 10.x | Bundled with Node.js |
| PostgreSQL | 15.x | https://www.postgresql.org |
| Git | any | https://git-scm.com |
| Rust | 1.80+ | https://rustup.rs — required only for contract work |
| stellar-cli | 27.x | See below — required only for contract work |

### Install stellar-cli (contract contributors only)

**Windows:**
```bash
winget install -e --id Stellar.StellarCLI
```

**macOS / Linux:**
```bash
cargo install --locked stellar-cli
```

### 1. Fork and clone

```bash
git clone https://github.com/<your-username>/Airflex.git
cd Airflex
git remote add upstream https://github.com/dark-sarge/Airflex.git
```

### 2. Set up the server

```bash
cd server
cp .env.example .env   # fill in your values — see docs/environment.md
npm install
npm run dev            # starts on http://localhost:3001
```

Verify the server is healthy:

```bash
curl http://localhost:3001/health
# → {"status":"ok","timestamp":"..."}
```

### 3. Set up the frontend

```bash
cd frontend
echo "NEXT_PUBLIC_API_URL=http://localhost:3001" > .env.local
npm install
npm run dev            # starts on http://localhost:3000
```

### 4. Set up the database

```bash
createdb airflex
# Run the schema from docs/getting-started.md
```

Full local setup instructions are in [docs/getting-started.md](./docs/getting-started.md).

---

## Branching Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable, production-ready code. Direct pushes are not allowed. |
| `feat/<short-description>` | New features |
| `fix/<short-description>` | Bug fixes |
| `docs/<short-description>` | Documentation-only changes |
| `refactor/<short-description>` | Code changes with no behaviour change |
| `chore/<short-description>` | Build, dependencies, config |
| `contract/<short-description>` | Soroban smart contract changes |

**Always branch off `main`:**

```bash
git checkout main
git pull upstream main
git checkout -b feat/your-feature-name
```

**Link your branch to an issue:**

Include the issue number in your branch name or commit message where applicable, e.g.
`feat/marketplace-root-page-issue-1`.

---

## Making Changes

1. Keep changes focused — one logical change per pull request.
2. Read the relevant existing code before writing new code. Match existing patterns,
   naming conventions, and libraries rather than introducing new ones.
3. Update or add documentation in `docs/` if your change affects the API, architecture,
   environment variables, or smart contract.
4. Do not commit secrets, `.env` files, private keys, or credentials.
5. Do not commit `.vscode/`, `.idea/`, or other editor-specific directories — they are
   git-ignored for a reason.

---

## Commit Message Convention

AirFlex follows [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <short summary>

[optional body]

[optional footer — e.g. Closes #42]
```

### Types

| Type | When to use |
|------|------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | Code change with no behaviour change |
| `chore` | Build process, dependencies, config |
| `contract` | Soroban smart contract changes |
| `test` | Adding or updating tests |

### Examples

```bash
feat(frontend): implement root marketplace page closes #1
fix(server): return 404 when trade offer not found
docs: add CONTRIBUTING guide
chore(server): pin pg to 8.12.0
contract(escrow): add extend_ttl to listing storage
```

Rules:
- Use the **imperative mood** in the summary: "add", "fix", "implement" — not "added" or "adding".
- Keep the summary line under **72 characters**.
- Reference the related issue in the footer: `Closes #<number>`.

---

## Pull Request Process

### Before opening a PR

- [ ] Branch is up to date with `main` (`git pull upstream main --rebase`)
- [ ] TypeScript compiles without errors (`npm run build` in `server/`)
- [ ] No secrets or credentials in the diff
- [ ] Relevant docs updated if applicable

### Opening the PR

1. Push your branch to your fork:
   ```bash
   git push -u origin feat/your-feature-name
   ```
2. Open a pull request against `main` on the upstream repo.
3. Fill in the PR template completely — summary, what changed, how to test, checklist.
4. Link the related issue in the PR description using `Closes #<number>`.

### PR title format

Follow the same convention as commit messages:

```
feat(frontend): implement root marketplace page
fix(server): handle missing wallet on trade creation
```

Keep titles under **70 characters**.

### Review

- At least one maintainer approval is required before merge.
- Address review comments with new commits — do not force-push over a PR under review.
- Once approved, a maintainer will squash-merge to `main`.

---

## Coding Standards

### TypeScript (server + frontend)

- `strict: true` is enforced — no implicit `any`, no unchecked nulls.
- Use explicit return types on all exported functions.
- Prefer `const` over `let`. Never use `var`.
- Use Zod for all external input validation (request bodies, query params).
- Wrap async Express handlers in the `asyncHandler` helper so errors propagate to the
  global error middleware.
- No `console.log` in committed code — use `console.error` for errors and prefix with
  a context label, e.g. `[trades]`.

### Frontend (Next.js + Tailwind CSS)

- All styling via Tailwind CSS utility classes — no inline styles, no external CSS
  frameworks.
- Prefer Server Components for data-fetching pages. Use Client Components only when
  interactivity (state, event handlers, browser APIs) is needed.
- Use `aria-label` and semantic HTML elements for accessibility.
- Images must have descriptive `alt` text.
- Keep components small and single-purpose. Extract sub-components when a file exceeds
  roughly 200 lines.

### API design

- Follow the patterns in `server/src/routes/trades.ts` for new route files.
- Always return consistent JSON shapes — `{ data: ... }` for success,
  `{ error: "..." }` for failures, `{ error: "...", details: {...} }` for validation errors.
- Use correct HTTP status codes: `200` OK, `201` Created, `400` Bad Request, `401`
  Unauthorized, `404` Not Found, `500` Internal Server Error.
- Apply the `authenticate` middleware to all routes that require a signed-in user.
- New environment variables must be documented in `docs/environment.md` and added to
  `server/.env.example`.

### Database

- Include a migration script with any schema change.
- Add indexes for columns that appear in `WHERE` or `ORDER BY` clauses.
- Never store plaintext secrets — encrypt sensitive values (e.g. `stellar_secret_key`)
  at rest.

---

## Smart Contract Guidelines

Contract changes carry the highest risk — a deployed contract cannot be patched in place
without redeployment.

- `require_auth()` must be called on every state-changing function.
- `extend_ttl()` must be called on every new persistent storage entry.
- Test all changes on **testnet** before opening a PR.
- Build the contract before committing:
  ```bash
  stellar contract build
  ```
- Update `docs/smart-contract.md` with any new or changed functions.
- Keep `contracts/readme.md` **Storage Schema** section in sync with `DataKey` changes in `escrow/src/lib.rs` (tiers, TTL, and off-chain query examples).
- If redeployment is required, add the new contract address to `server/.env.example`
  and document it in the PR description.

---

## Local Contract Builds

The Soroban contracts live in [`contracts/`](./contracts) as a Cargo workspace
(`escrow` and `marketplace`). This section covers everything needed to build,
test and deploy them from your own machine.

### Prerequisites

| Tool | Version | Why | Install |
|------|---------|-----|---------|
| Rust (via rustup) | 1.80+ | Compiles the contracts | https://rustup.rs |
| `wasm32v1-none` target | — | WASM target required by stellar-cli v22+ | `rustup target add wasm32v1-none` |
| Stellar CLI (Soroban CLI) | 22+ | Builds, deploys and invokes contracts | `cargo install --locked stellar-cli` |
| Docker | 24+ | Optional — runs a local Stellar network (`stellar container start`) | https://docs.docker.com/get-docker/ |
| GNU Make | any | Runs the `contracts/Makefile` targets | Bundled on macOS/Linux |

Verify the toolchain:

```bash
rustc --version
cargo --version
stellar --version
docker --version
```

Official setup documentation:

- Soroban environment setup — https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup
- Stellar CLI reference — https://developers.stellar.org/docs/tools/cli/stellar-cli
- Local network with Docker (Stellar Quickstart) — https://developers.stellar.org/docs/tools/quickstart

### Build the contracts

```bash
cd contracts
make build                 # cargo build --release --workspace (native build)
stellar contract build     # optimised .wasm in target/wasm32v1-none/release/
```

### Run the contract unit tests

```bash
cd contracts
make test                  # cargo test --workspace --all-features on the host target
```

Run a single crate or test while iterating:

```bash
cargo test -p escrow
cargo test -p marketplace <test_name>
```

`make clean` removes build artefacts.

### Deploy to Testnet from your machine

The full walkthrough is in
[`docs/SOROBAN_DEPLOY_GUIDE.md`](./docs/SOROBAN_DEPLOY_GUIDE.md). The short
version:

1. **Build the WASM:**
   ```bash
   cd contracts && stellar contract build
   ```
2. **Create a deployer identity** (stored locally by the CLI):
   ```bash
   stellar keys generate deployer --network testnet
   ```
3. **Fund it from Friendbot:**
   ```bash
   stellar keys fund deployer --network testnet
   ```
4. **Deploy and initialise** with the repository script, which writes the new
   contract IDs to `contracts/deployments.json`:
   ```bash
   SOROBAN_DEPLOYER_SECRET=$(stellar keys show deployer) \
   SOROBAN_ADMIN_ADDRESS=$(stellar keys address deployer) \
     ./contracts/deploy.sh --network testnet --commit no
   ```
5. **Point the server at your deployment** by copying the printed contract
   addresses into `server/.env` (see `server/.env.example`).

Never deploy to mainnet from a local machine, and never commit a secret key.
Use `--commit no` locally so `deployments.json` only changes through CI
(`.github/workflows/soroban-deploy.yml`).

---

## API Versioning Policy

All API routes are prefixed with a version identifier: `/api/v1/`.
This makes it possible to introduce breaking changes in a future `/api/v2/`
without disrupting existing clients.

### Rules

| Change type | Version impact | Action |
|------------|---------------|--------|
| **Breaking** — removing or renaming fields, changing status codes, altering semantics | New version required | Introduce `/api/v2/` prefix; deprecate and eventually sunset the old version |
| **Additive** — new optional fields, new endpoints, new optional query params | No new version | Ship under the same `/api/v1/` prefix |

### X-Api-Version header

Every HTTP response from the server includes:

```
X-Api-Version: 1
```

Clients may use this header to programmatically identify the API version
without inspecting the URL path.

### Deprecation process

1. Announce the deprecation in a GitHub Issue / Release Notes.
2. Add a `Deprecation` and `Sunset` response header to the old version endpoints.
3. Give consumers a reasonable migration window (minimum 3 months).
4. Remove the old version after the sunset date.

### OpenAPI specification

The canonical OpenAPI 3.0 spec lives at [`docs/openapi.yaml`](./docs/openapi.yaml).
Update it whenever you add or modify an endpoint. The spec is the contract
between the server and all consumers (frontend, mobile, third-party integrations).
Server CI also checks the methods and paths mounted in `server/src/routes/index.ts`
against `server/openapi.json`; update the route operations and regenerate the JSON
whenever a route is added, removed, or moved.

---

## Reporting Bugs

Open a [GitHub Issue](https://github.com/dark-sarge/Airflex/issues/new) and include:

1. **What happened** — a clear description of the bug.
2. **What you expected** — what should have happened instead.
3. **Steps to reproduce** — the exact sequence of steps to trigger the bug.
4. **Environment** — OS, Node.js version, browser (if frontend), relevant env vars
   (values redacted).
5. **Logs / screenshots** — any relevant console output or error messages.

---



## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Report them privately to security@airflex.io or through a
[GitHub Security Advisory](https://github.com/arflexx/Airflex/security/advisories/new).
Response times and the disclosure timeline are defined in [`SECURITY.md`](./SECURITY.md).

---

## License

By contributing to AirFlex you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
