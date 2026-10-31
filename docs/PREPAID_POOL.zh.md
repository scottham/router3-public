# 预付池（API Key 的扣费方式）

[English](PREPAID_POOL.md)

2026-10-26 起，API Key 从钱包的预付池扣费。用户的感受就是"自动扣款"：签一次名之后，平台按用量从钱包补充一个小额预付池，每次调用按实际 token 扣费，用户不用再充值。钱包自签的 x402 通道（本地代理、SDK）另见 [X402.md](X402.zh.md)，两者互不影响。

合约是 `WalletPrepaidPool`，2026-10-18 部署在 Monad 主网 `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3`（源码 `contracts/src/WalletPrepaidPool.sol`，`npm run contracts:verify` 编译后与链上字节码比对并打印 `POOL_CODE_HASH`）。合约不可升级，没有管理员提款函数。管理员能暂停结算及授予/撤销 Settler 和管理员角色；新增的 Settler 可绕过网关数据库与签名器策略，但仍受合约每日上限、补充规则和固定 Treasury 约束。用量计量需要信任部署者与合约管理员。

## 用户流程

1. 用钱包登录（SIWE，Monad chain 143）。钱包里有 Monad USDC 即可，不需要 MON。
2. 「API Key」页 → 开启自动扣款，签两个名，都不花 gas：
   - USDC `permit`：允许预付池从钱包总共拉多少 USDC（授权额度，默认 100）。
   - 预付池 `Configure`：补充目标（默认 5 USDC）和每日上限（默认 20 USDC）。
3. 网关代发这两笔交易，然后把预付池从钱包补到目标值。整个过程几秒钟。
4. 创建 API Key。同一钱包的所有 Key 共用这个预付池，新建马上能用。每个 Key 可设自己的每日上限和总上限。
5. 不用了：签名申请取回，调用立即停止；先扣掉已用的费用，等待期（主网 30 分钟）后余额由网关代为退回钱包，自动补充随之关闭。

## 扣费

| 环节 | 规则 |
| --- | --- |
| 冻结 | 请求开始时冻结估算费用：输入按 UTF-8 字节 ÷ 3，图片按每张上限，输出最多按 `API_KEY_HOLD_OUTPUT_TOKENS`（8192）算；单次上限 `API_KEY_REQUEST_LIMIT_USDC`（50） |
| 可用额 | `min(池余额, 今日剩余扣款额) − 已用未扣 − 取回中金额 − 进行中冻结额`。放不下时，如果钱包余额和授权足以补充，请求最多等 `POOL_REFILL_WAIT_MS`（15 秒）补充；否则返回 `402 INSUFFICIENT_BALANCE` |
| 结束 | 按实际 token 扣费，超过冻结额也照扣，但同时受钱包可付额和 Key 的每日/总剩余额度限制；Key 的额度还须预留其他进行中请求的冻结额。扣不下的部分记为 `unbilled_overrun`，由部署者承担，不追加扣款 |
| 用量未知 | 断流、超时、供应商未返回用量：按冻结额收费（同样受上面的上限约束）。连不上供应商（域名不解析、拒绝连接、TLS 失败）不收费；非流式调用客户端中途断开，网关仍等模型跑完，按用量收费 |
| 并发 | 每个 Key 最多 `API_KEY_MAX_CONCURRENCY`（128）个进行中请求 |
| 上链 | 已用费用和补充在同一笔 `settle` 里：可用额低于补充目标的一半、或有请求在等补充时补充；累计 ≥ `POOL_SETTLE_MIN_USDC`（1）、等待超过 7 天、或正在取回时扣款。每笔扣款对应一组请求，`usageRoot` 是这些请求 id 的哈希 |
| 归集 | 合约里 Treasury 应得达到 `POOL_SWEEP_MIN_USDC`（1）时调用 `sweep`，USDC 转入固定的 Treasury |

所有记账在 `private.pool_accounts` 的行锁下完成：冻结、释放、扣费都是同一事务里的读写，多个 API 副本同时处理同一钱包的请求也不会超额。

结算确认在账户锁内重新检查批次状态，每笔只记一次；只有取得不早于交易区块的链上快照，才一起更新池余额和已用未扣。快照读取失败时保留批次及应收，下一轮重试，普通快照刷新不会覆盖结算中的账户。

提交失败到达重试上限时，collector 通过 `fail_unsigned_pool_batch` 与 signer 取得同一把批次锁。签名日志里已有交易就恢复原交易哈希，继续确认；只有确定没有签名交易时才释放该批次的费用。数据库查询失败时保留原批次，不能依据 HTTP 超时推断交易未上链。

