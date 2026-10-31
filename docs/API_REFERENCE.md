# HTTP API

[中文](API_REFERENCE.zh.md)

Requests with an API key charge the wallet's [prepaid pool](PREPAID_POOL.md). Requests without a key use wallet-signed [x402 vouchers](X402.md).

## Health

- `GET /healthz`: process liveness.
- `GET /readyz`: database, Redis and provider readiness; `x402: true` means facilitator terms are loaded.

## Terms and models

- `GET /v1/x402`: channel terms: `scheme`, `network` (`eip155:143`), `asset` (USDC), `assetName`, `assetVersion`, `payTo` (Treasury), `receiverAuthorizer` (Settler), `withdrawDelaySeconds`, `minDepositAtomic`, `requestLimitAtomic`, `maxChannelsPerPayer`, `maxTimeoutSeconds`, `contract`, `depositCollector`, `facilitator`, `paths`, `ready`.
- `GET /v1/models`: without credentials, an OpenAI model list (`{object:'list', data:[{id, object, created, owned_by}]}`); with a console session, the catalog with prices, capabilities and service fees.

## Model calls

`POST /v1/chat/completions`, `POST /v1/messages` and `POST /v1/responses` accept their respective OpenAI Chat Completions, Anthropic Messages and OpenAI Responses formats. Set `stream: true` for SSE.

**With an API key:** use `Authorization: Bearer r3_live_…` or `x-api-key: r3_live_…`. Responses have `gateway.payment: 'api_key'`, `billed_usdc_nano`, `model_cost_usdc_nano` and `service_fee_usdc_nano`, with no `x402` field. Errors:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `API_KEY_INVALID` | 401 | Invalid or revoked key |
| `POOL_NOT_SET_UP` | 402 | Automatic payment is not enabled |
| `INSUFFICIENT_BALANCE` | 402 | The hold still does not fit after waiting for a refill; details include `requiredAtomic`, `availableAtomic`, `refillTargetAtomic`, `dailyRemainingAtomic` |
| `POOL_WITHDRAWING` | 402 | Pool withdrawal is pending |
| `API_KEY_DAILY_LIMIT`, `API_KEY_TOTAL_LIMIT` | 402 | Key budget exhausted |
| `X402_REQUEST_LIMIT` | 402 | Hold exceeds `API_KEY_REQUEST_LIMIT_USDC` (default 50) |
| `API_KEY_CONCURRENCY_LIMIT` | 429 | Exceeds `API_KEY_MAX_CONCURRENCY` (default 128) |

**Without a key (native x402):**

1. No `PAYMENT-SIGNATURE`: returns `402`; `PAYMENT-REQUIRED` is base64-encoded x402 v2 `PaymentRequired`. The body uses the endpoint's error format with `PAYMENT_REQUIRED`; `details.x402.accepts[0].amount` is the ceiling in micro-USDC.
2. Valid voucher: normal response with `gateway` fields `request_id`, `price_version_id`, `payment: 'x402'`, `billed_usdc_nano`, `model_cost_usdc_nano`, `service_fee_usdc_nano`, `service_fee_bps` and `x402: {charged_atomic, cumulative_atomic, ceiling_atomic, transaction, payment_response}`. Non-streaming responses also carry `PAYMENT-RESPONSE`.
3. SSE: `gateway` appears in the final data chunk: Chat Completions' `choices:[]` usage chunk, Messages' `message_delta`, or Responses' `response.completed`. Failures end with the protocol's `error` event.

