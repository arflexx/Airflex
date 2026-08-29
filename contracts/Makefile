.PHONY: build test clean

build:
	cargo build --release --workspace

test:
	cargo test --workspace --all-features --target $(shell rustc -vV | sed -n 's|host: ||p')

clean:
	cargo clean --workspace
