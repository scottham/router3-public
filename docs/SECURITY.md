# Security design

[中文](SECURITY.zh.md)

## Threats

1. Overcharging: claims above signed amounts or insufficient refunds.
2. Undercollection: a compromised API obtains unauthorized claim/refund signatures or omits billing.
3. SIWE challenge replay, wrong domain/chain, forged smart-account signatures.
4. Voucher replay, concurrent channel races and expired vouchers.
5. Provider timeouts causing free usage or duplicate charges.
6. Settler key compromise or signer/database privilege escalation.
7. Leaked prompts, responses, provider keys, cookies or connection strings.
8. Injected `api_base`, credentials, mocks, retries or fallbacks bypassing catalog/billing.
9. Fan-out through `n`/`best_of` producing multiple completions for one ceiling.
10. Raw database errors exposing internal schema.
11. Upstream errors exposing operator account information.
12. Leaked API keys, or database contents together with encryption keys.

## Implemented controls

- **Contracts:** x402 claims cannot exceed signed cumulative amounts. The pool enforces daily/per-debit limits, refill targets and fixed Treasury. Refunds return only to the owner; users can request and execute mature withdrawals on chain. Admins can grant/revoke settler/admin roles. A new settler bypasses gateway signing policy, not contract limits; usage metering still trusts the operator/admin.
- **Signer:** the sole holder of the Settler key. x402 signs only `ClaimBatch`/`Refund` EIP-712 messages for the fixed contract and chain 143, bounded by mirrored actual usage and the saved voucher. Pool calls are limited to `settle`, signed `permit` / `configureBySig` / `requestWithdrawalBySig` / `cancelWithdrawalBySig`, mature `withdraw(owner)` and `sweep()`. Calldata is reconstructed from database rows; code hash, Treasury, USDC and Settler role are checked. Nonce/signed bytes are journaled before broadcast. Daily gas/USDC budgets apply, in addition to contract limits.
- **Vouchers:** local verification with fresh state, facilitator chain checks otherwise. Mismatched cumulative amounts, replay, expiry and busy channels are rejected. One in-flight request per channel.
- **Unknown usage:** interrupted streams, timeouts and disconnects use the signed/held ceiling; only proven rejection before charging is free.
- **Authorization:** `AUTH_ALLOWED_ADDRESSES` is checked before payment state changes, including existing keys and dashboards. Wallet channel counts, per-request ceilings and key/channel rate limits bound requests.
- **Wallet keys:** the platform never receives a user's wallet key or seed phrase. A local proxy keeps its key on the user's machine.
- **API keys:** only token HMACs are stored. New keys do not create voucher authorizers; they bill a shared wallet pool. Opening/closing calls check current daily/total limits under account lock and reserve other in-flight holds. Uncollectible overruns are recorded and borne by the operator. Revocation blocks new calls; pool withdrawal and legacy-channel refunds are separate operations.
- **Recovery:** signer and failed-batch recovery share a batch lock. Signed transactions are journaled before broadcast; recovery restores the original hash when one exists. Confirmation updates batch state, balance and receivables together under account lock. Missing snapshots retry without releasing credit. Lost-request recovery also obeys key budgets.
- **Sessions:** short-lived, single-use challenges; SIWE address/domain/URI/chain/time checks. viem validates EOA, ERC-1271 and counterfactual ERC-6492 signatures on Monad. Sessions store HMAC digests and use HttpOnly, SameSite=Strict cookies. Sign-in manages the wallet's keys, pool and channels.
- **Database roles:** API, collector, reconciler, signer, catalog and metrics have separate least-privilege roles. Public tables use RLS.
- **Providers:** API, collector, catalog and bootstrap read the provider env file. Management keys never make completions; encrypted per-wallet call keys have remote OpenRouter limits. Allowlisted parameters prevent routing/credential overrides; `n`/`best_of` are dropped.
- **Errors:** only application-defined database codes are exposed; other database errors become `DATABASE_ERROR`. `sslmode=require` validates certificates by default. Upstream 401/403/404/5xx messages are redacted; actionable 400/413/422 messages may be forwarded.
- **Logs:** Authorization/Cookie redaction; no private keys, prompts or provider secrets in logs.

## Operational work remaining

- Cookie-session CSRF and browser penetration testing.
- KMS/HSM storage, rotation and disaster-recovery drills for the Settler key.
- A fallback facilitator.
- Provider invoice reconciliation, disputes, refunds and compliance review.

## Dependency audit

See [dependency security](DEPENDENCY_SECURITY.md) for fixes, unresolved wallet-SDK advisories and commands. Affected-package counts are not independent exploit counts; unproven reachability is not treated as a resolved issue.
