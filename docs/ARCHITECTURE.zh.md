# 架构

[English](ARCHITECTURE.md)

钱包地址就是身份。主要路径是 API Key：同一钱包的所有 Key 共用 `WalletPrepaidPool`，自动补充和扣费，详见 [预付池](PREPAID_POOL.zh.md)。高级路径是客户端自行签署 x402 `batch-settlement` 凭证，两条路径的余额和账本相互独立。

## 请求与计费

```text
客户端 → OpenAI Chat / Anthropic Messages / OpenAI Responses
       → Key 鉴权或 x402 凭证核验 → 目录、价格、选项校验
       → PostgreSQL 冻结额度 → 直连 DeepSeek 或 OpenRouter
       → 归一化 usage → 关闭请求、记录费用 → 返回 JSON / SSE
```

API Key 只存 Token 的 HMAC；新 Key 不创建通道、不保存用户钱包私钥或代签凭证的授权钥匙。冻结、释放与实际扣费在钱包账户行锁下完成。开始和结束都检查 Key 的每日/总额度，并为同 Key 其他在途请求保留冻结额度。实际用量超过估算时，最多收取池可付额和 Key 剩余额度，差额记为未收，由部署者承担；不终止已经派发的响应。每 Key 默认最多 128 个并发请求。

x402 请求先收到 `402` 与 `PAYMENT-REQUIRED`，客户端签累计凭证并带 `PAYMENT-SIGNATURE` 重发。网关核验后登记待结算，按实际用量更新累计额，最多到本次签署的上限；响应带 `PAYMENT-RESPONSE`，SSE 在最后一块带 `gateway.x402.payment_response`。同一通道同时一个请求，并发使用多通道。

供应商在收费前拒绝才免费取消。断流、超时或其他用量未知情形按上限收费，API Key 同时遵守钱包可付额及 Key 硬额度。没有自动重试、跨模型回退或响应缓存。

## 资金与结算

- **预付池**：用户签 USDC permit 与池配置，signer 代发。collector 规划 `settle`，将已用费用扣入合约的 Treasury 应计款，并按需要从钱包补充本人的池；`sweep` 归集到固定 Treasury。signer 钱包持少量 MON 支付 gas。用户签名申请取回后停止新调用，先结清已用费用；等待期满可由网关或任何人执行 `withdraw(owner)`，余额只回用户钱包。
- **x402**：用户签 ERC-3009 授权，由 facilitator 代存。collector 批量 claim 后 settle 给 Treasury；协作退款先结清再退款。用户也可在链上发起限时取回。此路径由 facilitator 发交易和付 gas。
- 计量需信任部署者；预付池合约限制扣款及资金去向，x402 合约限制为用户签署的累计额。池管理员能暂停结算及授予/撤销 Settler 和管理员角色；新增 Settler 可绕过网关签名策略，但不能绕过合约约束。见 [合约说明](../contracts/README.md)。

## 服务组件

| 组件 | 责任 |
|---|---|
| Web | React + Vite 控制台；RainbowKit 连接钱包，SIWE 登录管理本人的池、Key 和通道 |
| API | 三种模型协议、鉴权、报价、冻结与扣费、用户操作入队 |
| 供应商适配器 | 直连供应商；OpenRouter 按付款钱包创建调用子 Key，固定托管商，按报告成本结算 |
| Collector | `pool-worker.js` 管理池批次、补充与取回；`x402-settlement-worker.js` 经 facilitator claim / settle |
| Signer | 唯一持有 Settler 私钥；核验数据库与策略后签 x402 ClaimBatch/Refund，或重建并广播预付池交易 |
| Reconciler | 回收进程死亡遗留请求和过期登录数据；池请求按冻结额收费，x402 过期待结算不收费 |
| Catalog | 同步目录、价格、汇率、供应商余额和钱包调用 Key 额度 |
| PostgreSQL | 身份、账本、余额镜像、价格版本、批次、操作及 signer 交易日志 |
| Redis | 跨 API 副本共享速率限制，不参与财务正确性判断 |
| 本地 x402 代理 | 客户端自己持钱包私钥，通过通道池提供普通 OpenAI 接口 |

## 一致性与恢复

- 钱包池账户行锁串行化短账务事务；每钱包最多一个开放批次。签好的交易先写 signer 日志再广播，重试广播同一笔交易。
- signer 与批次失败恢复使用同一 advisory lock。HTTP 超时不能证明未上链：日志已有签名交易则恢复原交易，只有确认无签名时才释放原批次费用。
- 确认批次时在账户锁内重查状态，每笔只记一次；费用和不早于回执区块的链上快照同时更新，快照失败保留应收和批次重试。
- x402 镜像由 PostgreSQL 行锁实现 SDK ChannelStorage。facilitator 暂时不可用时，新鲜镜像允许本地验签；存款、claim 与退款延后。旧镜像或智能钱包等需要远端核验时无法继续调用。
- 意外退出的池请求由 reconciler 按冻结额关闭，仍遵守 Key 硬额度；UTC 每日额度按请求创建日归属。正常滚动更新先让新 API 就绪，再等待旧实例在途请求完成。

## 权限与部署

各进程使用独立最小权限数据库角色；signer 独占 `settlement_signing.transactions`，collector 只能通过窄恢复函数查询并恢复相关批次，详见 [数据库模型](DATABASE_SCHEMA.zh.md)。供应商 env 文件由 API、collector、catalog 和 bootstrap 读取；collector 需要 OpenRouter 管理 Key 同步钱包额度。管理 Key 不用于模型调用。

`AUTH_ALLOWED_ADDRESSES` 同时限制钱包登录、x402 付款、现有 API Key 调用和只读 Key 看板。部署更新的备份、迁移与 signer 顺序见 [独立部署](SELF_HOSTING.zh.md#更新)。
