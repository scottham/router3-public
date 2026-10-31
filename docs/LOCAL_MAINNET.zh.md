# Monad 主网，本地运行

[English](LOCAL_MAINNET.md)

本仓库自己的实例使用 `docker-compose.production.yml` 与 `.env.mainnet-local`，公网经 Cloudflare Tunnel（router3.ai）。

## 首次配置

```bash
npm ci
npm run pool:deploy               # 一次：POOL_ADDRESS / POOL_CODE_HASH 写回 .env
npm run mainnet:local:configure -- --public https://你的域名
npm run mainnet:local:build && npm run mainnet:local:init-db
npm run mainnet:local:start
npm run mainnet:local:tunnel      # 可选：Cloudflare
npm run mainnet:local:metrics     # 可选：Grafana
```

配置与密钥要求见 [独立部署](SELF_HOSTING.zh.md)。`.env.mainnet-local`、`.secrets/monad-settler.key` 及 `PROVIDER_ENV_FILE` 指定的供应商文件均不进 git。新配置默认用 `.secrets/providers.env`，已有实例可能用 `.secrets/mainnet-providers.env`。

## 用户如何使用

1. 钱包里持有 Monad 主网 USDC，用钱包登录控制台。
2. 开启自动扣款，签 USDC permit 与预付池配置；网关代付 gas。给 Settler 充 MON 是部署者的职责。
3. 创建 API Key，任何兼容客户端设置网关的 `/v1` 地址与此 Key。同一钱包的 Key 共用预付池，各 Key 可设每日与总额度。
4. 不再使用时撤销 Key；关闭自动扣款并申请取回池余额，结清已用费用后等待主网 30 分钟，网关代为执行取回。

高级客户端可自行签 x402 凭证，或运行本地代理：`ROUTER3_PAYER_KEY_FILE=... node clients/x402-proxy/cli.mjs serve --gateway https://router3.ai`，SDK 指向 `http://127.0.0.1:8402/v1`。代理自动存款开通道、按并发使用多通道，`refund --all` 逐条退款。这些通道不与 API Key 预付池共用余额，详见 [X402.md](X402.zh.md)。

## 资金与结算

- API Key 在数据库按实际用量记费；collector 按需要将扣款与补充合并成池的 `settle`，再归集给固定 Treasury。冻结、硬额度、超额未收及批次恢复规则见 [PREPAID_POOL.md](PREPAID_POOL.zh.md)。
- x402 按用户签署的累计凭证记费，经 facilitator 批量 claim / settle。
- 用量未知通常按冻结额或签署的上限收费；供应商在收费前拒绝才免费取消。
- 预付池的 gas 由 Settler 付，x402 的 gas 由 facilitator 付；用户直接在链上操作则自己付 gas。

## 地址

| 项目 | 地址 |
|---|---|
| USDC（Monad） | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| Router3 WalletPrepaidPool | `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3` |
| x402BatchSettlement | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` |
| ERC3009DepositCollector | `0x4020806089470a89826cB9fB1f4059150b550004` |
| facilitator | `https://x402-facilitator.molandak.org` |
| Treasury / Settler | `.env.mainnet-local` 的 `TREASURY_ADDRESS` / `SETTLER_ADDRESS` |

独立部署使用自己的预付池与收款钱包。

## 更新、检查与恢复

更新必须按 [独立部署的更新步骤](SELF_HOSTING.zh.md#更新)：备份、构建、停 worker、迁移与授权、更新 signer 并检查、滚动 API、恢复 worker 和 web。只构建并更新 API 会遗漏迁移及 signer 协调。

```bash
npm run mainnet:local:check-keys
npm run mainnet:local:status
curl --fail --silent https://router3.ai/readyz
curl --fail --silent https://router3.ai/v1/x402
npm run mainnet:local:backup
npm run test:mainnet-backup        # 隔离数据库恢复验证
```

facilitator 不可用会阻塞 x402 存款/claim/退款；新鲜镜像可继续本地核验部分调用，旧镜像与智能钱包等远端核验路径会受影响。预付池结算另走 signer 和 Monad RPC。

API 正常更新会排空在途流；意外死亡遗留的请求默认 15 分钟后由 reconciler 关闭：池请求按冻结额收费并遵守 Key 硬额度，x402 过期预留不收费。公网配置见 [Cloudflare](CLOUDFLARE.zh.md)，扩容边界见 [Redis 决策](REDIS_DECISION.zh.md)。
