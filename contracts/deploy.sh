#!/usr/bin/env bash
# =============================================================================
# deploy.sh — AirFlex Soroban contract build-and-deploy script
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
#   --help        Print this help message
#
# Required environment variables:
#   SOROBAN_DEPLOYER_SECRET   Stellar secret key (S...) of the deployer account
#   SOROBAN_ADMIN_ADDRESS     Stellar public key (G...) to set as contract admin
#
# Optional:
#   SOROBAN_RPC_URL           Override default RPC endpoint
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

# Script is expected to be run from the repo root or contracts/ directory.
# Resolve the contracts/ directory relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENTS_FILE="${SCRIPT_DIR}/deployments.json"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)     NETWORK="$2";    shift 2 ;;
    --contract)    CONTRACT="$2";   shift 2 ;;
    --initialize)  INITIALIZE="$2"; shift 2 ;;
    --commit)      COMMIT="$2";     shift 2 ;;
    --dry-run)     DRY_RUN="yes";   shift 1 ;;
    --force)       FORCE="yes";     shift 1 ;;
    --help)
      sed -n '/^# Usage:/,/^# ====/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation — argument ranges
# ---------------------------------------------------------------------------
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "ERROR: --network must be 'testnet' or 'mainnet'" >&2
  exit 1
fi

if [[ "$CONTRACT" != "escrow" && "$CONTRACT" != "marketplace" && "$CONTRACT" != "all" ]]; then
  echo "ERROR: --contract must be 'escrow', 'marketplace', or 'all'" >&2
  exit 1
fi

if [[ "$INITIALIZE" != "yes" && "$INITIALIZE" != "no" ]]; then
  echo "ERROR: --initialize must be 'yes' or 'no'" >&2
  exit 1
fi

if [[ "$COMMIT" != "yes" && "$COMMIT" != "no" ]]; then
  echo "ERROR: --commit must be 'yes' or 'no'" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Validation — required environment variables (non-empty)
# ---------------------------------------------------------------------------
# Done before any network call so a missing key fails fast and never leaves
# deployments.json in an inconsistent state (Issue #511).
if [[ -z "${SOROBAN_DEPLOYER_SECRET:-}" ]]; then
  echo "ERROR: SOROBAN_DEPLOYER_SECRET environment variable is not set" >&2
  exit 1
fi

if [[ -z "${SOROBAN_ADMIN_ADDRESS:-}" ]]; then
  echo "ERROR: SOROBAN_ADMIN_ADDRESS environment variable is not set" >&2
  exit 1
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

# ---------------------------------------------------------------------------
# Dry run — validate everything, then stop before any network call (Issue #511)
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "yes" ]]; then
  echo ""
  echo "=== AirFlex Soroban Deploy — DRY RUN (no network calls) ==="
  echo "  Network:       ${NETWORK}"
  echo "  Contract:      ${CONTRACT}"
  echo "  Initialize:    ${INITIALIZE}"
  echo "  Commit:        ${COMMIT}  (skipped in dry-run)"
  echo "  Force redeploy: ${FORCE}"
  echo "  RPC URL:       ${RPC_URL}"
  echo "  Deployer key:  ${SOROBAN_DEPLOYER_SECRET:0:4}…${SOROBAN_DEPLOYER_SECRET: -4}  (format OK)"
  echo "  Admin address: ${SOROBAN_ADMIN_ADDRESS}  (format OK)"
  echo ""
  echo "All pre-flight checks passed. Re-run without --dry-run to deploy."
  exit 0
fi

