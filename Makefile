RPC ?= http://127.0.0.1:9545

.PHONY: test chain deploy web

test: ## contract tests
	cd contracts && forge test

chain: ## local dev chain on port 9545 (leave it running)
	anvil --port 9545 --chain-id 31337 --block-time 1

deploy: ## deploy BrainVault to the running chain and tell the page where it is
	ETH_RPC_URL=$(RPC) scripts/deploy.sh

web: ## the vault page on http://127.0.0.1:5180
	python3 -m http.server 5180 --bind 127.0.0.1 --directory web
