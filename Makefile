RPC ?= http://127.0.0.1:9545

.PHONY: test chain deploy deploy-public deploy-drip web

test: ## contract tests
	cd contracts && forge test

chain: ## local dev chain on port 9545 (leave it running)
	anvil --port 9545 --chain-id 31337 --block-time 1

deploy: ## deploy BrainVault to the running chain and tell the page where it is
	ETH_RPC_URL=$(RPC) scripts/deploy.sh

deploy-public: ## deploy to the Sepolia test chain with the key in .keys/deployer.key (needs test coins)
	ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com VAULT_KEY_FILE=.keys/deployer.key \
	CHAIN_NAME="Sepolia test chain" LOG_WINDOW=9000 \
	FAUCET_URL=https://sepolia-faucet.pk910.de/ scripts/deploy.sh

deploy-drip: ## deploy and fund the free-coin drip on Sepolia (after deploy-public)
	ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com VAULT_KEY_FILE=.keys/deployer.key scripts/deploy-drip.sh

web: ## the vault page on http://127.0.0.1:5180
	python3 -m http.server 5180 --bind 127.0.0.1 --directory web
