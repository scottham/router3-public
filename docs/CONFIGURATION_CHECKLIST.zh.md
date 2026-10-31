# 配置清单

[English](CONFIGURATION_CHECKLIST.md)

部署者在 `.env` 里提供：Treasury 收款地址、Monad RPC、供应商 Key（DeepSeek 账户 Key、OpenRouter 管理 Key）、一把只用于部署合约的私钥；`npm run pool:deploy` 写入预付池地址和代码哈希，`npm run mainnet:local:configure -- --public https://域名` 生成其余全部（见 [独立部署](SELF_HOSTING.zh.md)）。生成或内置：Settler 钥匙文件（configure 生成，签 x402 凭证并发预付池交易，要少量 MON 付 gas）、数据库角色密码、HMAC/加密密钥、Redis 密码、主网 USDC 地址、x402 合约地址。

Redis 为共享协调状态，PostgreSQL 为账本真值，见 [Redis 与扩容](REDIS_DECISION.zh.md)。本仓库自己的主网实例使用 `.env.mainnet-local`，见 [本地主网指南](LOCAL_MAINNET.zh.md)。`CALL_SERVICE_FEE_BPS` 修改后需再次运行 `npm run mainnet:local:init-db` 发布新费率版本。

## 运行时变量

| 变量 | 说明 |
| --- | --- |
| `PUBLIC_APP_URL`、`CORS_ORIGINS` | 正式 HTTPS 域名；CORS 严格列出控制台域名 |
| `MONAD_RPC_URL` | 登录签名校验（ERC-1271/6492）、池快照、交易与回执、通道取回申请；链 ID 固定 143 |
| `APP_NAME`、`APP_LOGO_URL` | 钱包里显示的应用名与 HTTPS Logo |
| `CHAIN_CONFIG_JSON` | `{"143":{"name","rpcUrl","usdcAddress","confirmations"}}` |
| `TREASURY_ADDRESS`、`SETTLER_ADDRESS` | 收款钱包与 Settler 地址；池 signer 核对收款方/角色，x402 用作收款方/授权地址 |
| `SETTLER_SIGNER_URL`、`SETTLER_SIGNER_BEARER_TOKEN` | API 和 collector 访问 signer |
| `X402_FACILITATOR_URL`、`X402_FACILITATOR_TIMEOUT_MS` | facilitator，默认 Monad 基金会实例 |
| `X402_WITHDRAW_DELAY_SECONDS`、`X402_MIN_DEPOSIT_USDC`、`X402_REQUEST_LIMIT_USDC`、`X402_MAX_CHANNELS_PER_PAYER` | 取回等待期（86400）、最低存款（0.1）、单次上限（5）、每钱包通道数（128） |
| `API_KEY_MAX_CONCURRENCY` | 每个 API Key 同时进行的请求（128） |
| `API_KEY_REQUEST_LIMIT_USDC` | API Key 单个请求的冻结额上限（50） |
| `API_KEY_HOLD_OUTPUT_TOKENS` | API Key 请求冻结时最多按多少输出 token 算（8192），`max_tokens` 照原样转发 |
| `POOL_ADDRESS`、`POOL_CODE_HASH` | 预付池合约地址（主网 `0x5f60…1Fb3`）与运行时代码哈希（signer 每次签名前核对）；不设则 API Key 不可用 |
| `POOL_SETTLE_MIN_USDC`、`POOL_SETTLE_MAX_WAIT_SECONDS` | 已用费用攒到多少（1）或等多久（7 天）单独上链扣款；补充时总会顺带扣款 |
| `POOL_REFILL_BELOW_BPS`、`POOL_REFILL_WAIT_MS` | 可用额低于补充目标的多少比例时补充（5000 = 一半）；放不下的请求等补充的时间（15000） |
| `POOL_PERMIT_MIN_BALANCE_USDC`、`POOL_ACTIVATION_FEE_USDC`、`POOL_SWEEP_MIN_USDC` | 代发 permit 要求的钱包余额（1）、一次性开通费（0.05）、归集门槛（1） |
| `SETTLEMENT_SIGNER_DAILY_GAS_MON`、`SETTLEMENT_SIGNER_DAILY_PERMIT_GAS_MON`、`SETTLEMENT_SIGNER_MAX_GAS_MON` | signer 发交易的 gas 预算：每日 5 MON、其中 permit 1 MON、单笔 0.2 MON |
| `X402_CLAIM_MIN_USDC`、`X402_CLAIM_IDLE_SECONDS`、`X402_CLAIM_INTERVAL_SECONDS` | collector：满 1 USDC 或闲置一天即 claim，每 10 分钟扫描 |
| `STREAM_REQUEST_TIMEOUT_MS`、`STREAM_IDLE_TIMEOUT_MS`、`STALE_REQUEST_AFTER_SECONDS` | 流总预算（570000，不得更大）、空闲上限、丢失请求阈值（必须大于流预算） |
| `CALL_SERVICE_FEE_BPS` | 每次调用服务费（bootstrap 时发布费率版本） |
| `CNY_PER_USD` | 可选，覆盖 ECB 汇率 |
| `DEEPSEEK_API_KEY`、`OPENROUTER_MANAGEMENT_KEY` | 由 API、collector、catalog 和 bootstrap 读取（`PROVIDER_ENV_FILE`）；collector 用管理 Key 同步钱包额度 |
| `PROVIDER_CONFIG_FILE` | `providers.json`，见 [供应商](PROVIDERS.zh.md) |
| `REAL_MODEL_CALLS_ENABLED` | 默认 `false`；生产开启时必须配置 Monad 链条目 |
| `AUTH_SESSION_HMAC_SECRET`、`RESPONSE_ENCRYPTION_KEYS` | 随机生成；后者加密供应商 Key |
| `AUTH_ALLOWED_ADDRESSES` | 可选，逗号分隔的钱包地址。设置后只有这些地址能登录和付款 |
| `RATE_LIMIT_MAX`、`RATE_LIMIT_WINDOW`、`REDIS_URL`、`REDIS_NAMESPACE` | 共享速率限制：API Key 按 Key，x402 按通道，其他请求按 IP |
| `DATABASE_URL_METRICS`、`GRAFANA_*` | 可选，监控，见 [监控](MONITORING.zh.md) |
| `CLOUDFLARE_TUNNEL_TOKEN` | 可选，公网发布，见 [Cloudflare](CLOUDFLARE.zh.md) |
| `DB_SSL_REJECT_UNAUTHORIZED` | 保持默认 `true` |

钱包登录不需要任何钱包服务商密钥。前端可选 `WALLETCONNECT_PROJECT_ID`（构建时传入）以支持手机钱包。

## 客户端（本地代理）

| 变量 / 参数 | 说明 |
| --- | --- |
| `ROUTER3_PAYER_KEY` 或 `ROUTER3_PAYER_KEY_FILE` | 付款钱包私钥，只留在本机 |
| `ROUTER3_GATEWAY_URL` / `--gateway` | 网关地址 |
| `ROUTER3_RPC_URL` | Monad RPC，只用于恢复通道状态 |
| `ROUTER3_DIR` / `--dir` | 通道记录与 salt 目录（默认 `~/.router3`） |
| `ROUTER3_MAX_CHANNELS` / `--max-channels` | 通道池上限（默认 128） |
| `ROUTER3_MAX_PAYMENT_USD` | 单个请求最多冻结多少（默认 5，与网关单次上限一致；SDK 自身默认只有 1） |
| `ROUTER3_PROXY_PORT` / `--port` | 监听端口（默认 8402） |

## 本地开发

`npm run env:complete` 补齐本地 `.env` 的随机密钥和本地 Supabase 角色 URL。
