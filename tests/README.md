# tests/

Cross-package test fixtures that don't belong to a single workspace.

| Directory   | What it is                                                   |
| ----------- | ------------------------------------------------------------ |
| `load/`     | k6 load-test scenarios and baseline comparison               |
| `soroban/`  | Local Soroban sandbox for contract deployment/integration tests |

Server unit and integration tests live next to the code in `server/src/` and
run with `pnpm --filter airflex-server test`.

### Trade verification concurrency load test

The `verify-trade-delivery` queue has no HTTP entry point, so its load scenario
is not a k6 script. It lives in
`server/src/__tests__/verifyTradeConcurrency.load.test.ts` and runs with the
server's Jest suite. It pushes 50 concurrent trade verifications through the real
`QueueService` against a simulated Soroban RPC that returns HTTP 429 whenever
too many requests are in flight. It asserts zero rate-limit errors, and that
no more than `VERIFY_TRADE_CONCURRENCY` (default 5) jobs ever run at once.

---

## Soroban sandbox fixtures (`tests/soroban/`)

Scripts that start a private local Stellar network with Soroban RPC, deploy the
`escrow` and `marketplace` contracts to it, check they work, and remove all
trace of it afterwards. Nothing touches testnet, and no real keys are used.

### Prerequisites

| Tool | Notes |
| ---- | ----- |
| Docker with Compose v2 | runs the `stellar/quickstart` image |
| [`stellar` CLI](https://developers.stellar.org/docs/tools/cli) | v22 or newer |
| Rust + `wasm32v1-none` target | `rustup target add wasm32v1-none` |
| `bash`, `curl`, `make` | on Windows, use WSL or Git Bash |

### Quick start

From the repo root:

```bash
make -C contracts integration-test
```

That one target:

1. builds release WASM for both contracts,
2. starts the sandbox and waits for Soroban RPC to report healthy (gives up after 60s),
3. creates and funds a throwaway deployer identity via the sandbox friendbot,
4. deploys and initialises `escrow` (with native XLM as its allowed token) and `marketplace`,
5. runs smoke checks (`get_admin`, `is_paused`, `trade_count` / `listing_count`),
6. runs `$INTEGRATION_CMD` if you set it,
7. **always** tears the sandbox down, even if an earlier step failed.

### Step by step

Use the individual targets when you want the sandbox to stay up while you iterate:

```bash
make -C contracts sandbox-up       # start the network and fund the deployer
make -C contracts sandbox-deploy   # build + deploy + initialise both contracts
make -C contracts sandbox-smoke    # check the deployment
source tests/soroban/.sandbox/contracts.env
echo "$ESCROW_CONTRACT_ID $MARKETPLACE_CONTRACT_ID"
make -C contracts sandbox-down     # remove the container, volumes and local state
```

You can also run the scripts directly (`tests/soroban/sandbox-up.sh`, etc.).
`make` is only a thin wrapper around them.

### Exported contract IDs

`deploy-contracts.sh` writes `tests/soroban/.sandbox/contracts.env`:

```bash
export SOROBAN_NETWORK=airflex-local
export SOROBAN_RPC_URL=http://localhost:8000/rpc
export SOROBAN_NETWORK_PASSPHRASE="Standalone Network ; February 2017"
export SOROBAN_ADMIN_ADDRESS=G...
export NATIVE_TOKEN_CONTRACT_ID=C...
export ESCROW_CONTRACT_ID=C...
export ESCROW_CONTRACT_ADDRESS=C...   # name the server reads
export MARKETPLACE_CONTRACT_ID=C...
```

`source` it to point the server or other tooling at the sandbox. Under GitHub
Actions the same variables are also appended to `$GITHUB_ENV`.

### Running another suite against the sandbox

Set `INTEGRATION_CMD` and it runs from the repo root with `contracts.env` loaded,
after the smoke checks and before teardown:

```bash
INTEGRATION_CMD="pnpm --filter airflex-server test" make -C contracts integration-test
```

### Configuration

All settings are environment variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `SOROBAN_SANDBOX_PORT` | `8000` | Host port for RPC/horizon/friendbot |
| `SANDBOX_TIMEOUT` | `60` | Seconds to wait for RPC health |
| `SOROBAN_QUICKSTART_IMAGE` | `stellar/quickstart:latest` | Pin a specific quickstart tag |
| `SOROBAN_QUICKSTART_ARGS` | `--local --enable core,horizon,rpc` | Container arguments |
| `SOROBAN_COMPOSE_PROJECT` | `airflex-soroban-test` | Compose project name; set it per job to run sandboxes in parallel |
| `SOROBAN_SANDBOX_IDENTITY` | `airflex-sandbox-deployer` | stellar-cli identity name |
| `SOROBAN_SANDBOX_STATE_DIR` | `tests/soroban/.sandbox` | Where CLI config, keys and `contracts.env` are kept |
| `KEEP_SANDBOX` | unset | `1` leaves the sandbox running after `integration-test` |
| `INTEGRATION_CMD` | unset | Extra command to run against the deployed contracts |

To run two sandboxes side by side, give each one its own
`SOROBAN_COMPOSE_PROJECT`, `SOROBAN_SANDBOX_PORT` and `SOROBAN_SANDBOX_STATE_DIR`.

### Isolation and teardown

- **Ledger state** lives only inside the container. No volumes are declared, and
  `sandbox-down.sh` runs `docker compose down -v --remove-orphans`.
- **CLI state** (network alias, deployer key) goes under
  `tests/soroban/.sandbox/` because `STELLAR_CONFIG_HOME` points there. Your
  global `~/.config/stellar` is never modified. Teardown deletes the directory,
  and it is git-ignored.
- `sandbox-down.sh` is idempotent and safe to run when nothing is running.

### Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `Soroban RPC was not healthy after 60s` | The first run pulls the image, which takes longer. Run `docker pull stellar/quickstart:latest` first, or raise `SANDBOX_TIMEOUT`. The script prints the last 50 container log lines. |
| `port is already allocated` | Another sandbox or service is using 8000. Set `SOROBAN_SANDBOX_PORT=8010`. |
| `Escrow WASM not found` | Run `rustup target add wasm32v1-none`, then `make -C contracts wasm`. |
| Stale state after a crash | `make -C contracts sandbox-down` |

### Files

| File | Purpose |
| ---- | ------- |
| `soroban/docker-compose.yml` | Single `stellar/quickstart` service with an RPC healthcheck |
| `soroban/lib.sh` | Shared config and helpers, sourced by every script |
| `soroban/sandbox-up.sh` | Start the sandbox, wait for health, fund the deployer |
| `soroban/deploy-contracts.sh` | Build, deploy and initialise contracts, then write `contracts.env` |
| `soroban/smoke-test.sh` | Assert post-deploy contract state |
| `soroban/sandbox-down.sh` | Remove the container, volumes and `.sandbox/` |
| `soroban/integration-test.sh` | Full lifecycle with guaranteed teardown |
