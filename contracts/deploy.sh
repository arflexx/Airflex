#!/usr/bin/env bash
# =============================================================================
# deploy.sh — AirFlex Soroban contract build, deploy, verify and rollback script
#
# Usage:
#   ./contracts/deploy.sh [OPTIONS]
#
# Options:
#   --network     testnet | mainnet  (default: testnet)
#   --contract    escrow | marketplace | all  (default: all)
#   --initialize  yes | no  (default: yes)
#   --commit      yes | no  — commit deployments.json after deploy (default: yes)
#   --dry-run     Validate inputs and keypair format, then print the deploy
#                 plan and exit 0 WITHOUT making any network calls, building,
#                 or writing deployments.json.
#   --force       Re-deploy a contract even if deployments.json already holds a
#                 non-empty address for it on the target network (overrides the
#                 idempotency skip).
#   --rollback    Re-deploy the previous WASM hash recorded in deployments.json
#                 instead of building. Creates a NEW contract instance with
#                 fresh state; see contracts/readme.md before using it.
#   --verify      Smoke-test the contracts recorded in deployments.json against
#                 the network, without deploying or writing anything.
#   --yes         Skip the interactive mainnet confirmation (for CI, where the
#                 GitHub Environment approval replaces it).
#   --help        Print this help message
#
# A contract is written to deployments.json only after its on-chain WASM hash,
# its initialize call and its read-only getters have all been verified.
#
# Required environment variables:
#   SOROBAN_DEPLOYER_SECRET   Stellar secret key (S...) of the deployer account
#   SOROBAN_ADMIN_ADDRESS     Stellar public key (G...) to set as contract admin
#
# Optional:
#   SOROBAN_RPC_URL           Override default RPC endpoint
#   SOROBAN_ALLOWED_TOKENS    Comma-separated token contract IDs (C...) the escrow
#                             accepts; unset initialises it with none, and tokens
#                             must then be added with add_allowed_token
#   ESCROW_MAX_AMOUNT_STROOPS Per-listing escrow cap set via update_max_amount after
#                             initialize (issue #636); unset leaves escrow uncapped
#
# Examples:
#   # Validate keys + config without deploying anything
#   SOROBAN_DEPLOYER_SECRET=S... SOROBAN_ADMIN_ADDRESS=G... ./contracts/deploy.sh --dry-run
#
#   # Deploy all contracts to testnet
#   SOROBAN_DEPLOYER_SECRET=S... SOROBAN_ADMIN_ADDRESS=G... ./contracts/deploy.sh
#
#   # Deploy only the marketplace contract to testnet, skip initialize
#   SOROBAN_DEPLOYER_SECRET=S... SOROBAN_ADMIN_ADDRESS=G... \
#     ./contracts/deploy.sh --contract marketplace --initialize no
#
#   # Deploy escrow to mainnet (double-check before running!)
#   SOROBAN_DEPLOYER_SECRET=S... SOROBAN_ADMIN_ADDRESS=G... \
#     ./contracts/deploy.sh --network mainnet --contract escrow
#
#   # Roll the testnet escrow back to the previously deployed WASM
#   SOROBAN_DEPLOYER_SECRET=S... SOROBAN_ADMIN_ADDRESS=G... \
#     ./contracts/deploy.sh --contract escrow --rollback
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NETWORK="testnet"
CONTRACT="all"
INITIALIZE="yes"
COMMIT="yes"
DRY_RUN="no"
FORCE="no"
ROLLBACK="no"
VERIFY_ONLY="no"
ASSUME_YES="no"

# Script is expected to be run from the repo root or contracts/ directory.
# Resolve the contracts/ directory relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENTS_FILE="${SCRIPT_DIR}/deployments.json"
DEPLOYMENTS_TOOL="${SCRIPT_DIR}/scripts/deployments.cjs"

