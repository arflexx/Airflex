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
#   --help        Print this help message
#
# Required environment variables:
#   SOROBAN_DEPLOYER_SECRET   Stellar secret key (S...) of the deployer account
#   SOROBAN_ADMIN_ADDRESS     Stellar public key (G...) to set as contract admin
#
# Optional:
#   SOROBAN_RPC_URL           Override default RPC endpoint
#
# Examples:
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
    --help)
      sed -n '/^# Usage:/,/^# ====/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "ERROR: --network must be 'testnet' or 'mainnet'" >&2
  exit 1
fi

if [[ "$CONTRACT" != "escrow" && "$CONTRACT" != "marketplace" && "$CONTRACT" != "all" ]]; then
  echo "ERROR: --contract must be 'escrow', 'marketplace', or 'all'" >&2
  exit 1
fi

if [[ -z "${SOROBAN_DEPLOYER_SECRET:-}" ]]; then
  echo "ERROR: SOROBAN_DEPLOYER_SECRET environment variable is not set" >&2
  exit 1
fi

if [[ -z "${SOROBAN_ADMIN_ADDRESS:-}" ]]; then
  echo "ERROR: SOROBAN_ADMIN_ADDRESS environment variable is not set" >&2
  exit 1
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

# ---------------------------------------------------------------------------
# Network configuration
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

  echo ""
  echo ">> Deploying ${CONTRACT_NAME} contract..."

  local CONTRACT_ID
  CONTRACT_ID=$(stellar contract deploy \
    --wasm "${WASM_PATH}" \
    --source deployer \
    --network "${NETWORK}")

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
  fi

  # Update deployments.json using Node.js (available everywhere)
  echo ">> Updating deployments.json..."
  node -e "
    const fs = require('fs');
    const path = '${DEPLOYMENTS_FILE}';
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    data['${NETWORK}']['${CONTRACT_NAME}'] = '${CONTRACT_ID}';
    fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
    console.log('   deployments.json updated.');
  "

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
