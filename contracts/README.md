# WalletPrepaidPool

The contract API keys bill from (docs/PREPAID_POOL.md). One deployment per gateway. Not upgradeable; no admin withdrawal. Money leaves it only to the Treasury (settled usage) or back to the wallet that put it there.

| Network | Address | Deployed |
| --- | --- | --- |
| Monad mainnet (143) | `0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3` | 2026-10-18, by router3.ai |

Roles: `DEFAULT_ADMIN_ROLE` can pause and resume settlements and, through OpenZeppelin AccessControl, grant or revoke `SETTLER_ROLE` and administrator roles. `SETTLER_ROLE` (the gateway's Settler key) calls `settle` with the batches the database reconstructs. An admin can appoint another settler that bypasses the gateway's database and signing policy; the contract still enforces wallet daily limits, refill rules and the fixed Treasury. Usage metering therefore requires trust in both the operator and the contract admin. Everything else is the wallet's: `permit` on USDC, `configure`, `requestWithdrawal`, `cancelWithdrawal`, each also as a `…BySig` relay the gateway submits on the wallet's signature.

## Build and test

```sh
npm ci                      # OpenZeppelin 5.6.1 and forge-std come from the root package
cd contracts && forge build && forge test
```

`foundry.toml` pins solc 0.8.24, optimizer on, 200 runs. Keep those: the verification below compares the compiled runtime code with the chain.

## Verify a deployment

```sh
npm run contracts:verify -- --pool 0x… --rpc https://rpc.monad.xyz
```

It fetches the runtime code, masks the immutables (the constructor arguments below) and compares the rest with the committed artifact (`--build` recompiles it first, with Foundry). It prints the code hash, which is the value for `POOL_CODE_HASH`: the signer refuses to sign for a pool whose code hash differs. Exit 0 is a match.

## Deploy your own

`npm run pool:deploy` does it without Foundry: it reads `TREASURY_ADDRESS` and `DEPLOYER_PRIVATE_KEY` from `.env`, generates the Settler key when missing, sends the committed artifact (`contracts/artifacts/WalletPrepaidPool.json`, refreshed by `npm run contracts:build`), checks the deployed code against it, and writes `POOL_ADDRESS` and `POOL_CODE_HASH` back into `.env`. About 0.5 MON of gas. The constants below are overridable through `POOL_DEBIT_LIMIT_USDC`, `POOL_REFILL_CEILING_USDC`, `POOL_DEFAULT_REFILL_USDC`, `POOL_DEFAULT_DAILY_USDC` and `POOL_WITHDRAWAL_DELAY_SECONDS`; the admin through `POOL_ADMIN_ADDRESS`.

The same by hand, with Foundry. Constructor, in order:

| Argument | Mainnet value | Meaning |
| --- | --- | --- |
| `token` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | USDC on Monad |
| `recipient` | your `TREASURY_ADDRESS` | where settled usage goes |
| `admin` | a wallet you hold | can pause/resume settlements and grant/revoke settler and admin roles |
| `settler` | your `SETTLER_ADDRESS` | the gateway's signing key |
| `debitLimit` | `1000000000` (1,000 USDC) | most one `settle` may debit |
| `refillCeiling` | `1000000000` (1,000 USDC) | most a wallet may set as its refill target |
| `refillTarget` | `2000000` (2 USDC) | default refill target before the wallet configures one |
| `dailyLimit` | `20000000` (20 USDC) | default daily debit limit |
| `delay` | `1800` (30 min) | wait between a withdrawal request and the payout |

```sh
cd contracts
forge create src/WalletPrepaidPool.sol:WalletPrepaidPool \
  --rpc-url https://rpc.monad.xyz --private-key "$DEPLOYER_KEY" --broadcast \
  --constructor-args 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "$TREASURY_ADDRESS" "$ADMIN_ADDRESS" "$SETTLER_ADDRESS" \
    1000000000 1000000000 2000000 20000000 1800
```

Then set `POOL_ADDRESS` to the new address and `POOL_CODE_HASH` to what `npm run contracts:verify -- --pool <address>` prints. The deployer key is only needed for this transaction; the Treasury and the deployer must not be the Settler.
