# Brain Data Vault

Your keyboard is the brain sensor. The page reads your typing rhythm (key
timing and mouse movement, never the letters) and estimates focus, fatigue and
stress from it. Each recording is encrypted in your browser; a smart contract
stores only its fingerprint, who may read it, and every read attempt (allowed
or denied).

After three recordings the vault learns your normal: scores compare each
recording with your own other recordings (50 means "as usual for you"), worked
out in the browser from data only your key can decrypt.

Live mode turns the page into a notepad: scores update while you write and
each stretch of typing saves itself. A web page can only see typing inside
itself, so the browser extension in `extension/` does the reading everywhere
else in the browser.

## Browser sensor (Chrome extension)

It measures typing rhythm on the pages you use: key timing and mouse movement
only. It never reads which key was pressed (except to count Backspace), never
reads page text or addresses, and skips password fields. Recordings wait inside
the extension, unencrypted, until the vault page is open and unlocked; the page
then encrypts and stores them like any other session.

Install:

1. In Chrome open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this project's `extension` folder.
3. Open the vault at http://127.0.0.1:5180/ in Chrome and unlock it. The
   **Browser sensor** tile shows "on".

The extension's button pauses it or deletes what is waiting. It does not see
typing in other apps; that would need a desktop app.

## Online

The public site is https://victorialichtenfeld-ship-it.github.io/brain-vault/ and
runs on the Sepolia test chain. Visitors create a vault in their own
browser, and the page gets them free test coins by itself from the Drip
contract (`contracts/src/Drip.sol`): one small drip per new vault, at most 20 an
hour. The page asks for it with a sponsor key that is published in
`web/vault.public.json` on purpose; the contract limits what that key can take,
and its owner can replace the sponsor or withdraw the coins. If the drip is
used up, the page falls back to the no-account faucet at
https://sepolia-faucet.pk910.de/. `make deploy-drip` deploys and funds it. `make
deploy-public` deploys the contract there (the deploy key lives in the
git-ignored `.keys/` folder) and writes `web/vault.public.json`; pushing to
`main` republishes the site.

Demo status: the scores are rough heuristics, not a medical reading, and the
page itself hands data to
an app once the contract allows the read. A real product needs a separate
service that releases keys only when the contract says yes.

## Run it

Needs [Foundry](https://getfoundry.sh) (`forge`, `cast`, `anvil`), `jq` and Python 3.

```bash
make chain    # terminal 1: local dev chain, leave running
make deploy   # terminal 2: deploy the contract
make web      # then open http://127.0.0.1:5180
```

Create a vault password on the page, press "Get test coins", then record a
typing session and try Grant, Revoke and Request data.

```bash
make test     # 13 contract tests
```

## Layout

| Path | What |
|---|---|
| `contracts/src/BrainVault.sol` | The contract |
| `contracts/test/` | Its tests |
| `web/` | The page (`index.html`, `vault.js`), no build step |
| `scripts/deploy.sh` | Deploys and writes `web/vault.config.json` |

Works on any EVM chain: set `RPC` and `VAULT_KEY_FILE` for `make deploy`.
