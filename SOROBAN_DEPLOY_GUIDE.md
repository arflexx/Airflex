# Soroban Smart Contract Deployment Guide

A complete, reusable reference for writing and deploying a Soroban (Rust) smart
contract to the Stellar network — from zero to live. Based on the real steps
used to deploy the AirFlex escrow contract.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Machine Setup](#2-machine-setup)
3. [Create the Contract Project](#3-create-the-contract-project)
4. [Write the Contract](#4-write-the-contract)
5. [Build the Contract](#5-build-the-contract)
6. [Generate a Deployer Keypair](#6-generate-a-deployer-keypair)
7. [Fund the Deployer Account](#7-fund-the-deployer-account)
8. [Deploy to Testnet](#8-deploy-to-testnet)
9. [Initialize the Contract](#9-initialize-the-contract)
10. [Verify the Deployment](#10-verify-the-deployment)
11. [Call Contract Functions](#11-call-contract-functions)
12. [Deploy to Mainnet](#12-deploy-to-mainnet)
13. [Integrate with a Backend](#13-integrate-with-a-backend)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites

You need the following installed before anything else.

### Rust

Install from https://rustup.rs — one command:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On **Windows**, download and run `rustup-init.exe` from the same site.

Verify:

```bash
rustc --version
cargo --version
```

### stellar-cli

**Windows (recommended):**

```bash
winget install -e --id Stellar.StellarCLI --accept-source-agreements --accept-package-agreements
```

**macOS / Linux:**

```bash
cargo install --locked stellar-cli
```

> **Windows note:** `cargo install stellar-cli` requires a working native linker
> (either MSVC build tools or MinGW). The `winget` installer uses a pre-built
> binary and avoids this entirely — prefer it on Windows.

Verify:

```bash
stellar --version
```

### WASM target

`stellar-cli` v22+ requires `wasm32v1-none`:

```bash
rustup target add wasm32v1-none
```

> Older guides reference `wasm32-unknown-unknown`. That target no longer works
> with `stellar-cli` v22+. Always use `wasm32v1-none`.

---

## 2. Machine Setup

### Check your toolchain (Windows only)

```bash
rustup toolchain list
```

Y
If `cargo test` fails with `dlltool not found`, either:
- Install the MSVC C++ build tools via Visual Studio Installer, **or**
- Run tests in CI (Linux) and only do WASM builds locally

### Refresh PATH after installing stellar-cli

In PowerShell you need to reload the PATH in the current session:

```powershell
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH","User")
stellar --version
```

---

## 3. Create the Contract Project

### Option A — New standalone project

```bash
mkdir my-contracts
cd my-contracts
```

Create `Cargo.toml` (workspace root):

```toml
[workspace]
members = ["my-contract"]
resolver = "2"

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
```

Create the contract crate:

```bash
mkdir my-contract/src
```

Create `my-contract/Cargo.toml`:

```toml
[package]
name = "my-contract"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = { version = "22.0.11" }

[dev-dependencies]
soroban-sdk = { version = "22.0.11", features = ["testutils"] }

[features]
testutils = ["soroban-sdk/testutils"]
```

> Always pin the `soroban-sdk` version. Soroban APIs change between major
> versions and an unpinned dep can silently break your build.

### Option B — Add to an existing workspace

Add your new contract to the `members` array in the root `Cargo.toml`:

```toml
[workspace]
members = ["escrow", "my-new-contract"]
```

Then create `my-new-contract/Cargo.toml` and `my-new-contract/src/lib.rs`
following the same pattern as Option A.

---

## 4. Write the Contract

Minimum working contract in `my-contract/src/lib.rs`:

```rust
#![no_std]

use soroban_sdk::{contract, contractimpl, Env, Symbol, symbol_short};

#[contract]
pub struct MyContract;

#[contractimpl]
impl MyContract {
    /// One-time initialisation — call immediately after deploy.
    pub fn initialize(env: Env, admin: soroban_sdk::Address) {
        if env.storage().instance().has(&symbol_short!("admin")) {
            panic!("already initialised");
        }
        admin.require_auth();
        env.storage().instance().set(&symbol_short!("admin"), &admin);
    }

    /// Example read function.
    pub fn hello(env: Env, name: Symbol) -> Symbol {
        name
    }
}
```

### Key rules

| Rule | Why |
|------|-----|
| `#![no_std]` at the top | Soroban WASM runs in a `no_std` environment |
| `#[contract]` on the struct | Marks it as a Soroban contract |
| `#[contractimpl]` on the impl block | Exports functions to the ABI |
| `require_auth()` on every state-changing call | Prevents unauthorised invocation |
| Use `env.storage().persistent()` for user data | Survives ledger close |
| Use `env.storage().instance()` for contract-level data | Admin, counters, config |
| Call `extend_ttl()` on persistent entries | Entries expire after ~30 days without a bump |
| Never use `std::` types | Use `soroban_sdk::Vec`, `soroban_sdk::Map`, `soroban_sdk::String` |

### Storage TTL pattern (copy-paste)

```rust
// After writing a persistent entry, bump its TTL so it doesn't expire
env.storage()
    .persistent()
    .extend_ttl(&your_key, 17_280, 17_280 * 30); // ~30 days of ledgers

// For instance storage
env.storage()
    .instance()
    .extend_ttl(17_280, 17_280 * 30);
```

---

## 5. Build the Contract

From your workspace root (the folder containing the root `Cargo.toml`):

```bash
stellar contract build
```

This runs `cargo rustc` with the correct flags for `wasm32v1-none` and applies
`wasm-opt` automatically.

Successful output looks like:

```
✅ Build Complete
   Wasm File: target/wasm32v1-none/release/my_contract.wasm (XXXX bytes optimized)
   Wasm Hash: <64-char hex>
   Exported Functions: N found
```

**Save the Wasm Hash** — you'll need it to verify the deployment on-chain.

> The WASM file name is your crate name with hyphens replaced by underscores.
> `my-contract` → `my_contract.wasm`

---

## 6. Generate a Deployer Keypair

```bash
stellar keys generate my-deployer --network testnet
```

This saves the keypair to `~/.config/stellar/identity/my-deployer.toml`.

Get the public key:

```bash
stellar keys address my-deployer
```

> **Security:** The identity file contains your secret key in plain text.
> For production deployments use a hardware wallet or a secrets manager.
> Never commit identity files or share your secret key.

---

## 7. Fund the Deployer Account

### Testnet (free via Friendbot)

```bash
stellar keys fund my-deployer --network testnet
```

Or call Friendbot directly in a browser:

```
https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>
```

### Mainnet

You must transfer real XLM to the deployer address from an exchange or existing
wallet. The account needs a minimum balance of ~1 XLM plus enough to cover the
deployment fee (typically 0.01–0.1 XLM depending on WASM size).

---

## 8. Deploy to Testnet

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/my_contract.wasm \
  --source my-deployer \
  --network testnet
```

The command outputs two things — **save both**:

```
✅ Transaction submitted successfully!
🔗 https://stellar.expert/explorer/testnet/tx/<UPLOAD_TX_HASH>

Deploying contract using wasm hash <WASM_HASH>
✅ Transaction submitted successfully!
C<CONTRACT_ADDRESS>
🔗 https://stellar.expert/explorer/testnet/tx/<DEPLOY_TX_HASH>
🔗 https://lab.stellar.org/r/testnet/contract/<CONTRACT_ADDRESS>
✅ Deployed!
```

The contract address starts with `C` and is 56 characters long.

---

## 9. Initialize the Contract

If your contract has an `initialize` function (recommended), call it
immediately after deployment before anyone else can:

```bash
stellar contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source my-deployer \
  --network testnet \
  -- initialize --admin <DEPLOYER_PUBLIC_KEY>
```

The `--` separates `stellar` CLI flags from your contract function arguments.
Function arguments are passed as `--<param_name> <value>`.

---

## 10. Verify the Deployment

### Check the contract exists on-chain

```bash
stellar contract info --id <CONTRACT_ADDRESS> --network testnet
```

### Inspect exported functions

```bash
stellar contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source my-deployer \
  --network testnet \
  -- --help
```

### View on the explorer

- Testnet: `https://stellar.expert/explorer/testnet/contract/<CONTRACT_ADDRESS>`
- Mainnet: `https://stellar.expert/explorer/public/contract/<CONTRACT_ADDRESS>`
- Stellar Lab: `https://lab.stellar.org/r/testnet/contract/<CONTRACT_ADDRESS>`

---

## 11. Call Contract Functions

### Read-only (simulation only, no fees)

```bash
stellar contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source my-deployer \
  --network testnet \
  -- hello --name World
```

### State-changing (requires auth + fee)

```bash
stellar contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source my-deployer \
  --network testnet \
  -- my_function --param1 value1 --param2 value2
```



## 12. Deploy to Mainnet

Mainnet deployment is identical to testnet with two changes:

1. Replace `--network testnet` with `--network mainnet`
2. Use a funded mainnet account as `--source`

```bash
# Deploy
stellar contract deploy \
  --wasm target/wasm32v1-none/release/my_contract.wasm \
  --source my-mainnet-deployer \
  --network mainnet

# Initialize
stellar contract invoke \
  --id <MAINNET_CONTRACT_ADDRESS> \
  --source my-mainnet-deployer \
  --network mainnet \
  -- initialize --admin <ADMIN_PUBLIC_KEY>
```

### Mainnet checklist before deploying

- [ ] Contract tested on testnet end-to-end
- [ ] All functions have `require_auth()` where needed
- [ ] Panic messages are clear and don't leak sensitive data
- [ ] TTL bumps are in place for all persistent storage
- [ ] Admin key is stored securely (hardware wallet recommended)
- [ ] Contract has been audited or reviewed by a second developer
- [ ] You have enough XLM in the deployer account

---

## 13. Integrate with a Backend

Once deployed, store the contract address in your server's environment:

```env
# .env
ESCROW_CONTRACT_ADDRESS=C<YOUR_CONTRACT_ADDRESS>
STELLAR_NETWORK=testnet          # or mainnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

Mainnet RPC endpoints:

```env
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
# or use: https://soroban-rpc.stellar.org (public, rate-limited)
```

### Calling the contract from Node.js / TypeScript

```typescript
import {
  Horizon, SorobanRpc, TransactionBuilder, Networks,
  BASE_FEE, Contract, Address, nativeToScVal, Keypair,
} from "@stellar/stellar-sdk";

const horizon   = new Horizon.Server("https://horizon-testnet.stellar.org");
const soroban   = new SorobanRpc.Server("https://soroban-testnet.stellar.org");
const contract  = new Contract("<CONTRACT_ADDRESS>");
const network   = Networks.TESTNET;

async function callMyFunction(callerSecret: string, arg: string) {
  const keypair = Keypair.fromSecret(callerSecret);
  const account = await horizon.loadAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: network })
    .addOperation(
      contract.call(
        "my_function",
        nativeToScVal(arg, { type: "symbol" })
      )
    )
    .setTimeout(30)
    .build();

  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await soroban.sendTransaction(prepared);
  // Poll for confirmation...
  return result;
}
```

---

## 14. Troubleshooting

### `wasm32v1-none` target not found

```bash
rustup target add wasm32v1-none
```

### `reference-types not enabled: zero byte expected`

You built with `cargo build --target wasm32-unknown-unknown` instead of using
`stellar contract build`. Always use `stellar contract build` — it sets the
correct flags and runs `wasm-opt` for Soroban compatibility.

### `can't find crate for std`

Your `soroban-sdk` version is too old for the `wasm32v1-none` target. Upgrade
to `soroban-sdk = "22.0.11"` or higher in your `Cargo.toml`.

### `dlltool not found` (Windows)

`cargo test` is trying to compile a native binary with the GNU toolchain which
needs MinGW. Options:
- Install Visual Studio C++ build tools and switch to the `msvc` toolchain
- Run `cargo test` in WSL or CI (Linux) instead
- The WASM build (`stellar contract build`) is unaffected — only native tests fail

### `already initialised` panic on `initialize`

You called `initialize` twice. This is intentional — the contract protects
against re-initialization. If you need a fresh state, deploy a new contract
instance.

### Transaction simulation failed: `HostError`

Usually means the contract logic panicked during simulation. Read the
`data` field in the error output — it contains the panic message from
your contract.

### Account not funded / `op_no_account`

Run `stellar keys fund my-deployer --network testnet` or send XLM to the
address on mainnet.

### `spin v0.9.8 is yanked`

Use `cargo install stellar-cli` without `--locked`, or use the `winget`
pre-built binary instead.

---

## Quick Reference Card

```bash
# 1 — Install tools
winget install -e --id Stellar.StellarCLI          # Windows
cargo install --locked stellar-cli                  # macOS/Linux
rustup target add wasm32v1-none

# 2 — Build
stellar contract build

# 3 — Keypair
stellar keys generate my-deployer --network testnet
stellar keys address my-deployer

# 4 — Fund (testnet)
stellar keys fund my-deployer --network testnet

# 5 — Deploy
stellar contract deploy \
  --wasm target/wasm32v1-none/release/my_contract.wasm \
  --source my-deployer \
  --network testnet

# 6 — Initialize
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source my-deployer \
  --network testnet \
  -- initialize --admin <PUBLIC_KEY>

# 7 — Verify
stellar contract info --id <CONTRACT_ID> --network testnet
```
