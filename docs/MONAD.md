# Monad deployment notes

[中文](MONAD.zh.md)

Since 2026-10-18, wallet sign-in and billing use Monad mainnet (chain 143). Base is no longer used. Chain ID, USDC and public RPC constants live in `src/chain.js` and `web/src/chain.js`.

| Item | Monad mainnet |
| --- | --- |
| Chain ID | 143 |
| USDC | Circle native `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (FiatToken v2.2, EIP-712 domain `USDC` / `2`) |
| Native token | MON, for gas |
| Public RPC | `https://rpc.monad.xyz` (rate-limited; use a dedicated production RPC) |
| Explorer | https://monadscan.com |

## Migration changes

- **Configuration:** `BASE_ACCOUNT_*` / `BASE_MAINNET_RPC_URL` became `MONAD_RPC_URL`, `APP_NAME`, `APP_LOGO_URL`. Signer gas budgets use MON (`SETTLEMENT_SIGNER_MAX_GWEI=1000`, `_MAX_GAS_MON=0.2`, `_DAILY_GAS_MON=5`). Base L1 data-fee reserves were removed.
- **Database:** `202610180004_monad_mainnet.sql` sets chain constraints to 143. Historical Base rows remain under `NOT VALID` constraints; Base wallet bindings were revoked and sessions invalidated. Users sign in again for a Monad wallet record. Migration refuses outstanding Base holds/receivables. The policy was disabled until bootstrap configured the Monad contract.
- **Contracts:** the initial WalletChargeRouter deployment was replaced the same day by [WalletPrepaidPool](PREPAID_POOL.md). See [deployment instructions](../contracts/README.md).
- **Frontend:** wagmi/RainbowKit target `monad`; unknown-chain wallets receive `wallet_addEthereumChain`. The console uses the Monad accent color.

## Chain behavior and implementation

These observations describe the migration and October 2026 acceptance checks; gas prices, RPC retention and network load can change.

| Behavior | Handling |
| --- | --- |
| Gas is charged against the transaction gas limit; measured receipts used `gasUsed = gasLimit` | Signer/deployment estimates use a 10% buffer; network cost is recorded from limit × price |
| Delegated EIP-7702 accounts have reserve-balance rules when transferring value | The Settler is a generated ordinary EOA and pool transactions send zero value |
| `latest` may be an unfinalized proposal | Pool/permit receipts are compared to `finalized`; configured confirmations are additional blocks after finalization (default 0) |
| Full nodes keep limited historical state; the public RPC retained roughly a million blocks in the migration checks | Fork tests pin near the upstream finalized head and check USDC's name; override with `MONAD_FORK_RPC_URL` |
| No global mempool; transaction lookup may return null before inclusion | Persist signed bytes before broadcast, then rebroadcast the same transaction/nonce |
| A 100 gwei base-fee floor was observed | Default per-transaction price ceiling is 1000 gwei |

## Parallel execution

Monad executes transactions optimistically in parallel and reruns conflicts in order, preserving serial semantics. This does not remove the gateway's sequencing boundaries:

1. **Pool settlement:** one Settler submits sequential nonces. Debits update pool balances/Treasury accrual; refills update individual wallet USDC balances/allowances. Different wallets can avoid some conflicts, but Treasury accrual shares a slot.
2. **Relayed permits and pool operations:** wallet state is separate, but the transaction sender is still one Settler.

With usage batched around the 1 USDC threshold, chain throughput is not the primary bottleneck.

October acceptance observations included 0.3–0.4 second blocks, finalized state close to head, and low block utilization. The old direct-debit transaction used a 249,169 gas limit, approximately 0.025 MON at 100 gwei. At the historical MON price of $0.02–0.035, that was about $0.0005–0.0009 versus roughly $0.002 measured on Base. These are historical measurements, not current cost estimates.

The prepaid pool reduces transaction frequency more directly: it avoids one transaction per bill. Settlement happens with refills, withdrawals or accumulated usage; USDC transfers occur on refill/sweep. Fast finality also permits a 30-minute pool withdrawal delay and confirmation within seconds.

Potential future scaling options are batching multiple payers into one transaction or sharding wallets across Settler addresses. Shared Treasury state still creates conflicts; neither is required by the current implementation.

## Operations

The reference pool `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3` was deployed on 2026-10-18 with a measured deployment cost of 0.281 MON. The legacy direct-debit contract is retired. Current configuration and acceptance procedures are in [local mainnet](LOCAL_MAINNET.md) and [self-hosting](SELF_HOSTING.md).

Use a dedicated `MONAD_RPC_URL` in production and replenish the Settler when MON falls below the operator's gas reserve (the reference threshold is about 0.5 MON).