升级这套恢复逻辑须先应用 `202610310001_pool_batch_recovery.sql` 和角色授权，再更新 signer，最后更新 collector/API/reconciler；旧 signer 不参与批次锁，不能与新恢复逻辑混跑。无需重新部署链上合约。每日 Key 额度按请求创建的 UTC 日期归属，跨日完成和异常退出后的恢复也遵守该日额度。

## 平台能动用多少

- 每天最多扣"每日上限"这么多，由合约限制；调低每日上限要等取回等待期后才生效。
- 只能把钱从钱包补进这个钱包自己的预付池，总量不超过 permit 授权额度，余额不超过补充目标。
- 预付池里的钱只能付给固定的 Treasury（按账单），或者退回钱包本人。
- 用户随时可以把授权额度设为 0 停止补充；网关不在线时，等待期满后任何人都可以执行 `withdraw(owner)`，钱只会回到用户钱包。

Key 泄露时，最多在每日上限和这个 Key 自己的额度内花预付池的钱，钱转不走。撤销 Key 立即生效。

钱包从 `AUTH_ALLOWED_ADDRESSES` 移除后，已有 Key 的模型调用和只读看板也会返回 `403 ADDRESS_NOT_ALLOWED`。额度调低不会撤销已经发生的费用，但未完成请求结算时会重新读取当前额度。

## 交易与 gas

网关代发的操作由 Settler 支付 gas；用户直接在链上操作时，需要自己的 MON。

- `signer` 容器是唯一持有 Settler 私钥的进程。collector 只告诉它"发第几号批次 / 第几号操作"，签名器自己从数据库读出那一行重建调用数据，所以别的进程决定不了签什么。
- 允许的调用：`settle`（批次）、用户签名的 `permit` / `configureBySig` / `requestWithdrawalBySig` / `cancelWithdrawalBySig`、到期的 `withdraw(owner)`、`sweep()`。签名前核对预付池代码哈希（`POOL_CODE_HASH`）、Treasury、USDC 和 Settler 角色。
- nonce 和签好的交易先写进 `settlement_signing.transactions` 再广播，重启后重发同一笔；每日 gas 上限 5 MON，其中 permit 代发单独 1 MON；单笔最多 0.2 MON。
- 一笔 `settle`（扣款 + 补充）约 25 万 gas，主网约 0.025 MON。低频用户的小额账单攒到 1 USDC 或随下次补充一起结算。

防刷 gas：代发 permit 要求钱包里至少有 `POOL_PERMIT_MIN_BALANCE_USDC`（1）USDC；第一次 permit 成功后记一笔 `POOL_ACTIVATION_FEE_USDC`（0.05）的开通费，随第一次扣款结算。补充只在真的有调用时才发生。

## OpenRouter 子 Key

每个钱包在 OpenRouter 有自己的子 Key（管理 Key 创建）。子 Key 的额度等于这个钱包预付池的每日上限，每天重置（`limit_reset: daily`）；没有预付池的钱包用 `providers.json` 的 `payerKeyLimitUsd`。即使网关自己的记账出错，一个钱包在 OpenRouter 一天也花不过这个数。钱包改每日上限（`configure`）确认上链后，collector 立刻把子 Key 额度改过去；catalog 每小时再核对一次额度和用量。

## 旧 Key

2026-10-26 之前创建的 Key 各有一条 x402 通道。它们现在也从预付池扣费；通道里剩下的钱在 Key 列表里点「退回旧余额」退回钱包（不用签名）。

## 测试

- `test/api-keys.test.js`：在合约模型上跑通开通、共用、并发、等补充、扣款与归集、每日上限截断、Key 额度、取回、签名校验。
- `npm run test:pool-db`：真实 Postgres 上 60 个并发冻结、扣费恰好到池余额为止、collector 规划批次、签名器重建调用数据、各角色权限、丢失请求按冻结额收费。
- `npm run test:pool-recovery-e2e`：自动创建临时 PostgreSQL 和本地 Anvil，部署提交的合约，通过真实 signer HTTP 和完整 API 验证响应丢失恢复、签名与放弃竞态、多 collector、快照失败、Key 硬额度及白名单。包含并发 JSON/SSE 调用；模型使用本地 mock，不消耗供应商或主网资金。需要 Docker、Foundry 和本地 `postgres:17-bookworm` 镜像，结束后清理测试资源。
- `npm run test:pool-fork`：Monad 主网分叉上对已部署的预付池跑完整流程：permit、配置、补充、扣款、归集、取回。
