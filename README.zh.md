# Router3

可自行部署的模型 API 网关，支持 OpenAI Chat Completions、Anthropic Messages 和 Responses，费用从钱包以 USDC 在 Monad 上结算。

线上实例：[router3.ai](https://router3.ai)。[English](README.md)。

- **API Key**：从钱包共享预付池自动扣款，支持每把 Key 的花费限额，最多 128 并发。
- **x402**：通过 SDK 或本地代理使用自签付款通道，无需 API Key。
- **供应商**：DeepSeek 和 OpenRouter，按供应商价格加收 `CALL_SERVICE_FEE_BPS`（默认 1%）服务费。

## 自部署

需要 Node.js 22+、Docker Compose、HTTPS 域名、Monad RPC、Treasury 收款地址和供应商密钥。OpenRouter 使用管理 Key。部署钱包需要 MON 支付合约部署 gas。

```bash
npm ci
cp .env.example .env     # 填写 Treasury、RPC、供应商 Key 和 DEPLOYER_PRIVATE_KEY
npm run pool:deploy
npm run mainnet:local:configure -- --public https://你的域名
npm run mainnet:local:build
npm run mainnet:local:init-db
npm run mainnet:local:start
```

部署完成后删除 `DEPLOYER_PRIVATE_KEY`，给脚本打印的 Settler 地址转 MON 支付运行 gas（可先转约 1 MON）。

HTTPS 接入、配置和升级步骤见[独立部署](docs/SELF_HOSTING.zh.md)。

## 合约

router3.ai 当前在 Monad 使用的生产预付池：

[0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3](https://monadvision.com/address/0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3)

源码：[WalletPrepaidPool.sol](contracts/src/WalletPrepaidPool.sol)。`npm run contracts:verify` 比对链上运行时代码与提交的编译产物。详见[合约说明](contracts/README.md)。

## 架构

PostgreSQL 保存账本和链上状态，Redis 提供共享 API 限流。

| 服务 | 作用 |
| --- | --- |
| `api` | 鉴权、模型调用、用量计费 |
| `collector` | 预付池扣款、补充、取回及 x402 结算 |
| `signer` | 预付池交易和 x402 claim/退款签名 |
| `reconciler` | 丢失请求恢复、过期会话清理 |
| `catalog` | 模型、价格和供应商 Key 同步 |
| `web` | Nginx 和控制台 |

## 控制台

钱包登录、自动扣款、API Key 管理、调用记录、模型目录及自签通道，支持中英文。

使用模拟数据预览：`npm run web:preview`。

## 开发与验证

需要 Node.js 22+ 和 Docker；合约与链上测试还需要 Foundry。

```bash
npm ci && npm run web:install
npm run verify
npm run web:build
npm run contracts:verify
npm run test:openai-sdk-compat
npm run test:pool-recovery-e2e
```

## 文档

- [预付池](docs/PREPAID_POOL.zh.md) · [x402 通道](docs/X402.zh.md) · [架构](docs/ARCHITECTURE.zh.md) · [HTTP API](docs/API_REFERENCE.zh.md) · [数据库](docs/DATABASE_SCHEMA.zh.md)
- [安全](docs/SECURITY.zh.md) · [已知限制](docs/KNOWN_LIMITATIONS.zh.md) · [依赖安全](docs/DEPENDENCY_SECURITY.zh.md) · [供应商](docs/PROVIDERS.zh.md) · [Redis 与扩容](docs/REDIS_DECISION.zh.md)
- [独立部署](docs/SELF_HOSTING.zh.md) · [本地主网](docs/LOCAL_MAINNET.zh.md) · [配置清单](docs/CONFIGURATION_CHECKLIST.zh.md) · [监控](docs/MONITORING.zh.md) · [Cloudflare](docs/CLOUDFLARE.zh.md) · [Monad](docs/MONAD.zh.md)

## 许可证

[MIT](LICENSE)。
