# 数据库模型

[English](DATABASE_SCHEMA.md)

PostgreSQL 是账本真值。迁移在 `supabase/migrations/`，按文件名顺序应用。历史迁移曾删除旧池及项目路径；后续迁移重新引入钱包共享预付池与 API Key 额度。新安装必须应用完整序列，不能只选单个迁移。

## Public Schema

- `app_users`、`user_profiles`、`user_wallets`：钱包登录创建的用户与钱包绑定（`private.resolve_or_create_base_account`）。RLS 开启，后端角色各有自己的 select 策略。
- `model_catalog`：模型目录（公开名、供应商、供应商模型 id、模态、能力、是否启用）。

## Private Schema

### 身份与会话

- `base_auth_challenges`、`base_auth_sessions`、`base_account_bindings`：SIWE challenge、会话（只存 HMAC 摘要）、地址到用户的绑定。
- `cleanup_expired_base_auth_data()`：reconciler 每分钟清理。

### 目录与价格

- `model_price_versions`：不可变价格版本（客户价、供应商价、`provider_quote`、`bailian_quote` 含汇率、阶梯、峰谷、路由）。
- `call_fee_policies`：不可变服务费率版本。
- `bailian_catalog_state`、`catalog_model_access`、`catalog_sync_runs`、`provider_balance_checks`：同步状态、可用性探测、同步记录、供应商余额对账。

### x402 通道

- `x402_channels`：通道镜像（SDK `ChannelStorage` 的记录：`state` jsonb 全量，另有 payer、payer_authorizer、累计实付、最新凭证额、余额、已 claim、取回申请时间、最近请求时间）。
- `x402_requests`：每次通道付款：协议、模型、价格版本、费率、`max_charge_usdc_nano`（冻结额）、`ceiling_atomic`、`actual_charge_usdc_nano`、`charged_atomic`、`cumulative_atomic`、`charged_from`（usage|ceiling）、模型费与服务费、供应商成本、用量、结算交易、失败码、状态（running/completed/failed/settlement_failed）。
- `x402_settlements`：存款、claim、settle、退款的链上操作日志。
- `recover_lost_x402_requests(before)`：超时仍 running 的请求标为 `REQUEST_LOST`。

### 供应商 Key

- `api_keys`：付款钱包、名称、前缀、Token 的 HMAC、状态、最近使用与每日/总额度。新 Key 从钱包池扣费；旧通道、salt 和加密授权钥匙字段保留用于旧余额退款，不用于新请求扣费。
- `provider_payer_keys`：每个付款钱包一把 OpenRouter 调用 Key（远端名、哈希、状态、加密后的秘密、限额、用量）。

### 预付池

- `pool_accounts`：每个钱包一行。链上快照（池余额、取回中金额、补充目标、每日上限与剩余、钱包余额与授权）和网关自己的累计（已用未扣 `unsettled_atomic`、进行中冻结 `held_atomic`、进行中请求数）。冻结、释放、扣费都在这行的锁下进行。
- `pool_requests`：从预付池付款的请求和开通费；`batch_id` 指向扣掉它的那笔 settle。
- `pool_batches`：链上 `settle`（扣款与/或补充），`batch_key` / `claim_key` 一次性，`usage_root` 是所含请求 id 的哈希；每个钱包同时最多一笔进行中。
- `pool_ops`：用户签名后待代发的调用（permit、配置、取回申请与取消）和网关自己的（执行到期取回、归集）。
- `settlement_signing.transactions`：signer 的交易日志（nonce、签好的交易、gas 上限），只有 signer 角色可读写。
- Key 冻结与已花费从 `pool_requests.api_key_id` 汇总，在钱包账户锁内同时检查每日/总额度；每日归属按请求创建的 UTC 日期。
- `recover_lost_pool_requests(before)`：reconciler 把超时请求按冻结额关闭，受钱包可付额及 Key 硬额度限制，未收差额留账。
- `fail_unsigned_pool_batch(payer,id,error)`：`202610310001_pool_batch_recovery.sql` 的窄权限恢复函数。与 signer 共用批次 advisory lock；有签名日志时恢复原交易为 submitted，确认无签名才失败并解绑费用；collector 无法读取原始交易日志。

### 指标

- `metrics_snapshot()`、`metrics_x402()`、`metrics_provider_balance()`：只给 `gateway_metrics` 角色的汇总函数。

## 角色

| 角色 | 权限 |
|---|---|
| `gateway_api` | 登录会话、通道镜像、请求账本和钱包 Key；池账户、请求、操作读写，池批次只读；目录、价格只读 |
| `gateway_settler` | collector 使用；通道镜像与结算日志；池账户、请求、操作与批次；Key 只读、供应商钱包 Key 更新、批次恢复函数 |
| `gateway_reconciler` | public/private 表只读；过期登录清理、x402 和池丢失请求恢复三个函数 |
| `gateway_signer` | 通道镜像、池账户/批次/操作只读；独占 signer 交易日志的读写权限 |
| `gateway_catalog` | 目录、价格、同步状态读写；钱包 Key 读与更新；池账户只读；供应商余额函数 |
| `gateway_metrics` | 三个汇总函数 |

授权在 `supabase/manual/create_backend_roles.sql.template`（API/settler/reconciler）和 `ops/bootstrap-production-db.mjs`（signer/catalog/metrics）。

## 货币单位

- `*_usdc_nano`：10⁻⁹ USDC；`*_atomic`：10⁻⁶ USDC（链上单位）；`*_usd_nano`：10⁻⁹ USD。
- 价格字段均为每百万 token。
