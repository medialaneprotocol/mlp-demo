#!/usr/bin/env bash
# The demo's gate: it builds the demo, it runs the demo headlessly, and it
# fails when a measurement is over its budget.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== the toolchain"
node --version
cargo --version

echo "== the types"
npx --no-install tsc --noEmit

echo "== the bundle"
node scripts/build.mjs

echo "== the lane"
cargo build --release --locked --manifest-path rust/Cargo.toml

echo "== the headless run"
node scripts/headless.mjs

echo "== the demo's gate is green"