x402 errors (402): `PAYMENT_REQUIRED`, `X402_PAYMENT_INVALID` (invalid/expired voucher, busy channel or insufficient balance), `X402_REQUEST_LIMIT`, `X402_CHANNEL_LIMIT`, `X402_SETTLEMENT_FAILED`. Allowlist rejection returns `403 ADDRESS_NOT_ALLOWED`. Other errors: `MODEL_NOT_FOUND` (404); `VALIDATION_ERROR`, `MODEL_PROTOCOL_UNSUPPORTED`, `MODEL_IMAGE_INPUT_UNSUPPORTED`, `SERVER_TOOLS_NOT_SUPPORTED`, `RESPONSES_STORE_NOT_SUPPORTED`, `RESPONSES_STATE_NOT_SUPPORTED` (422); `X402_UNAVAILABLE` (facilitator terms not loaded) and `REAL_MODEL_CALLS_DISABLED` (503).

Upstream rejection before charging, such as `PROVIDER_REQUEST_REJECTED` (400), is free. Unknown-usage failures such as `PROVIDER_TIMEOUT` (504), `PROVIDER_STREAM_INCOMPLETE` or `PROVIDER_USAGE_UNAVAILABLE` (502) are charged at the ceiling.

### Content and images

Chat Completions `content` accepts a string or an array of `[{type:'text'}, {type:'image_url'}]`. Holds use each model's per-image ceiling. Audio, web search and fan-out through `n` are unsupported. Messages and Responses reject server-side tools such as web search and stored state (`store`, `previous_response_id`).

## Channel operations

- `POST /v1/x402/deposit`: deposit without inference. Without a payment header it returns a 402 quote for 1 micro-USDC. A `deposit` payload (ERC-3009 authorization plus voucher) is relayed by the facilitator and returns `{channel, request_id, transaction}`.
- `GET|POST /v1/x402/refund`: cooperative refund. Without a payment header it quotes amount 0. A `refund` payload (zero-cost voucher, optional `amount`) claims outstanding usage before refunding, returning `PAYMENT-RESPONSE` and `{transaction}`.

## API keys and prepaid pool (session authentication)

- `GET /v1/keys`: `{terms:{requestLimitAtomic, maxConcurrency, holdOutputTokens}, pool, keys:[{id, name, prefix, state, createdAt, lastUsedAt, revokedAt, dailyLimitAtomic, totalLimitAtomic, running, spentTodayAtomic, spentAtomic, maxConcurrency, legacyChannel}]}`. `pool` matches `GET /v1/pool`'s `account`; only legacy keys have `legacyChannel`.
- `POST /v1/keys` `{name, dailyLimitUsdc?, totalLimitUsdc?}` → `201 {token, key}`. The token is returned once.
- `PATCH /v1/keys/:id` `{dailyLimitUsdc, totalLimitUsdc}` → `{key}`; `null` or 0 means unlimited.
- `POST /v1/keys/:id/refund`: refund a legacy key's x402 balance to its wallet; `{refunded:false}` if no channel exists.
- `DELETE /v1/keys/:id`: revoke the key, also refunding a legacy channel; returns `{revoked, refund}`.
- `GET /v1/keys/:id/requests`: latest 100 calls, including `charge_nano`, `ceiling_atomic`, `charged_from`, `settled`.
- `GET /v1/pool`: `{terms:{poolAddress, usdcAddress, chainId, treasury, withdrawalDelaySeconds, maxRefillTargetAtomic, defaultRefillTargetAtomic, defaultDailyLimitAtomic, activationFeeAtomic, permitMinBalanceAtomic, poolDomain, usdcDomain}, account:{state: none|pending|active|paused|withdrawing, poolBalanceAtomic, availableAtomic, unsettledAtomic, heldAtomic, running, refillTargetAtomic, dailyLimitAtomic, dailyRemainingAtomic, walletBalanceAtomic, allowanceAtomic, withdrawalAtomic, withdrawableAt, snapshotAt, ops}, nonces:{pool, usdc}}`.
- `POST /v1/pool/setup` `{permit:{value, deadline, signature}, configure:{refillTarget, dailyLimit, nonce, deadline, signature}}` → `202 {ops}`. Supply EIP-712 signatures for USDC `Permit` (spender = pool, domain from `terms.usdcDomain`) and pool `Configure` (domain from `terms.poolDomain`). The gateway verifies EOA/ERC-1271 signatures before queuing. Errors: `POOL_PERMIT_BALANCE_LOW` (422, wallet USDC below `permitMinBalanceAtomic`), `POOL_SIGNATURE_INVALID` (422), `POOL_SIGNATURE_EXPIRED` (422), `POOL_OP_PENDING` (409, operation of the same kind still pending).
- `POST /v1/pool/permit` `{value, deadline, signature}`: change allowance; 0 stops refills.
- `POST /v1/pool/configure` `{refillTarget, dailyLimit, nonce, deadline, signature}`: change refill target and daily limit.
- `POST /v1/pool/withdrawal` `{amount, nonce, deadline, signature}` (`RequestWithdrawal`): request withdrawal; the collector executes `withdraw` after the delay. `DELETE /v1/pool/withdrawal` `{nonce, deadline, signature}` (`CancelWithdrawal`): cancel it.

