# Router3

A self-hostable gateway for OpenAI Chat Completions, Anthropic Messages and Responses APIs. Usage is paid from your wallet in USDC on Monad.

Live instance: [router3.ai](https://router3.ai). [中文](README.zh.md).

- **API keys:** automatic payment from a wallet's shared prepaid pool, per-key spending limits and up to 128 concurrent requests per key.
- **x402:** self-signed payment channels through an SDK or the local proxy, without an API key.
- **Providers:** DeepSeek and OpenRouter. Provider prices plus `CALL_SERVICE_FEE_BPS` (default 1%).

## Self-host

Needs Node.js 22+, Docker Compose, an HTTPS domain, a Monad RPC, a Treasury address and provider credentials. OpenRouter requires a management key. The deployer wallet needs MON for contract deployment.

```bash
npm ci
cp .env.example .env     # fill Treasury, RPC, provider keys and DEPLOYER_PRIVATE_KEY
npm run pool:deploy
npm run mainnet:local:configure -- --public https://your.domain
npm run mainnet:local:build
npm run mainnet:local:init-db
npm run mainnet:local:start
```

Remove `DEPLOYER_PRIVATE_KEY` after deployment. Fund the printed Settler address with MON for transaction gas (about 1 MON to start).

HTTPS setup, configuration and upgrades: [Self-hosting](docs/SELF_HOSTING.md).

## Contract

router3.ai's production prepaid pool on Monad:

[0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3](https://monadvision.com/address/0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3)

Source: [WalletPrepaidPool.sol](contracts/src/WalletPrepaidPool.sol). `npm run contracts:verify` compares the on-chain runtime code with the committed build. See [contract documentation](contracts/README.md).

## Architecture

PostgreSQL stores billing and chain state; Redis provides shared API rate limits.

| Service | Role |
| --- | --- |
| `api` | Authentication, model calls and usage billing |
| `collector` | Pool debits, refills, withdrawals and x402 settlement |
| `signer` | Pool transactions and x402 claim/refund signatures |
| `reconciler` | Lost-request recovery and expired-session cleanup |
| `catalog` | Model, price and provider-key synchronization |
| `web` | Nginx and the console |

## Console

Wallet sign-in, automatic payment, API keys, usage history, model catalog and self-signed channels. Available in English and Chinese.

Preview with mock data: `npm run web:preview`.

## Develop and verify

Node.js 22+ and Docker; Foundry for contract and chain tests.

```bash
npm ci && npm run web:install
npm run verify
npm run web:build
npm run contracts:verify
npm run test:openai-sdk-compat
npm run test:pool-recovery-e2e
```

## Documentation

- [Prepaid pool](docs/PREPAID_POOL.md) · [x402 channels](docs/X402.md) · [Architecture](docs/ARCHITECTURE.md) · [HTTP API](docs/API_REFERENCE.md) · [Database](docs/DATABASE_SCHEMA.md)
- [Security](docs/SECURITY.md) · [Known limitations](docs/KNOWN_LIMITATIONS.md) · [Dependency security](docs/DEPENDENCY_SECURITY.md) · [Providers](docs/PROVIDERS.md) · [Redis and scaling](docs/REDIS_DECISION.md)
- [Self-hosting](docs/SELF_HOSTING.md) · [Local mainnet](docs/LOCAL_MAINNET.md) · [Configuration](docs/CONFIGURATION_CHECKLIST.md) · [Monitoring](docs/MONITORING.md) · [Cloudflare](docs/CLOUDFLARE.md) · [Monad](docs/MONAD.md)

## License

[MIT](LICENSE).
