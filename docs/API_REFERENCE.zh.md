# HTTP API

[English](API_REFERENCE.md)

两种付款方式：带 API Key，从钱包的预付池扣费（[说明](PREPAID_POOL.zh.md)）；不带 Key，由客户端用钱包签 x402 凭证（[说明](X402.zh.md)）。

## 健康检查

- `GET /healthz`：进程存活。
- `GET /readyz`：数据库、Redis、供应商就绪；`x402: true` 表示 facilitator 条款已加载。

## 条款与模型

- `GET /v1/x402`：通道条款。`scheme`、`network`（`eip155:143`）、`asset`（USDC）、`payTo`（Treasury）、`receiverAuthorizer`（Settler）、`withdrawDelaySeconds`、`minDepositAtomic`、`requestLimitAtomic`、`maxChannelsPerPayer`、`maxTimeoutSeconds`、`contract`、`depositCollector`、`facilitator`、`paths`、`ready`。
- `GET /v1/models`：不带凭据返回 OpenAI 格式的模型列表（`{object:'list', data:[{id, object, created, owned_by}]}`）；带登录会话返回控制台目录（含价格、能力、服务费）。

## 模型调用

`POST /v1/chat/completions`（OpenAI Chat Completions）、`POST /v1/messages`（Anthropic Messages）、`POST /v1/responses`（OpenAI Responses）。请求体按各自格式；`stream: true` 为 SSE。

**带 API Key**：`Authorization: Bearer r3_live_…` 或 `x-api-key: r3_live_…`。直接返回结果；`gateway.payment: 'api_key'`，含 `billed_usdc_nano`、`model_cost_usdc_nano`、`service_fee_usdc_nano`，没有 `x402` 字段。错误：`API_KEY_INVALID` 401（无效或已撤销）、`POOL_NOT_SET_UP` 402（钱包还没开启自动扣款）、`INSUFFICIENT_BALANCE` 402（等了补充仍放不下本次冻结额，`details.requiredAtomic` / `availableAtomic` / `refillTargetAtomic` / `dailyRemainingAtomic`）、`POOL_WITHDRAWING` 402（预付池取回中）、`API_KEY_DAILY_LIMIT` / `API_KEY_TOTAL_LIMIT` 402（Key 自己的额度用完）、`X402_REQUEST_LIMIT` 402（冻结额超过 `API_KEY_REQUEST_LIMIT_USDC`，默认 50）、`API_KEY_CONCURRENCY_LIMIT` 429（超过 `API_KEY_MAX_CONCURRENCY`，默认 128）。

**不带 Key（x402 原生）**：

1. 不带 `PAYMENT-SIGNATURE` 头：`402`，`PAYMENT-REQUIRED` 头是 base64 的 x402 v2 `PaymentRequired`；响应体按端点格式给出错误 `PAYMENT_REQUIRED`，`details.x402.accepts[0].amount` 是本次上限（微 USDC）。
2. 带有效凭证：正常响应。响应体 `gateway`：`request_id`、`price_version_id`、`payment: 'x402'`、`billed_usdc_nano`、`model_cost_usdc_nano`、`service_fee_usdc_nano`、`service_fee_bps`、`x402: {charged_atomic, cumulative_atomic, ceiling_atomic, transaction, payment_response}`。非流式另带 `PAYMENT-RESPONSE` 头。
3. 流式：最后一个数据块（Chat Completions 的 `choices:[]` 用量块、Messages 的 `message_delta`、Responses 的 `response.completed`）带 `gateway`。错误以各格式的 `error` 事件结束。

错误码（402）：`PAYMENT_REQUIRED`、`X402_PAYMENT_INVALID`（凭证无效、过期、通道忙、余额不足）、`X402_REQUEST_LIMIT`（上限超过单次限制）、`X402_CHANNEL_LIMIT`（钱包通道数已满）、`X402_SETTLEMENT_FAILED`。白名单拒绝返回 `403 ADDRESS_NOT_ALLOWED`。其他：`MODEL_NOT_FOUND` 404、`VALIDATION_ERROR` / `MODEL_PROTOCOL_UNSUPPORTED` / `MODEL_IMAGE_INPUT_UNSUPPORTED` / `SERVER_TOOLS_NOT_SUPPORTED` / `RESPONSES_STORE_NOT_SUPPORTED` / `RESPONSES_STATE_NOT_SUPPORTED` 422、`X402_UNAVAILABLE` 503（facilitator 条款未加载）、`REAL_MODEL_CALLS_DISABLED` 503。

