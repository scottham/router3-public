# Configuration checklist

[中文](CONFIGURATION_CHECKLIST.zh.md)

Set the Treasury address, Monad RPC, provider keys (DeepSeek account key and optional OpenRouter management key) and deployment-only private key in `.env`. `npm run pool:deploy` writes the pool address and code hash; `npm run mainnet:local:configure -- --public https://your.domain` generates the remaining configuration ([self-hosting](SELF_HOSTING.md)). Generated or built-in values include the Settler key file, database role passwords, HMAC/encryption keys, Redis password, USDC address and x402 contract addresses. The Settler signs x402 messages and sends pool transactions, so it needs MON for gas.

Redis provides shared coordination; PostgreSQL is the financial source of truth ([Redis and scaling](REDIS_DECISION.md)). The reference deployment uses `.env.mainnet-local` ([local mainnet](LOCAL_MAINNET.md)). After changing `CALL_SERVICE_FEE_BPS`, rerun `npm run mainnet:local:init-db` to publish a new fee-policy version.

## Runtime variables

| Variable | Purpose |
| --- | --- |
| `PUBLIC_APP_URL`, `CORS_ORIGINS` | Production HTTPS origin; explicitly allow console origins |
| `MONAD_RPC_URL` | ERC-1271/6492 sign-in checks, pool snapshots, transactions/receipts and channel withdrawals; chain ID is fixed at 143 |
| `APP_NAME`, `APP_LOGO_URL` | Name and HTTPS logo shown in wallets |
| `CHAIN_CONFIG_JSON` | `{"143":{"name","rpcUrl","usdcAddress","confirmations"}}` |
| `TREASURY_ADDRESS`, `SETTLER_ADDRESS` | Treasury and Settler addresses; the pool signer checks recipient/role, while x402 uses receiver/authorizer addresses |
| `SETTLER_SIGNER_URL`, `SETTLER_SIGNER_BEARER_TOKEN` | API/collector access to the signer |
| `X402_FACILITATOR_URL`, `X402_FACILITATOR_TIMEOUT_MS` | Facilitator endpoint and timeout; defaults to the Monad Foundation instance |
| `X402_WITHDRAW_DELAY_SECONDS`, `X402_MIN_DEPOSIT_USDC`, `X402_REQUEST_LIMIT_USDC`, `X402_MAX_CHANNELS_PER_PAYER` | Withdrawal delay (86400), minimum deposit (0.1), per-call limit (5), channels per wallet (128) |
| `API_KEY_MAX_CONCURRENCY` | Running requests per key (128) |
| `API_KEY_REQUEST_LIMIT_USDC` | Maximum hold per API key request (50) |
| `API_KEY_HOLD_OUTPUT_TOKENS` | Maximum output tokens used to estimate a key's hold (8192); forwarded `max_tokens` is unchanged |
| `POOL_ADDRESS`, `POOL_CODE_HASH` | Pool address (reference mainnet deployment `0x5f60…1Fb3`) and runtime code hash checked before signing; unset disables API keys |
| `POOL_SETTLE_MIN_USDC`, `POOL_SETTLE_MAX_WAIT_SECONDS` | Usage threshold (1) or wait (7 days) for a standalone debit; refills carry outstanding usage along |
| `POOL_REFILL_BELOW_BPS`, `POOL_REFILL_WAIT_MS` | Refill below this fraction of target availability (5000 = half); request refill wait (15000 ms) |
| `POOL_PERMIT_MIN_BALANCE_USDC`, `POOL_ACTIVATION_FEE_USDC`, `POOL_SWEEP_MIN_USDC` | Wallet balance required to relay permit (1), one-time activation fee (0.05), sweep threshold (1) |
| `SETTLEMENT_SIGNER_DAILY_GAS_MON`, `SETTLEMENT_SIGNER_DAILY_PERMIT_GAS_MON`, `SETTLEMENT_SIGNER_MAX_GAS_MON` | Signer gas budgets: 5 MON/day, 1 MON/day for permits, 0.2 MON/transaction |
| `X402_CLAIM_MIN_USDC`, `X402_CLAIM_IDLE_SECONDS`, `X402_CLAIM_INTERVAL_SECONDS` | Claim at 1 USDC or after a day idle; scan every 10 minutes |
| `STREAM_REQUEST_TIMEOUT_MS`, `STREAM_IDLE_TIMEOUT_MS`, `STALE_REQUEST_AFTER_SECONDS` | Total stream budget (570000 ms maximum), idle timeout and abandoned-request age (must exceed stream budget) |
| `CALL_SERVICE_FEE_BPS` | Per-call service fee; bootstrap publishes a versioned policy |
| `CNY_PER_USD` | Optional ECB FX override |
| `DEEPSEEK_API_KEY`, `OPENROUTER_MANAGEMENT_KEY` | Provider env file read by API, collector, catalog and bootstrap (`PROVIDER_ENV_FILE`); collector synchronizes wallet limits |
| `PROVIDER_CONFIG_FILE` | `providers.json` ([providers](PROVIDERS.md)) |
| `REAL_MODEL_CALLS_ENABLED` | Defaults to `false`; production calls require a Monad chain entry |
| `AUTH_SESSION_HMAC_SECRET`, `RESPONSE_ENCRYPTION_KEYS` | Generated secrets; encryption protects provider keys |
| `AUTH_ALLOWED_ADDRESSES` | Optional comma-separated wallet allowlist for sign-in and payment |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`, `REDIS_URL`, `REDIS_NAMESPACE` | Shared rate limits: by API key, x402 channel, otherwise IP |
| `DATABASE_URL_METRICS`, `GRAFANA_*` | Optional [monitoring](MONITORING.md) |
| `CLOUDFLARE_TUNNEL_TOKEN` | Optional [public access](CLOUDFLARE.md) |
| `DB_SSL_REJECT_UNAUTHORIZED` | Keep the default `true` |

Wallet sign-in needs no wallet-service credentials. Optional `WALLETCONNECT_PROJECT_ID`, supplied at frontend build time, enables mobile wallets.

## Client: local proxy

| Variable / option | Purpose |
| --- | --- |
| `ROUTER3_PAYER_KEY` or `ROUTER3_PAYER_KEY_FILE` | Payer private key; keep it on the client machine |
| `ROUTER3_GATEWAY_URL` / `--gateway` | Gateway URL |
| `ROUTER3_RPC_URL` | Monad RPC for channel recovery |
| `ROUTER3_DIR` / `--dir` | Channel records and salts (default `~/.router3`) |
| `ROUTER3_MAX_CHANNELS` / `--max-channels` | Channel-pool limit (128) |
| `ROUTER3_MAX_PAYMENT_USD` | Maximum hold per request (5, matching the gateway; the SDK's own default is 1) |
| `ROUTER3_PROXY_PORT` / `--port` | Listening port (8402) |

## Local development

`npm run env:complete` fills local `.env` secrets and Supabase role URLs.
