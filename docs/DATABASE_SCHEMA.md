# Database schema

[中文](DATABASE_SCHEMA.zh.md)

PostgreSQL is the ledger of record. Apply `supabase/migrations/` in filename order. Historical migrations removed the old pool/project path; later migrations restored the shared wallet pool and key limits. A new installation must apply the full sequence.

## Public schema

- `app_users`, `user_profiles`, `user_wallets`: accounts and wallet bindings created by wallet sign-in (`private.resolve_or_create_base_account`). RLS is enabled, with backend-role SELECT policies.
- `model_catalog`: public model name, provider, provider model ID, modalities, capabilities and enabled state.

## Private schema

### Identity and sessions

- `base_auth_challenges`, `base_auth_sessions`, `base_account_bindings`: SIWE challenges, session HMACs and address/account bindings.
- `cleanup_expired_base_auth_data()`: reconciler cleanup every minute.

### Catalog and pricing

- `model_price_versions`: immutable customer/provider prices; `provider_quote` and `bailian_quote` retain FX, tiers, time-of-use and routing data.
- `call_fee_policies`: immutable service-fee versions.
- `bailian_catalog_state`, `catalog_model_access`, `catalog_sync_runs`, `provider_balance_checks`: synchronization state, access probes, sync history and provider balance reconciliation.

### x402 channels

- `x402_channels`: SDK ChannelStorage mirror. Full `state` JSON plus payer, payer_authorizer, cumulative charge, latest voucher ceiling, balance, claimed amount, withdrawal timestamp and last request timestamp.
- `x402_requests`: protocol, model, price/fee versions, `max_charge_usdc_nano` (hold), `ceiling_atomic`, `actual_charge_usdc_nano`, `charged_atomic`, `cumulative_atomic`, `charged_from` (`usage|ceiling`), model/service fees, provider cost, usage, settlement transaction, failure code and status (`running/completed/failed/settlement_failed`).
- `x402_settlements`: deposit, claim, settlement and refund transaction log.
- `recover_lost_x402_requests(before)`: marks stale running requests `REQUEST_LOST`.

### API and provider keys

- `api_keys`: payer wallet, name, prefix, token HMAC, state, last use and daily/total limits. New keys bill the wallet pool. Legacy channel, salt and encrypted authorizer fields remain for old-balance refunds, not new request billing.
- `provider_payer_keys`: one OpenRouter call key per wallet, including remote name/hash, state, encrypted secret, limit and usage.

### Prepaid pool

- `pool_accounts`: one row per wallet. Chain snapshots contain balance, pending withdrawal, refill target, daily limits/remaining budget, wallet balance and allowance. Gateway counters include `unsettled_atomic`, `held_atomic` and running requests. Holds, releases and charges share this row lock.
- `pool_requests`: pool-funded requests and activation fees; `batch_id` points to the debit settlement.
- `pool_batches`: on-chain `settle` calls (debit and/or refill), unique `batch_key` / `claim_key`, and `usage_root` hashing included request IDs. At most one open batch per wallet.
- `pool_ops`: signed permit/configuration/withdrawal operations and gateway operations (mature withdrawal, sweep).
- `settlement_signing.transactions`: signer-only journal of nonce, signed transaction and gas limits.
- Key holds/spend are aggregated by `pool_requests.api_key_id`; daily/total limits are checked under the account lock. Daily usage belongs to the request's UTC creation date.
- `recover_lost_pool_requests(before)`: closes abandoned requests at the hold, bounded by wallet/key limits; unbilled overruns remain recorded.
- `fail_unsigned_pool_batch(payer,id,error)`: narrow recovery function added by `202610310001_pool_batch_recovery.sql`. It shares the signer's batch advisory lock: journaled transactions recover to submitted with the original hash; only unsigned batches can fail and detach charges. The collector cannot read raw signed transactions.

### Metrics

- `metrics_snapshot()`, `metrics_x402()`, `metrics_provider_balance()`: aggregate functions exposed only to `gateway_metrics`.

## Roles

| Role | Permissions |
| --- | --- |
| `gateway_api` | Auth sessions, channel mirror, request ledger and wallet keys; read/write pool accounts/requests/ops, read-only pool batches; read-only catalog/prices |
| `gateway_settler` | Collector role: channel mirror and settlement log; pool accounts/requests/ops/batches; read-only API keys, provider-key updates and batch-recovery function |
| `gateway_reconciler` | Read-only public/private tables; expired-auth cleanup and x402/pool lost-request recovery functions |
| `gateway_signer` | Read-only channels and pool accounts/batches/ops; exclusive runtime access to the transaction journal |
| `gateway_catalog` | Catalog/prices/sync state; read/update provider wallet keys; read-only pool accounts; provider-balance function |
| `gateway_metrics` | Three aggregate functions |

Grants live in `supabase/manual/create_backend_roles.sql.template` (API/collector/reconciler) and `ops/bootstrap-production-db.mjs` (signer/catalog/metrics).

## Currency units

- `*_usdc_nano`: 10⁻⁹ USDC; `*_atomic`: 10⁻⁶ USDC (on-chain units); `*_usd_nano`: 10⁻⁹ USD.
- Token prices are per million tokens.