上游失败：`PROVIDER_REQUEST_REJECTED` 400 不收费；`PROVIDER_TIMEOUT` 504、`PROVIDER_STREAM_INCOMPLETE` 502、`PROVIDER_USAGE_UNAVAILABLE` 502 等按上限收费。

### 消息内容与图片

Chat Completions 的 `content` 可以是字符串或 `[{type:'text'}, {type:'image_url'}]` 数组；图片按模型的每张上限估算冻结额。不支持音频、联网搜索、`n` 扇出。Messages 和 Responses 不支持服务端工具（web search 等）和存储状态（`store`、`previous_response_id`）。

## 通道操作

- `POST /v1/x402/deposit`：无调用充值。不带付款头返回 402 报价（amount 1 微 USDC）；带 `deposit` 载荷（ERC-3009 授权 + 凭证）时 facilitator 存入，返回 `{channel, request_id, transaction}`。
- `GET|POST /v1/x402/refund`：协作退款。不带付款头返回 402（amount 0）；带 `refund` 载荷（零费用凭证，可选 `amount`）时先 claim 欠款再退，返回 `PAYMENT-RESPONSE` 头和 `{transaction}`。

## API Key 与预付池（登录会话）

- `GET /v1/keys`：`{terms:{requestLimitAtomic, maxConcurrency, holdOutputTokens}, pool, keys:[{id, name, prefix, state, createdAt, lastUsedAt, revokedAt, dailyLimitAtomic, totalLimitAtomic, running, spentTodayAtomic, spentAtomic, maxConcurrency, legacyChannel}]}`。`pool` 同 `GET /v1/pool` 的 `account`；`legacyChannel` 只有旧 Key 有。
- `POST /v1/keys` `{name, dailyLimitUsdc?, totalLimitUsdc?}` → `201 {token, key}`；`token` 只返回这一次。
- `PATCH /v1/keys/:id` `{dailyLimitUsdc, totalLimitUsdc}`（`null` 或 0 表示不限）→ `{key}`。
- `POST /v1/keys/:id/refund`：旧 Key 的 x402 通道余额退回钱包；没有通道时返回 `{refunded:false}`。
- `DELETE /v1/keys/:id`：撤销（旧 Key 同时退回通道余额），返回 `{revoked, refund}`。
- `GET /v1/keys/:id/requests`：最近 100 次调用（`charge_nano`、`ceiling_atomic`、`charged_from`、`settled`）。
- `GET /v1/pool`：`{terms:{poolAddress, usdcAddress, chainId, treasury, withdrawalDelaySeconds, maxRefillTargetAtomic, defaultRefillTargetAtomic, defaultDailyLimitAtomic, activationFeeAtomic, permitMinBalanceAtomic, poolDomain, usdcDomain}, account:{state: none|pending|active|paused|withdrawing, poolBalanceAtomic, availableAtomic, unsettledAtomic, heldAtomic, running, refillTargetAtomic, dailyLimitAtomic, dailyRemainingAtomic, walletBalanceAtomic, allowanceAtomic, withdrawalAtomic, withdrawableAt, snapshotAt, ops}, nonces:{pool, usdc}}`。
- `POST /v1/pool/setup` `{permit:{value, deadline, signature}, configure:{refillTarget, dailyLimit, nonce, deadline, signature}}` → `202 {ops}`：USDC `Permit`（spender = 预付池，域取自 `terms.usdcDomain`）和预付池 `Configure`（域 `terms.poolDomain`）的 EIP-712 签名。网关先核验签名（EOA 或 ERC-1271），再排队代发。钱包 USDC 少于 `permitMinBalanceAtomic` 时 422 `POOL_PERMIT_BALANCE_LOW`；签名不对 422 `POOL_SIGNATURE_INVALID`；过期 422 `POOL_SIGNATURE_EXPIRED`；同类操作还在提交 409 `POOL_OP_PENDING`。
- `POST /v1/pool/permit` `{value, deadline, signature}`：改授权额度（0 停止补充）。
- `POST /v1/pool/configure` `{refillTarget, dailyLimit, nonce, deadline, signature}`：改补充目标和每日上限。
- `POST /v1/pool/withdrawal` `{amount, nonce, deadline, signature}`（`RequestWithdrawal`）：申请取回；等待期满后 collector 代为执行 `withdraw`。`DELETE /v1/pool/withdrawal` `{nonce, deadline, signature}`（`CancelWithdrawal`）：取消。

