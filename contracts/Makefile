.PHONY: build test test-escrow test-marketplace clean wasm \
	sandbox-up sandbox-deploy sandbox-smoke sandbox-down integration-test

# Local Soroban sandbox fixtures (see tests/README.md)
SANDBOX := $(CURDIR)/../tests/soroban

build:
	cargo build --release --workspace

# Workspace-wide tests (escrow + marketplace). `make test` runs every escrow
# test, including the dispute-resolution coverage from Issue #508, with no
# failures.
test:
	cargo test --workspace --all-features --target $(shell rustc -vV | sed -n 's|host: ||p')

# Escrow contract tests only — surfaces dispute-resolution coverage (Issue #508).
test-escrow:
	cargo test --package airflex-escrow --all-features --target $(shell rustc -vV | sed -n 's|host: ||p')

# Marketplace contract tests only — surfaces replay-protection coverage (Issue #512).
test-marketplace:
	cargo test --package airflex-marketplace --all-features --target $(shell rustc -vV | sed -n 's|host: ||p')

clean:
	cargo clean --workspace

# Release WASM consumed by the sandbox deploy fixture and deploy.sh
wasm:
	cargo build --release --target wasm32v1-none

# Start the local sandbox and fund a deployer identity (< 60s)
sandbox-up:
	bash $(SANDBOX)/sandbox-up.sh

# Build, deploy and initialise escrow + marketplace; writes contract IDs to
# tests/soroban/.sandbox/contracts.env
sandbox-deploy: wasm
	bash $(SANDBOX)/deploy-contracts.sh --skip-build

# Check the deployed contracts are live and initialised
sandbox-smoke:
	bash $(SANDBOX)/smoke-test.sh

# Remove the sandbox container, volumes and all local state
sandbox-down:
	bash $(SANDBOX)/sandbox-down.sh

# Full lifecycle: up → deploy → smoke (+ $$INTEGRATION_CMD) → down (always)
integration-test: wasm
	SKIP_BUILD=1 bash $(SANDBOX)/integration-test.sh