# Mainnet guard — require explicit acknowledgement
if [[ "$NETWORK" == "mainnet" ]]; then
  echo ""
  echo "⚠️  WARNING: You are about to deploy to MAINNET."
  echo "   This costs real XLM and produces an immutable on-chain address."
  echo ""
  read -r -p "Type 'deploy to mainnet' to confirm: " CONFIRM
  if [[ "$CONFIRM" != "deploy to mainnet" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

echo ""
echo "=== AirFlex Soroban Deploy ==="
echo "  Network:  ${NETWORK}"
echo "  Contract: ${CONTRACT}"
echo "  RPC URL:  ${RPC_URL}"
echo ""

# ---------------------------------------------------------------------------
# Add deployer identity and network to stellar-cli config
# ---------------------------------------------------------------------------
echo ">> Configuring stellar-cli..."

echo "$SOROBAN_DEPLOYER_SECRET" | \
  stellar keys add deployer --secret-key --stdin 2>/dev/null || true

stellar network add "${NETWORK}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo ">> Building contracts (release WASM)..."
(
  cd "${SCRIPT_DIR}"
  cargo build --release --target wasm32v1-none
)
echo "   Build complete."

# ---------------------------------------------------------------------------
# Helper: deploy a single contract
# ---------------------------------------------------------------------------
deploy_contract() {
  local CONTRACT_NAME="$1"   # escrow | marketplace
  local WASM_NAME="$2"       # e.g. airflex_escrow

  local WASM_PATH="${SCRIPT_DIR}/target/wasm32v1-none/release/${WASM_NAME}.wasm"

  if [[ ! -f "$WASM_PATH" ]]; then
    echo "ERROR: WASM not found at ${WASM_PATH}" >&2
    exit 1
  fi

  # Idempotency (Issue #511): if deployments.json already records a non-empty
  # address for this contract on this network, skip the deploy unless --force.
  # Re-running after a failed deploy (which never wrote JSON) therefore deploys
  # fresh, never producing duplicate or contradictory entries.
  local EXISTING_ID
  EXISTING_ID=$(node -e "
    const fs = require('fs');
    try {
      const data = JSON.parse(fs.readFileSync('${DEPLOYMENTS_FILE}', 'utf8'));
      process.stdout.write((data['${NETWORK}'] && data['${NETWORK}']['${CONTRACT_NAME}']) || '');
    } catch { process.stdout.write(''); }
  ")
  if [[ -n "$EXISTING_ID" && "$FORCE" != "yes" ]]; then
    echo ">> ${CONTRACT_NAME} already deployed on ${NETWORK} (${EXISTING_ID}); skipping."
    echo "   (use --force to redeploy)"
    return 0
  fi

  echo ""
  echo ">> Deploying ${CONTRACT_NAME} contract..."

  local CONTRACT_ID
  CONTRACT_ID=$(stellar contract deploy \
    --wasm "${WASM_PATH}" \
    --source deployer \
    --network "${NETWORK}")

  # On-chain confirmation: a real deploy returns a 'C…' contract id. If the
  # CLI produced anything else (or nothing), the on-chain step failed, so we
  # abort BEFORE touching deployments.json.
  if [[ -z "$CONTRACT_ID" || ! "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
    echo "ERROR: ${CONTRACT_NAME} deploy did not return a valid contract id (got '${CONTRACT_ID}')" >&2
    exit 1
  fi

  echo "   Deployed ${CONTRACT_NAME}: ${CONTRACT_ID}"

  # Initialize
  if [[ "$INITIALIZE" == "yes" ]]; then
    echo ">> Initializing ${CONTRACT_NAME}..."
    stellar contract invoke \
      --id "${CONTRACT_ID}" \
      --source deployer \
      --network "${NETWORK}" \
      -- initialize \
      --admin "${SOROBAN_ADMIN_ADDRESS}"
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
        --new_max "${ESCROW_MAX_AMOUNT_STROOPS}"
      echo "   Max amount set."
    fi
  fi

  # Update deployments.json atomically — only AFTER a confirmed on-chain
  # deploy + initialize. A temp file in the same directory is written first,
  # then renamed into place, so a crash mid-write cannot leave a half-written
  # (inconsistent) deployments.json.
  echo ">> Updating deployments.json..."
  local TMP_FILE
  TMP_FILE="$(mktemp "${DEPLOYMENTS_FILE}.XXXXXX")"
  node -e "
    const fs = require('fs');
    const path = '${DEPLOYMENTS_FILE}';
    let data;
    try { data = JSON.parse(fs.readFileSync(path, 'utf8')); }
    catch { data = {}; }
    data['${NETWORK}'] = data['${NETWORK}'] || {};
    data['${NETWORK}']['${CONTRACT_NAME}'] = '${CONTRACT_ID}';
    fs.writeFileSync('${TMP_FILE}', JSON.stringify(data, null, 2) + '\n');
  "
  mv -f "${TMP_FILE}" "${DEPLOYMENTS_FILE}"
  echo "   deployments.json updated."

  echo "   Stellar Expert: ${STELLAR_EXPERT_BASE}/${CONTRACT_ID}"
}

# ---------------------------------------------------------------------------
# Deploy selected contracts
# ---------------------------------------------------------------------------
if [[ "$CONTRACT" == "escrow" || "$CONTRACT" == "all" ]]; then
  deploy_contract "escrow" "airflex_escrow"
fi

if [[ "$CONTRACT" == "marketplace" || "$CONTRACT" == "all" ]]; then
  deploy_contract "marketplace" "airflex_marketplace"
fi

# ---------------------------------------------------------------------------
# Commit deployments.json
# ---------------------------------------------------------------------------
if [[ "$COMMIT" == "yes" ]]; then
  echo ""
  echo ">> Committing deployments.json..."
  git add "${DEPLOYMENTS_FILE}"
  if git diff --cached --quiet; then
    echo "   No changes to commit (addresses unchanged)."
  else
    git commit -m "chore(contracts): update ${NETWORK} deployment addresses [skip ci]"
    echo "   Committed."
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Deployment Complete ==="
echo ""
node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('${DEPLOYMENTS_FILE}', 'utf8'));
  const net = data['${NETWORK}'];
  console.log('  Network: ${NETWORK}');
  Object.entries(net).forEach(([k, v]) => {
    console.log('  ' + k + ': ' + (v || '(not deployed)'));
  });
"
echo ""
echo "Next steps:"
echo "  1. Set ESCROW_CONTRACT_ID and MARKETPLACE_CONTRACT_ID in server/.env"
echo "  2. Push the deployments.json commit: git push"
echo ""
