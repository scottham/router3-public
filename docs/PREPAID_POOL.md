# Prepaid pool: API key billing

[中文](PREPAID_POOL.zh.md)

Since 2026-10-26, API keys bill the wallet's prepaid pool. The gateway refills a small pool from the wallet as usage accrues and charges each call by actual tokens. Wallet-signed [x402 channels](X402.md) are a separate payment path.

The contract is `WalletPrepaidPool`, deployed on Monad mainnet at `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3` on 2026-10-18. Source: `contracts/src/WalletPrepaidPool.sol`. `npm run contracts:verify` compares on-chain runtime code with the artifact and prints `POOL_CODE_HASH`. The contract is not upgradeable and has no admin withdrawal. Admins can pause settlement and grant/revoke settler/admin roles. Additional settlers can bypass gateway database/signing policy but remain subject to contract daily limits, refill rules and the fixed Treasury. Metering requires trust in the operator and admin.

## User flow

1. Sign in with a wallet (SIWE, Monad chain 143) holding Monad USDC; no MON is needed for relayed operations.
2. Enable automatic payment on the API keys page with two gasless signatures:
   - USDC `permit`: total allowance the pool may pull from the wallet (UI default 100 USDC).
   - Pool `Configure`: refill target (UI default 5 USDC) and daily debit limit (20 USDC).
3. The gateway relays both transactions. Refills are triggered when calls need pool funds; setup/submission takes a few seconds.
4. Create API keys. All keys owned by the wallet share the pool; each can have daily/total limits.
5. To exit, sign a withdrawal request. New calls stop, owed usage is settled first, and the gateway returns the remaining balance after the delay (30 minutes on mainnet). Refills turn off.

## Billing

| Stage | Rule |
| --- | --- |
| Hold | Estimate input as UTF-8 bytes ÷ 3, images at per-image ceilings and output up to `API_KEY_HOLD_OUTPUT_TOKENS` (8192). Per-request ceiling: `API_KEY_REQUEST_LIMIT_USDC` (50) |
| Availability | `min(pool balance, daily remaining) − unsettled usage − pending withdrawal − running holds`. If a refill can cover the hold, wait up to `POOL_REFILL_WAIT_MS` (15 seconds); otherwise return `402 INSUFFICIENT_BALANCE` |
| Completion | Charge actual usage, including above the estimate, but only within the wallet's payable amount and key daily/total budget after reserving other running holds. Record the uncollected part as `unbilled_overrun`; the operator bears it |
| Unknown usage | Interrupted stream, timeout or missing usage: charge the hold within the same limits. DNS/connection/TLS failures are free. Non-streaming calls continue after client disconnect and bill actual usage |
| Concurrency | At most `API_KEY_MAX_CONCURRENCY` (128) running requests per key |
| Settlement | Combine debits/refills in `settle`. Refill below half the target availability or for waiting calls; debit when owed usage reaches `POOL_SETTLE_MIN_USDC` (1), waits over 7 days, or withdrawal is pending. `usageRoot` hashes the included request IDs |
| Sweep | At `POOL_SWEEP_MIN_USDC` (1) of Treasury accrual, `sweep` sends USDC to the fixed Treasury |

Holds, releases and charges use the `private.pool_accounts` row lock in one transaction. Multiple API replicas share the same account lock and cannot reserve beyond availability.

Batch confirmation rechecks state under the account lock and applies once. Balance and unsettled usage update only with a snapshot at or after the receipt block. Failed snapshot reads retain the batch and receivable for retry; routine refreshes do not overwrite an account with an open batch.

At the submission retry limit, `fail_unsigned_pool_batch` takes the same batch lock as the signer. A journaled transaction recovers its original hash for confirmation; only an unsigned batch releases its attached charges. Database failure keeps the batch pending. HTTP timeout is not evidence that no transaction was sent.

To upgrade this recovery logic, apply `202610310001_pool_batch_recovery.sql` and role grants, update the signer, then collector/API/reconciler. The old signer lacks the batch lock and must not run with the new recovery path. No contract redeployment is needed. Key daily budgets use the request's UTC creation day, including completion after midnight and abandoned-request recovery.

## Authorization limits

- The contract enforces the wallet's daily debit limit. A reduction takes effect after the withdrawal delay.
- Refills go only from the wallet into its own pool, within permit allowance and refill target.
- Pool funds can only pay the fixed Treasury for usage or return to the owner.
- Allowance 0 stops refills. If the gateway is offline, anyone can execute a mature `withdraw(owner)`; funds still go only to the owner.

A leaked key can spend within wallet/key limits but cannot redirect funds. Revocation immediately prevents new calls.

Removing a wallet from `AUTH_ALLOWED_ADDRESSES` rejects its existing keys and read-only dashboards with `403 ADDRESS_NOT_ALLOWED`. Lower limits do not undo past charges; closing requests rereads current key limits.

## Transactions and gas

The gateway pays gas for relayed operations; direct user transactions require the user's own MON.

- Only the signer container holds the Settler private key. The collector identifies a batch/operation; the signer reads its row and reconstructs calldata.
- Allowed calls: batch `settle`, signed `permit` / `configureBySig` / `requestWithdrawalBySig` / `cancelWithdrawalBySig`, mature `withdraw(owner)` and `sweep()`. Before signing it checks `POOL_CODE_HASH`, Treasury, USDC and the Settler role.
- Nonce and signed bytes go to `settlement_signing.transactions` before broadcast. Restarts resend the same transaction. Default gas budgets: 5 MON/day, including 1 MON/day for permits, and 0.2 MON/transaction.
- A debit/refill `settle` measured around 250,000 gas, approximately 0.025 MON at the measured gas price. Small bills accumulate to 1 USDC or settle with the next refill.

Permit relay requires `POOL_PERMIT_MIN_BALANCE_USDC` (1) of wallet USDC. The first successful permit records a one-time `POOL_ACTIVATION_FEE_USDC` (0.05) fee, collected with the first debit. Refills are triggered by actual demand.

## OpenRouter wallet keys

The management key creates a call key per wallet. Its limit follows the pool daily limit and resets daily (`limit_reset: daily`); wallets without a pool use `payerKeyLimitUsd` from `providers.json`. This provides an independent OpenRouter spending bound. Once a `configure` transaction confirms, the collector updates the remote limit; catalog checks limits and usage hourly.

## Legacy keys

Keys created before 2026-10-26 had their own x402 channel. They now charge the pool too. Refund the old channel balance from the key list's legacy-balance action; no wallet signature is needed.

## Tests

- `test/api-keys.test.js`: setup, shared pools, concurrency, waiting for refills, debits/sweeps, daily truncation, key limits, withdrawals and signatures.
- `npm run test:pool-db`: real PostgreSQL, 60 concurrent holds, balance-bounded charges, collector planning, signer calldata, role permissions and lost-request charging.
- `npm run test:pool-recovery-e2e`: disposable PostgreSQL/local Anvil, committed contract, real signer HTTP and full API. Covers lost responses, signer/failure races, multiple collectors, snapshot failure, hard key limits, allowlists and concurrent JSON/SSE calls. Mock inference; no provider/mainnet funds. Needs Docker, Foundry and local `postgres:17-bookworm`; resources are removed afterwards.
- `npm run test:pool-fork`: deployed pool on a Monad mainnet fork: permit, configuration, refill, debit, sweep and withdrawal.