# RPC nodes can lag a confirmed transaction by a few ledgers, so verification
# retries before declaring a deployment broken.
VERIFY_ATTEMPTS=5
VERIFY_DELAY_SECS=5

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
require_value() {
  [[ $# -ge 2 ]] || fail "$1 requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)     require_value "$@"; NETWORK="$2";    shift 2 ;;
    --contract)    require_value "$@"; CONTRACT="$2";   shift 2 ;;
    --initialize)  require_value "$@"; INITIALIZE="$2"; shift 2 ;;
    --commit)      require_value "$@"; COMMIT="$2";     shift 2 ;;
    --dry-run)     DRY_RUN="yes";     shift 1 ;;
    --force)       FORCE="yes";       shift 1 ;;
    --rollback)    ROLLBACK="yes";    shift 1 ;;
    --verify)      VERIFY_ONLY="yes"; shift 1 ;;
    --yes)         ASSUME_YES="yes";  shift 1 ;;
    --help)
      sed -n '/^# Usage:/,/^# ====/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation — argument ranges
# ---------------------------------------------------------------------------
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  fail "--network must be 'testnet' or 'mainnet'"
fi

if [[ "$CONTRACT" != "escrow" && "$CONTRACT" != "marketplace" && "$CONTRACT" != "all" ]]; then
  fail "--contract must be 'escrow', 'marketplace', or 'all'"
fi

if [[ "$INITIALIZE" != "yes" && "$INITIALIZE" != "no" ]]; then
  fail "--initialize must be 'yes' or 'no'"
fi

if [[ "$COMMIT" != "yes" && "$COMMIT" != "no" ]]; then
  fail "--commit must be 'yes' or 'no'"
fi

if [[ "$ROLLBACK" == "yes" && "$VERIFY_ONLY" == "yes" ]]; then
  fail "--rollback and --verify cannot be combined"
fi

# ---------------------------------------------------------------------------
# Validation — required environment variables (non-empty)
# ---------------------------------------------------------------------------
# Done before any network call so a missing key fails fast and never leaves
# deployments.json in an inconsistent state (Issue #511).
if [[ -z "${SOROBAN_DEPLOYER_SECRET:-}" ]]; then
  fail "SOROBAN_DEPLOYER_SECRET environment variable is not set"
fi

if [[ -z "${SOROBAN_ADMIN_ADDRESS:-}" ]]; then
  fail "SOROBAN_ADMIN_ADDRESS environment variable is not set"
fi

# ---------------------------------------------------------------------------
# Validation — keypair format (Stellar base32 patterns)
# ---------------------------------------------------------------------------
# Stellar secret keys:  'S' followed by 55 base32 chars [A-Z2-7]  = 56 total
# Stellar public keys:  'G' followed by 55 base32 chars [A-Z2-7]  = 56 total
# This validates format/pattern only (not the checksum); the Soroban CLI
# itself rejects a key that cannot derive a valid account when used.
if [[ ! "${SOROBAN_DEPLOYER_SECRET}" =~ ^S[A-Z2-7]{55}$ ]]; then
  echo "ERROR: SOROBAN_DEPLOYER_SECRET is not a valid Stellar secret key" >&2
  echo "       (expected 'S' + 55 base32 characters [A-Z2-7], 56 total)" >&2
  exit 1
fi

