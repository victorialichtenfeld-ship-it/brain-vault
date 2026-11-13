#!/usr/bin/env bash
# Deploys contracts/src/BrainVault.sol and writes web/vault.config.json
# (git-ignored) so the page can find it.
# By default it signs with anvil's first built-in account, a publicly known
# test key that is only good on a local dev chain. For any other chain set
# VAULT_KEY_FILE to a file holding the deployer's private key.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC=${ETH_RPC_URL:-http://127.0.0.1:9545}
ANVIL_TEST_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
if [ -n "${VAULT_KEY_FILE:-}" ]; then PK=$(cat "$VAULT_KEY_FILE"); else PK=$ANVIL_TEST_KEY; fi

cd "$ROOT/contracts"
OUT=$(forge create src/BrainVault.sol:BrainVault --rpc-url "$RPC" --private-key "$PK" --broadcast --json)
ADDR=$(jq -r .deployedTo <<<"$OUT")
TX=$(jq -r .transactionHash <<<"$OUT")
[ "$(cast code "$ADDR" --rpc-url "$RPC")" != 0x ] || { echo "no code at $ADDR" >&2; exit 1; }
BLOCK=$(cast receipt "$TX" blockNumber --rpc-url "$RPC")
CHAIN=$(cast chain-id --rpc-url "$RPC")

jq -n --arg a "$ADDR" --arg r "$RPC" --argjson c "$CHAIN" --argjson b "$BLOCK" \
  '{address: $a, chainId: $c, deployBlock: $b, rpc: $r, name: "Local dev chain", symbol: "ETH"}' >"$ROOT/web/vault.config.json"
echo "BrainVault deployed at $ADDR in block $BLOCK (chain $CHAIN)"
echo "wrote web/vault.config.json; run 'make web' and open http://127.0.0.1:5180"