## API Key 自查（Key 认证）

只读，`Authorization: Bearer r3_live_…` 或 `x-api-key`；没有 Key 401 `API_KEY_REQUIRED`，无效或已撤销 401 `API_KEY_INVALID`。每个 Key 120 次/分钟。不返回钱包地址和钱包余额，也不能改额度、撤销或取回。dsh 看板插件只用这组接口。

- `GET /v1/key`：`{key:{id, name, prefix, createdAt, lastUsedAt, dailyLimitAtomic, totalLimitAtomic, running, spentTodayAtomic, spentAtomic, maxConcurrency, requestLimitAtomic, holdOutputTokens}, pool}`。`pool` 同 `GET /v1/pool` 的 `account` 去掉 `walletBalanceAtomic` 和 `ops`，多一个 `refillable`（钱包余额和授权是否还够补充）；没有预付池时 `{state:'none'}`。
- `GET /v1/key/usage?days=30`（1–90）：`{since, days, daily:[{day, requests, failed, charged_atomic, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, avg_latency_ms}], models:[{model, …同上}]}`，UTC 日，只含已结束的调用，`models` 按花费降序。
- 兼容别名（同样认证，数值为 USD）：`GET /v1/dashboard/billing/subscription`（`hard_limit_usd` = 累计花费 + 当前可用额）和 `GET /v1/dashboard/billing/usage?start_date&end_date`（`total_usage` 美分，`end_date` 不含）——NextChat、Cherry Studio、ChatBox、one-api 系客户端读这对；`GET /v1/auth/key`（`{data:{label, usage, limit, limit_remaining, is_free_tier}}`）和 `GET /v1/credits`（`{data:{total_credits, total_usage}}`）——OpenRouter 格式；`GET /user/balance` / `GET /v1/user/balance`——DeepSeek 格式，`total_balance` 为当前可用额。"可用额"取预付池可用额与这把 Key 剩余额度的较小值。
- `GET /v1/key/requests?limit=50&before=<created_at>`（limit 1–200）：`{items, next}`，`items` 同 `GET /v1/keys/:id/requests` 并带 `model`、`latency_ms`、`usage`；`next` 是下一页的 `before`，没有更多时为 `null`。

## 控制台（登录会话）

钱包登录：`GET /v1/auth/config`（站点、网络、链、x402 条款）、`POST /v1/auth/challenge`、`POST /v1/auth/verify`（SIWE 消息与签名 → `mcg_session` HttpOnly Cookie）、`POST /v1/auth/logout`、`GET /v1/me`。

- `GET /v1/x402/channels`（不含 API Key 的通道）：`{terms, payer, walletKind: 'eoa'|'contract', channels:[{channel_id, config, balance_atomic, charged_atomic, claimed_atomic, withdraw_requested_at, last_request_at, requests}]}`。
- `GET /v1/x402/channels/:channelId/requests`：该通道最近 100 次调用（状态、模型、费用、上限、`charged_from`、用量）。

## 客户端

有 Key 时任何 OpenAI/Anthropic/Responses 客户端只改 base URL 和 Key。没有 Key 时见 [x402](X402.zh.md)「客户端」：本地代理把 402 流程变成普通接口。
