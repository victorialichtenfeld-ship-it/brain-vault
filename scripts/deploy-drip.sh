#!/usr/bin/env bash
# Deploys contracts/src/Drip.sol on the public test chain, funds it, and adds
# its address and a fresh sponsor key to web/vault.public.json.
# The sponsor key is PUBLIC on purpose: the page uses it to ask the contract
# for coins on a visitor's behalf. It only ever holds a small float, and the
# contract caps what it can take. Test networks only.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC=${ETH_RPC_URL:?set ETH_RPC_URL}
PK=$(cat "${VAULT_KEY_FILE:?set VAULT_KEY_FILE}")
FUND=${DRIP_FUND:-0.6ether}
CFG="$ROOT/web/vault.public.json"
[ -f "$CFG" ] || { echo "deploy the vault first (make deploy-public)" >&2; exit 1; }
[ "$(cast chain-id --rpc-url "$RPC")" != 31337 ] || { echo "not for the local dev chain" >&2; exit 1; }

SPONSOR_KEY=$(cast wallet new --json | jq -r '.data[0].private_key')
SPONSOR=$(cast wallet address --private-key "$SPONSOR_KEY")
cd "$ROOT/contracts"
OUT=$(forge create src/Drip.sol:Drip --rpc-url "$RPC" --private-key "$PK" --broadcast --value "$FUND" --json --constructor-args "$SPONSOR")
ADDR=$(jq -r .deployedTo <<<"$OUT")
[ "$(cast code "$ADDR" --rpc-url "$RPC")" != 0x ] || { echo "no code at $ADDR" >&2; exit 1; }
cast send "$SPONSOR" --value 0.0005ether --rpc-url "$RPC" --private-key "$PK" >/dev/null

jq --arg a "$ADDR" --arg k "$SPONSOR_KEY" '.drip = {address: $a, sponsorKey: $k}' "$CFG" >"$CFG.tmp" && mv "$CFG.tmp" "$CFG"
echo "Drip deployed at $ADDR, funded with $FUND; sponsor $SPONSOR"
echo "updated web/vault.public.json; commit and push it to update the public site"
