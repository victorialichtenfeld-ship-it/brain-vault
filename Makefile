RPC ?= http://127.0.0.1:9545

.PHONY: test chain deploy deploy-public web

test: ## contract tests
	cd contracts && forge test

chain: ## local dev chain on port 9545 (leave it running)
	anvil --port 9545 --chain-id 31337 --block-time 1

deploy: ## deploy BrainVault to the running chain and tell the page where it is
	ETH_RPC_URL=$(RPC) scripts/deploy.sh

deploy-public: ## deploy to Base Sepolia with the key in .keys/deployer.key (needs test coins)
	ETH_RPC_URL=https://base-sepolia-rpc.publicnode.com VAULT_KEY_FILE=.keys/deployer.key \
	CHAIN_NAME="Base Sepolia test chain" LOG_WINDOW=40000 \
	FAUCET_URL=https://docs.base.org/get-started/get-funds scripts/deploy.sh

web: ## the vault page on http://127.0.0.1:5180
	python3 -m http.server 5180 --bind 127.0.0.1 --directory web
