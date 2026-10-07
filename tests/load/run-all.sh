#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${LOAD_TEST_BASE_URL:-}" ]]; then
  echo "LOAD_TEST_BASE_URL is required" >&2
  exit 1
fi

SCRIPTS=(marketplace.js otp-burst.js trade-create.js)
OUT_DIR="${LOAD_TEST_OUTPUT_DIR:-./load-results}"
mkdir -p "$OUT_DIR"

for script in "${SCRIPTS[@]}"; do
  name="${script%.js}"
  if [[ "$script" == "trade-create.js" && -z "${LOAD_TEST_AUTH_TOKEN:-}" ]]; then
    echo "Skipping trade-create.js (set LOAD_TEST_AUTH_TOKEN to include it)" >&2
    continue
  fi
  k6 run --summary-export "${OUT_DIR}/${name}-summary.json" "tests/load/${script}"
done

echo "Load test summaries written to ${OUT_DIR}"
