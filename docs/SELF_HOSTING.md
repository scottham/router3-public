# Self-hosting

[中文](SELF_HOSTING.zh.md)

Each deployment needs a Treasury wallet, its own prepaid-pool contract and provider credentials. Scripts generate the Settler key, database roles and secrets. Advanced x402 channels use the Foundation's deployed `x402BatchSettlement` contract and facilitator-paid gas. API keys use the prepaid pool; the Settler needs MON for transaction gas.

## Prerequisites

- A Docker host, Node.js 22+, a domain and HTTPS (or [Cloudflare Tunnel](CLOUDFLARE.md)). Foundry is not required.
- A Treasury address, preferably a multisig or hardware wallet whose private key stays off the server.
- A deployment wallet with about 0.5 MON. Its key is needed only for deployment; remove it from `.env` afterwards. The script estimates the actual gas cost.
- A DeepSeek key; optionally an OpenRouter **management key**, not a call key.

## Initial deployment

```bash
npm ci                   # script dependencies; Docker builds the web app
cp .env.example .env     # fill TREASURY_ADDRESS, MONAD_RPC_URL, DEEPSEEK_API_KEY, OPENROUTER_MANAGEMENT_KEY, DEPLOYER_PRIVATE_KEY
npm run pool:deploy      # deploy the pool; save POOL_ADDRESS / POOL_CODE_HASH to .env
npm run mainnet:local:configure -- --public https://your.domain
npm run mainnet:local:build && npm run mainnet:local:init-db
npm run mainnet:local:start
```

The configure step prints the Settler address and MON balance. Fund it with about 1 MON to start. The default daily gas budget is 5 MON; actual usage is typically much lower.

Then check the deployment:

```bash
curl -s https://your.domain/v1/x402 | jq .ready  # true: facilitator terms loaded
npm run mainnet:local:tunnel                    # optional; set CLOUDFLARE_TUNNEL_TOKEN in .env before configure
npm run mainnet:local:check-keys
```

- The pool is not upgradeable and has no admin withdrawal. [Contract documentation](../contracts/README.md) covers constructor arguments, deployed-bytecode checks with `npm run contracts:verify`, and the equivalent `forge create` command.
- To use an existing pool, put its `POOL_ADDRESS` and `POOL_CODE_HASH` in `.env`. `pool:deploy` refuses to overwrite an existing address without `--force`: the old pool holds user funds and a new pool starts empty.
- Rerunning `configure` preserves generated passwords, HMAC/encryption keys and the Settler file. Values in `.env`, including Treasury, RPC, pool, allowlist and provider keys, can override existing settings. Check the source configuration before rerunning. Pass `--public` again only when changing the domain.
- `providers/providers.mainnet.json` selects providers and models ([providers](PROVIDERS.md)). Provider keys live in `.secrets/providers.env`, read by API, collector, catalog and bootstrap; the collector uses the management key to synchronize wallet limits.
- Other settings are listed in `.env.example` and the [configuration checklist](CONFIGURATION_CHECKLIST.md).

## Updating

First check whether the release's migrations are compatible with the API instances still serving requests. Destructive migrations need a maintenance window. The sequence below covers the pool batch-recovery upgrade: an old signer must not run with the new recovery logic. Keep the old images and private configuration for application rollback.

```bash
git pull
npm ci
npm run verify
npm run mainnet:local:backup       # stop on failure; keep a backup off the host
npm run mainnet:local:build        # build before stopping workers
```

Run the following steps in order. Stop and investigate if any command fails:

```bash
compose() { docker compose --env-file .env.mainnet-local -f docker-compose.production.yml "$@"; }
compose stop collector reconciler catalog
npm run mainnet:local:init-db      # apply migrations, role grants, catalog and fee policy
compose up -d --no-deps --force-recreate signer
# Use the container's own token without printing it.
compose exec -T signer node --input-type=module -e '
for (let i = 0; i < 30; i++) {
  const ok = await fetch("http://127.0.0.1:8790/healthz", {
    headers: {authorization: "Bearer " + process.env.SETTLER_SIGNER_BEARER_TOKEN},
    signal: AbortSignal.timeout(2000)
  }).then(r => r.ok, () => false);
  if (ok) process.exit(0);
  await new Promise(r => setTimeout(r, 1000));
}
process.exit(1);'
ops/deploy-api.sh                  # wait for readiness, then drain the old API
compose up -d --no-deps --force-recreate collector reconciler catalog web
npm run mainnet:local:status
curl --fail --silent https://your.domain/readyz
```

If migration or signer checks fail, keep collector/reconciler stopped, fix the cause and resume at the failed step. Rolling back an image does not roll back the database. Do not overwrite a live production database with a pre-upgrade backup. Use `npm run test:mainnet-backup` to validate restores in isolation.

## Live acceptance

```bash
npm run test:x402-live   # PRIVATE_KEY in .env: wallet with USDC; real deposits, calls, refunds and settlement
```

## Operations

- Funds remain in the contracts until settlement/claim; transfers to Treasury are revenue.
- The default facilitator is the Monad Foundation's free instance. A self-hosted alternative needs the `@x402/core` facilitator code and a relay wallet with MON; set `X402_FACILITATOR_URL`.
- See [monitoring](MONITORING.md). Back up with `npm run mainnet:local:backup` and validate with `npm run test:mainnet-backup`.
- Operators are responsible for provider resale terms; see [providers](PROVIDERS.md).
