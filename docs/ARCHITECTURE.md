# Architecture

[中文](ARCHITECTURE.zh.md)

A wallet address is the identity. API keys use a shared `WalletPrepaidPool`: all keys owned by one wallet share its balance, refills and billing ([prepaid pool](PREPAID_POOL.md)). Advanced clients can sign x402 `batch-settlement` vouchers themselves. The two payment paths have separate balances and ledgers.

## Requests and billing

```text
Client → OpenAI Chat / Anthropic Messages / OpenAI Responses
       → API key authentication or x402 voucher verification
       → Catalog, pricing and option validation → PostgreSQL hold
       → DeepSeek or OpenRouter → Normalized usage → Charge → JSON / SSE
```

Only an HMAC of each API key token is stored. New keys create no channel and hold no wallet private key or voucher-signing key. Holds, releases and charges run under the wallet account row lock. Opening and closing a request checks the key's daily/total limits and reserves the holds of its other running requests. If actual usage exceeds the estimate, the charge is bounded by the pool's payable amount and the key's remaining budget. The operator bears and records any unbilled difference; an already dispatched response is not interrupted. The default concurrency is 128 requests per key.

An x402 request first receives `402` and `PAYMENT-REQUIRED`. The client signs a cumulative voucher and retries with `PAYMENT-SIGNATURE`. After verification, the gateway registers a pending settlement and charges actual usage up to the signed ceiling. Responses carry `PAYMENT-RESPONSE`; SSE includes `gateway.x402.payment_response` in its final chunk. A channel handles one request at a time; concurrency uses multiple channels.

A provider rejection before charging cancels the hold for free. Interrupted streams, timeouts and other unknown-usage cases are charged at the ceiling; API key charges also obey wallet and key limits. There are no automatic retries, cross-model fallbacks or response caches.

## Funds and settlement

- **Prepaid pool:** the user signs a USDC permit and pool configuration; the signer relays them. The collector plans `settle` calls that debit usage into the contract's Treasury accrual and refill the user's pool from their wallet when needed. `sweep` transfers accrued USDC to the fixed Treasury. The signer holds MON for gas. A signed withdrawal request stops new calls; owed usage is settled first. After the delay, the gateway or anyone else can execute `withdraw(owner)`, which pays only the owner.
- **x402:** the user signs an ERC-3009 authorization and the facilitator relays the deposit. The collector batches claims and settles to the Treasury. Cooperative refunds settle owed usage before returning funds. Users can also initiate a timed withdrawal on chain. The facilitator submits transactions and pays gas for this path.
- Usage metering requires trust in the operator. The pool contract limits debits and destinations; x402 limits claims to the user's signed cumulative amount. Pool admins can pause settlement and grant/revoke settler and admin roles. An additional settler can bypass gateway signing policy, but remains subject to contract limits. See [contract documentation](../contracts/README.md).

## Components

| Component | Responsibility |
| --- | --- |
| Web | React/Vite console, RainbowKit connection and SIWE management of the user's pool, keys and channels |
| API | Three model protocols, authentication, quotes, holds, charges and queued user operations |
| Provider adapters | Direct upstream calls; per-wallet OpenRouter keys, pinned hosts and reported-cost billing |
| Collector | `pool-worker.js` handles pool batches, refills and withdrawals; `x402-settlement-worker.js` claims/settles through the facilitator |
| Signer | Sole holder of the Settler private key; validates database state and policy before signing x402 ClaimBatch/Refund messages or rebuilding and broadcasting pool transactions |
| Reconciler | Recovers abandoned requests and expired auth data; pool requests are charged their hold, expired x402 reservations are not charged |
| Catalog | Synchronizes models, prices, FX, provider balances and wallet call-key limits |
| PostgreSQL | Identity, ledgers, balance mirrors, price versions, batches, operations and signer journal |
| Redis | Shared rate limits across API replicas; no financial authorization decisions |
| Local x402 proxy | Holds the wallet key on the client's machine and exposes a regular OpenAI interface backed by a channel pool |

## Consistency and recovery

- Wallet account row locks serialize short financial transactions. Each wallet has at most one open pool batch. Signed transactions are journaled before broadcast; retries send the same bytes.
- The signer and failed-batch recovery share an advisory lock. HTTP timeout does not prove a transaction was never sent: a journal entry recovers the original transaction, and only an unsigned batch may release its charges.
- Confirmation rechecks batch state under the account lock and applies each debit once. Receivables and a snapshot at or after the receipt block update together. A failed snapshot leaves both the batch and receivables pending.
- x402 ChannelStorage uses PostgreSQL row locks. Fresh mirrors allow local verification during facilitator outages; deposits, claims and refunds wait. Stale mirrors and smart-wallet paths requiring remote verification remain blocked.
- The reconciler closes abandoned pool requests at their hold, subject to key limits. Daily budgets use each request's creation date in UTC. Rolling deployment starts a ready replacement API before draining the old instance.

## Permissions and deployment

Processes use separate database roles with minimal permissions. Only the signer accesses `settlement_signing.transactions`; the collector recovers related batches through a narrow function ([database schema](DATABASE_SCHEMA.md)). API, collector, catalog and bootstrap read the provider env file. The collector needs the OpenRouter management key to synchronize wallet limits; that key is not used for completions.

`AUTH_ALLOWED_ADDRESSES` applies to wallet sign-in, x402 payments, existing API key calls and key dashboards. Backups, migrations and signer update order are covered in [self-hosting](SELF_HOSTING.md#updating).