## Key dashboard (API key authentication)

Read-only, using `Authorization: Bearer r3_live_…` or `x-api-key`. Missing key: `API_KEY_REQUIRED` (401); invalid/revoked key: `API_KEY_INVALID` (401). Limit: 120 requests/minute per key. These endpoints expose neither wallet address nor wallet balance and cannot change limits, revoke keys or withdraw funds. The dsh dashboard plugin uses this API.

- `GET /v1/key`: `{key:{id, name, prefix, createdAt, lastUsedAt, dailyLimitAtomic, totalLimitAtomic, running, spentTodayAtomic, spentAtomic, maxConcurrency, requestLimitAtomic, holdOutputTokens}, pool}`. `pool` omits `walletBalanceAtomic` and `ops` from the session endpoint and adds `refillable` (wallet balance/allowance can still fund a refill). No pool: `{state:'none'}`.
- `GET /v1/key/usage?days=30` (1–90): `{since, days, daily:[{day, requests, failed, charged_atomic, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, avg_latency_ms}], models:[{model, …same metrics}]}`. UTC days, completed calls only; models sorted by spend descending.
- Compatibility aliases use the same authentication and USD amounts: `GET /v1/dashboard/billing/subscription` (`hard_limit_usd` = lifetime spend + available amount) and `GET /v1/dashboard/billing/usage?start_date&end_date` (`total_usage` in cents, exclusive `end_date`) for NextChat, Cherry Studio, ChatBox and one-api clients; `GET /v1/auth/key` (`{data:{label, usage, limit, limit_remaining, is_free_tier}}`) and `GET /v1/credits` (`{data:{total_credits, total_usage}}`) in OpenRouter format; `GET /user/balance` / `GET /v1/user/balance` in DeepSeek format, with `total_balance` equal to the available amount. Availability is the smaller of pool availability and the key's remaining budget.
- `GET /v1/key/requests?limit=50&before=<created_at>` (limit 1–200): `{items, next}`. Items include the session request fields plus `model`, `latency_ms`, `usage`; `next` is the next page's `before` value, or `null`.

## Console (session authentication)

Wallet sign-in: `GET /v1/auth/config` (site, network, chains, x402 terms), `POST /v1/auth/challenge`, `POST /v1/auth/verify` (SIWE message/signature → `mcg_session` HttpOnly cookie), `POST /v1/auth/logout`, `GET /v1/me`.

- `GET /v1/x402/channels` (excluding API key channels): `{terms, payer, walletKind: 'eoa'|'contract', channels:[{channel_id, config, balance_atomic, charged_atomic, claimed_atomic, withdraw_requested_at, last_request_at, requests}]}`.
- `GET /v1/x402/channels/:channelId/requests`: latest 100 calls for the channel, including status, model, fee, ceiling, `charged_from` and usage.

## Clients

With a key, configure any compatible OpenAI/Anthropic/Responses client with the gateway base URL and token. Without a key, see [x402 clients](X402.md#clients): the local proxy handles the 402 flow.
