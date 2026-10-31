# Running Monad mainnet locally

[中文](LOCAL_MAINNET.zh.md)

The reference deployment uses `docker-compose.production.yml` and `.env.mainnet-local`, exposed through Cloudflare Tunnel at router3.ai.

## Initial setup

```bash
npm ci
npm run pool:deploy               # once: write POOL_ADDRESS / POOL_CODE_HASH to .env
npm run mainnet:local:configure -- --public https://your.domain
npm run mainnet:local:build && npm run mainnet:local:init-db
npm run mainnet:local:start
npm run mainnet:local:tunnel      # optional Cloudflare
npm run mainnet:local:metrics     # optional Grafana
```

See [self-hosting](SELF_HOSTING.md) for keys and configuration. `.env.mainnet-local`, `.secrets/monad-settler.key` and the file selected by `PROVIDER_ENV_FILE` stay out of git. New setups default to `.secrets/providers.env`; existing instances may use `.secrets/mainnet-providers.env`.

## User flow

1. Hold Monad mainnet USDC and sign in with the wallet.
2. Enable automatic payment: sign a USDC permit and pool configuration. The gateway pays gas; the operator funds the Settler's MON.
3. Create an API key and configure a compatible client with the gateway's `/v1` URL. Keys share the wallet pool and can have individual daily/total limits.
4. Revoke unused keys. To exit, request pool withdrawal: settle owed usage, wait the mainnet 30-minute delay, then let the gateway return the balance and disable refills.

Advanced clients can sign x402 vouchers or run `ROUTER3_PAYER_KEY_FILE=... node clients/x402-proxy/cli.mjs serve --gateway https://router3.ai`, with SDKs pointing to `http://127.0.0.1:8402/v1`. The proxy deposits/opens channels as needed for concurrency; `refund --all` refunds each channel. These balances are separate from the API key pool ([x402](X402.md)).

## Funds and settlement

- API key usage is recorded in PostgreSQL. Collector combines debits/refills in pool `settle` calls and sweeps to the fixed Treasury. See [pool billing and recovery](PREPAID_POOL.md) for holds, hard budgets and unbilled overruns.
- x402 bills signed cumulative vouchers and claims/settles through the facilitator.
- Unknown usage is normally charged at the held/signed ceiling; proven rejection before charging is free.
- The Settler pays pool gas; the facilitator pays x402 gas. Direct user transactions require the user's MON.

## Addresses

| Item | Address |
| --- | --- |
| USDC (Monad) | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| Router3 WalletPrepaidPool | `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3` |
| x402BatchSettlement | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` |
| ERC3009DepositCollector | `0x4020806089470a89826cB9fB1f4059150b550004` |
| Facilitator | `https://x402-facilitator.molandak.org` |
| Treasury / Settler | `TREASURY_ADDRESS` / `SETTLER_ADDRESS` in `.env.mainnet-local` |

Independent deployments use their own pool and Treasury.

## Updates, checks and recovery

Follow [the update sequence](SELF_HOSTING.md#updating): backup, build, stop workers, migrate/grant roles, replace/check signer, roll API, resume workers/web. Updating only the API omits migration and signer coordination.

```bash
npm run mainnet:local:check-keys
npm run mainnet:local:status
curl --fail --silent https://router3.ai/readyz
curl --fail --silent https://router3.ai/v1/x402
npm run mainnet:local:backup
npm run test:mainnet-backup        # isolated restore check
```

Facilitator outages block x402 deposits/claims/refunds. Fresh mirrors can verify some calls locally; stale mirrors and smart-wallet verification are affected. Pool settlement uses the signer and Monad RPC independently.

Normal API updates drain streams. The reconciler closes requests abandoned by a crash after 15 minutes by default: pool calls charge the hold within key limits; expired x402 reservations are free. See [Cloudflare](CLOUDFLARE.md) and [replica boundaries](REDIS_DECISION.md).