if [[ ! "${SOROBAN_ADMIN_ADDRESS}" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo "ERROR: SOROBAN_ADMIN_ADDRESS is not a valid Stellar public key" >&2
  echo "       (expected 'G' + 55 base32 characters [A-Z2-7], 56 total)" >&2
  exit 1
fi

# Build the escrow allow-list argument: "C1,C2" -> ["C1","C2"]
ALLOWED_TOKENS_JSON="[]"
if [[ -n "${SOROBAN_ALLOWED_TOKENS:-}" ]]; then
  if [[ ! "${SOROBAN_ALLOWED_TOKENS}" =~ ^C[A-Z2-7]{55}(,C[A-Z2-7]{55})*$ ]]; then
    fail "SOROBAN_ALLOWED_TOKENS must be comma-separated contract IDs (C...) without spaces"
  fi
  ALLOWED_TOKENS_JSON="[\"${SOROBAN_ALLOWED_TOKENS//,/\",\"}\"]"
fi

# ---------------------------------------------------------------------------
# Network configuration (local string assignment only — no network call yet)
# ---------------------------------------------------------------------------
if [[ "$NETWORK" == "mainnet" ]]; then
  RPC_URL="${SOROBAN_RPC_URL:-https://mainnet.stellar.validationcloud.io/v1/}"
  NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
  STELLAR_EXPERT_BASE="https://stellar.expert/explorer/public/contract"
else
  RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
  NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
  STELLAR_EXPERT_BASE="https://stellar.expert/explorer/testnet/contract"
fi

if [[ "$VERIFY_ONLY" == "yes" ]]; then
  MODE="verify"
elif [[ "$ROLLBACK" == "yes" ]]; then
  MODE="rollback"
else
  MODE="deploy"
fi

if [[ "$CONTRACT" == "all" ]]; then
  SELECTED="escrow marketplace"
else
  SELECTED="$CONTRACT"
fi

# ---------------------------------------------------------------------------
# deployments.json access
# ---------------------------------------------------------------------------
# recorded <contract> <field>
recorded() {
  node "${DEPLOYMENTS_TOOL}" get "${DEPLOYMENTS_FILE}" "${NETWORK}" "$1" "$2"
}

# Resolve every rollback target up front: with `--contract all`, a contract
# without history must abort the run before anything is deployed.
ESCROW_ROLLBACK_HASH=""
MARKETPLACE_ROLLBACK_HASH=""
if [[ "$MODE" == "rollback" ]]; then
  for name in $SELECTED; do
    hash="$(node "${DEPLOYMENTS_TOOL}" rollback-target "${DEPLOYMENTS_FILE}" "${NETWORK}" "${name}")"
    if [[ "$name" == "escrow" ]]; then
      ESCROW_ROLLBACK_HASH="$hash"
    else
      MARKETPLACE_ROLLBACK_HASH="$hash"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Dry run — validate everything, then stop before any network call (Issue #511)
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "yes" ]]; then
  echo ""
  echo "=== AirFlex Soroban Deploy — DRY RUN (no network calls) ==="
  echo "  Mode:          ${MODE}"
  echo "  Network:       ${NETWORK}"
  echo "  Contract:      ${CONTRACT}"
  echo "  Initialize:    ${INITIALIZE}"
  echo "  Commit:        ${COMMIT}  (skipped in dry-run)"
  echo "  Force redeploy: ${FORCE}"
  echo "  RPC URL:       ${RPC_URL}"
  echo "  Deployer key:  ${SOROBAN_DEPLOYER_SECRET:0:4}…${SOROBAN_DEPLOYER_SECRET: -4}  (format OK)"
  echo "  Admin address: ${SOROBAN_ADMIN_ADDRESS}  (format OK)"
  echo "  Escrow tokens: ${ALLOWED_TOKENS_JSON}"
  if [[ "$MODE" == "rollback" ]]; then
    echo "  Rollback to:   escrow=${ESCROW_ROLLBACK_HASH:-—} marketplace=${MARKETPLACE_ROLLBACK_HASH:-—}"
  fi
  echo ""
  echo "All pre-flight checks passed. Re-run without --dry-run to ${MODE}."
  exit 0
fi

# Mainnet guard — require explicit acknowledgement before spending or replacing
if [[ "$NETWORK" == "mainnet" && "$MODE" != "verify" && "$ASSUME_YES" != "yes" ]]; then
  echo ""
  echo "⚠️  WARNING: You are about to ${MODE} on MAINNET."
  echo "   This costs real XLM and produces an immutable on-chain address."
  echo ""
  read -r -p "Type '${MODE} to mainnet' to confirm: " CONFIRM
  if [[ "$CONFIRM" != "${MODE} to mainnet" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

echo ""
echo "=== AirFlex Soroban Deploy ==="
echo "  Mode:     ${MODE}"
echo "  Network:  ${NETWORK}"
echo "  Contract: ${CONTRACT}"
echo "  RPC URL:  ${RPC_URL}"
echo ""

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# ---------------------------------------------------------------------------
# Add deployer identity and network to stellar-cli config
# ---------------------------------------------------------------------------
echo ">> Configuring stellar-cli..."

echo "$SOROBAN_DEPLOYER_SECRET" | \
  stellar keys add deployer --secret-key --stdin 2>/dev/null || true

stellar network add "${NETWORK}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" 2>/dev/null || true

# The address is recorded next to every deployment, so resolve it from the same
# identity that signs — and stop here if that identity was not configured.
DEPLOYER_ADDRESS="$(stellar keys address deployer)" || fail "could not resolve the deployer identity"
if [[ ! "$DEPLOYER_ADDRESS" =~ ^G[A-Z2-7]{55}$ ]]; then
  fail "deployer identity did not resolve to a Stellar address (got '${DEPLOYER_ADDRESS}')"
fi
echo "   Deployer: ${DEPLOYER_ADDRESS}"

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
# on_chain_wasm_hash <contract id> — SHA-256 of the WASM the instance runs.
on_chain_wasm_hash() {
  local OUT="${WORK_DIR}/$1.wasm"
  rm -f "${OUT}"
  stellar contract fetch \
    --id "$1" \
    --network "${NETWORK}" \
    --out-file "${OUT}" >/dev/null 2>&1 || return 1
  node "${DEPLOYMENTS_TOOL}" sha256 "${OUT}"
}

# view <contract id> <fn> — call a read-only getter, printing the bare value.
view() {
  local RAW
  RAW="$(stellar contract invoke \
    --id "$1" \
    --source deployer \
    --network "${NETWORK}" \
    -- "$2" 2>/dev/null)" || return 1
  printf '%s' "${RAW//\"/}"
}

# expect <description> <expected> <command...> — retry until the command prints
# the expected value, or abort the run.
expect() {
  local DESCRIPTION="$1" EXPECTED="$2"
  shift 2
  local ACTUAL="" ATTEMPT
  for (( ATTEMPT = 1; ATTEMPT <= VERIFY_ATTEMPTS; ATTEMPT++ )); do
    ACTUAL="$("$@")" || ACTUAL="<call failed>"
    if [[ "$ACTUAL" == "$EXPECTED" ]]; then
      echo "   ok   ${DESCRIPTION}"
      return 0
    fi
    if (( ATTEMPT < VERIFY_ATTEMPTS )); then
      sleep "${VERIFY_DELAY_SECS}"
    fi
  done
  fail "verification failed — ${DESCRIPTION}: expected '${EXPECTED}', got '${ACTUAL}'"
}

# verify_contract <name> <contract id> <expected wasm hash, may be empty>
verify_contract() {
  local NAME="$1" ID="$2" HASH="$3"
  echo ">> Verifying ${NAME} (${ID})..."
  if [[ -n "$HASH" ]]; then
    expect "on-chain WASM hash matches" "${HASH}" on_chain_wasm_hash "${ID}"
  fi
  if [[ "$INITIALIZE" == "yes" ]]; then
    expect "admin is ${SOROBAN_ADMIN_ADDRESS}" "${SOROBAN_ADMIN_ADDRESS}" view "${ID}" get_admin
    expect "contract is not paused" "false" view "${ID}" is_paused
    if [[ "$NAME" == "escrow" && -n "${ESCROW_MAX_AMOUNT_STROOPS:-}" ]]; then
      expect "escrow max amount is set" "${ESCROW_MAX_AMOUNT_STROOPS}" view "${ID}" max_amount
    fi
  fi
}

# ---------------------------------------------------------------------------
# Verify-only mode — post-deploy smoke test
# ---------------------------------------------------------------------------
if [[ "$MODE" == "verify" ]]; then
  for name in $SELECTED; do
    id="$(recorded "${name}" contract_id)"
    [[ -n "$id" ]] || fail "no ${name} deployment recorded on ${NETWORK}"
    verify_contract "${name}" "${id}" "$(recorded "${name}" wasm_hash)"
  done
  echo ""
  echo "All smoke checks passed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Build (a rollback redeploys WASM that is already on the ledger)
# ---------------------------------------------------------------------------
if [[ "$MODE" == "deploy" ]]; then
  echo ">> Building contracts (release WASM)..."
  (
    cd "${SCRIPT_DIR}"
    cargo build --release --target wasm32v1-none
  )
  echo "   Build complete."
fi

# ---------------------------------------------------------------------------
# Helper: deploy, initialize, verify and record a single contract
# ---------------------------------------------------------------------------
deploy_contract() {
  local CONTRACT_NAME="$1"    # escrow | marketplace
  local ROLLBACK_HASH="$2"    # WASM hash to redeploy, empty for a fresh build

  local CONTRACT_ID WASM_HASH EXISTING_ID

  if [[ -n "$ROLLBACK_HASH" ]]; then
    WASM_HASH="$ROLLBACK_HASH"
    echo ""
    echo ">> Rolling ${CONTRACT_NAME} back to WASM ${WASM_HASH}..."
    CONTRACT_ID="$(stellar contract deploy \
      --wasm-hash "${WASM_HASH}" \
      --source deployer \
      --network "${NETWORK}")" \
      || fail "${CONTRACT_NAME} rollback deploy failed; deployments.json was not changed"
  else
    local WASM_PATH="${SCRIPT_DIR}/target/wasm32v1-none/release/airflex_${CONTRACT_NAME}.wasm"
    [[ -f "$WASM_PATH" ]] || fail "WASM not found at ${WASM_PATH}"

    # Idempotency (Issue #511): if deployments.json already records a non-empty
    # address for this contract on this network, skip the deploy unless --force.
    # Re-running after a failed deploy (which never wrote JSON) therefore deploys
    # fresh, never producing duplicate or contradictory entries.
    EXISTING_ID="$(recorded "${CONTRACT_NAME}" contract_id)"
    if [[ -n "$EXISTING_ID" && "$FORCE" != "yes" ]]; then
      echo ">> ${CONTRACT_NAME} already deployed on ${NETWORK} (${EXISTING_ID}); skipping."
      echo "   (use --force to redeploy)"
      return 0
    fi

    WASM_HASH="$(node "${DEPLOYMENTS_TOOL}" sha256 "${WASM_PATH}")"
    echo ""
    echo ">> Deploying ${CONTRACT_NAME} contract (WASM ${WASM_HASH})..."
    CONTRACT_ID="$(stellar contract deploy \
      --wasm "${WASM_PATH}" \
      --source deployer \
      --network "${NETWORK}")" \
      || fail "${CONTRACT_NAME} deploy failed; deployments.json was not changed"
  fi

  # On-chain confirmation: a real deploy returns a 'C…' contract id. If the
  # CLI produced anything else (or nothing), the on-chain step failed, so we
  # abort BEFORE touching deployments.json.
  if [[ ! "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
    fail "${CONTRACT_NAME} deploy did not return a valid contract id (got '${CONTRACT_ID}')"
  fi

  # Printed straight away so the instance can be found if a later step aborts.
  echo "   Deployed ${CONTRACT_NAME}: ${CONTRACT_ID}"

  # Initialize
  if [[ "$INITIALIZE" == "yes" ]]; then
    echo ">> Initializing ${CONTRACT_NAME}..."
    if [[ "$CONTRACT_NAME" == "escrow" ]]; then
      if [[ "$ALLOWED_TOKENS_JSON" == "[]" ]]; then
        echo "   WARNING: SOROBAN_ALLOWED_TOKENS is unset; escrow accepts no tokens yet."
      fi
      stellar contract invoke \
        --id "${CONTRACT_ID}" \
        --source deployer \
        --network "${NETWORK}" \
        -- initialize \
        --admin "${SOROBAN_ADMIN_ADDRESS}" \
        --allowed_tokens "${ALLOWED_TOKENS_JSON}" \
        || fail "${CONTRACT_NAME} initialize failed; deployments.json was not changed"
    else
      stellar contract invoke \
        --id "${CONTRACT_ID}" \
        --source deployer \
        --network "${NETWORK}" \
        -- initialize \
        --admin "${SOROBAN_ADMIN_ADDRESS}" \
        || fail "${CONTRACT_NAME} initialize failed; deployments.json was not changed"
    fi
    echo "   Initialized."

    # Per-listing escrow cap (issue #636). initialize stores an uncapped
    # default; set the real cap here when ESCROW_MAX_AMOUNT_STROOPS is given.
    if [[ "$CONTRACT_NAME" == "escrow" && -n "${ESCROW_MAX_AMOUNT_STROOPS:-}" ]]; then
      echo ">> Setting escrow max amount to ${ESCROW_MAX_AMOUNT_STROOPS} stroops..."
      stellar contract invoke \
        --id "${CONTRACT_ID}" \
        --source deployer \
        --network "${NETWORK}" \
        -- update_max_amount \
        --new_max "${ESCROW_MAX_AMOUNT_STROOPS}" \
        || fail "update_max_amount failed; deployments.json was not changed"
      echo "   Max amount set."
    fi
  fi

  # Every write above reported success; confirm the network agrees before the
  # registry does (issue #645). A failed check exits here.
  verify_contract "${CONTRACT_NAME}" "${CONTRACT_ID}" "${WASM_HASH}"

  echo ">> Updating deployments.json..."
  CONTRACT_ID="${CONTRACT_ID}" \
  WASM_HASH="${WASM_HASH}" \
  DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  DEPLOYER="${DEPLOYER_ADDRESS}" \
  IS_ROLLBACK="${ROLLBACK}" \
    node "${DEPLOYMENTS_TOOL}" record "${DEPLOYMENTS_FILE}" "${NETWORK}" "${CONTRACT_NAME}"
  echo "   deployments.json updated."

  echo "   Stellar Expert: ${STELLAR_EXPERT_BASE}/${CONTRACT_ID}"
}

# ---------------------------------------------------------------------------
# Deploy (or roll back) selected contracts
# ---------------------------------------------------------------------------
if [[ "$CONTRACT" == "escrow" || "$CONTRACT" == "all" ]]; then
  deploy_contract "escrow" "${ESCROW_ROLLBACK_HASH}"
fi

if [[ "$CONTRACT" == "marketplace" || "$CONTRACT" == "all" ]]; then
  deploy_contract "marketplace" "${MARKETPLACE_ROLLBACK_HASH}"
fi

# ---------------------------------------------------------------------------
# Commit deployments.json
# ---------------------------------------------------------------------------
if [[ "$COMMIT" == "yes" ]]; then
  echo ""
  echo ">> Committing deployments.json..."
  git -C "${SCRIPT_DIR}" add "${DEPLOYMENTS_FILE}"
  if git -C "${SCRIPT_DIR}" diff --cached --quiet; then
    echo "   No changes to commit (addresses unchanged)."
  else
    git -C "${SCRIPT_DIR}" commit -m "chore(contracts): update ${NETWORK} deployment addresses [skip ci]"
    echo "   Committed."
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Deployment Complete (${MODE}) ==="
echo ""
echo "  Network: ${NETWORK}"
node "${DEPLOYMENTS_TOOL}" summary "${DEPLOYMENTS_FILE}" "${NETWORK}"
echo ""
echo "Next steps:"
echo "  1. Set ESCROW_CONTRACT_ID and MARKETPLACE_CONTRACT_ID in server/.env"
echo "  2. Push the deployments.json commit: git push"
echo ""
