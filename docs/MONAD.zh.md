# Monad 迁移

[English](MONAD.md)

2026-10-18 起，登录与扣费只在 Monad 主网（chain 143）进行，Base 不再使用。链 ID、USDC 地址和公共 RPC 都集中在 `src/chain.js`（前端为 `web/src/chain.js`）。

| 项目 | Monad 主网 |
| --- | --- |
| Chain ID | 143 |
| USDC | Circle 原生 `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`（FiatToken v2.2，EIP-712 域 `USDC` / `2`） |
| 原生币 | MON，用于 gas |
| 公共 RPC | `https://rpc.monad.xyz`（有限速，生产换专用 RPC） |
| 浏览器 | https://monadscan.com |

## 改了什么

- **配置**：`BASE_ACCOUNT_*`、`BASE_MAINNET_RPC_URL` 改为 `MONAD_RPC_URL`、`APP_NAME`、`APP_LOGO_URL`；signer 的 gas 限额改用 MON 计价（`SETTLEMENT_SIGNER_MAX_GWEI=1000`、`_MAX_GAS_MON=0.2`、`_DAILY_GAS_MON=5`），删掉 Base 的 L1 数据费预留。
- **数据库**：`202610180004_monad_mainnet.sql` 把 chain 约束改为 143。旧 Base 行保留为历史（`NOT VALID`），Base 钱包标为 revoked，所有会话失效，用户重新登录后得到 Monad 钱包行；若 Base 仍有在途预留或应收，迁移拒绝执行。政策行被重置为未启用，由 bootstrap 写入 Monad 合约。
- **合约**：最初原样部署 `WalletChargeRouter`；同日改为 [预付池](PREPAID_POOL.zh.md) `WalletPrepaidPool`，部署方式见 `contracts/README.md`。
- **前端**：wagmi/RainbowKit 只配置 `monad`；钱包不认识 143 时自动 `wallet_addEthereumChain`；主题改为 Monad 紫。

## Monad 与 Base 的差异，以及代码怎么处理

下列数据来自迁移和 2026 年 10 月的验收观察，gas 价格、RPC 保留范围和网络负载可能变化。

| 差异 | 处理 |
| --- | --- |
| 按 **gas limit** 收费，不按实际用量；收据里的 `gasUsed` 就等于 gas limit（已在主网核对） | signer 和部署脚本的估算余量从 20% 降到 10%；账本记录的网络费用按 gas limit × 价格 |
| **Reserve balance**：EIP-7702 委托账户转出价值后必须仍 ≥ 10 MON，否则交易被打包但回滚（仍扣 gas） | Settler 是新生成的普通 EOA，交易 value 为 0，不受影响 |
| `latest` 是尚未投票的提议块，收据在终局前可能变化 | 扣款与 permit 收据只和 `finalized` 区块比较；`confirmations` 改为“finalized 之后再等几个块”，默认 0 |
| 全节点只保留约数天历史状态（公共 RPC 约 100 万块可查，500 万块已不可查） | fork 测试在启动时固定到上游 finalized 附近的块，并核对 USDC 名称；`MONAD_FORK_RPC_URL` 可换上游 |
| 没有全局 mempool；`eth_getTransactionByHash` 在打包前返回 null | signer 本来就先持久化签名字节再广播，重试只重发同一笔交易，不换 nonce |
| 基础费下限 100 gwei | 默认单笔 gas 价格上限 1000 gwei |

## 并行执行对本项目有没有用

**直接作用很小。** Monad 的乐观并行执行是链的执行策略：同一区块里的交易并行执行，读写冲突的交易按顺序重跑，结果与串行执行完全一致。它提高的是整条链的吞吐，不改变单个应用的交易语义。本项目的链上写入有两种：

1. **结算** `settle`（扣费 + 补充）：全部由同一个 Settler 地址发出，nonce 本来就是串行的。改用预付池后，扣费只写池子合约里的记账（池子余额、Treasury 应得），补充写用户自己的 USDC 余额和授权；不同用户的补充互不冲突，但 Treasury 应得是同一个存储槽。
2. **代提交 permit 与池子请求**：写入各用户自己的状态，不同用户之间不冲突，但发送方仍是同一个 Settler。

按目前的量（大约每消费 1 USDC 才结算一次），链的吞吐根本不是瓶颈。

**间接有用的是并行执行带来的低费用和快终局：**

- 实测主网每块约 0.3–0.4 秒，`finalized` 基本紧跟最新块；每块只用了 150M gas 上限中的几百万，网络很空。
- 基础费在 100 gwei 下限。主网实测：旧"授权直扣"一次收款的 gas limit 为 249,169，约 0.025 MON（Monad 按 limit 计费，冷存储访问也更贵），按 MON $0.02–0.035 计约 $0.0005–0.0009，比 Base 实测的约 $0.002 便宜 2–4 倍，而不是此前估计的 10 倍。
- 快终局让取回冷却期可以较短（30 分钟），结算在几秒内就能确认。

**预付池对 gas 的影响比并行执行大得多**：账单已被池子覆盖，不再需要"每笔账单一笔交易"，只在补充、取回或累计到 1 USDC 时结算；扣费在合约内记账，USDC 只在补充和 sweep 时转移。

**量大以后可以做的两件事（现在不需要）：**

- **多付款人合批**：把多个用户的扣费和补充合进一笔交易，交易数降到原来的 1/N。
- **多个 Settler 分片**：按钱包把结算分给多个 Settler 地址，同时有多笔交易在途；它们都写 Treasury 应得这个存储槽，Monad 能正确处理冲突，只是这部分并行度降低。

## 运营者需要做的

参考实例的预付池 `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3` 于 2026-10-18 部署，实测部署费为 0.281 MON。旧直扣合约已停用。当前配置与验收流程见[本地主网](LOCAL_MAINNET.zh.md)和[独立部署](SELF_HOSTING.zh.md)。

仍需：生产换专用 Monad RPC（`MONAD_RPC_URL`）；Settler 余额低于约 0.5 MON 时补充。
